import type { Feature, FeatureCollection, Geometry } from 'geojson'

export type GISLayerMeta = {
  id: string
  label: string
  table: string
  geometry_column: string
  geometry_type: string | null
  row_count: number
  bounds: [number, number, number, number] | null
  color: string
  property_columns: string[]
  renderers?: GISLayerRenderer[]
}

export type GISLayerRenderer = {
  field: string
  label: string
  source: string
  metric: string
  measure: string
}

export type GISLayersResponse = {
  database: string
  source_crs: string
  target_crs: string
  layers: GISLayerMeta[]
}

export type GISFeatureProperties = Record<string, string | number | boolean | null>

export type GISFeature = Feature<Geometry, GISFeatureProperties>

export type GISFeatureCollection = FeatureCollection<Geometry, GISFeatureProperties> & {
  metadata?: {
    layer_id: string
    label: string
    returned: number
    limit: number
    spatial_filter?: [number, number, number, number] | null
  }
}
