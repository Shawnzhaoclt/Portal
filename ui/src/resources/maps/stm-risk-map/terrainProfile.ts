import { portalRequestBinary, portalRequestJson } from "../../../desktop/request";
import { isDesktopRuntime, saveExportAs } from "../../../desktop/runtime";
import { downloadBytes } from "../../../lib/fileDownload";

export type TerrainProfileMode = "draw" | "pipe" | "drainage";
export type TerrainProfileCoordinate = [number, number];

export type TerrainProfileSample = {
  index: number;
  distance_feet: number;
  fraction: number;
  longitude: number;
  latitude: number;
  ground_elevation: number | null;
  asset_elevation: number | null;
  cover: number | null;
};

export type TerrainProfileEndpoint = {
  role: "start" | "end" | "upstream" | "downstream";
  label: string;
  elevation: number | null;
  longitude: number;
  latitude: number;
};

export type TerrainProfileDefect = {
  mlo_id: string;
  observation_text: string | null;
  source_distance_feet: number | null;
  profile_distance_feet: number | null;
  condition_risk: number;
  relative_depth: number | null;
  is_continuous: boolean | null;
  location_status: string;
};

export type TerrainProfileItpipes = {
  status: "ready" | "no_inspection" | "no_positive_defects" | "unavailable";
  message: string;
  inspection: {
    mli_id: string;
    ml_id: string;
    inspection_date: string | null;
    inspection_direction: string | number | null;
    inspection_direction_code: 0 | 1 | null;
    inspection_direction_label: string;
    production_asset_id: string;
  } | null;
  defects: TerrainProfileDefect[];
  located_count: number;
  unlocated_count: number;
  station_tolerance_feet?: number;
  risk_scale?: { minimum: number; maximum: number };
};

export type TerrainProfileResult = {
  ok: boolean;
  mode: TerrainProfileMode;
  asset: Record<string, unknown> | null;
  path: { type: "LineString"; coordinates: TerrainProfileCoordinate[] };
  samples: TerrainProfileSample[];
  sample_count: number;
  sample_interval_feet: number;
  statistics: {
    length_feet: number;
    ground_min: number | null;
    ground_max: number | null;
    ground_mean: number | null;
    ground_change: number | null;
    elevation_gain: number | null;
    elevation_loss: number | null;
    pipe_grade_percent: number | null;
    minimum_ground_to_invert: number | null;
  };
  endpoints: { start: TerrainProfileEndpoint; end: TerrainProfileEndpoint };
  itpipes: TerrainProfileItpipes | null;
  orientation: string;
  warnings: string[];
  dem: {
    source_id: string;
    file_name: string;
    version: string;
    crs: string;
    horizontal_units: string;
    vertical_units: string;
    resolution_feet: number;
    source_dataset: string;
  };
  elapsed_ms: number;
};

export type TerrainProfileRequest = {
  mode: TerrainProfileMode;
  geometry?: { type: "LineString"; coordinates: TerrainProfileCoordinate[] };
  asset_id?: string;
};

export function fetchTerrainProfile(payload: TerrainProfileRequest, signal?: AbortSignal) {
  return portalRequestJson<TerrainProfileResult>("/api/map/terrain-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function exportTerrainProfile(profile: TerrainProfileResult) {
  const response = await portalRequestBinary("/api/map/terrain-profile/export/excel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const fileName = `Storm_Water_Terrain_Profile_${stamp}.xlsx`;
  if (isDesktopRuntime()) {
    return saveExportAs(fileName, new Uint8Array(response.bytes), "excel", true);
  }
  return downloadBytes(response.bytes, response.mediaType, fileName, { openInExcel: true });
}

export async function exportTerrainProfileGraph(dataUrl: string) {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !dataUrl.slice(0, separator).toLowerCase().includes("image/jpeg")) {
    throw new Error("The terrain profile graph could not be encoded as a JPG image.");
  }
  const binary = window.atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const fileName = `Storm_Water_Terrain_Profile_Graph_${stamp}.jpg`;
  if (isDesktopRuntime()) return saveExportAs(fileName, bytes, "jpg", true);
  return downloadBytes(bytes, "image/jpeg", fileName);
}

export function reverseTerrainProfile(profile: TerrainProfileResult): TerrainProfileResult {
  const length = profile.statistics.length_feet;
  const samples = [...profile.samples].reverse().map((sample, index) => ({
    ...sample,
    index,
    distance_feet: round3(length - sample.distance_feet),
    fraction: round6(1 - sample.fraction),
  }));
  const groundChange = profile.statistics.ground_change;
  return {
    ...profile,
    path: { ...profile.path, coordinates: [...profile.path.coordinates].reverse() },
    samples,
    endpoints: { start: profile.endpoints.end, end: profile.endpoints.start },
    itpipes: profile.itpipes ? {
      ...profile.itpipes,
      defects: profile.itpipes.defects.map((defect) => ({
        ...defect,
        profile_distance_feet: defect.profile_distance_feet === null
          ? null
          : round3(length - defect.profile_distance_feet),
      })),
    } : null,
    orientation: profile.orientation.includes("reversed")
      ? profile.mode === "draw" ? "drawn" : "upstream_to_downstream"
      : profile.mode === "draw" ? "reversed_drawn" : "reversed_downstream_to_upstream",
    statistics: {
      ...profile.statistics,
      ground_change: groundChange === null ? null : round3(-groundChange),
      elevation_gain: profile.statistics.elevation_loss,
      elevation_loss: profile.statistics.elevation_gain,
    },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
