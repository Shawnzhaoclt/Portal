import type {
  AmTeamInspectionSearchResponse,
  AmTeamInspectionResponse,
  AmTeamObservationResponse,
  AmTeamPipeInspectionGroupResponse,
  AmTeamPipeSearchResponse,
} from './types'
import { portalDataUrl, portalRequestJson } from '../../desktop/request'

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

export async function fetchAmTeamObservations(mliId: string) {
  const response = await apiGet<AmTeamObservationResponse>(
    `/api/amteam/inspections/${encodeURIComponent(mliId)}/observations`,
  )
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
