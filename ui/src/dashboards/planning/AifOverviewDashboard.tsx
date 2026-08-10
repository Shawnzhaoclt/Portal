import { useEffect, useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { BarChart3, CalendarCheck, ClipboardCheck, ClipboardClock, Database, Download, Filter, LayoutDashboard, RefreshCw } from 'lucide-react'
import { EChart } from '../../EChart'
import '../critical-team/CriticalTeamDashboard.css'
import './AifOverviewDashboard.css'
import { portalRequestJson } from '../../desktop/request'
import { formatDateOnly, formatDateTime, formatMonthYear } from '../../lib/dateTime'
import { createPortalExcelWorkbook, downloadExcelWorkbook } from '../../lib/excelExport'

type AifOverviewPoint = {
  month_key: string
  month_label: string
  count_value: number
}

type AifOverviewSeries = {
  key: string
  label: string
  activity_key: string
  activity_label: string
  color: string
  points: AifOverviewPoint[]
}

type AifOverviewResponse = {
  date_from: string
  date_to: string
  months: Array<{ key: string; label: string }>
  activities: Array<{ key: string; label: string; total: number }>
  metrics: {
    total: number
    completed: number
    inspections: number
    project_started: number
  }
  series: AifOverviewSeries[]
}

type AifPeriodMode = 'month' | 'quarter' | 'fiscal_year'

const DEFAULT_DATE_FROM = '2025-07-01'
const DEFAULT_DATE_TO = '2026-06-30'
const AIF_EARLIEST_DATE = '2020-01-01'

const PERIOD_MODE_LABELS: Record<AifPeriodMode, string> = {
  month: 'Month',
  quarter: 'Quarter',
  fiscal_year: 'Fiscal Year',
}

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  return portalRequestJson<T>(`${path}${suffix}`)
}

function fetchAifOverview(dateFrom: string, dateTo: string) {
  const params = new URLSearchParams()
  params.set('date_from', dateFrom)
  params.set('date_to', dateTo)
  return apiGet<AifOverviewResponse>('/api/planning/aif-overview', params)
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat().format(value)
}

