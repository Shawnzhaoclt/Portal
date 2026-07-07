import type {
  AttributeFilterFieldsResponse,
  AssetSearchResponse,
  AttributeFilterPayload,
  Bounds,
  DuckDbGeoJsonFeatureCollection,
  InventoryMetricsResponse,
  Manifest,
  MapStyle,
  RiskLayerSelection,
  RiskHistogramResponse,
  RiskSortType,
  RiskTopListResponse,
} from "./types";

const API_BASE = String(import.meta.env.VITE_MAP_TILES_API_BASE || "").replace(/\/$/, "");

export async function fetchManifest(): Promise<Manifest> {
  return fetchJson<Manifest>(apiPath("/api/maplibre/manifest"));
}

export async function fetchMapStyle(stylePath: string): Promise<{ style: MapStyle; styleBase: URL }> {
  const styleUrl = new URL(apiPath(`/api/maplibre/styles/${stylePath}`), window.location.origin);
  const style = await fetchJson<MapStyle>(styleUrl.href);
  rewritePmtilesUrls(style, new URL(".", styleUrl));
  rewriteTileUrls(style, new URL(".", styleUrl));
  rewriteSpriteUrl(style, new URL(".", styleUrl));
  return { style, styleBase: new URL(".", styleUrl) };
}

export async function searchAssets(query: string, limit = 12): Promise<AssetSearchResponse> {
  const url = new URL(apiPath("/api/search/assets"), window.location.origin);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  return fetchJson<AssetSearchResponse>(url.href);
}

export async function fetchInventoryMetrics(bbox?: Bounds, filters?: AttributeFilterPayload): Promise<InventoryMetricsResponse> {
  const url = new URL(apiPath("/api/metrics/inventory"), window.location.origin);
  if (bbox) {
    const [west, south, east, north] = bbox;
    url.searchParams.set("west", String(west));
    url.searchParams.set("south", String(south));
    url.searchParams.set("east", String(east));
    url.searchParams.set("north", String(north));
  }
  appendAttributeFilters(url, filters);
  return fetchJson<InventoryMetricsResponse>(url.href);
}

export async function fetchDuckDbGeoJson(
  datasetId: string,
  bbox: Bounds,
  limit = 25000,
  filters?: AttributeFilterPayload,
): Promise<DuckDbGeoJsonFeatureCollection> {
  const url = new URL(apiPath(`/api/duckdb/geojson/${encodeURIComponent(datasetId)}`), window.location.origin);
  const [west, south, east, north] = bbox;
  url.searchParams.set("west", String(west));
  url.searchParams.set("south", String(south));
  url.searchParams.set("east", String(east));
  url.searchParams.set("north", String(north));
  url.searchParams.set("limit", String(limit));
  appendAttributeFilters(url, filters);
  return fetchJson<DuckDbGeoJsonFeatureCollection>(url.href);
}

export async function fetchAttributeFilterFields(targetId: string): Promise<AttributeFilterFieldsResponse> {
  const url = new URL(apiPath(`/api/filters/fields/${encodeURIComponent(targetId)}`), window.location.origin);
  return fetchJson<AttributeFilterFieldsResponse>(url.href);
}

export async function fetchRiskTopList(
  bbox: Bounds,
  risk: RiskSortType,
  layers: RiskLayerSelection,
  filters?: AttributeFilterPayload,
): Promise<RiskTopListResponse> {
  const url = new URL(apiPath("/api/risk/top-list"), window.location.origin);
  const [west, south, east, north] = bbox;
  url.searchParams.set("risk", risk);
  url.searchParams.set("cityworks_layer", layers.cityworks);
  url.searchParams.set("itpipes_layer", layers.itpipes);
  url.searchParams.set("west", String(west));
  url.searchParams.set("south", String(south));
  url.searchParams.set("east", String(east));
  url.searchParams.set("north", String(north));
  appendAttributeFilters(url, filters);
  url.searchParams.set("_ts", String(Date.now()));
  return fetchJson<RiskTopListResponse>(url.href);
}

export async function fetchRiskHistograms(
  bbox: Bounds,
  risk: RiskSortType,
  layers: RiskLayerSelection,
  filters?: AttributeFilterPayload,
): Promise<RiskHistogramResponse> {
  const url = new URL(apiPath("/api/risk/histograms"), window.location.origin);
  const [west, south, east, north] = bbox;
  url.searchParams.set("risk", risk);
  url.searchParams.set("cityworks_layer", layers.cityworks);
  url.searchParams.set("itpipes_layer", layers.itpipes);
  url.searchParams.set("west", String(west));
  url.searchParams.set("south", String(south));
  url.searchParams.set("east", String(east));
  url.searchParams.set("north", String(north));
  appendAttributeFilters(url, filters);
  url.searchParams.set("_ts", String(Date.now()));
  return fetchJson<RiskHistogramResponse>(url.href);
}

function appendAttributeFilters(url: URL, filters?: AttributeFilterPayload): void {
  if (!filters || !Object.keys(filters).length) {
    return;
  }
  url.searchParams.set("filters", JSON.stringify(filters));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json() as Promise<T>;
}

function apiPath(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

function apiOrigin(): string {
  if (API_BASE) {
    return API_BASE;
  }
  return typeof window === "undefined" ? "" : window.location.origin;
}

function rewritePmtilesUrls(style: MapStyle, styleBase: URL): void {
  Object.values(style.sources || {}).forEach((source) => {
    if (!source || !("url" in source) || !source.url?.startsWith("pmtiles://")) {
      return;
    }
    const innerUrl = source.url.slice("pmtiles://".length);
    const filename = innerUrl.split(/[\\/]/).pop() || "";
    const origin = apiOrigin();
    if (origin && filename.toLowerCase().endsWith(".pmtiles")) {
      source.url = `pmtiles://${origin}/api/pmtiles/${filename}`;
      return;
    }
    if (/^(https?:)?\/\//i.test(innerUrl) || /^[A-Za-z]:[\\/]/.test(innerUrl)) {
      return;
    }
    source.url = `pmtiles://${new URL(innerUrl, styleBase).href}`;
  });
}

function rewriteTileUrls(style: MapStyle, styleBase: URL): void {
  Object.values(style.sources || {}).forEach((source) => {
    if (!source || !("tiles" in source) || !Array.isArray(source.tiles)) {
      return;
    }
    source.tiles = source.tiles.map((tile) => {
      if (typeof tile !== "string") {
        return tile;
      }
      if (/^(https?:)?\/\//i.test(tile)) {
        return tile;
      }
      if (tile.startsWith("/api/")) {
        return apiOrigin() ? `${apiOrigin()}${tile}` : tile;
      }
      if (tile.startsWith("/")) {
        return `${window.location.origin}${tile}`;
      }
      return `${styleBase.href}${tile}`;
    });
  });
}

function rewriteSpriteUrl(style: MapStyle, styleBase: URL): void {
  const sprite = style.sprite;
  if (typeof sprite !== "string" || !sprite) {
    return;
  }
  if (/^(https?:)?\/\//i.test(sprite)) {
    return;
  }
  if (sprite.startsWith("/api/")) {
    style.sprite = apiOrigin() ? `${apiOrigin()}${sprite}` : sprite;
    return;
  }
  if (sprite.startsWith("/")) {
    style.sprite = `${window.location.origin}${sprite}`;
    return;
  }
  style.sprite = new URL(sprite, styleBase).href;
}
