import type {
  AmTeamObservationBatchResponse,
  AmTeamInspectionSearchResponse,
  AmTeamInspectionResponse,
  AmTeamObservationResponse,
  AmTeamPipeInspectionGroupResponse,
  AmTeamPipeSearchResponse,
} from './types'
import { portalDataUrl, portalRequestJson } from '../../desktop/request'
import { itpipesSessionCookie } from '../../desktop/runtime'

/** Which inputs an observation code actually uses, measured from real ITPipes data. */
export type ObservationCodeMetadata = {
  grade?: boolean
  value_percent?: boolean
  clock?: boolean
  joint?: boolean
  continuous?: boolean
  remarks?: boolean
  source_rows?: number
}

export type PortalDictionaryItem = {
  id: number
  item_code: string
  label: string
  sort_order: number
  is_active: boolean
  metadata?: ObservationCodeMetadata | null
}

export type PortalDictionaryItemsResponse = {
  dictionary: {
    dictionary_key: string
    name: string
    is_active: boolean
  }
  items: PortalDictionaryItem[]
}

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  return portalRequestJson<T>(`${path}${suffix}`)
}

export function fetchAmTeamPipes(search: string) {
  const params = new URLSearchParams()
  params.set('search', search)
  params.set('limit', '50')
  return apiGet<AmTeamPipeSearchResponse>('/api/amteam/pipes', params)
}

export function fetchAmTeamInspectionSearch(search: string) {
  const params = new URLSearchParams()
  params.set('search', search)
  params.set('limit', '500')
  return apiGet<AmTeamInspectionSearchResponse>('/api/amteam/inspection-search', params)
}

export function fetchAmTeamPipeGroups(search: string, kind?: string) {
  const params = new URLSearchParams()
  params.set('search', search)
  params.set('pipe_limit', '500')
  if (kind) {
    params.set('kind', kind)
  }
  return apiGet<AmTeamPipeInspectionGroupResponse>('/api/amteam/pipe-groups', params)
}

export function fetchAmTeamInspections(mlId: string) {
  return apiGet<AmTeamInspectionResponse>(`/api/amteam/pipes/${encodeURIComponent(mlId)}/inspections`)
}

export function fetchPortalDictionaryItems(dictionaryKey: string) {
  return apiGet<PortalDictionaryItemsResponse>(
    `/api/dictionaries/${encodeURIComponent(dictionaryKey)}/items`,
  )
}

/** One observation a reviewer records against an inspection, stored in stormwater.db. */
export type UserObservationRequest = {
  code: string
  observation_text: string
  distance: number
  digital_time_seconds: number | null
  grade: number | null
  value_percent: number | null
  clock_from: number | null
  clock_to: number | null
  joint: boolean | null
  remarks: string | null
  continuous: boolean
  finish_distance: number | null
  finish_time_seconds: number | null
}

export function createUserObservation(mliId: string, payload: UserObservationRequest) {
  return portalRequestJson<{ mli_id: string; rows: unknown[] }>(
    `/api/amteam/inspections/${encodeURIComponent(mliId)}/user-observations`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export function deleteUserObservation(mliId: string, mloId: string) {
  return portalRequestJson<{ mli_id: string; deleted: string[] }>(
    `/api/amteam/inspections/${encodeURIComponent(mliId)}/user-observations/${encodeURIComponent(mloId)}`,
    { method: 'DELETE' },
  )
}

export type ItpipesMediaEntry = {
  name: string
  kind: 'video' | 'picture' | 'report' | 'other'
  source_url: string
  url: string
}

export type ItpipesManifest = {
  connected: boolean
  reason?: string
  detail?: string
  mli_id?: string
  source_url?: string
  media: ItpipesMediaEntry[]
  counts?: Record<string, number>
}

/** Media elements report ITpipes load failures here; the viewer listens and
 * recovers - re-minting expired presigned URLs, or reopening sign-in when the
 * session itself has lapsed. A broadcast keeps the deeply nested video and
 * snapshot components free of recovery plumbing. */
const itpipesErrorListeners = new Set<() => void>()

export function onItpipesMediaError(listener: () => void) {
  itpipesErrorListeners.add(listener)
  return () => {
    itpipesErrorListeners.delete(listener)
  }
}

export function notifyItpipesMediaError(sourceUrl: string | null | undefined) {
  if (!sourceUrl || !sourceUrl.includes('/api/amteam/itpipes/media')) return
  for (const listener of [...itpipesErrorListeners]) listener()
}

/** Whether ITpipes still recognises this machine's session. Drives the sign-in gate. */
export async function checkItpipesSession(): Promise<{ connected: boolean; reason?: string }> {
  const cookie = await itpipesSessionCookie()
  if (!cookie) return { connected: false, reason: 'no_session' }
  return portalRequestJson<{ connected: boolean; reason?: string }>('/api/amteam/itpipes/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  })
}

/** Media for one inspection, fetched with the signed-in user's own session. */
export async function fetchItpipesMedia(mliId: string): Promise<ItpipesManifest> {
  const cookie = await itpipesSessionCookie()
  const manifest = await portalRequestJson<ItpipesManifest>('/api/amteam/itpipes/manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mli_id: mliId, cookie }),
  })
  return {
    ...manifest,
    media: (manifest.media ?? []).map((entry) => ({ ...entry, url: portalDataUrl(entry.url) })),
  }
}

function normalizeObservationResponse(response: AmTeamObservationResponse): AmTeamObservationResponse {
  const mapAsset = (asset: AmTeamObservationResponse['media']['snapshots'][number]) => ({
    ...asset,
    url: portalDataUrl(asset.url),
  })
  return {
    ...response,
    media: {
      ...response.media,
      snapshots: response.media.snapshots.map(mapAsset),
      videos: response.media.videos.map(mapAsset),
      reports: response.media.reports.map(mapAsset),
    },
    rows: response.rows.map((row) => ({
      ...row,
      image_url: row.image_url ? portalDataUrl(row.image_url) : null,
      image_urls: row.image_urls.map(portalDataUrl),
    })),
  }
}

export async function fetchAmTeamObservations(mliId: string) {
  const response = await apiGet<AmTeamObservationResponse>(
    `/api/amteam/inspections/${encodeURIComponent(mliId)}/observations`,
  )
  return normalizeObservationResponse(response)
}

export async function fetchAmTeamObservationsBatch(mliIds: string[]) {
  const uniqueIds = [...new Set(mliIds.map((value) => value.trim()).filter(Boolean))]
  if (!uniqueIds.length) return {} as Record<string, AmTeamObservationResponse>

  const params = new URLSearchParams()
  uniqueIds.forEach((mliId) => params.append('mli_id', mliId))
  const response = await apiGet<AmTeamObservationBatchResponse>('/api/amteam/inspections/observations', params)
  return Object.fromEntries(
    Object.entries(response.rows).map(([mliId, observationResponse]) => [
      mliId,
      normalizeObservationResponse(observationResponse),
    ]),
  )
}
