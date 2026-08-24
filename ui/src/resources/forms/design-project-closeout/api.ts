import { portalRequestBinary, portalRequestJson } from '../../../desktop/request'

const ROOT = '/api/forms/design-project-closeout'

export type CloseoutStatus = 'pending_review' | 'approved' | 'returned'

export type CloseoutAsset = {
  global_id?: string
  record_revision?: string
  asset_id: string
  construction_plan_id: string | null
  critical_facility_id: string | null
  flooding_design_standards: string | null
  flooding_impact: string | null
  flooding_service_eligibility: string | null
  post_project_asset_condition: string | null
  notes: string | null
  sort_order?: number
}

export type CloseoutProject = {
  global_id: string
  record_revision: string
  display_key: string
  project_name: string | null
  status: CloseoutStatus
  source_of_analysis: string | null
  date_of_analysis: string | null
  cityworks_wo_id: string | null
  intake_method: string | null
  submitted_at: string | null
  submitted_by: string | null
  submitted_by_user_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  review_memo: string | null
  updated_at: string | null
  asset_count?: number
}

export type CloseoutProjectList = {
  rows: CloseoutProject[]
  status_counts: Record<CloseoutStatus, number>
  can_create: boolean
  can_submit: boolean
  can_review: boolean
  can_delete: boolean
}

export type CloseoutProjectDetail = {
  project: CloseoutProject
  assets: CloseoutAsset[]
  can_edit: boolean
  can_delete: boolean
  can_review: boolean
}

export type CloseoutAssetInput = {
  asset_id: string
  construction_plan_id: string | null
  critical_facility_id: string | null
  flooding_design_standards: string
  flooding_impact: string
  flooding_service_eligibility: string
  post_project_asset_condition: string | null
  notes: string | null
}

export type CloseoutProjectInput = {
  project_name: string | null
  cityworks_wo_id: string | null
  source_of_analysis: string
  date_of_analysis: string
  intake_method: 'manual' | 'excel' | 'cityworks'
  assets: CloseoutAssetInput[]
}

export type CloseoutImportSummary = {
  file_name: string
  row_count: number
  project_count: number
  errors: string[]
  imported: boolean
}

export type CityworksWorkorder = {
  workorder_id: string
  description: string | null
  project_name: string | null
  status: string | null
  date_wo_closed: string | null
  storm_asset_count: number
}

export type CityworksWorkorderAssets = {
  workorder: { workorder_id: string; description: string | null; project_name: string | null; actual_finish: string | null }
  assets: { asset_id: string; entity_type: string }[]
}

export function fetchCloseoutProjects(status?: CloseoutStatus, search?: string) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (search) params.set('search', search)
  params.set('limit', '200')
  const suffix = params.size ? `?${params.toString()}` : ''
  return portalRequestJson<CloseoutProjectList>(`${ROOT}/projects${suffix}`)
}

export function fetchCloseoutProject(globalId: string) {
  return portalRequestJson<CloseoutProjectDetail>(`${ROOT}/projects/${encodeURIComponent(globalId)}`)
}

