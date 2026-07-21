export type CellValue = string | number | boolean | null

export type AssetRow = {
  [key: string]: CellValue
}

export type DataSourceInfo = {
  tableName: string
  sourceFile: string
  rowCount: number
  importedAtUtc: string
}

export type CriticalAssetDataset = {
  generatedAtUtc: string
  worksheets: string[]
  dataSources: DataSourceInfo[]
  tables: {
    multiple: AssetRow[]
    pipes: AssetRow[]
    structures: AssetRow[]
  }
}

export type RiskMetric = 'RISK' | 'COND_RISK' | 'FLOOD_RISK' | 'CLOG_RISK'

export type SourceKey = 'both' | 'pipes' | 'structures'

export type MetricKey = 'risk' | 'condition' | 'flood' | 'clog'

export type BooleanFilterValue = 'all' | 'true' | 'false'

export type RangeFilter = {
  min: string
  max: string
}

export type DateRangeFilter = {
  from: string
  to: string
}

export type TableColumnFilters = {
  numeric: Record<string, RangeFilter>
  dates: Record<string, DateRangeFilter>
  text: Record<string, string>
  multi: Record<string, string[]>
}

export type FilterState = {
  search: string
  facilityId: string
  assetId: string
  inspectionCount: string
  inspectionDate: string
  material: string[]
  streetWater: BooleanFilterValue
  mostRecent: BooleanFilterValue
  numeric: Record<string, RangeFilter>
  flags: Record<string, BooleanFilterValue>
}

export type SourceSummary = {
  row_count: number
  facility_count: number
  asset_count: number
  avg_risk?: number | null
  avg_condition?: number | null
  avg_flood?: number | null
  avg_clog?: number | null
}

export type SummaryResponse = {
  sources: Record<SourceKey, SourceSummary>
}

export type SourceResponse = {
  database: string
  data_sources: Array<{
    table_name: string
    source_file: string
    row_count: number
    imported_at_utc: string
  }>
  tables: Record<
    SourceKey,
    {
      table_name: string
      row_count: number
      columns: Array<{ name: string; data_type: string; ordinal_position: number }>
    }
  >
  metrics: Record<MetricKey, string>
  pipe_flags: string[]
}

export type FilterOptionsResponse = {
  sources: Record<
    SourceKey,
    {
      facility_ids: CellValue[]
      asset_ids: CellValue[]
      inspection_counts: CellValue[]
      inspection_dates: string[]
      materials: CellValue[]
      street_water: CellValue[]
      numeric_ranges?: Record<string, { min: number | null; max: number | null }>
      date_ranges?: Record<string, { min: string | null; max: string | null }>
      checklist_values?: Record<string, CellValue[]>
    }
  >
  numeric_filters: Record<string, string>
  pipe_flags: string[]
}

export type AggregateRow = {
  facility_id: string
  row_count: number
  avg_value: number | null
  median_value: number | null
  max_value: number | null
  sum_value: number | null
  avg_percent_consumed: number | null
  avg_pipe_size: number | null
  inspection_count: number | null
}

export type AggregatesResponse = {
  source: SourceKey
  metric: MetricKey
  rows: AggregateRow[]
}

export type HistoryResponse = {
  source: SourceKey
  columns: string[]
  rows: AssetRow[]
}

export type TableResponse = {
  source: SourceKey
  columns: string[]
  total: number
  limit: number
  offset: number
  rows: AssetRow[]
}

