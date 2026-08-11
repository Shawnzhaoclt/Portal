import { portalRequestJson } from '../../../desktop/request'
import { downloadPortalFile } from '../../../lib/fileDownload'

export type AifStatus = 'pending' | 'ready_to_review' | 'completed'

export type AifActions = {
  can_view: boolean
  can_edit: boolean
  can_submit: boolean
  can_delete: boolean
  can_review: boolean
  can_reopen: boolean
}

export type AifRecord = {
  global_id: string
  record_revision: string
  conflict_state: string
  inspection_id: string
  entity_uid: string
  inspection_date: string | null
  inspected_by: string | null
  inspected_by_user_id: string | null
  date_closed: string | null
  closed_by: string | null
  closed_by_user_id: string | null
  initiated_by: string
  initiated_by_user_id: string
  date_initiated: string
  submitted_to: string | null
  submitted_to_user_id: string | null
  date_submitted: string | null
  status: AifStatus
  inspection_direction: number | null
  flooding_impact: string | null
  flooding_service_eligibility: string | null
  flooding_design_standards: string | null
  defect_severity: string | null
  defect_callout: string | null
  consequence_location: string | null
  consequence_location_zol: string | null
  service_eligibility: string | null
  defect_stationing: number | null
  limited_extensive: 'Limited' | 'Extensive' | null
  source_system: 'itpipes'
  source_mli_id: string
  source_mlo_id: string
  source_inspection_date: string | null
  updated_at: string
  updated_by: string
  updated_by_user_id: string
  active_source_mlo_id: string | null
  actions: AifActions
}

export type AifEditableFields = Pick<
  AifRecord,
  | 'inspection_direction'
  | 'flooding_impact'
  | 'flooding_service_eligibility'
  | 'flooding_design_standards'
  | 'defect_severity'
  | 'defect_callout'
  | 'consequence_location'
  | 'consequence_location_zol'
  | 'service_eligibility'
  | 'defect_stationing'
  | 'limited_extensive'
>

export type SourceInspection = {
  mli_id: string
  inspection_date: string | null
  inspection_direction: 0 | 1 | null
  observation_count: number
}

export type SourceObservation = {
  mlo_id: string
  mli_id: string
  inspection_direction: 0 | 1 | null
  us_asset_id: string | null
  ds_asset_id: string | null
  condition_risk: number | null
  flooding_impact: string | null
  flooding_service_eligibility: string | null
  flooding_design_standards: string | null
  service_eligibility: string | null
  consequence_location: string | null
  consequence_location_zol: string | null
  vcr_time: string | number | null
  stationing: number | null
}

export type InspectionHistory = {
  inspection_id: string
  inspection_date: string | null
  source: 'Cityworks' | 'Portal AIF'
  status: string | null
  actor: string | null
  global_id?: string
}

export type AssetSearchResponse = {
  asset_id: string
  inspections: SourceInspection[]
  history: InspectionHistory[]
  history_warning: string | null
}

export type AssetCandidateResponse = {
  query: string
  candidates: string[]
}

export type ObservationResponse = {
  asset_id: string
  inspection: SourceInspection
  source_inspection_date: string | null
  observations: SourceObservation[]
}

export type EnrichmentResponse = {
  observation: SourceObservation
  source_inspection_date: string | null
  enrichment: {
    available: boolean
    ambiguous: boolean
    message?: string
    limited_extensive?: 'Limited' | 'Extensive' | null
    defect_severity?: string | null
    defect_callout?: string | null
    clogging_evidence?: number | null
  }
}

export type RegisterFilters = {
  saved_view: string
  search: string
  status: string
  source_date_from: string
  source_date_to: string
  initiated_from: string
  initiated_to: string
  submitted_from: string
  submitted_to: string
  closed_from: string
  closed_to: string
  initiator_employee_id: string
  reviewer_employee_id: string
  defect_severity: string
}

export type RegisterResponse = {
  rows: AifRecord[]
  total: number
  status_counts: Record<AifStatus, number>
  next_cursor: string | null
  current_cursor: string | null
  can_create: boolean
  can_export: boolean
}

export type Reviewer = {
  employee_id: string
  display_name: string
  email: string
  is_direct_manager: boolean
}
export type AifEvent = {
  global_id: string
  event_type: string
  actor_user_id: string | null
  actor_name: string | null
  event_at: string
  from_status: string | null
  to_status: string | null
  memo: string | null
}