function formatDate(value: string) {
  return formatDateOnly(value, value)
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function currentLocalDate() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

function parseMonthKey(monthKey: string) {
  const [yearText, monthText] = monthKey.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

function monthEndDate(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function monthRange(monthKey: string) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return { dateFrom: DEFAULT_DATE_FROM, dateTo: DEFAULT_DATE_TO }
  return {
    dateFrom: isoDate(parsed.year, parsed.month, 1),
    dateTo: isoDate(parsed.year, parsed.month, monthEndDate(parsed.year, parsed.month)),
  }
}

function fiscalYearForMonth(year: number, month: number) {
  return month >= 7 ? year + 1 : year
}

function fiscalYearForIsoDate(value: string) {
  const parsed = parseMonthKey(value.slice(0, 7))
  if (!parsed) return currentLocalDate().year
  return fiscalYearForMonth(parsed.year, parsed.month)
}

function fiscalYearForCurrentDate() {
  const now = currentLocalDate()
  return fiscalYearForMonth(now.year, now.month)
}

function fiscalYearRange(fiscalYear: number) {
  return {
    dateFrom: isoDate(fiscalYear - 1, 7, 1),
    dateTo: isoDate(fiscalYear, 6, 30),
  }
}

function fiscalQuarterForMonth(month: number) {
  if (month >= 7 && month <= 9) return 1
  if (month >= 10 && month <= 12) return 2
  if (month >= 1 && month <= 3) return 3
  return 4
}

function quarterKeyForIsoDate(value: string) {
  const parsed = parseMonthKey(value.slice(0, 7))
  if (!parsed) return `FY${fiscalYearForCurrentDate()}-Q1`
  return `FY${fiscalYearForMonth(parsed.year, parsed.month)}-Q${fiscalQuarterForMonth(parsed.month)}`
}

function parseQuarterKey(value: string) {
  const match = value.match(/^FY(\d{4})-Q([1-4])$/)
  if (!match) return null
  return { fiscalYear: Number(match[1]), quarter: Number(match[2]) }
}

function quarterRange(quarterKey: string) {
  const parsed = parseQuarterKey(quarterKey)
  if (!parsed) return { dateFrom: DEFAULT_DATE_FROM, dateTo: DEFAULT_DATE_TO }
  const quarterStartMonths: Record<number, number> = {
    1: 7,
    2: 10,
    3: 1,
    4: 4,
  }
  const quarterStartMonth = quarterStartMonths[parsed.quarter]
  const startYear = parsed.quarter <= 2 ? parsed.fiscalYear - 1 : parsed.fiscalYear
  const endMonth = quarterStartMonth + 2
  return {
    dateFrom: isoDate(startYear, quarterStartMonth, 1),
    dateTo: isoDate(startYear, endMonth, monthEndDate(startYear, endMonth)),
  }
}

function quarterIndex(quarterKey: string) {
  const parsed = parseQuarterKey(quarterKey)
  if (!parsed) return 0
  return parsed.fiscalYear * 4 + parsed.quarter
}

function orderedDateRange(dateFrom: string, dateTo: string) {
  if (dateTo < dateFrom) return { dateFrom: dateTo, dateTo: dateFrom }
  return { dateFrom, dateTo }
}

function periodSelectionDateRange(
  mode: AifPeriodMode,
  monthFrom: string,
  monthTo: string,
  quarterFrom: string,
  quarterTo: string,
  fiscalYearFrom: number,
  fiscalYearTo: number,
) {
  if (mode === 'fiscal_year') {
    const startYear = Math.min(fiscalYearFrom, fiscalYearTo)
    const endYear = Math.max(fiscalYearFrom, fiscalYearTo)
    return {
      dateFrom: fiscalYearRange(startYear).dateFrom,
      dateTo: fiscalYearRange(endYear).dateTo,
    }
  }
  if (mode === 'quarter') {
    const firstQuarter = quarterIndex(quarterFrom) <= quarterIndex(quarterTo) ? quarterFrom : quarterTo
    const lastQuarter = firstQuarter === quarterFrom ? quarterTo : quarterFrom
    return {
      dateFrom: quarterRange(firstQuarter).dateFrom,
      dateTo: quarterRange(lastQuarter).dateTo,
    }
  }
  const start = monthRange(monthFrom)
  const end = monthRange(monthTo)
  return orderedDateRange(start.dateFrom, end.dateTo)
}

function periodSelectionLabel(
  mode: AifPeriodMode,
  dateFrom: string,
  dateTo: string,
  quarterFrom: string,
  quarterTo: string,
  fiscalYearFrom: number,
  fiscalYearTo: number,
) {
  if (mode === 'fiscal_year') {
    return `FY${Math.min(fiscalYearFrom, fiscalYearTo)} to FY${Math.max(fiscalYearFrom, fiscalYearTo)}`
  }
  if (mode === 'quarter') {
    return `${quarterFrom.replace('-', ' ')} to ${quarterTo.replace('-', ' ')}`
  }
  return `${formatMonthYear(dateFrom)} to ${formatMonthYear(dateTo)}`
}

function fiscalYearOptions() {
  const startYear = fiscalYearForIsoDate(AIF_EARLIEST_DATE)
  const endYear = fiscalYearForCurrentDate()
  const years = []
  for (let year = startYear; year <= endYear; year += 1) years.push(year)
  return years
}

function quarterOptions() {
  const start = quarterKeyForIsoDate(AIF_EARLIEST_DATE)
  const end = quarterKeyForIsoDate(isoDate(currentLocalDate().year, currentLocalDate().month, currentLocalDate().day))
  const options: Array<{ key: string; label: string }> = []
  for (let index = quarterIndex(start); index <= quarterIndex(end); index += 1) {
    const fiscalYear = Math.floor((index - 1) / 4)
    const quarter = ((index - 1) % 4) + 1
    options.push({ key: `FY${fiscalYear}-Q${quarter}`, label: `FY${fiscalYear} Q${quarter}` })
  }
  return options
}

function periodForMonth(month: { key: string; label: string }, mode: AifPeriodMode) {
  if (mode === 'month') return { key: month.key, label: month.label }
  const parsed = parseMonthKey(month.key)
  if (!parsed) return { key: month.key, label: month.label }
  const fiscalYear = fiscalYearForMonth(parsed.year, parsed.month)
  if (mode === 'quarter') {
    const quarter = fiscalQuarterForMonth(parsed.month)
    return { key: `FY${fiscalYear}-Q${quarter}`, label: `FY${fiscalYear} Q${quarter}` }
  }
  return { key: `FY${fiscalYear}`, label: `FY${fiscalYear}` }
}

function aggregateAifOverviewData(data: AifOverviewResponse | null, mode: AifPeriodMode): AifOverviewResponse | null {
  if (!data || mode === 'month') return data

  const periodOrder: Array<{ key: string; label: string }> = []
  const periodLookup = new Map<string, { key: string; label: string }>()
  const monthToPeriod = new Map<string, string>()

  for (const month of data.months) {
    const period = periodForMonth(month, mode)
    monthToPeriod.set(month.key, period.key)
    if (!periodLookup.has(period.key)) {
      periodLookup.set(period.key, period)
      periodOrder.push(period)
    }
  }

  const series = data.series.map((seriesItem) => {
    const totals = new Map<string, number>()
    for (const point of seriesItem.points) {
      const periodKey = monthToPeriod.get(point.month_key)
      if (!periodKey) continue
      totals.set(periodKey, (totals.get(periodKey) ?? 0) + point.count_value)
    }
    return {
      ...seriesItem,
      points: periodOrder.map((period) => ({
        month_key: period.key,
        month_label: period.label,
        count_value: totals.get(period.key) ?? 0,
      })),
    }
  })

  return {
    ...data,
    months: periodOrder,
    series,
  }
}

function createAifOverviewWorkbook(data: AifOverviewResponse, periodMode: AifPeriodMode) {
  const seriesByKey = new Map(data.series.map((series) => [series.key, series]))
  const valueFor = (monthKey: string, key: string) =>
    seriesByKey.get(key)?.points.find((point) => point.month_key === monthKey)?.count_value ?? 0
  return createPortalExcelWorkbook({
    title: `AIF Overview Chart Data (${PERIOD_MODE_LABELS[periodMode]})`,
    sheetName: 'AIF Overview',
    columns: [
      { heading: PERIOD_MODE_LABELS[periodMode], width: 18 },
      { heading: 'AIFs Completed', width: 20 },
      { heading: 'Inspections Performed', width: 22 },
      { heading: 'Projects Started', width: 20 },
    ],
    metadata: [
      `Date range: ${formatDate(data.date_from)} to ${formatDate(data.date_to)}`,
      `Generated at: ${formatDateTime(new Date())}`,
    ],
    rows: [
      ...data.months.map((month) => ({
        cells: [
          month.label,
          valueFor(month.key, 'completed'),
          valueFor(month.key, 'inspections'),
          valueFor(month.key, 'project_started'),
        ],
      })),
      {
        kind: 'total' as const,
        cells: ['Total', data.metrics.completed, data.metrics.inspections, data.metrics.project_started],
      },
    ],
    autoFilter: false,
  })
}

function downloadAifOverviewData(data: AifOverviewResponse, periodMode: AifPeriodMode) {
  const workbook = createAifOverviewWorkbook(data, periodMode)
  return downloadExcelWorkbook(workbook, `aif-overview-${periodMode}-${data.date_from}-to-${data.date_to}.xlsx`)
}
function makeAifChartOption(data: AifOverviewResponse | null): EChartsOption {
  const months = data?.months ?? []
  const seriesList = data?.series ?? []

  return {
    color: seriesList.map((series) => series.color),
    animationDuration: 260,
    grid: { top: 66, right: 28, bottom: 42, left: 58, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
    },
    legend: {
      top: 0,
      right: 4,
      itemWidth: 11,
      itemHeight: 11,
      data: seriesList.map((series) => series.label),
      textStyle: { color: '#334155', fontSize: 12, fontWeight: 700 },
    },
    xAxis: {
      type: 'category',
      data: months.map((month) => month.label),
      axisTick: { alignWithLabel: true },
      axisLine: { lineStyle: { color: '#cfd8e3' } },
      axisLabel: {
        color: '#64748b',
        interval: 0,
        rotate: months.length > 8 ? 30 : 0,
        fontWeight: 650,
      },
    },
    yAxis: {
      type: 'value',
      name: 'AIFs',
      max: ({ max }) => Math.max(1, Math.ceil(max * 1.15)),
      nameTextStyle: { color: '#64748b', fontWeight: 800 },
      axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: '#e4ebf1' } },
    },
    series: seriesList.map((series) => {
      const lookup = new Map(series.points.map((point) => [point.month_key, point.count_value]))
      return {
        name: series.label,
        type: 'bar',
        barMinWidth: 4,
        barMaxWidth: 34,
        barGap: '18%',
        barCategoryGap: '28%',
        itemStyle: { color: series.color },
        label: {
          show: true,
          position: 'top',
          distance: 3,
          color: '#334155',
          fontSize: 11,
          fontWeight: 800,
          formatter: ({ value }) => {
            const count = Number(value)
            return count > 0 ? formatNumber(count) : ''
          },
        },
        emphasis: { focus: 'series' },
        data: months.map((month) => lookup.get(month.key) ?? 0),
      }
    }),
  }
}

