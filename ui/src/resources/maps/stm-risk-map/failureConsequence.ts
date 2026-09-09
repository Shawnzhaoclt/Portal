import { portalRequestJson } from "../../../desktop/request";

export type FailureAssetType = "pipe" | "structure" | "channel";
export type FailureDefectSource = "itpipes" | "cityworks" | "inventory" | "simulated";

export const DEFAULT_FAILURE_CONSEQUENCE_EXTENT_MILES = 0.2;
export const FAILURE_CONSEQUENCE_EXTENT_OPTIONS = Array.from(
  { length: 10 },
  (_, index) => Number(((index + 1) / 10).toFixed(1)),
);

export type FailureDefect = {
  id: string;
  source: FailureDefectSource;
  label: string;
  located: boolean;
  geometry: GeoJSON.Geometry | null;
  relative_depth: number | null;
  condition_risk: number | null;
  station_feet: number | null;
  zoi_radius_feet: number | null;
  metadata: Record<string, unknown>;
};

export type ImpactedFeature = {
  id: string;
  category: string;
  label: string;
  source_table: string;
  relationship: "direct" | "within_zoi" | "context";
  is_influenced: boolean;
  measurement_type: "area" | "length" | "point" | null;
  influenced_area_sqft: number | null;
  feature_area_sqft: number | null;
  influenced_length_feet: number | null;
  feature_length_feet: number | null;
  influenced_percent: number | null;
  /** True when the map extent cut the feature, so `geometry` is not its full outline. */
  extends_beyond_extent: boolean;
  geometry: GeoJSON.Geometry;
  influenced_geometry: GeoJSON.Geometry | null;
  attributes: Record<string, unknown>;
};

export type FailureCutawayTerrain = {
  center: [number, number];
  width_feet: number;
  height_feet: number;
  columns: number;
  rows: number;
  elevations: number[];
  minimum_elevation: number;
  maximum_elevation: number;
  base_elevation: number;
  nodata_cells_filled: number;
  dem_file: string;
  asset_geometry: GeoJSON.Geometry;
  bounds_geometry: GeoJSON.Geometry;
  soil_layers_schematic: boolean;
};

export type FailureConsequenceResult = {
  ok: boolean;
  asset: Record<string, unknown> & {
    asset_id: string;
    asset_type: FailureAssetType;
    geometry: GeoJSON.Geometry;
    orientation: string;
  };
  defects: FailureDefect[];
  active_defect_id: string | null;
  cutaway: FailureCutawayTerrain | null;
  analysis: null | {
    scenario_id: string;
    zoi_radius_feet: number;
    minimum_zoi_radius_feet: number;
    maximum_zoi_radius_feet: number;
    zoi_geometry: GeoJSON.Geometry;
    scenario_zoi_geometry: GeoJSON.Geometry | null;
    influence_footprint_geometry: GeoJSON.Geometry | null;
    display_extent_geometry: GeoJSON.Geometry;
    display_extent_miles: number;
    clip_basis: "map_extent";
    impacted_features: ImpactedFeature[];
    counts: Record<string, number>;
    total_impacted: number;
    total_context: number;
  };
  method: {
    zoi_formula: string;
    context_clip: string;
    latest_itpipes_only: boolean;
    latest_cityworks_only: boolean;
    fallback_to_older_inspections: boolean;
    screening_only: boolean;
  };
  warnings: string[];
  elapsed_ms: number;
};

export type FailureScenario =
  | { source: "itpipes" | "cityworks" | "inventory"; id: string }
  | {
      source: "simulated";
      id?: "simulated";
      coordinates: [number, number];
      condition_risk?: number | null;
    };

/** One row of the inspection under review, stationed along the pipe by the analysis. */
export type ReviewedObservation = {
  mlo_id: string;
  label: string;
  distance_feet: number | null;
  condition_risk?: number | null;
  origin?: string;
};

type FailureConsequenceRequestOptions = {
  scenario?: FailureScenario;
  signal?: AbortSignal;
  reviewed?: { observations: ReviewedObservation[]; inspection_direction: string | null };
  extentMiles?: number;
};

export async function fetchFailureConsequence(
  assetId: string,
  assetType: FailureAssetType,
  options: FailureConsequenceRequestOptions = {},
): Promise<FailureConsequenceResult> {
  const {
    scenario,
    signal,
    reviewed,
    extentMiles = DEFAULT_FAILURE_CONSEQUENCE_EXTENT_MILES,
  } = options;
  return portalRequestJson<FailureConsequenceResult>("/api/map/failure-consequence", {
    method: "POST",
    body: JSON.stringify({
      asset_id: assetId,
      asset_type: assetType,
      scenario,
      extent_miles: extentMiles,
      ...reviewed,
    }),
    signal,
  });
}
