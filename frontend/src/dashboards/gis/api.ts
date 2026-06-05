import type { GISFeatureCollection, GISLayersResponse } from './types'

function defaultApiBaseUrl() {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8000'
  }
  return `${window.location.protocol}//${window.location.hostname}:8000`
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? defaultApiBaseUrl()

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function fetchGISLayers() {
  return apiGet<GISLayersResponse>('/api/gis/layers')
}

export type GISFeatureRequestOptions = {
  limit?: number
  bbox?: [number, number, number, number] | null
  history?: boolean
}

export function fetchGISLayerFeatures(layerId: string, options: GISFeatureRequestOptions | number = {}) {
  const limit = typeof options === 'number' ? options : options.limit ?? 1000
  const params = new URLSearchParams({ limit: String(limit) })
  const bbox = typeof options === 'number' ? null : options.bbox
  const history = typeof options === 'number' ? false : options.history
  if (history) {
    params.set('history', 'true')
  }
  if (bbox) {
    params.set('min_lng', String(bbox[0]))
    params.set('min_lat', String(bbox[1]))
    params.set('max_lng', String(bbox[2]))
    params.set('max_lat', String(bbox[3]))
  }
  return apiGet<GISFeatureCollection>(`/api/gis/layers/${encodeURIComponent(layerId)}/features?${params}`)
}
