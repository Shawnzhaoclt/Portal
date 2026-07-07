import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

export type Bounds = [number, number, number, number];

export type ManifestMap = {
  id: string;
  name: string;
  style: string;
  style_layer_count?: number;
  source_layer_count?: number;
  label_layer_count?: number;
};

export type Manifest = {
  default_map_id?: string;
  style_filename?: string;
  view?: {
    bounds?: Bounds;
    protected_bounds?: Bounds;
    min_zoom?: number;
    minimum_scale?: number;
    padding?: number;
  };
  maps: ManifestMap[];
};

export type ViewConfig = {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  bounds?: Bounds;
  protectedBounds?: Bounds;
  minZoom?: number;
  padding?: number;
  minimumScale?: number;
};

export type MapStyle = StyleSpecification & {
  metadata?: {
    source_layer_count?: number;
    aprx_map?: string;
    [key: string]: unknown;
  };
};

export type LayerMetadata = {
  aprx_layer?: string;
  parent_group?: string;
  tile_source_layer?: string;
  class_label?: string;
  label_layer?: boolean;
  basemap_service?: boolean;
  effective_visible?: boolean;
  aprx_visible?: boolean;
  aprx_label_class_visible?: boolean;
  maplibre_label_available?: boolean;
  maplibre_label_visible?: boolean;
  [key: string]: unknown;
};

export type StyleLayer = LayerSpecification & {
  metadata?: LayerMetadata;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  "source-layer"?: string;
};

export type Metrics = {
  styleLayers: number;
  sourceLayers: number;
  activeLayers: number;
  visibleLabels: number;
  renderedFeatures: number;
  labelLayers: number;
};

export type SelectedFeature = {
  layerLabel: string;
  layerType: string;
  properties: Array<[string, string]>;
};

export type AssetSearchResult = {
  id: string;
  feature_id: number;
  dataset_id: string;
  table_name: string;
  layer_name: string;
  kind: string;
  label: string;
  subtitle: string;
  match_field: string;
  match_value: string;
  score: number;
  geometry_type: string;
  geometry?: {
    type: string;
    coordinates?: unknown;
    geometries?: unknown;
  } | null;
  bbox?: Bounds | null;
  properties: Record<string, unknown>;
};

export type AssetSearchResponse = {
  query: string;
  database_exists: boolean;
  results: AssetSearchResult[];
  returned: number;
  message?: string;
};

export type InventoryMetric = {
  id: string;
  label: string;
  unit: string;
  precision: number;
  total: number;
  visible_extent: number;
  source_table: string;
};

export type InventoryMetricsResponse = {
  ok: boolean;
  generated_at: number;
  bbox: Bounds | null;
  metrics: InventoryMetric[];
};

export type DuckDbGeoJsonFeature = {
  type: "Feature";
  id?: string | number;
  geometry: AssetSearchResult["geometry"];
  properties: Record<string, unknown>;
};

export type DuckDbGeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: DuckDbGeoJsonFeature[];
  metadata?: Record<string, unknown>;
};

export type AttributeFilterOperator =
  | "eq"
  | "ne"
  | "contains"
  | "starts_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_null"
  | "is_not_null";

export type AttributeFilterFieldType = "number" | "text" | "date";

export type AttributeFilterField = {
  name: string;
  type: AttributeFilterFieldType;
  data_type?: string;
};

export type AttributeFilterRule = {
  id: string;
  field: string;
  operator: AttributeFilterOperator;
  value: string;
};

export type AttributeFilterPayload = Record<string, AttributeFilterRule[]>;

export type AttributeFilterFieldsResponse = {
  ok: boolean;
  target_id: string;
  fields: AttributeFilterField[];
  message?: string;
};

export type RiskSortType = "total" | "condition" | "flood" | "clog";
export type RiskLayerGroup = "cityworks" | "itpipes";
export type RiskLayerSelection = Record<RiskLayerGroup, string>;

export type RiskTopListItem = {
  rank: number;
  id: string;
  feature_id: number;
  dataset_id: string;
  layer_id: string;
  layer_label: string;
  risk_score: number;
  risk_field: string;
  title: string;
  subtitle: string;
  geometry_type: string;
  geometry?: AssetSearchResult["geometry"] | null;
  bbox?: Bounds | null;
  properties: Record<string, unknown>;
};

export type RiskTopList = {
  id: string;
  label: string;
  dataset_id: string;
  risk_field: string;
  items: RiskTopListItem[];
};

export type RiskTopListResponse = {
  ok: boolean;
  generated_at?: number;
  risk: RiskSortType;
  risk_field: string;
  bbox: Bounds | null;
  lists: RiskTopList[];
  message?: string;
};

export type RiskHistogramBin = {
  label: string;
  start: number;
  end: number;
  count: number;
};

export type RiskHistogram = {
  id: string;
  label: string;
  dataset_id: string;
  risk_field: string;
  total: number;
  out_of_range: number;
  bins: RiskHistogramBin[];
};

export type RiskHistogramResponse = {
  ok: boolean;
  generated_at?: number;
  risk: RiskSortType;
  risk_field: string;
  bbox: Bounds | null;
  histograms: RiskHistogram[];
  message?: string;
};
