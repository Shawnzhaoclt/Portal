import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import '../critical-team/CriticalTeamDashboard.css'
import './PlanningPendingAifQaTable.css'
import { portalRequestJson } from '../../desktop/request'
import { openExternalUrl } from '../../desktop/runtime'
import { formatDateOnly, formatDateTime } from '../../lib/dateTime'
import { createPortalExcelWorkbook, downloadExcelWorkbook } from '../../lib/excelExport'

type CellValue = string | number | boolean | null
type PendingAifRow = Record<string, CellValue> & {
  _links?: Record<string, string>
}

type PendingAifResponse = {
  total: number
  limit: number
  offset: number
  source_published_at_utc?: string | null
  rows: PendingAifRow[]
}

type PendingAifFilterOptions = Record<string, string[]>

type NumberFilterMode = 'any' | 'exact' | 'between' | 'greater' | 'less'
type DateFilterMode = 'any' | 'exact' | 'between' | 'before' | 'after'
type SortDirection = 'asc' | 'desc'

type NumberFilter = {
  mode: NumberFilterMode
  from: string
  to: string
}

type DateFilter = {
  mode: DateFilterMode
  from: string
  to: string
}

type PendingAifColumn = {
  key: string
  label: string
  width: string
  type: 'category' | 'date' | 'number' | 'text'
  link?: boolean
}

const PENDING_AIF_COLUMNS: PendingAifColumn[] = [
  { key: 'inspection_id', label: 'Inspection ID', width: '132px', type: 'number', link: true },
  { key: 'asset_id', label: 'Asset ID', width: '140px', type: 'text' },
  { key: 'inspection_date', label: 'Inspection Date', width: '148px', type: 'date' },
  { key: 'inspection_by', label: 'Inspection By', width: '164px', type: 'category' },
  { key: 'inspection_status', label: 'Inspection Status', width: '160px', type: 'category' },
  { key: 'submit_to', label: 'Submit To', width: '160px', type: 'category' },
  { key: 'team', label: 'Team', width: '160px', type: 'category' },
  { key: 'related_workorder_id', label: 'WorkOrder ID', width: '140px', type: 'number', link: true },
  { key: 'critical_team_status', label: 'Critical Team Status', width: '184px', type: 'category' },
  { key: 'investigation_id', label: 'Investigation ID', width: '140px', type: 'number', link: true },
  { key: 'investigation_status', label: 'Investigation Status', width: '185px', type: 'category' },
]

const NUMBER_FILTER_KEYS = ['inspection_id', 'related_workorder_id', 'investigation_id'] as const
const TEXT_FILTER_KEYS = ['asset_id'] as const
const CATEGORY_FILTER_KEYS = [
  'inspection_by',
  'inspection_status',
  'submit_to',
  'team',
  'critical_team_status',
  'investigation_status',
] as const
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500]
const DEFAULT_SORT = { column: 'inspection_id', direction: 'asc' as SortDirection }
const CRITICAL_TEAM_ONLY_COLUMNS = new Set(['related_workorder_id', 'critical_team_status'])

function createEmptyNumberFilters() {
  return Object.fromEntries(
    NUMBER_FILTER_KEYS.map((key) => [key, { mode: 'any', from: '', to: '' }]),
  ) as Record<(typeof NUMBER_FILTER_KEYS)[number], NumberFilter>
}

function createEmptyTextFilters() {
  return Object.fromEntries(TEXT_FILTER_KEYS.map((key) => [key, ''])) as Record<(typeof TEXT_FILTER_KEYS)[number], string>
}

function createEmptyCategoryFilters() {
  return Object.fromEntries(CATEGORY_FILTER_KEYS.map((key) => [key, ''])) as Record<
    (typeof CATEGORY_FILTER_KEYS)[number],
    string
  >
}

function createEmptyDateFilter(): DateFilter {
  return { mode: 'any', from: '', to: '' }
}

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  return portalRequestJson<T>(`${path}${suffix}`)
}

function fetchPendingAifFilterOptions() {
  return apiGet<PendingAifFilterOptions>('/api/planning/pending-aif/filter-options')
}