const ROOT = '/api/forms/create-aif-from-itpipes'

function query(filters: RegisterFilters, extra: Record<string, string>) {
  const params = new URLSearchParams(extra)
  Object.entries(filters).forEach(([key, value]) => value && params.set(key, value))
  return params.toString()
}

export function fetchAifs(filters: RegisterFilters, sort: string, direction: string, pageSize: number, cursor?: string | null) {
  const suffix = query(filters, { sort, direction, page_size: String(pageSize), ...(cursor ? { cursor } : {}) })
  return portalRequestJson<RegisterResponse>(`${ROOT}/aifs?${suffix}`)
}

export function fetchAif(globalId: string) {
  return portalRequestJson<{ aif: AifRecord }>(`${ROOT}/aifs/${encodeURIComponent(globalId)}`)
}

export function searchAifAsset(assetId: string) {
  return portalRequestJson<AssetSearchResponse>(`${ROOT}/assets/${encodeURIComponent(assetId)}`)
}

export function fetchAifAssetCandidates(query: string) {
  const params = new URLSearchParams({ query, limit: '10' })
  return portalRequestJson<AssetCandidateResponse>(`${ROOT}/asset-candidates?${params.toString()}`)
}

export function fetchAifObservations(assetId: string, mliId: string) {
  return portalRequestJson<ObservationResponse>(`${ROOT}/assets/${encodeURIComponent(assetId)}/inspections/${encodeURIComponent(mliId)}/observations`)
}

export function fetchAifEnrichment(assetId: string, mliId: string, mloId: string) {
  return portalRequestJson<EnrichmentResponse>(`${ROOT}/assets/${encodeURIComponent(assetId)}/inspections/${encodeURIComponent(mliId)}/observations/${encodeURIComponent(mloId)}/enrichment`)
}

export function createAif(payload: { asset_id: string; source_mli_id: string; source_mlo_id: string } & AifEditableFields) {
  return portalRequestJson<{ aif: AifRecord }>(`${ROOT}/aifs`, { method: 'POST', body: JSON.stringify(payload) })
}

export function saveAif(record: AifRecord, fields: AifEditableFields, memo?: string) {
  return portalRequestJson<{ aif: AifRecord }>(`${ROOT}/aifs/${encodeURIComponent(record.global_id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...fields, record_revision: record.record_revision, memo: memo || null }),
  })
}

export function deleteAif(record: AifRecord) {
  return portalRequestJson<{ ok: boolean; global_id: string; inspection_id: string; events_retained: boolean }>(
    `${ROOT}/aifs/${encodeURIComponent(record.global_id)}`,
    { method: 'DELETE', body: JSON.stringify({ record_revision: record.record_revision }) },
  )
}

export function fetchAifReviewers() {
  return portalRequestJson<{ reviewers: Reviewer[] }>(`${ROOT}/reviewers`)
}

export function submitAif(record: AifRecord, reviewerEmployeeId: string, memo: string, severityUnavailable: boolean, calloutUnavailable: boolean) {
  return portalRequestJson<{ aif: AifRecord }>(`${ROOT}/aifs/${encodeURIComponent(record.global_id)}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      record_revision: record.record_revision,
      reviewer_employee_id: reviewerEmployeeId,
      memo: memo || null,
      defect_severity_unavailable: severityUnavailable,
      defect_callout_unavailable: calloutUnavailable,
    }),
  })
}

export function transitionAif(record: AifRecord, action: 'return_to_edit' | 'complete' | 'reopen', memo: string) {
  return portalRequestJson<{ aif: AifRecord }>(`${ROOT}/aifs/${encodeURIComponent(record.global_id)}/workflow`, {
    method: 'POST',
    body: JSON.stringify({ record_revision: record.record_revision, action, memo: memo || null }),
  })
}

export function fetchAifEvents(globalId: string) {
  return portalRequestJson<{ events: AifEvent[] }>(`${ROOT}/aifs/${encodeURIComponent(globalId)}/events`)
}

export function exportAifRegister(filters: RegisterFilters, sort: string, direction: string) {
  return downloadPortalFile(`${ROOT}/export?${query(filters, { sort, direction })}`, 'Asset-Inspection-Form-Register.xlsx')
}
