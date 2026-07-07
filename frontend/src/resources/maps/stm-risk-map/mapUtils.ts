import maplibregl, { type LngLatBoundsLike, type Map as MapLibreMap } from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import type { Bounds, MapStyle, Manifest, StyleLayer, ViewConfig } from "./types";

const WEB_MERCATOR_SCALE_ZOOM_0 = 591657550.5;
const MAX_RENDER_PIXEL_RATIO = 1.5;
const DEFAULT_VIEW_NORTH_OFFSET_MILES = 1.25;
const LATITUDE_DEGREES_PER_MILE = 1 / 69;

export const DEFAULT_VIEW: ViewConfig = {
  center: [-80.8431, 35.2271],
  zoom: 10,
  pitch: 0,
  bearing: 0,
};

let protocolRegistered = false;

export function registerPmtilesProtocol(): void {
  if (protocolRegistered) {
    return;
  }
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

export class ScaleRatioControl {
  private map?: MapLibreMap;
  private container?: HTMLDivElement;
  private readonly update = () => {
    if (!this.map || !this.container) {
      return;
    }
    const center = this.map.getCenter();
    const denominator = scaleDenominator(center.lat, this.map.getZoom());
    this.container.textContent = `Scale 1:${formatScaleDenominator(denominator)}`;
  };

  onAdd(controlMap: MapLibreMap): HTMLElement {
    this.map = controlMap;
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl map-scale-ratio";
    this.map.on("move", this.update);
    this.map.on("zoom", this.update);
    this.update();
    return this.container;
  }

  onRemove(): void {
    this.map?.off("move", this.update);
    this.map = undefined;
    this.container?.remove();
    this.container = undefined;
  }
}

export function scaleDenominator(latitude: number, zoom: number): number {
  const latitudeFactor = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  return (WEB_MERCATOR_SCALE_ZOOM_0 * latitudeFactor) / 2 ** zoom;
}

export function formatScaleDenominator(value: number): string {
  return roundScaleDenominator(value).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

function roundScaleDenominator(value: number): number {
  if (value >= 1_000_000) {
    return Math.round(value / 10_000) * 10_000;
  }
  if (value >= 100_000) {
    return Math.round(value / 1_000) * 1_000;
  }
  if (value >= 10_000) {
    return Math.round(value / 100) * 100;
  }
  if (value >= 1_000) {
    return Math.round(value / 10) * 10;
  }
  return Math.max(1, Math.round(value));
}

export function viewFromManifest(manifest?: Manifest): ViewConfig | null {
  const view = manifest?.view || {};
  const manifestBounds = normalizeBounds(view.bounds);
  if (!manifestBounds) {
    return null;
  }
  const bounds = shiftBoundsNorth(manifestBounds, DEFAULT_VIEW_NORTH_OFFSET_MILES);
  const protectedBounds = normalizeBounds(view.protected_bounds);
  return {
    ...DEFAULT_VIEW,
    bounds,
    protectedBounds: protectedBounds ? shiftBoundsNorth(protectedBounds, DEFAULT_VIEW_NORTH_OFFSET_MILES) : bounds,
    minZoom: numberOrUndefined(view.min_zoom),
    padding: numberOrUndefined(view.padding) ?? 24,
    minimumScale: numberOrUndefined(view.minimum_scale),
  };
}

export async function viewFromPmtiles(style: MapStyle): Promise<ViewConfig> {
  const sourceUrl = Object.values(style.sources || {}).find((source) => {
    return source?.type === "vector" && "url" in source && source.url?.startsWith("pmtiles://");
  });
  const url = sourceUrl && "url" in sourceUrl ? sourceUrl.url : "";
  if (!url) {
    return DEFAULT_VIEW;
  }
  try {
    const header = await new PMTiles(url.slice("pmtiles://".length)).getHeader();
    if (Number.isFinite(header.centerLon) && Number.isFinite(header.centerLat)) {
      return {
        ...DEFAULT_VIEW,
        center: [header.centerLon, header.centerLat],
        zoom: Math.min(Number.isFinite(header.centerZoom) ? header.centerZoom : DEFAULT_VIEW.zoom, 11),
      };
    }
  } catch (error) {
    console.warn("Could not read PMTiles header.", error);
  }
  return DEFAULT_VIEW;
}

export function mapOptionsForView(view: ViewConfig, baseOptions: maplibregl.MapOptions): maplibregl.MapOptions {
  const options: maplibregl.MapOptions = {
    ...baseOptions,
    pitch: view.pitch,
    bearing: view.bearing,
    collectResourceTiming: false,
    refreshExpiredTiles: false,
    pixelRatio: renderPixelRatio(),
    canvasContextAttributes: {
      antialias: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    },
  };
  if (Number.isFinite(view.minZoom)) {
    options.minZoom = view.minZoom;
  }
  if (validBounds(view.bounds)) {
    options.bounds = boundsToLngLatBounds(view.bounds);
    options.fitBoundsOptions = { padding: viewPadding(view), duration: 0 };
  } else {
    options.center = view.center;
    options.zoom = view.zoom;
  }
  return options;
}

function renderPixelRatio(): number {
  if (typeof window === "undefined") {
    return 1;
  }
  return Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO);
}

export function applyView(map: MapLibreMap, view: ViewConfig, duration = 0): void {
  if (validBounds(view.bounds)) {
    map.fitBounds(boundsToLngLatBounds(view.bounds), {
      padding: viewPadding(view),
      duration,
    });
    return;
  }
  map.easeTo({
    center: view.center,
    zoom: Math.max(view.zoom, Number.isFinite(view.minZoom) ? view.minZoom || view.zoom : view.zoom),
    pitch: view.pitch,
    bearing: view.bearing,
    duration,
  });
}

export function boundsToLngLatBounds(bounds: Bounds): LngLatBoundsLike {
  return [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ];
}

export function validBounds(bounds?: Bounds): bounds is Bounds {
  return Boolean(
    bounds &&
      bounds.length === 4 &&
      bounds.every(Number.isFinite) &&
      bounds[0] < bounds[2] &&
      bounds[1] < bounds[3],
  );
}

export function normalizeBounds(bounds?: unknown): Bounds | undefined {
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    return undefined;
  }
  const normalized = bounds.map(Number) as Bounds;
  return validBounds(normalized) ? normalized : undefined;
}