export default function AifOverviewDashboard() {
  const [periodMode, setPeriodMode] = useState<AifPeriodMode>('month')
  const [monthFrom, setMonthFrom] = useState(DEFAULT_DATE_FROM.slice(0, 7))
  const [monthTo, setMonthTo] = useState(DEFAULT_DATE_TO.slice(0, 7))
  const [quarterFrom, setQuarterFrom] = useState(quarterKeyForIsoDate(DEFAULT_DATE_FROM))
  const [quarterTo, setQuarterTo] = useState(quarterKeyForIsoDate(DEFAULT_DATE_TO))
  const [fiscalYearFrom, setFiscalYearFrom] = useState(fiscalYearForIsoDate(AIF_EARLIEST_DATE))
  const [fiscalYearTo, setFiscalYearTo] = useState(fiscalYearForCurrentDate())
  const [data, setData] = useState<AifOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const fiscalYears = useMemo(() => fiscalYearOptions(), [])
  const quarters = useMemo(() => quarterOptions(), [])
  const fiscalYearsDescending = useMemo(() => [...fiscalYears].reverse(), [fiscalYears])
  const quartersDescending = useMemo(() => [...quarters].reverse(), [quarters])
  const activeDateRange = useMemo(
    () => periodSelectionDateRange(periodMode, monthFrom, monthTo, quarterFrom, quarterTo, fiscalYearFrom, fiscalYearTo),
    [fiscalYearFrom, fiscalYearTo, monthFrom, monthTo, periodMode, quarterFrom, quarterTo],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchAifOverview(activeDateRange.dateFrom, activeDateRange.dateTo)
      .then((response) => {
        if (!cancelled) setData(response)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load AIF overview.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDateRange.dateFrom, activeDateRange.dateTo])

  const refreshOverview = () => {
    setLoading(true)
    setError('')
    fetchAifOverview(activeDateRange.dateFrom, activeDateRange.dateTo)
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unable to load AIF overview.')
      })
      .finally(() => setLoading(false))
  }

  const handlePeriodModeChange = (nextMode: AifPeriodMode) => {
    setPeriodMode(nextMode)
    if (nextMode === 'fiscal_year') {
      setFiscalYearFrom(fiscalYearForIsoDate(AIF_EARLIEST_DATE))
      setFiscalYearTo(fiscalYearForCurrentDate())
    } else if (nextMode === 'quarter') {
      setQuarterFrom(quarterKeyForIsoDate(AIF_EARLIEST_DATE))
      setQuarterTo(quarterKeyForIsoDate(isoDate(currentLocalDate().year, currentLocalDate().month, currentLocalDate().day)))
    }
  }

  const chartData = useMemo(() => aggregateAifOverviewData(data, periodMode), [data, periodMode])
  const chartOption = useMemo(() => makeAifChartOption(chartData), [chartData])
  const completed = data?.metrics.completed ?? 0
  const inspections = data?.metrics.inspections ?? 0
  const projectStarted = data?.metrics.project_started ?? 0
  const dateRangeLabel = periodSelectionLabel(
    periodMode,
    data?.date_from ?? activeDateRange.dateFrom,
    data?.date_to ?? activeDateRange.dateTo,
    quarterFrom,
    quarterTo,
    fiscalYearFrom,
    fiscalYearTo,
  )
  const periodDescription = `${PERIOD_MODE_LABELS[periodMode]} totals for completed AIFs, inspections, and project starts.`
  const canDownload = Boolean(chartData && !loading && !error)

  return (
    <div className="workbook-shell overview-mode portal-view-mode aif-overview-workbook">
      <main className="sheet-canvas aif-overview-canvas">
        <section className="sheet-panel overview-panel aif-overview-panel">
          <div className="panel-header">
            <div>
              <LayoutDashboard size={18} />
              <div className="panel-title-copy">
                <h2>Overview</h2>
              <p>Asset Inspection Form activity by month.</p>
              </div>
            </div>
            <div className="panel-header-actions aif-overview-actions">
              <span className="panel-header-meta">{dateRangeLabel}</span>
              <button
                type="button"
                className="aif-overview-export-button"
                disabled={!canDownload}
                onClick={async () => {
                  if (!chartData) return
                  try {
                    await downloadAifOverviewData(chartData, periodMode)
                  } catch (exportError) {
                    setError(exportError instanceof Error ? exportError.message : 'Unable to open the Excel export.')
                  }
                }}
              >
                <Download size={14} />
                Download
              </button>
              <div className="aif-overview-filter-wrap">
                <button
                  type="button"
                  className="aif-overview-filter-button"
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  <Filter size={14} />
                  Filters
                </button>
                {filtersOpen ? (
                  <div className="aif-overview-filter-menu">
                    <label>
                      Show by
                      <select value={periodMode} onChange={(event) => handlePeriodModeChange(event.currentTarget.value as AifPeriodMode)}>
                        <option value="month">Month</option>
                        <option value="quarter">Quarter</option>
                        <option value="fiscal_year">Fiscal Year</option>
                      </select>
                    </label>
                    {periodMode === 'fiscal_year' ? (
                      <>
                        <label>
                          From FY
                          <select value={fiscalYearFrom} onChange={(event) => setFiscalYearFrom(Number(event.currentTarget.value))}>
                            {fiscalYears.map((year) => (
                              <option key={year} value={year}>FY{year}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          To FY
                          <select value={fiscalYearTo} onChange={(event) => setFiscalYearTo(Number(event.currentTarget.value))}>
                            {fiscalYearsDescending.map((year) => (
                              <option key={year} value={year}>FY{year}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : null}
                    {periodMode === 'quarter' ? (
                      <>
                        <label>
                          From Quarter
                          <select value={quarterFrom} onChange={(event) => setQuarterFrom(event.currentTarget.value)}>
                            {quarters.map((quarter) => (
                              <option key={quarter.key} value={quarter.key}>{quarter.label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          To Quarter
                          <select value={quarterTo} onChange={(event) => setQuarterTo(event.currentTarget.value)}>
                            {quartersDescending.map((quarter) => (
                              <option key={quarter.key} value={quarter.key}>{quarter.label}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : null}
                    {periodMode === 'month' ? (
                      <>
                        <label>
                          From Month
                          <input type="month" value={monthFrom} onChange={(event) => setMonthFrom(event.currentTarget.value)} />
                        </label>
                        <label>
                          To Month
                          <input type="month" value={monthTo} onChange={(event) => setMonthTo(event.currentTarget.value)} />
                        </label>
                      </>
                    ) : null}
                    <button type="button" onClick={refreshOverview} disabled={loading}>
                      <RefreshCw size={15} />
                      Refresh
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {loading ? <div className="loading-bar">Refreshing AIF overview</div> : null}

          <div className="profile-grid overview-kpi-grid aif-kpi-grid">
            <div className="kpi kpi-green">
              <div className="kpi-icon"><ClipboardCheck size={20} /></div>
              <div className="kpi-copy">
                <span>AIFs Completed</span>
                <div className="kpi-value"><strong>{formatNumber(completed)}</strong></div>
              </div>
            </div>
            <div className="kpi kpi-blue">
              <div className="kpi-icon"><ClipboardClock size={20} /></div>
              <div className="kpi-copy">
                <span>Inspections Performed</span>
                <div className="kpi-value"><strong>{formatNumber(inspections)}</strong></div>
              </div>
            </div>
            <div className="kpi kpi-orange">
              <div className="kpi-icon"><CalendarCheck size={20} /></div>
              <div className="kpi-copy">
                <span>Projects Started</span>
                <div className="kpi-value"><strong>{formatNumber(projectStarted)}</strong></div>
              </div>
            </div>
          </div>

          <div className="overview-trend-card aif-chart-card">
            <div className="panel-header">
              <div>
                <BarChart3 size={18} />
                <div className="panel-title-copy">
                  <h2>Trend</h2>
                  <p>{periodDescription}</p>
                </div>
              </div>
            </div>
            {error ? (
              <div className="aif-overview-chart-empty">
                <Database size={26} />
                <span>{error}</span>
              </div>
            ) : (
              <EChart option={chartOption} height="100%" />
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
