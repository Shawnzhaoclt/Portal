import type {
  AggregatesResponse,
  FilterOptionsResponse,
  FilterState,
  HistoryResponse,
  MetricKey,
  SourceKey,
  SourceResponse,
  SummaryResponse,
  TableColumnFilters,
  TableResponse,
} from './types'
import { portalRequestJson } from '../../desktop/request'

export type TableRequest = {
  source: SourceKey
  limit: number
  offset: number
  sortBy?: string
  sortDir: 'asc' | 'desc'
}

const NUMERIC_PARAM_MAP: Record<string, [string, string]> = {
  risk: ['min_risk', 'max_risk'],
  condition_risk: ['min_condition_risk', 'max_condition_risk'],
  flood_risk: ['min_flood_risk', 'max_flood_risk'],
  clog_risk: ['min_clog_risk', 'max_clog_risk'],
  risk_delta: ['min_risk_delta', 'max_risk_delta'],
  condition_delta: ['min_condition_delta', 'max_condition_delta'],
  flood_delta: ['min_flood_delta', 'max_flood_delta'],
  clog_delta: ['min_clog_delta', 'max_clog_delta'],
  risk_delta_sum: ['min_risk_delta_sum', 'max_risk_delta_sum'],
  condition_delta_sum: ['min_condition_delta_sum', 'max_condition_delta_sum'],
  flood_delta_sum: ['min_flood_delta_sum', 'max_flood_delta_sum'],
  clog_delta_sum: ['min_clog_delta_sum', 'max_clog_delta_sum'],
  pipe_size: ['min_pipe_size', 'max_pipe_size'],
  inspection_count: ['min_inspection_count', 'max_inspection_count'],
}

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  return portalRequestJson<T>(`${path}${suffix}`)
}

export function paramsFromFilters(filters: FilterState): URLSearchParams {
  const params = new URLSearchParams()

  if (filters.search.trim()) {
    params.set('search', filters.search.trim())
  }
  if (filters.facilityId.trim()) {
    params.set('facility_id', filters.facilityId.trim())
  }
  if (filters.assetId.trim()) {
    params.set('asset_id', filters.assetId.trim())
  }
  if (filters.inspectionCount.trim()) {
    params.set('inspection_count', filters.inspectionCount.trim())
  }
  if (filters.inspectionDate.trim()) {
    params.set('inspection_date', filters.inspectionDate.trim())
  }
  for (const material of filters.material) {
    if (material) {
      params.append('material', material)
    }
  }
  if (filters.streetWater !== 'all') {
    params.set('street_water', filters.streetWater)
  }
  if (filters.mostRecent !== 'all') {
    params.set('most_recent', filters.mostRecent)
  }

  for (const [key, range] of Object.entries(filters.numeric)) {
    const paramsForRange = NUMERIC_PARAM_MAP[key]
    if (!paramsForRange) {
      continue
    }
    const [minParam, maxParam] = paramsForRange
    if (range.min.trim()) {
      params.set(minParam, range.min.trim())
    }
    if (range.max.trim()) {
      params.set(maxParam, range.max.trim())
    }
  }

  for (const [field, value] of Object.entries(filters.flags)) {
    if (value !== 'all') {
      params.append('flag', `${field}:${value}`)
    }
  }

  return params
}

function appendTableColumnFilters(params: URLSearchParams, filters?: TableColumnFilters) {
  if (!filters) {
    return
  }

  for (const [column, range] of Object.entries(filters.numeric)) {
    if (range.min.trim() || range.max.trim()) {
      params.append('number_filter', `${column}:${range.min.trim()}:${range.max.trim()}`)
    }
  }

  for (const [column, range] of Object.entries(filters.dates)) {
    if (range.from.trim() || range.to.trim()) {
      params.append('date_filter', `${column}:${range.from.trim()}:${range.to.trim()}`)
    }
  }

  for (const [column, value] of Object.entries(filters.text)) {
    if (value.trim()) {
      params.append('text_filter', `${column}:${value.trim()}`)
    }
  }

  for (const [column, values] of Object.entries(filters.multi)) {
    for (const value of values) {
      params.append('multi_filter', `${column}:${value}`)
    }
  }
}

export function fetchSource() {
  return apiGet<SourceResponse>('/api/critical-assets/source')
}

export function fetchSummary() {
  return apiGet<SummaryResponse>('/api/critical-assets/summary')
}

export function fetchFilterOptions() {
  return apiGet<FilterOptionsResponse>('/api/critical-assets/filter-options')
}

export function fetchAggregates(
  source: SourceKey,
  metric: MetricKey,
  filters: FilterState,
  limit = 1000,
) {
  const params = paramsFromFilters(filters)
  params.set('limit', String(limit))
  return apiGet<AggregatesResponse>(`/api/critical-assets/aggregates/${source}/${metric}`, params)
}

export function fetchHistory(source: SourceKey, filters: FilterState, limit = 2500, worksheet?: string) {
  const params = paramsFromFilters(filters)
  params.set('source', source)
  params.set('limit', String(limit))
  if (worksheet) {
    params.set('worksheet', worksheet)
  }
  return apiGet<HistoryResponse>('/api/critical-assets/history', params)
}

export function fetchTable(request: TableRequest, filters: FilterState, columnFilters?: TableColumnFilters) {
  const params = paramsFromFilters(filters)
  appendTableColumnFilters(params, columnFilters)
  params.set('limit', String(request.limit))
  params.set('offset', String(request.offset))
  params.set('sort_dir', request.sortDir)
  if (request.sortBy) {
    params.set('sort_by', request.sortBy)
  }

  return apiGet<TableResponse>(`/api/critical-assets/table/${request.source}`, params)
}

