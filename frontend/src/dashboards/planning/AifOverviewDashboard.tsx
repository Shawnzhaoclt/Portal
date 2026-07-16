import { useEffect, useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { BarChart3, CalendarCheck, ClipboardCheck, ClipboardClock, Database, Download, Filter, LayoutDashboard, RefreshCw } from 'lucide-react'
import { EChart } from '../../EChart'
import '../critical-team/CriticalTeamDashboard.css'
import './AifOverviewDashboard.css'

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
  const response = await fetch(`${path}${suffix}`)
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `Request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
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
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).format(date)
}

function formatMonthYear(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
  }).format(date)
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

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function columnLetter(index: number) {
  let column = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    column = String.fromCharCode(65 + remainder) + column
    value = Math.floor((value - 1) / 26)
  }
  return column
}

function xlsxTextCell(columnIndex: number, rowIndex: number, value: string, style = 0) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  return `<c r="${cellRef}" t="inlineStr" s="${style}"><is><t>${escapeXml(value)}</t></is></c>`
}

function xlsxNumberCell(columnIndex: number, rowIndex: number, value: number, style = 0) {
  const cellRef = `${columnLetter(columnIndex)}${rowIndex}`
  return `<c r="${cellRef}" s="${style}"><v>${value}</v></c>`
}

function encodeText(value: string) {
  return new TextEncoder().encode(value)
}

const CRC32_TABLE = (() => {
  const table: number[] = []
  for (let index = 0; index < 256; index += 1) {
    let current = index
    for (let bit = 0; bit < 8; bit += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    }
    table[index] = current >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function concatBytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function zipDateTime(date: Date) {
  return {
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

function createZip(files: Array<{ name: string; content: string }>) {
  const now = zipDateTime(new Date())
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  const entries: Array<{ nameBytes: Uint8Array; bytes: Uint8Array; crc: number; offset: number }> = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encodeText(file.name)
    const bytes = encodeText(file.content)
    const fileCrc = crc32(bytes)
    const header = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, now.time, true)
    view.setUint16(12, now.date, true)
    view.setUint32(14, fileCrc, true)
    view.setUint32(18, bytes.length, true)
    view.setUint32(22, bytes.length, true)
    view.setUint16(26, nameBytes.length, true)
    header.set(nameBytes, 30)

    entries.push({ nameBytes, bytes, crc: fileCrc, offset })
    localChunks.push(header, bytes)
    offset += header.length + bytes.length
  }

  const centralOffset = offset
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.nameBytes.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, now.time, true)
    view.setUint16(14, now.date, true)
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.bytes.length, true)
    view.setUint32(24, entry.bytes.length, true)
    view.setUint16(28, entry.nameBytes.length, true)
    view.setUint32(42, entry.offset, true)
    header.set(entry.nameBytes, 46)
    centralChunks.push(header)
    offset += header.length
  }

  const centralSize = offset - centralOffset
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, centralOffset, true)

  return concatBytes([...localChunks, ...centralChunks, end])
}

function createAifOverviewWorkbook(data: AifOverviewResponse, periodMode: AifPeriodMode) {
  const seriesByKey = new Map(data.series.map((series) => [series.key, series]))
  const rows = data.months.map((month, index) => {
    const rowIndex = index + 5
    const valueFor = (key: string) => seriesByKey.get(key)?.points.find((point) => point.month_key === month.key)?.count_value ?? 0
    return `<row r="${rowIndex}">${[
      xlsxTextCell(0, rowIndex, month.label, index % 2 === 0 ? 4 : 0),
      xlsxNumberCell(1, rowIndex, valueFor('completed'), index % 2 === 0 ? 4 : 0),
      xlsxNumberCell(2, rowIndex, valueFor('inspections'), index % 2 === 0 ? 4 : 0),
      xlsxNumberCell(3, rowIndex, valueFor('project_started'), index % 2 === 0 ? 4 : 0),
    ].join('')}</row>`
  })
  const totalRowIndex = data.months.length + 5
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D${totalRowIndex}"/>
  <cols>
    <col min="1" max="1" width="18" customWidth="1"/>
    <col min="2" max="4" width="20" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1" ht="24" customHeight="1">${xlsxTextCell(0, 1, `AIF Overview Chart Data (${PERIOD_MODE_LABELS[periodMode]})`, 2)}</row>
    <row r="2">${xlsxTextCell(0, 2, `Date range: ${formatDate(data.date_from)} to ${formatDate(data.date_to)}`, 5)}</row>
    <row r="3">${xlsxTextCell(0, 3, `Generated at: ${new Date().toLocaleString('en-US')}`, 5)}</row>
    <row r="4">${[
      xlsxTextCell(0, 4, PERIOD_MODE_LABELS[periodMode], 3),
      xlsxTextCell(1, 4, 'AIFs Completed', 3),
      xlsxTextCell(2, 4, 'Inspections Performed', 3),
      xlsxTextCell(3, 4, 'Projects Started', 3),
    ].join('')}</row>
    ${rows.join('\n    ')}
    <row r="${totalRowIndex}">${[
      xlsxTextCell(0, totalRowIndex, 'Total', 3),
      xlsxNumberCell(1, totalRowIndex, data.metrics.completed, 3),
      xlsxNumberCell(2, totalRowIndex, data.metrics.inspections, 3),
      xlsxNumberCell(3, totalRowIndex, data.metrics.project_started, 3),
    ].join('')}</row>
  </sheetData>
  <mergeCells count="3">
    <mergeCell ref="A1:D1"/>
    <mergeCell ref="A2:D2"/>
    <mergeCell ref="A3:D3"/>
  </mergeCells>
</worksheet>`

  return createZip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="AIF Overview" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="15"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0B3558"/><name val="Calibri"/></font>
    <font><i/><sz val="10"/><color rgb="FF5B6B80"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F5D8F"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD6E7F2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFB7C7D8"/></left>
      <right style="thin"><color rgb="FFB7C7D8"/></right>
      <top style="thin"><color rgb="FFB7C7D8"/></top>
      <bottom style="thin"><color rgb="FFB7C7D8"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', content: worksheet },
  ])
}

function downloadAifOverviewData(data: AifOverviewResponse, periodMode: AifPeriodMode) {
  const workbook = createAifOverviewWorkbook(data, periodMode)
  const blob = new Blob([workbook], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `aif-overview-${periodMode}-${data.date_from}-to-${data.date_to}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
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
                onClick={() => {
                  if (chartData) downloadAifOverviewData(chartData, periodMode)
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