function fetchPendingAifRows({
  categoryFilters,
  dateFilter,
  limit,
  numberFilters,
  offset,
  search,
  sort,
  textFilters,
}: {
  categoryFilters: ReturnType<typeof createEmptyCategoryFilters>
  dateFilter: DateFilter
  limit: number
  numberFilters: ReturnType<typeof createEmptyNumberFilters>
  offset: number
  search: string
  sort: typeof DEFAULT_SORT
  textFilters: ReturnType<typeof createEmptyTextFilters>
}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  params.set('sort_by', sort.column)
  params.set('sort_dir', sort.direction)
  if (search.trim()) params.set('search', search.trim())

  for (const [key, filter] of Object.entries(numberFilters)) {
    if (filter.mode === 'any') continue
    params.set(`${key}_mode`, filter.mode)
    if (filter.from) params.set(`${key}_from`, filter.from)
    if (filter.to) params.set(`${key}_to`, filter.to)
  }

  for (const [key, value] of Object.entries(textFilters)) {
    if (value.trim()) params.set(`${key}_filter`, value.trim())
  }

  for (const [key, value] of Object.entries(categoryFilters)) {
    if (value) params.append(`${key}_filter`, value)
  }

  if (dateFilter.mode !== 'any') {
    params.set('inspection_date_mode', dateFilter.mode)
    if (dateFilter.from) params.set('inspection_date_from', dateFilter.from)
    if (dateFilter.to) params.set('inspection_date_to', dateFilter.to)
  }

  return apiGet<PendingAifResponse>('/api/planning/pending-aif', params)
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat().format(value)
}

function formatSourceTimestamp(value: string | null | undefined) {
  if (!value) return null
  const formatted = formatDateTime(value, '')
  return formatted || null
}

function cellText(value: CellValue, column: PendingAifColumn) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (column.type === 'number') return String(value).replace(/\.0$/, '')
  if (typeof value === 'number') return formatNumber(value)
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value)) return formatDateOnly(value, value)
  return String(value)
}

function isCriticalTeamRow(row: PendingAifRow) {
  return String(row.team ?? '').trim().toLowerCase() === 'critical team'
}

function visibleCellText(row: PendingAifRow, column: PendingAifColumn) {
  if (CRITICAL_TEAM_ONLY_COLUMNS.has(column.key) && !isCriticalTeamRow(row)) return ''
  return cellText(row[column.key], column)
}

function visibleCellHref(row: PendingAifRow, column: PendingAifColumn) {
  if (!column.link) return ''
  if (CRITICAL_TEAM_ONLY_COLUMNS.has(column.key) && !isCriticalTeamRow(row)) return ''
  return row._links?.[column.key] ?? ''
}

function createXlsx(rows: PendingAifRow[]) {
  return createPortalExcelWorkbook({
    title: `Planning Pending AIF QA/QC - ${formatNumber(rows.length)} Pending ${rows.length === 1 ? 'AIF' : 'AIFs'}`,
    sheetName: 'Pending AIF QA QC',
    columns: PENDING_AIF_COLUMNS.map((column) => ({
      heading: column.label,
      minWidth: column.link ? 12 : 10,
      maxWidth: 38,
    })),
    rows: rows.map((row) => ({
      cells: PENDING_AIF_COLUMNS.map((column) => {
        const text = visibleCellText(row, column)
        return {
          value: !text || text === '-' ? null : text,
          hyperlink: visibleCellHref(row, column) || null,
        }
      }),
    })),
  })
}

