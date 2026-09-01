import { portalRequestJson } from '../../../desktop/request'

export type RecordKind = 'service_request' | 'inspection' | 'investigation' | 'work_order'

export type RecordSummary = {
  kind: RecordKind
  kind_label: string
  id: string
  title: string
  status: string
  opened_at: string | null
  closed_at: string | null
  link_reason: string
  available: boolean
  cityworks_url: string | null
  subtitle?: string
}

export type RelatedAsset = {
  asset_id: string
  asset_type: string
  reached_by: string
}

export type RecordDetail = {
  record: RecordSummary
  fields: Record<string, unknown>
  assets: RelatedAsset[]
  related: RecordSummary[]
  counts: Record<string, number>
}

/** Cityworks names asset classes its own way. Portal holds three of them — the
 * ids already match (S_224321, P_133765, D_50278), so only the name is translated. */
export type PortalAssetType = 'structure' | 'pipe' | 'channel'

const PORTAL_ASSET_TYPES: Record<string, PortalAssetType> = {
  STRUCTURES: 'structure',
  PIPES: 'pipe',
  CHANNELS: 'channel',
}

export function portalAssetType(entityType: string): PortalAssetType | undefined {
  return PORTAL_ASSET_TYPES[entityType.trim().toUpperCase()]
}

const BASE = '/api/tables/work-management-lookup'

export async function searchRecords(query: string, limit = 10) {
  return portalRequestJson<{ query: string; matches: RecordSummary[] }>(
    `${BASE}/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  )
}

export async function resolveRecord(query: string) {
  return portalRequestJson<{ query: string; matches: RecordSummary[] }>(
    `${BASE}/resolve?query=${encodeURIComponent(query)}`,
  )
}

export async function fetchRecord(kind: RecordKind, id: string) {
  return portalRequestJson<RecordDetail>(`${BASE}/records/${kind}/${encodeURIComponent(id)}`)
}
