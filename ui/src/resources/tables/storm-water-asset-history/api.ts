import { portalRequestJson } from '../../../desktop/request'
import { downloadPortalFile } from '../../../lib/fileDownload'

const ROOT = '/api/tables/storm-water-asset-history'

export type AssetType = 'structure' | 'pipe' | 'channel'
export type HistoryKind = 'timeline' | 'service_requests' | 'investigations' | 'inspections' | 'work_orders' | 'itpipes_defects' | 'pipe_risk'

export type AssetCandidate = {
  asset_id: string
  asset_type: AssetType
  label: string
  subtitle: string
  status?: unknown
}

export type AssignmentState = 'assigned' | 'unassigned' | 'mixed' | 'not_evaluated' | 'data_issue' | 'data_unavailable'

export type AssetSummaryResponse = {
  asset: {
    asset_id: string
    asset_type: AssetType
    entity_type: string
    status?: unknown
    summary: Record<string, unknown>
    all_fields: Record<string, unknown>
  }
  assignment: {
    combined: AssignmentState
    branches: Record<string, { state: string; context: Record<string, string[]> }>
    source_id: string
    version: string
    published_at?: string | null
  }
  counts: Record<HistoryKind, number>
  sources: Record<string, { source_id: string; available: boolean; version: string; published_at?: string | null }>
  errors?: Record<string, string>
}

export type HistoryRecord = {
  kind: 'service_request' | 'investigation' | 'inspection' | 'work_order'
  record_id: string
  event_date?: string | null
  status?: string | null
  priority?: string | null
  title?: string | null
  summary?: string | null
  person?: string | null
  relationship: string
  related_id?: string
  source_url?: string | null
  condition_risk?: number | null
  flood_risk?: number | null
  clogging_risk?: number | null
  risk?: number | null
  event_name?: string
  event_field?: string
  event_key?: string
}

export type ITPipesDefectRecord = {
  kind: 'itpipes_defect'
  record_id: string
  asset_id: string
  production_asset_id?: string
  mli_id: string
  mlo_id: string
  ml_id: string
  inspection_date?: string | null
  inspection_direction?: string | null
  is_continuous?: boolean | null
  observation_text?: string | null
  distance?: number | null
  relative_depth?: number | null
  condition_risk?: number | null
  flood_risk?: number | null
  clogging_risk?: number | null
  risk?: number | null
}

export type PipeRiskRecord = {
  kind: 'pipe_risk'
  record_id: string
  asset_id: string
  basin_name?: string | null
  work_zone_id?: string | null
  cl_score?: number | null
  lof_score?: number | null
  cof_score?: number | null
  risk?: number | null
}

export type AssetHistoryRecord = HistoryRecord | ITPipesDefectRecord | PipeRiskRecord

export type RecordsResponse = {
  kind: HistoryKind
  page: number
  page_size: number
  total: number
  record_total?: number
  items: AssetHistoryRecord[]
}

export type RecordDetail = {
  kind: string
  record_id: string
  fields: Record<string, unknown>
  questions: Array<Record<string, unknown>>
  source_url?: string | null
}

export type ExportField = { key: string; label: string }
export type ExportFieldCatalog = { worksheets: Partial<Record<HistoryKind, ExportField[]>> }
export type ExportFieldSelection = Partial<Record<HistoryKind, string[]>>

export async function searchAssetCandidates(query: string) {
  return portalRequestJson<{ results: AssetCandidate[] }>(`${ROOT}/asset-candidates?query=${encodeURIComponent(query)}&limit=10`)
}

export async function loadAssetSummary(assetType: AssetType, assetId: string) {
  return portalRequestJson<AssetSummaryResponse>(`${ROOT}/assets/${assetType}/${encodeURIComponent(assetId)}/summary`)
}

export async function loadAssetRecords(assetType: AssetType, assetId: string, parameters: Record<string, string | number>) {
  const query = new URLSearchParams()
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== '') query.set(key, String(value))
  })
  return portalRequestJson<RecordsResponse>(`${ROOT}/assets/${assetType}/${encodeURIComponent(assetId)}/records?${query}`)
}

export async function loadRecordDetail(kind: string, recordId: string, workZoneId = '') {
  const query = new URLSearchParams()
  if (workZoneId) query.set('work_zone_id', workZoneId)
  const suffix = query.size ? `?${query}` : ''
  return portalRequestJson<RecordDetail>(`${ROOT}/records/${kind}/${encodeURIComponent(recordId)}${suffix}`)
}

export async function loadExportFields(assetType: AssetType, assetId: string) {
  return portalRequestJson<ExportFieldCatalog>(`${ROOT}/assets/${assetType}/${encodeURIComponent(assetId)}/export-fields`)
}

export async function exportAssetHistory(assetType: AssetType, assetId: string, parameters: Record<string, string>, fields: ExportFieldSelection = {}) {
  const query = new URLSearchParams(parameters)
  if (Object.keys(fields).length) query.set('additional_fields', JSON.stringify(fields))
  return downloadPortalFile(
    `${ROOT}/assets/${assetType}/${encodeURIComponent(assetId)}/export?${query}`,
    `Storm_Water_Asset_History_${assetId}.xlsx`,
  )
}
