import type { GISFeatureCollection, GISLayersResponse } from './types'
import { portalRequestJson } from '../../desktop/request'

async function apiGet<T>(path: string): Promise<T> {
  return portalRequestJson<T>(path)
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
