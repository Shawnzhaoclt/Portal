export type CellValue = string | number | boolean | null

export type AssetRow = {
  [key: string]: CellValue
}

export type CriticalTeamSheetKind = 'chart' | 'table'

export type CriticalTeamSheetConfig = {
  title: string
  kind: CriticalTeamSheetKind
  date_key: string
  group_column: 'submit_to' | 'wo_closed_by'
  default_years: string[]
  default_statuses: string[]
  exclude_blank_group: boolean
}

export type CriticalTeamSourceResponse = {
  database: string
  metadata: {
    workbook: string
    source_server: string
    source_database: string
    source_tables: string
    row_count: number
    imported_at_utc: string
  }
  columns: Array<{ name: string; data_type: string; ordinal_position: number }>
  sheets: Record<string, CriticalTeamSheetConfig>
}

export type CriticalTeamSummaryResponse = {
  row_count: number
  workorder_count: number
  project_started: number
  inspections_completed: number
  reports_completed: number
  workorders_closed: number
  ready_for_review: number
  review_complete: number
}

export type CriticalTeamOverviewPoint = {
  month_start: string
  month_label: string
  count_value: number
}

export type CriticalTeamOverviewSeries = {
  key: string
  label: string
  color: string
  points: CriticalTeamOverviewPoint[]
}

export type CriticalTeamOverviewMetrics = {
  row_count: number
  workorder_count: number
  future_inspection_scheduled: number
  inspection_in_progress: number
  on_hold: number
  ready_for_review: number
  revisions_required: number
  review_complete: number
}

export type CriticalTeamOverviewResponse = {
  filters: {
    date_from: string
    date_to: string
  }
  metrics: CriticalTeamOverviewMetrics
  totals: {
    all_time_started_projects: number
    all_time_scheduled_inspections: number
    all_time_future_inspection_scheduled: number
    all_time_inspection_in_progress: number
    all_time_on_hold: number
    all_time_ready_for_review: number
    all_time_revisions_required: number
    all_time_review_complete: number
  }
  series: CriticalTeamOverviewSeries[]
}

export type CriticalTeamFilterOptionsResponse = {
  submit_to: string[]
  wo_closed_by: string[]
  critical_team_status: string[]
  years: Record<string, string[]>
}

export type CriticalTeamSheetRow = {
  month_start: string | null
  month_label: string
  group_name: string
  count_value: number
}

export type CriticalTeamSheetResponse = {
  sheet_id: string
  sheet: CriticalTeamSheetConfig
  rows: CriticalTeamSheetRow[]
}

export type CriticalTeamWorkordersResponse = {
  total: number
  limit: number
  offset: number
  rows: AssetRow[]
}