function shiftBoundsNorth(bounds: Bounds, miles: number): Bounds {
  const latitudeOffset = miles * LATITUDE_DEGREES_PER_MILE;
  return [bounds[0], bounds[1] + latitudeOffset, bounds[2], bounds[3] + latitudeOffset];
}

export function viewPadding(view: ViewConfig): number {
  return Math.max(0, Number.isFinite(view.padding) ? Number(view.padding) : 24);
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function isBasemapLayer(layer: StyleLayer): boolean {
  return Boolean(layer.metadata?.basemap_service);
}

export function isLabelLayer(layer: StyleLayer): boolean {
  return Boolean(layer.metadata?.label_layer);
}

export function layerEnabledByStyle(layer: StyleLayer): boolean {
  return layer.metadata?.effective_visible !== false && layer.metadata?.aprx_visible !== false;
}

export function labelEnabledByStyle(layer: StyleLayer): boolean {
  return (
    layerEnabledByStyle(layer) &&
    layer.metadata?.aprx_label_class_visible !== false &&
    layer.metadata?.maplibre_label_visible !== false
  );
}

export function labelAvailableByStyle(layer: StyleLayer): boolean {
  return (
    layerEnabledByStyle(layer) &&
    layer.metadata?.aprx_label_class_visible !== false &&
    layer.metadata?.maplibre_label_available !== false
  );
}

export function layerDefaultVisible(layer: StyleLayer): boolean {
  return layer.layout?.visibility !== "none";
}

export function layerLabel(layer: StyleLayer): string {
  const aprxLayer = layer.metadata?.aprx_layer || layer.id;
  const leaf = String(aprxLayer).split("\\").pop() || layer.id;
  const classLabel = layer.metadata?.class_label;
  return classLabel ? `${leaf}: ${classLabel}` : leaf;
}

export function layerSubtitle(layer: StyleLayer): string {
  const sourceLayer = layer.metadata?.tile_source_layer || layer["source-layer"] || layer.type;
  return `${layer.type} / ${sourceLayer}`;
}

export function layerColor(layer: StyleLayer): string {
  if (typeof layer.metadata?.legend_color === "string") {
    return layer.metadata.legend_color;
  }
  const paint = layer.paint || {};
  const candidates = [
    paint["circle-color"],
    paint["circle-stroke-color"],
    paint["line-color"],
    paint["fill-color"],
    paint["fill-outline-color"],
    paint["text-color"],
    paint["text-halo-color"],
  ];
  for (const value of candidates) {
    const color = simpleColor(value);
    if (color) {
      return color;
    }
  }
  return "#71d7ff";
}

function simpleColor(value: unknown): string {
  if (typeof value === "string") {
    const color = value.trim();
    return /^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(color) && !isTransparentColor(color) ? color : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const color = simpleColor(item);
      if (color) {
        return color;
      }
    }
  }
  return "";
}

function isTransparentColor(color: string): boolean {
  if (/^transparent$/i.test(color)) {
    return true;
  }
  const rgbaMatch = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/i);
  if (rgbaMatch) {
    return Number(rgbaMatch[1]) <= 0;
  }
  const hslaMatch = color.match(/^hsla\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/i);
  if (hslaMatch) {
    return Number(hslaMatch[1]) <= 0;
  }
  return /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(color) && color.endsWith("00");
}
