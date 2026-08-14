import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

import { portalRequestBinary, portalRequestJson } from "../../../desktop/request";
import { isDesktopRuntime, saveExportAs } from "../../../desktop/runtime";
import { downloadBytes } from "../../../lib/fileDownload";

export type AssetExtractAssetType = "structure" | "pipe" | "channel";
export type AssetExtractAssignmentState = "assigned" | "unassigned" | "not_evaluated" | "data_unavailable";
export type AssetExtractFieldType = "text" | "number" | "date" | "boolean";
export type AssetExtractOperator = "eq" | "ne" | "contains" | "starts_with" | "gt" | "gte" | "lt" | "lte" | "is_null" | "is_not_null";

export type AssetExtractField = {
  name: string;
  label: string;
  type: AssetExtractFieldType;
  data_type: string;
  operators: AssetExtractOperator[];
  default: boolean;
  filterable: boolean;
};

export type AssetExtractTypeCatalog = {
  asset_type: AssetExtractAssetType;
  label: string;
  table: string;
  id_field: string;
  geometry_field: string;
  fields: AssetExtractField[];
  filter_fields: AssetExtractField[];
  default_fields: string[];
};

export type AssetExtractCatalog = {
  asset_types: Record<AssetExtractAssetType, AssetExtractTypeCatalog>;
  assignment_states: Array<{ value: AssetExtractAssignmentState; label: string }>;
  related_sections: Array<{ key: AssetExtractRelatedKey; label: string }>;
  boundary_sources: Array<{ id: string; label: string }>;
  limits: { preview: number; export: number };
};

export type AssetExtractBoundaryCandidate = {
  id: string;
  label: string;
  subtitle: string;
};

export type AssetExtractBoundaryGeometry = {
  source_id: string;
  feature_ids: string[];
  label: string;
  area: AssetExtractArea;
};

export type AssetExtractRelatedKey = "service_requests" | "investigations" | "inspections" | "work_orders" | "itpipes_defects" | "pipe_risk";

export type AssetExtractFilter = {
  id: string;
  field: string;
  operator: AssetExtractOperator;
  value: string;
};

export type AssetExtractArea = Feature<Polygon | MultiPolygon>;

export type AssetExtractPayload = {
  area: Polygon | MultiPolygon;
  asset_types: AssetExtractAssetType[];
  assignment_states: AssetExtractAssignmentState[];
  filters: Partial<Record<AssetExtractAssetType, AssetExtractFilter[]>>;
  fields: Partial<Record<AssetExtractAssetType, string[]>>;
  include_related: Record<AssetExtractRelatedKey, boolean>;
  related_mode: "all" | "most_recent";
};

export type AssetExtractPreview = FeatureCollection & {
  total: number;
  counts_by_type: Partial<Record<AssetExtractAssetType, number>>;
  counts_by_status: Partial<Record<AssetExtractAssignmentState, number>>;
  preview_limit: number;
  truncated: boolean;
  warnings: string[];
  assignment_source: { source_id: string; version?: string; published_at?: string | null };
};

export function fetchAssetExtractCatalog() {
  return portalRequestJson<AssetExtractCatalog>("/api/map/asset-data-extract/catalog");
}

export function searchAssetExtractBoundaries(sourceId: string, query: string) {
  const search = new URLSearchParams({ source_id: sourceId, q: query, limit: "10" });
  return portalRequestJson<{ source_id: string; items: AssetExtractBoundaryCandidate[]; limit: number }>(
    `/api/map/asset-data-extract/boundaries/search?${search.toString()}`,
  );
}

export function resolveAssetExtractBoundaries(sourceId: string, featureIds: string[]) {
  return portalRequestJson<AssetExtractBoundaryGeometry>("/api/map/asset-data-extract/boundaries/geometry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id: sourceId, feature_ids: featureIds }),
  });
}

export function previewAssetExtract(payload: AssetExtractPayload) {
  return portalRequestJson<AssetExtractPreview>("/api/map/asset-data-extract/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function exportAssetExtract(payload: AssetExtractPayload, format: "excel" | "geopackage") {
  const response = await portalRequestBinary(`/api/map/asset-data-extract/export/${format}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const fileName = format === "excel"
    ? `Storm_Water_Asset_Data_Extract_${stamp}.xlsx`
    : `Storm_Water_Asset_Data_Extract_${stamp}.gpkg`;
  if (isDesktopRuntime()) {
    return saveExportAs(fileName, new Uint8Array(response.bytes), format, format === "excel");
  }
  return downloadBytes(response.bytes, response.mediaType, fileName, { openInExcel: format === "excel" });
}