export function createCloseoutProject(payload: CloseoutProjectInput) {
  return portalRequestJson<{ project: CloseoutProject }>(`${ROOT}/projects`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateCloseoutProject(globalId: string, payload: CloseoutProjectInput & { record_revision: string }) {
  return portalRequestJson<{ project: CloseoutProject }>(`${ROOT}/projects/${encodeURIComponent(globalId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function reviewCloseoutProject(
  globalId: string,
  action: 'approve' | 'return',
  recordRevision: string,
  memo: string | null,
) {
  return portalRequestJson<{ project: CloseoutProject }>(
    `${ROOT}/projects/${encodeURIComponent(globalId)}/review`,
    { method: 'POST', body: JSON.stringify({ action, record_revision: recordRevision, memo }) },
  )
}

export function deleteCloseoutProject(globalId: string, recordRevision: string) {
  return portalRequestJson<{ ok: boolean }>(`${ROOT}/projects/${encodeURIComponent(globalId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ record_revision: recordRevision }),
  })
}

export type CloseoutBatchResult = {
  reviewed?: number
  deleted?: number
  action?: 'approve' | 'return'
  skipped: { global_id: string; reason: string }[]
}

export function batchReviewCloseoutProjects(action: 'approve' | 'return', globalIds: string[], memo: string | null) {
  return portalRequestJson<CloseoutBatchResult>(`${ROOT}/projects/batch-review`, {
    method: 'POST',
    body: JSON.stringify({ action, global_ids: globalIds, memo }),
  })
}

export function batchDeleteCloseoutProjects(globalIds: string[]) {
  return portalRequestJson<CloseoutBatchResult>(`${ROOT}/projects/batch-delete`, {
    method: 'POST',
    body: JSON.stringify({ global_ids: globalIds }),
  })
}

export function fetchCloseoutEvents(globalId: string) {
  return portalRequestJson<{ events: Record<string, unknown>[] }>(
    `${ROOT}/projects/${encodeURIComponent(globalId)}/events`,
  )
}

export function importCloseoutExcel(payload: {
  file_name: string
  file_base64: string
  dry_run: boolean
  approve_immediately: boolean
}) {
  return portalRequestJson<CloseoutImportSummary>(`${ROOT}/import-excel`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function searchCityworksWorkorders(query: { search?: string; closed_since?: string }) {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.closed_since) params.set('closed_since', query.closed_since)
  return portalRequestJson<{
    cutoff: string | null
    rows: CityworksWorkorder[]
    workorder_url_template: string | null
  }>(
    `${ROOT}/cityworks/workorders?${params}`,
  )
}

export type CloseoutAttachmentCandidate = {
  image_path: string
  file_name: string
  title: string | null
  attached_by: string | null
  attached_at: string | null
  eligible: boolean
  reason: string
}

export type CloseoutAttachmentResult = {
  workorder_id: string
  candidates: CloseoutAttachmentCandidate[]
  selected: CloseoutAttachmentCandidate | null
  summary: CloseoutImportSummary | null
}

export function importWorkorderAttachment(workorderId: string, dryRun: boolean) {
  return portalRequestJson<CloseoutAttachmentResult>(
    `${ROOT}/cityworks/workorders/${encodeURIComponent(workorderId)}/import-attachment`,
    { method: 'POST', body: JSON.stringify({ dry_run: dryRun }) },
  )
}

export function fetchCityworksWorkorderAssets(workorderId: string) {
  return portalRequestJson<CityworksWorkorderAssets>(
    `${ROOT}/cityworks/workorders/${encodeURIComponent(workorderId)}/assets`,
  )
}

export function exportCloseoutSelection(body: {
  status: CloseoutStatus | 'all'
  asset_keys?: string[]
  project_global_ids?: string[]
}) {
  return portalRequestBinary(`${ROOT}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type WorkorderCheck = {
  workorder_id: string
  exists: boolean
  checked: boolean
  reason?: string
  project_name?: string | null
}

export function checkCloseoutWorkorder(workorderId: string) {
  return portalRequestJson<WorkorderCheck>(
    `${ROOT}/cityworks/workorders/${encodeURIComponent(workorderId)}/exists`,
  )
}

export type CloseoutAssetCandidate = {
  asset_id: string
  asset_type: string | null
  subtitle: string | null
}

export function fetchCloseoutAssetCandidates(query: string) {
  const params = new URLSearchParams({ query, limit: '10' })
  return portalRequestJson<{ query: string; candidates: CloseoutAssetCandidate[] }>(
    `${ROOT}/asset-candidates?${params.toString()}`,
  )
}

export type CloseoutFlatRow = Record<string, string | null> & { Status: CloseoutStatus; project_global_id: string }

export function fetchCloseoutRows(status: CloseoutStatus | 'all') {
  return portalRequestJson<{
    headings: string[]
    rows: CloseoutFlatRow[]
    workorder_url_template: string | null
  }>(
    `${ROOT}/rows?status=${status}`,
  )
}