function downloadRows(rows: PendingAifRow[]) {
  const workbook = createXlsx(rows)
  return downloadExcelWorkbook(workbook, `planning-pending-aif-qa-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
function hasActiveFilters(
  search: string,
  numberFilters: ReturnType<typeof createEmptyNumberFilters>,
  textFilters: ReturnType<typeof createEmptyTextFilters>,
  categoryFilters: ReturnType<typeof createEmptyCategoryFilters>,
  dateFilter: DateFilter,
) {
  return (
    Boolean(search.trim()) ||
    Object.values(numberFilters).some((filter) => filter.mode !== 'any' && (filter.from || filter.to)) ||
    Object.values(textFilters).some((value) => value.trim()) ||
    Object.values(categoryFilters).some(Boolean) ||
    (dateFilter.mode !== 'any' && Boolean(dateFilter.from || dateFilter.to))
  )
}

function activeFilterCount(
  search: string,
  numberFilters: ReturnType<typeof createEmptyNumberFilters>,
  textFilters: ReturnType<typeof createEmptyTextFilters>,
  categoryFilters: ReturnType<typeof createEmptyCategoryFilters>,
  dateFilter: DateFilter,
) {
  return (
    (search.trim() ? 1 : 0) +
    Object.values(numberFilters).filter((filter) => filter.mode !== 'any' && Boolean(filter.from || filter.to)).length +
    Object.values(textFilters).filter((value) => value.trim()).length +
    Object.values(categoryFilters).filter(Boolean).length +
    (dateFilter.mode !== 'any' && Boolean(dateFilter.from || dateFilter.to) ? 1 : 0)
  )
}

function PlanningPendingAifQaTable() {
  const [rowsResponse, setRowsResponse] = useState<PendingAifResponse | null>(null)
  const [options, setOptions] = useState<PendingAifFilterOptions>({})
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [numberFilters, setNumberFilters] = useState(createEmptyNumberFilters)
  const [textFilters, setTextFilters] = useState(createEmptyTextFilters)
  const [categoryFilters, setCategoryFilters] = useState(createEmptyCategoryFilters)
  const [dateFilter, setDateFilter] = useState(createEmptyDateFilter)
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [showFilters, setShowFilters] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('critical-team-dashboard-active')
    document.body.classList.add('critical-team-dashboard-active')
    return () => {
      document.documentElement.classList.remove('critical-team-dashboard-active')
      document.body.classList.remove('critical-team-dashboard-active')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchPendingAifFilterOptions()
      .then((response) => {
        if (!cancelled) setOptions(response)
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : String(requestError))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPendingAifRows({
      categoryFilters,
      dateFilter,
      limit: pageSize,
      numberFilters,
      offset: (page - 1) * pageSize,
      search,
      sort,
      textFilters,
    })
      .then((response) => {
        if (cancelled) return
        setRowsResponse(response)
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : String(requestError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [categoryFilters, dateFilter, numberFilters, page, pageSize, reloadToken, search, sort, textFilters])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchDraft)
    }, 280)
    return () => window.clearTimeout(timer)
  }, [searchDraft])

  useEffect(() => {
    const total = rowsResponse?.total ?? 0
    const pageCount = Math.max(1, Math.ceil(total / pageSize))
    if (page > pageCount) setPage(pageCount)
  }, [page, pageSize, rowsResponse?.total])

  const rows = rowsResponse?.rows ?? []
  const total = rowsResponse?.total ?? 0
  const firstRecord = total === 0 ? 0 : (rowsResponse?.offset ?? 0) + 1
  const lastRecord = total === 0 ? 0 : Math.min((rowsResponse?.offset ?? 0) + rows.length, total)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const sourceTimestamp = formatSourceTimestamp(rowsResponse?.source_published_at_utc)
  const activeFilters = useMemo(
    () => hasActiveFilters(search, numberFilters, textFilters, categoryFilters, dateFilter),
    [categoryFilters, dateFilter, numberFilters, search, textFilters],
  )
  const filterCount = useMemo(
    () => activeFilterCount(search, numberFilters, textFilters, categoryFilters, dateFilter),
    [categoryFilters, dateFilter, numberFilters, search, textFilters],
  )

  function updateNumberFilter(column: (typeof NUMBER_FILTER_KEYS)[number], next: Partial<NumberFilter>) {
    setPage(1)
    setNumberFilters((current) => {
      const nextFilter = { ...current[column], ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'greater' || next.mode === 'less') {
        nextFilter.to = ''
      }
      return { ...current, [column]: nextFilter }
    })
  }

  function updateDateFilter(next: Partial<DateFilter>) {
    setPage(1)
    setDateFilter((current) => {
      const nextFilter = { ...current, ...next }
      if (next.mode === 'any') {
        nextFilter.from = ''
        nextFilter.to = ''
      }
      if (next.mode === 'exact' || next.mode === 'before' || next.mode === 'after') {
        nextFilter.to = ''
      }
      return nextFilter
    })
  }

  function clearFilters() {
    setSearch('')
    setSearchDraft('')
    setNumberFilters(createEmptyNumberFilters())
    setTextFilters(createEmptyTextFilters())
    setCategoryFilters(createEmptyCategoryFilters())
    setDateFilter(createEmptyDateFilter())
    setPage(1)
  }

  function changeSort(column: string) {
    setPage(1)
    setSort((current) => {
      if (current.column === column) {
        return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { column, direction: 'asc' }
    })
  }

  function moveToPage(nextPage: number) {
    setPage(Math.max(1, Math.min(pageCount, nextPage)))
  }

  async function downloadAllRows() {
    if (total <= 0 || exporting) return
    setError(null)
    setExporting(true)
    try {
      const batchSize = 5000
      const allRows: PendingAifRow[] = []
      let offset = 0
      let expectedTotal = total
      while (offset < expectedTotal) {
        const response = await fetchPendingAifRows({
          categoryFilters,
          dateFilter,
          limit: Math.min(batchSize, Math.max(1, expectedTotal - offset)),
          numberFilters,
          offset,
          search,
          sort,
          textFilters,
        })
        expectedTotal = response.total
        allRows.push(...response.rows)
        if (response.rows.length === 0) break
        offset += response.rows.length
      }
      await downloadRows(allRows)
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : String(requestError))
    } finally {
      setExporting(false)
    }
  }

  function renderColumnFilter(column: PendingAifColumn) {
    if (column.type === 'number') {
      const filter = numberFilters[column.key as (typeof NUMBER_FILTER_KEYS)[number]]
      return (
        <div className="number-filter-cell">
          <select
            className="column-filter-select"
            value={filter.mode}
            onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { mode: event.target.value as NumberFilterMode })}
            aria-label={`${column.label} filter mode`}
          >
            <option value="any">Any number</option>
            <option value="exact">Equals</option>
            <option value="between">Between</option>
            <option value="greater">Greater</option>
            <option value="less">Less</option>
          </select>
          {filter.mode !== 'any' ? (
            <input
              className="number-filter-input"
              inputMode="numeric"
              placeholder="Value"
              value={filter.from}
              onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { from: event.target.value })}
            />
          ) : null}
          {filter.mode === 'between' ? (
            <input
              className="number-filter-input"
              inputMode="numeric"
              placeholder="To"
              value={filter.to}
              onChange={(event) => updateNumberFilter(column.key as (typeof NUMBER_FILTER_KEYS)[number], { to: event.target.value })}
            />
          ) : null}
        </div>
      )
    }

    if (column.type === 'text') {
      return (
        <div className="text-filter-cell">
          <input
            className="text-filter-input"
            placeholder="Search"
            value={textFilters[column.key as (typeof TEXT_FILTER_KEYS)[number]] ?? ''}
            onChange={(event) => {
              setPage(1)
              setTextFilters((current) => ({ ...current, [column.key]: event.target.value }))
            }}
            aria-label={`${column.label} search`}
          />
        </div>
      )
    }

    if (column.type === 'date') {
      return (
        <div className="date-filter-cell">
          <select
            className="column-filter-select"
            value={dateFilter.mode}
            onChange={(event) => updateDateFilter({ mode: event.target.value as DateFilterMode })}
            aria-label="Inspection date filter mode"
          >
            <option value="any">Any date</option>
            <option value="exact">On</option>
            <option value="between">Between</option>
            <option value="before">Before</option>
            <option value="after">After</option>
          </select>
          {dateFilter.mode !== 'any' ? (
            <input
              className="date-picker-trigger"
              type="date"
              value={dateFilter.from}
              onChange={(event) => updateDateFilter({ from: event.target.value })}
            />
          ) : null}
          {dateFilter.mode === 'between' ? (
            <input
              className="date-picker-trigger"
              type="date"
              value={dateFilter.to}
              onChange={(event) => updateDateFilter({ to: event.target.value })}
            />
          ) : null}
        </div>
      )
    }

    if (column.type === 'category') {
      return (
        <select
          className="column-filter-select"
          value={categoryFilters[column.key as (typeof CATEGORY_FILTER_KEYS)[number]] ?? ''}
          onChange={(event) => {
            setPage(1)
            setCategoryFilters((current) => ({ ...current, [column.key]: event.target.value }))
          }}
          aria-label={`${column.label} filter`}
        >
          <option value="">All</option>
          {(options[column.key] ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    }

    return null
  }

  return (
    <div className="workbook-shell detail-mode portal-view-mode planning-aif-workbook">
      <main className="sheet-canvas planning-aif-canvas">
        {error ? <div className="error-banner">{error}</div> : null}

        <section className="sheet-panel table-panel detail-panel planning-aif-panel">
          <div className="panel-header planning-aif-header">
            <div>
              <ClipboardCheck size={18} />
              <div className="panel-title-copy">
                <h2>Planning Pending AIF QA/QC</h2>
                <p>{sourceTimestamp ? `Last available data: ${sourceTimestamp}. ${formatNumber(total)} pending AIF records.` : `Review ${formatNumber(total)} pending Asset Inspection Forms and related Cityworks activity.`}</p>
              </div>
            </div>
            <div className="planning-aif-header-actions">
              <div className="planning-aif-total" aria-label={`${formatNumber(total)} pending AIF records`}>
                <strong>{formatNumber(total)}</strong>
                <span>Pending AIFs</span>
              </div>
              <button
                className="planning-aif-icon-button"
                type="button"
                title="Refresh data"
                aria-label="Refresh pending AIF data"
                disabled={loading}
                onClick={() => setReloadToken((current) => current + 1)}
              >
                <RefreshCw size={16} className={loading ? 'is-spinning' : undefined} />
              </button>
            </div>
          </div>

          <div className="detail-toolbar planning-aif-toolbar">
            <label className="planning-aif-search">
              <Search size={16} />
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Search inspection, asset, team, workorder, investigator"
                aria-label="Search pending AIF records"
              />
            </label>
            <div className="detail-toolbar-actions planning-aif-toolbar-actions">
              <button
                className={showFilters ? 'planning-aif-filter-button is-active' : 'planning-aif-filter-button'}
                type="button"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((current) => !current)}
              >
                <SlidersHorizontal size={14} />
                Filters{filterCount > 0 ? ` (${filterCount})` : ''}
              </button>
              <span className="table-result-range">
                {formatNumber(firstRecord)}-{formatNumber(lastRecord)} of {formatNumber(total)}
              </span>
              <div className="records-per-page">
                <span>Rows</span>
                <select
                  className="page-size-select"
                  value={pageSize}
                  onChange={(event) => {
                    setPage(1)
                    setPageSize(Number(event.target.value))
                  }}
                  aria-label="Records per page"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
              <button className="export-button" type="button" disabled={total === 0 || exporting} onClick={downloadAllRows}>
                <Download size={14} />
                {exporting ? 'Preparing...' : 'Export'}
              </button>
              <button className="clear-table-filters" type="button" disabled={!activeFilters} onClick={clearFilters}>
                <X size={14} />
                Clear{filterCount > 0 ? ` (${filterCount})` : ''}
              </button>
            </div>
          </div>

          <div className="planning-aif-status-row" aria-live="polite">
            <span>{loading ? 'Refreshing records...' : activeFilters ? `${filterCount} active filter${filterCount === 1 ? '' : 's'}` : 'All pending records'}</span>
          </div>

          <div className="table-wrap" aria-busy={loading}>
            <table className="detail-table planning-aif-table">
              <colgroup>
                {PENDING_AIF_COLUMNS.map((column) => (
                  <col key={column.key} style={{ width: column.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {PENDING_AIF_COLUMNS.map((column) => (
                    <th key={column.key} aria-sort={sort.column === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        className={sort.column === column.key ? 'sort-button active' : 'sort-button'}
                        type="button"
                        title={`Sort by ${column.label}`}
                        onClick={() => changeSort(column.key)}
                      >
                        <span>{column.label}</span>
                        {sort.column === column.key ? (
                          sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />
                        ) : (
                          <ArrowDownUp size={13} />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
                {showFilters ? (
                  <tr className="column-filter-row">
                    {PENDING_AIF_COLUMNS.map((column) => (
                      <th key={column.key}>{renderColumnFilter(column)}</th>
                    ))}
                  </tr>
                ) : null}
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const key = String(row.inspection_id ?? `${rowsResponse?.offset ?? 0}-${index}`)
                  return (
                    <tr key={key}>
                      {PENDING_AIF_COLUMNS.map((column) => {
                        const text = visibleCellText(row, column)
                        const href = visibleCellHref(row, column)
                        return (
                          <td key={column.key} title={text}>
                            {href && text !== '-' ? (
                              <a
                                className="planning-aif-table-link"
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                title={`Open ${column.label} ${text} in Cityworks`}
                                onClick={(event) => {
                                  event.preventDefault()
                                  void openExternalUrl(href).catch((error) => {
                                    toast.error(error instanceof Error ? error.message : 'Could not open the link.')
                                  })
                                }}
                              >
                                {text}
                                <ExternalLink size={12} aria-hidden="true" />
                              </a>
                            ) : column.key === 'inspection_status' && text !== '-' ? (
                              <span className="planning-aif-status-badge">{text}</span>
                            ) : (
                              text
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td className="empty-row planning-aif-empty-row" colSpan={PENDING_AIF_COLUMNS.length}>
                      <Search size={18} aria-hidden="true" />
                      <span>{loading ? 'Loading pending AIF records...' : 'No pending AIF records match the current filters.'}</span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="pagination" aria-label="Pending AIF pagination">
            <span>
              Page {formatNumber(total === 0 ? 1 : page)} of {formatNumber(pageCount)}
            </span>
            <div className="pagination-actions">
              <button type="button" title="First page" aria-label="First page" disabled={page <= 1} onClick={() => moveToPage(1)}>
                <ChevronsLeft size={16} />
              </button>
              <button type="button" title="Previous page" aria-label="Previous page" disabled={page <= 1} onClick={() => moveToPage(page - 1)}>
                <ChevronLeft size={16} />
              </button>
              <button type="button" title="Next page" aria-label="Next page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(page + 1)}>
                <ChevronRight size={16} />
              </button>
              <button type="button" title="Last page" aria-label="Last page" disabled={page >= pageCount || total === 0} onClick={() => moveToPage(pageCount)}>
                <ChevronsRight size={16} />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default PlanningPendingAifQaTable
