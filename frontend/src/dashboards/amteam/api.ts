import type {
  AmTeamInspectionSearchResponse,
  AmTeamInspectionResponse,
  AmTeamObservationResponse,
  AmTeamPipeInspectionGroupResponse,
  AmTeamPipeSearchResponse,
} from './types'

async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const suffix = params && params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(`${path}${suffix}`)

  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const payload = await response.json()
      message = payload?.detail?.message ?? payload?.message ?? JSON.stringify(payload)
    } catch {
      message = await response.text()
    }
    throw new Error(message || `Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
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

export function fetchAmTeamObservations(mliId: string) {
  return apiGet<AmTeamObservationResponse>(`/api/amteam/inspections/${encodeURIComponent(mliId)}/observations`)
}
