import type {
  CriticalTeamFilterOptionsResponse,
  CriticalTeamOverviewResponse,
  CriticalTeamSheetResponse,
  CriticalTeamSourceResponse,
  CriticalTeamSummaryResponse,
  CriticalTeamWorkordersResponse,
} from './types'
import { storedManagementToken } from '../../management/api'
import { portalRequestJson } from '../../desktop/request'

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  const token = storedManagementToken()
  return portalRequestJson<T>(`${path}${suffix}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
}

export type CriticalTeamFilters = {
  tableauDefaults: boolean
  years: string[]
  submitTo: string[]
  closedBy: string
  statuses: string[]
  search: string
}

export type CriticalTeamOverviewFilters = {
  dateFrom: string
  dateTo: string
  submitTo: string[]
  closedBy: string[]
}

export type CriticalTeamWorkorderColumnFilters = Partial<Record<string, string>>
export type CriticalTeamWorkorderDateFilter = {
  mode: 'any' | 'exact' | 'between' | 'before' | 'after'
  from: string
  to: string
}
export type CriticalTeamWorkorderNumberFilter = {
  mode: 'any' | 'exact' | 'between' | 'greater' | 'less'
  from: string
  to: string
}
export type CriticalTeamWorkorderFilters = {
  numbers?: Partial<Record<string, CriticalTeamWorkorderNumberFilter>>
  categories?: Partial<Record<string, string[]>>
  dates?: Partial<Record<string, CriticalTeamWorkorderDateFilter>>
}
export type CriticalTeamWorkorderSort = {
  sortBy: string
  sortDir: 'asc' | 'desc'
}

export function fetchCriticalTeamSource() {
  return apiGet<CriticalTeamSourceResponse>('/api/critical-team/source')
}

export function fetchCriticalTeamSummary() {
  return apiGet<CriticalTeamSummaryResponse>('/api/critical-team/summary')
}

export function fetchCriticalTeamOverview(filters: CriticalTeamOverviewFilters) {
  const params = new URLSearchParams()
  if (filters.dateFrom) {
    params.set('date_from', filters.dateFrom)
  }
  if (filters.dateTo) {
    params.set('date_to', filters.dateTo)
  }
  for (const submitter of filters.submitTo) {
    params.append('submit_to', submitter)
  }
  for (const reviewer of filters.closedBy) {
    params.append('closed_by', reviewer)
  }

  return apiGet<CriticalTeamOverviewResponse>('/api/critical-team/overview', params)
}

export function fetchCriticalTeamFilterOptions() {
  return apiGet<CriticalTeamFilterOptionsResponse>('/api/critical-team/filter-options')
}

export function fetchCriticalTeamSheet(sheetId: string, filters: CriticalTeamFilters) {
  const params = new URLSearchParams()
  params.set('tableau_defaults', String(filters.tableauDefaults))
  for (const year of filters.years) {
    params.append('year', year)
  }
  for (const status of filters.statuses) {
    params.append('status', status)
  }
  for (const submitter of filters.submitTo) {
    params.append('submit_to', submitter)
  }
  if (filters.closedBy) {
    params.set('closed_by', filters.closedBy)
  }

  return apiGet<CriticalTeamSheetResponse>(`/api/critical-team/sheet/${sheetId}`, params)
}

const WORKORDER_NUMBER_FILTER_PARAM_PREFIXES: Record<string, string> = {
  workorder_id: 'workorder_id',
  facility_id: 'facility_id',
  condition_risk: 'condition_risk',
}

const WORKORDER_CATEGORY_FILTER_PARAMS: Record<string, string> = {
  submit_to: 'submit_to_filter',
  wo_closed_by: 'wo_closed_by_filter',
  critical_team_status: 'critical_team_status_filter',
}

const WORKORDER_DATE_FILTER_PARAM_PREFIXES: Record<string, string> = {
  project_start_date: 'project_start_date',
  inspection_complete_date: 'inspection_complete_date',
  report_complete_date: 'report_complete_date',
  wo_closed_date: 'wo_closed_date',
}

export function fetchCriticalTeamWorkorders(
  filters: CriticalTeamFilters,
  limit = 100,
  offset = 0,
  columnFilters: CriticalTeamWorkorderFilters = {},
  sort?: CriticalTeamWorkorderSort,
) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (sort?.sortBy) {
    params.set('sort_by', sort.sortBy)
    params.set('sort_dir', sort.sortDir)
  }
  if (filters.search.trim()) {
    params.set('search', filters.search.trim())
  }
  for (const submitter of filters.submitTo) {
    params.append('submit_to', submitter)
  }
  if (filters.closedBy) {
    params.set('closed_by', filters.closedBy)
  }
  for (const status of filters.statuses) {
    params.append('status', status)
  }
  for (const [column, filter] of Object.entries(columnFilters.numbers ?? {})) {
    const prefix = WORKORDER_NUMBER_FILTER_PARAM_PREFIXES[column]
    if (!prefix || !filter || filter.mode === 'any') {
      continue
    }
    params.set(`${prefix}_mode`, filter.mode)
    if (filter.from) {
      params.set(`${prefix}_from`, filter.from)
    }
    if (filter.to) {
      params.set(`${prefix}_to`, filter.to)
    }
  }
  for (const [column, values] of Object.entries(columnFilters.categories ?? {})) {
    const param = WORKORDER_CATEGORY_FILTER_PARAMS[column]
    if (!param) {
      continue
    }
    for (const value of values ?? []) {
      if (value) {
        params.append(param, value)
      }
    }
  }
  for (const [column, filter] of Object.entries(columnFilters.dates ?? {})) {
    const prefix = WORKORDER_DATE_FILTER_PARAM_PREFIXES[column]
    if (!prefix || !filter || filter.mode === 'any') {
      continue
    }
    params.set(`${prefix}_mode`, filter.mode)
    if (filter.from) {
      params.set(`${prefix}_from`, filter.from)
    }
    if (filter.to) {
      params.set(`${prefix}_to`, filter.to)
    }
  }

  return apiGet<CriticalTeamWorkordersResponse>('/api/critical-team/workorders', params)
}
