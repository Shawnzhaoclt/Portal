import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import {
  AlertTriangle,
  Check,
  CircleDot,
  Crosshair,
  LoaderCircle,
  MapPinned,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import FailureConsequenceScene3D from "./FailureConsequenceScene3D";
import type { FailureConsequenceResult, FailureDefect, ImpactedFeature } from "./failureConsequence";
import { isBasemapLayer, isLabelLayer } from "./mapUtils";
import type { MapStyle, StyleLayer } from "./types";

type Props = {
  error: string;
  loading: boolean;
  open: boolean;
  result: FailureConsequenceResult | null;
  simulating: boolean;
  is3d: boolean;
  terrainStyle: MapStyle | null;
  activeBasemapId: "cltex" | "mecklenburg-aerial-2025";
  basemapEnabled: boolean;
  aerialBasemapUrl: string;
  onClose: () => void;
  onMapClick: (coordinates: [number, number]) => void;
  onMapReady: (map: MapLibreMap | null) => void;
  onSelectDefect: (defect: FailureDefect) => void;
  onSimulatingChange: (active: boolean) => void;
  onToggle3d: () => void;
};

type Tab = "summary" | "features" | "method";

const SOURCE_LABELS: Record<FailureDefect["source"], string> = {
  itpipes: "ITPipes observed",
  cityworks: "Cityworks observed",
  inventory: "Structure invert",
  simulated: "Simulated",
};

const EMPTY_MAP_CENTER: [number, number] = [-80.8431, 35.2271];
const FAILURE_CONSEQUENCE_SOURCE_ID = "failure-consequence-analysis";
const FAILURE_FEATURE_FLASH_DURATION_MS = 2_600;
const FAILURE_FEATURE_FLASH_LAYER_IDS = {
  fill: `${FAILURE_CONSEQUENCE_SOURCE_ID}-feature-flash-fill`,
  line: `${FAILURE_CONSEQUENCE_SOURCE_ID}-feature-flash-line`,
  point: `${FAILURE_CONSEQUENCE_SOURCE_ID}-feature-flash-point`,
} as const;

export default function FailureConsequencePanel({
  error,
  loading,
  open,
  result,
  simulating,
  is3d,
  terrainStyle,
  activeBasemapId,
  basemapEnabled,
  aerialBasemapUrl,
  onClose,
  onMapClick,
  onMapReady,
  onSelectDefect,
  onSimulatingChange,
  onToggle3d,
}: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const [basemapTextureUrl, setBasemapTextureUrl] = useState<string | null>(null);
  const [flashedFeatureId, setFlashedFeatureId] = useState<string | null>(null);
  const [flashToken, setFlashToken] = useState(0);
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const flashAnimationFrameRef = useRef<number | null>(null);
  const flashClearTimerRef = useRef<number | null>(null);
  const simulatingRef = useRef(simulating);
  const onMapClickRef = useRef(onMapClick);
  const onMapReadyRef = useRef(onMapReady);
  const minimalMap = useMemo(
    () => buildConsequenceMapStyle(terrainStyle, activeBasemapId, basemapEnabled, aerialBasemapUrl),
    [activeBasemapId, aerialBasemapUrl, basemapEnabled, terrainStyle],
  );
  const active = result?.defects.find((item) => item.id === result.active_defect_id) ?? null;
  const located = (result?.defects.filter((item) => item.located) ?? []).toSorted((left, right) => {
    const leftRisk = left.condition_risk ?? Number.NEGATIVE_INFINITY;
    const rightRisk = right.condition_risk ?? Number.NEGATIVE_INFINITY;
    return rightRisk - leftRisk;
  });
  const unlocated = result?.defects.filter((item) => !item.located) ?? [];
  const hasAnalysis = Boolean(result?.analysis);
  const hasImpactedFeatures = (result?.analysis?.total_impacted ?? 0) > 0;
  const influencedFeatures = useMemo(
    () => (result?.analysis?.impacted_features ?? []).filter((feature) => feature.is_influenced),
    [result?.analysis?.impacted_features],
  );
  const groupedFeatures = useMemo(() => {
    const groups = new Map<string, { label: string; category: string; count: number }>();
    for (const feature of influencedFeatures) {
      const current = groups.get(feature.category);
      if (current) current.count += 1;
      else groups.set(feature.category, { label: feature.label, category: feature.category, count: 1 });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [influencedFeatures]);
  const changeSimulationMode = (activeState: boolean) => {
    if (activeState && is3d) onToggle3d();
    onSimulatingChange(activeState);
  };
  const flashAffectedFeature = (featureId: string) => {
    setFlashedFeatureId(featureId);
    setFlashToken((value) => value + 1);
    if (flashClearTimerRef.current != null) window.clearTimeout(flashClearTimerRef.current);
    flashClearTimerRef.current = window.setTimeout(() => {
      setFlashedFeatureId(null);
      flashClearTimerRef.current = null;
    }, FAILURE_FEATURE_FLASH_DURATION_MS);
    if (!is3d && mapRef.current) {
      startAffectedFeatureFlash2d(mapRef.current, featureId, flashAnimationFrameRef);
    }
  };

  useEffect(() => {
    simulatingRef.current = simulating;
  }, [simulating]);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  useEffect(() => {
    if (!open || !mapNodeRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapNodeRef.current,
      style: minimalMap.style,
      center: EMPTY_MAP_CENTER,
      zoom: 11,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      renderWorldCopies: false,
      maxPitch: 70,
      canvasContextAttributes: {
        preserveDrawingBuffer: true,
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    const handleLoad = () => {
      onMapReadyRef.current(map);
      applyConsequenceMapMode(map, false, minimalMap.terrainSourceId, minimalMap.exaggeration, false);
    };
    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (!simulatingRef.current) return;
      onMapClickRef.current([event.lngLat.lng, event.lngLat.lat]);
    };
    map.on("load", handleLoad);
    map.on("click", handleClick);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => map.resize());
    resizeObserver?.observe(mapNodeRef.current);

    return () => {
      resizeObserver?.disconnect();
      map.off("load", handleLoad);
      map.off("click", handleClick);
      if (flashAnimationFrameRef.current != null) {
        window.cancelAnimationFrame(flashAnimationFrameRef.current);
        flashAnimationFrameRef.current = null;
      }
      onMapReadyRef.current(null);
      map.remove();
      mapRef.current = null;
    };
  }, [minimalMap.exaggeration, minimalMap.style, minimalMap.terrainSourceId, open]);

  useEffect(() => {
    if (!is3d || !result?.cutaway || !mapRef.current) {
      setBasemapTextureUrl(null);
      return;
    }
    const map = mapRef.current;
    let cancelled = false;
    const capture = async () => {
      const texture = await captureConsequenceBasemap(map, result.cutaway!.bounds_geometry);
      if (!cancelled) setBasemapTextureUrl(texture);
    };
    if (map.isStyleLoaded()) void capture();
    else map.once("load", capture);
    return () => {
      cancelled = true;
      map.off("load", capture);
    };
  }, [is3d, minimalMap.style, result?.cutaway]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = simulating ? "crosshair" : "grab";
  }, [simulating]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => () => {
    if (flashAnimationFrameRef.current != null) window.cancelAnimationFrame(flashAnimationFrameRef.current);
    if (flashClearTimerRef.current != null) window.clearTimeout(flashClearTimerRef.current);
  }, []);

  if (!open) return null;
  return (
    <div className="failure-consequence-backdrop" role="dialog" aria-modal="true" aria-label="Asset failure consequence analysis">
      <section className="failure-consequence-panel">
        <header className="failure-consequence-header">
          <div className="failure-consequence-title-icon"><ShieldAlert size={21} /></div>
          <div className="failure-consequence-title">
            <strong>Failure Consequence</strong>
            <span>Local DEM, selected asset, defects, zone of influence, and affected features</span>
          </div>
          <div className="failure-consequence-selected-asset">
            <span>Selected asset</span>
            <strong>{String(result?.asset.asset_id ?? "Loading…")}</strong>
          </div>
          <span className="failure-consequence-type">{String(result?.asset.asset_type ?? "asset")}</span>
          <div className="failure-consequence-mode-toggle" role="group" aria-label="Map dimension">
            <button type="button" className={!is3d ? "active" : ""} onClick={() => { if (is3d) onToggle3d(); }}>2D</button>
            <button type="button" className={is3d ? "active" : ""} onClick={() => { if (!is3d) onToggle3d(); }}>3D</button>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close consequence analysis"><X size={21} /></button>
        </header>

        <div className="failure-consequence-workspace">
          <div className="failure-consequence-map-shell">
            <div ref={mapNodeRef} className={`failure-consequence-map ${is3d ? "hidden" : ""}`} />
            {is3d ? (
              <FailureConsequenceScene3D
                result={result}
                basemapTextureUrl={basemapTextureUrl}
                flashedFeatureId={flashedFeatureId}
                flashToken={flashToken}
              />
            ) : null}
            {!is3d && !minimalMap.terrainSourceId ? <div className="failure-consequence-map-notice"><AlertTriangle size={16} />Local DEM terrain is unavailable.</div> : null}
            {!is3d && simulating ? <div className="failure-consequence-map-instruction"><Crosshair size={17} />Click the selected asset to place the simulated defect.</div> : null}
            {!is3d && !loading && !error && result && !hasAnalysis && !simulating ? (
              <div className="failure-consequence-map-empty" role="status">
                <span className="failure-consequence-map-empty-icon"><MapPinned size={22} /></span>
                <div>
                  <strong>No consequence area yet</strong>
                  <span>Place a simulated defect on the selected asset to calculate its ZOI and affected features.</span>
                </div>
                <button type="button" onClick={() => changeSimulationMode(true)}><Crosshair size={16} />Place defect</button>
              </div>
            ) : null}
            {!is3d && !loading && !error && hasAnalysis && !hasImpactedFeatures ? (
              <div className="failure-consequence-map-zero" role="status">
                ZOI calculated. No configured consequence features are influenced by this scenario.
              </div>
            ) : null}
            {!is3d ? <div className="failure-consequence-map-legend" aria-label="Map legend">
              <strong>Map key</strong>
              <span><i className="asset" />Selected asset</span>
              <span><i className="zoi" />Scenario ZOI</span>
              <span><i className="impact" />Influenced portion</span>
              <span><i className="defect" />Observed, invert, or simulated point</span>
            </div> : null}
          </div>

          <aside className="failure-consequence-inspector">
            {error ? <div className="failure-consequence-error"><AlertTriangle size={17} />{error}</div> : null}
            {loading ? <div className="failure-consequence-loading"><LoaderCircle className="spin" size={20} />Analyzing local spatial sources…</div> : null}

            <section className="failure-consequence-scenario">
              <div className="failure-consequence-section-heading">
                <div><span>Failure scenarios</span><strong>{located.length ? `${located.length} mapped scenario${located.length === 1 ? "" : "s"}` : "Asset-wide screening"}</strong></div>
                {active ? <span className={`failure-source-badge ${active.source}`}>{SOURCE_LABELS[active.source]}</span> : null}
              </div>
              {located.length ? (
                <div className="failure-defect-list">
                  {located.map((defect) => (
                    <button
                      type="button"
                      key={defect.id}
                      className={`failure-defect-row ${defect.id === result?.active_defect_id ? "active" : ""}`}
                      onClick={() => onSelectDefect(defect)}
                    >
                      <span className={`failure-defect-symbol ${defect.source}`}><CircleDot size={16} /></span>
                      <span><strong>{defect.label}</strong><small>{SOURCE_LABELS[defect.source]}{defect.station_feet != null ? ` · ${defect.station_feet.toFixed(1)} ft` : ""}</small></span>
                      <span className="failure-defect-risk">{defect.condition_risk == null ? "—" : defect.condition_risk.toFixed(1)}</span>
                      {defect.id === result?.active_defect_id ? <Check size={17} /> : null}
                    </button>
                  ))}
                </div>
              ) : !loading ? (
                <div className="failure-no-scenario" role="status">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>No mapped observed defect</strong>
                    <span>
                      {unlocated.length
                        ? `${unlocated.length} latest-inspection defect${unlocated.length === 1 ? " is" : "s are"} missing usable stationing or direction.`
                        : "The latest inspections contain no defect with a usable map location."}
                    </span>
                  </div>
                </div>
              ) : null}
              {located.length && unlocated.length ? <p className="failure-unlocated">{unlocated.length} additional latest-inspection defect{unlocated.length === 1 ? "" : "s"} could not be mapped.</p> : null}
              <div className={`failure-simulate ${simulating ? "active" : ""} ${!located.length ? "recommended" : ""}`}>
                <button type="button" className={`failure-place-defect ${simulating ? "cancel" : ""}`} onClick={() => changeSimulationMode(!simulating)}>
                  <Crosshair size={17} /> {simulating ? "Cancel placement" : "Place on map"}
                </button>
                <span className="failure-depth-method">Depth is calculated from DEM ground and interpolated asset invert.</span>
              </div>
            </section>

            <nav className="failure-consequence-tabs" aria-label="Consequence result views">
              {(["summary", "features", "method"] as const).map((value) => (
                <button type="button" key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "features" ? "Affected features" : value[0].toUpperCase() + value.slice(1)}</button>
              ))}
            </nav>

            <section className="failure-consequence-body">
              {tab === "summary" ? (
                <>
                  <div className="failure-kpis">
                    <div><span>Max. ZOI radius</span><strong>{result?.analysis ? `${result.analysis.maximum_zoi_radius_feet.toFixed(1)} ft` : "—"}</strong></div>
                    <div><span>Affected features</span><strong>{result?.analysis?.total_impacted ?? 0}</strong></div>
                    <div><span>Condition risk</span><strong>{active?.condition_risk == null ? "—" : active.condition_risk.toFixed(1)}</strong></div>
                  </div>
                  <div className="failure-summary-list">
                    {groupedFeatures.slice(0, 8).map((item) => <div key={item.category}><span>{item.label}</span><strong>{item.count}</strong></div>)}
                    {!groupedFeatures.length ? <p className="failure-empty">No configured consequence features are influenced by the active scenario.</p> : null}
                  </div>
                </>
              ) : null}
              {tab === "features" ? (
                <div className="failure-feature-list">
                  {influencedFeatures.map((feature) => (
                    <button
                      type="button"
                      key={feature.id}
                      className={flashedFeatureId === feature.id ? "flashing" : ""}
                      onClick={() => flashAffectedFeature(feature.id)}
                      title={`Flash ${feature.label} on the ${is3d ? "3D" : "2D"} map`}
                    >
                      <MapPinned size={17} />
                      <div>
                        <strong>{feature.label}</strong>
                        <span>{feature.relationship === "direct" ? "Direct contact" : "Within zone of influence"}</span>
                        <small>{influenceMeasurementLabel(feature)}</small>
                      </div>
                      <small>{feature.source_table}</small>
                    </button>
                  ))}
                  {!influencedFeatures.length ? <p className="failure-empty">No affected features are available for this scenario.</p> : null}
                </div>
              ) : null}
              {tab === "method" ? (
                <div className="failure-method">
                  <div className="failure-method-formula">
                    <span>Zone of influence</span>
                    <strong>{result?.method.zoi_formula ?? "3 ft + (2 × relative depth)"}</strong>
                  </div>
                  <div className="failure-method-note">
                    <strong>Latest inspections only</strong>
                    <p>The latest ITPipes and Cityworks inspections are evaluated; older inspections are not substituted.</p>
                  </div>
                  <div className="failure-method-note">
                    <strong>Screening result</strong>
                    <p>Results are transient and read-only. Verify findings in the field before making an engineering decision.</p>
                  </div>
                </div>
              ) : null}
              {result?.warnings.map((warning) => <div className="failure-warning" key={warning}><AlertTriangle size={15} />{warning}</div>)}
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

function influenceMeasurementLabel(feature: ImpactedFeature): string {
  if (feature.measurement_type === "area" && feature.influenced_area_sqft != null) {
    const percentage = feature.influenced_percent == null ? "" : ` · ${feature.influenced_percent.toFixed(1)}%`;
    return `${feature.influenced_area_sqft.toLocaleString(undefined, { maximumFractionDigits: 1 })} sq ft${percentage}`;
  }
  if (feature.measurement_type === "length" && feature.influenced_length_feet != null) {
    const percentage = feature.influenced_percent == null ? "" : ` · ${feature.influenced_percent.toFixed(1)}%`;
    return `${feature.influenced_length_feet.toLocaleString(undefined, { maximumFractionDigits: 1 })} ft influenced${percentage}`;
  }
  return "Inside scenario ZOI";
}

function startAffectedFeatureFlash2d(
  map: MapLibreMap,
  featureId: string,
  animationFrameRef: { current: number | null },
): void {
  if (!map.isStyleLoaded() || !map.getSource(FAILURE_CONSEQUENCE_SOURCE_ID)) return;
  ensureAffectedFeatureFlashLayers(map);
  if (animationFrameRef.current != null) window.cancelAnimationFrame(animationFrameRef.current);

  const selectedFilter = ["all", ["==", ["get", "role"], "influence"], ["==", ["get", "impact_id"], featureId]] as never;
  map.setFilter(FAILURE_FEATURE_FLASH_LAYER_IDS.fill, ["all", selectedFilter, ["==", ["geometry-type"], "Polygon"]] as never);
  map.setFilter(FAILURE_FEATURE_FLASH_LAYER_IDS.line, ["all", selectedFilter, ["!=", ["geometry-type"], "Point"]] as never);
  map.setFilter(FAILURE_FEATURE_FLASH_LAYER_IDS.point, ["all", selectedFilter, ["==", ["geometry-type"], "Point"]] as never);
  Object.values(FAILURE_FEATURE_FLASH_LAYER_IDS).forEach((layerId) => map.setLayoutProperty(layerId, "visibility", "visible"));

  const startedAt = performance.now();
  const animate = (now: number) => {
    const elapsed = now - startedAt;
    const pulse = (Math.sin((elapsed / 340) * Math.PI * 2) + 1) / 2;
    map.setPaintProperty(FAILURE_FEATURE_FLASH_LAYER_IDS.fill, "fill-opacity", 0.18 + pulse * 0.42);
    map.setPaintProperty(FAILURE_FEATURE_FLASH_LAYER_IDS.line, "line-width", 4 + pulse * 5);
    map.setPaintProperty(FAILURE_FEATURE_FLASH_LAYER_IDS.line, "line-opacity", 0.72 + pulse * 0.28);
    map.setPaintProperty(FAILURE_FEATURE_FLASH_LAYER_IDS.point, "circle-radius", 7 + pulse * 7);
    map.setPaintProperty(FAILURE_FEATURE_FLASH_LAYER_IDS.point, "circle-opacity", 0.78 + pulse * 0.22);
    if (elapsed < FAILURE_FEATURE_FLASH_DURATION_MS) {
      animationFrameRef.current = window.requestAnimationFrame(animate);
      return;
    }
    Object.values(FAILURE_FEATURE_FLASH_LAYER_IDS).forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
    });
    animationFrameRef.current = null;
  };
  animationFrameRef.current = window.requestAnimationFrame(animate);
}

function ensureAffectedFeatureFlashLayers(map: MapLibreMap): void {
  if (!map.getLayer(FAILURE_FEATURE_FLASH_LAYER_IDS.fill)) {
    map.addLayer({
      id: FAILURE_FEATURE_FLASH_LAYER_IDS.fill,
      type: "fill",
      source: FAILURE_CONSEQUENCE_SOURCE_ID,
      filter: ["==", ["get", "impact_id"], "__none__"],
      layout: { visibility: "none" },
      paint: { "fill-color": "#ffd300", "fill-opacity": 0 },
      metadata: { runtime_helper: true },
    });
  }
  if (!map.getLayer(FAILURE_FEATURE_FLASH_LAYER_IDS.line)) {
    map.addLayer({
      id: FAILURE_FEATURE_FLASH_LAYER_IDS.line,
      type: "line",
      source: FAILURE_CONSEQUENCE_SOURCE_ID,
      filter: ["==", ["get", "impact_id"], "__none__"],
      layout: { visibility: "none" },
      paint: {
        "line-color": "#ffb000",
        "line-width": 5,
        "line-opacity": 1,
        "line-blur": 0.4,
      },
      metadata: { runtime_helper: true },
    });
  }
  if (!map.getLayer(FAILURE_FEATURE_FLASH_LAYER_IDS.point)) {
    map.addLayer({
      id: FAILURE_FEATURE_FLASH_LAYER_IDS.point,
      type: "circle",
      source: FAILURE_CONSEQUENCE_SOURCE_ID,
      filter: ["==", ["get", "impact_id"], "__none__"],
      layout: { visibility: "none" },
      paint: {
        "circle-color": "#ffd300",
        "circle-radius": 8,
        "circle-opacity": 1,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3,
      },
      metadata: { runtime_helper: true },
    });
  }
}

function buildConsequenceMapStyle(
  sourceStyle: MapStyle | null,
  activeBasemapId: "cltex" | "mecklenburg-aerial-2025",
  basemapEnabled: boolean,
  aerialBasemapUrl: string,
): {
  style: StyleSpecification;
  terrainSourceId: string | null;
  exaggeration: number;
} {
  const terrain = sourceStyle?.metadata?.terrain;
  const terrainMetadata = terrain && typeof terrain === "object"
    ? terrain as { source?: unknown; exaggeration?: unknown }
    : null;
  const sourceId = typeof terrainMetadata?.source === "string" ? terrainMetadata.source : "";
  const source = sourceId ? sourceStyle?.sources?.[sourceId] : undefined;
  const terrainSourceId = source?.type === "raster-dem" ? sourceId : null;
  const exaggeration = Number(terrainMetadata?.exaggeration);
  const sources: StyleSpecification["sources"] = {};
  if (terrainSourceId && source) sources[terrainSourceId] = cloneStyleValue(source);
  const layers: StyleSpecification["layers"] = [
    {
      id: "failure-consequence-background",
      type: "background",
      paint: { "background-color": "#edf2f5" },
    },
  ];
  if (basemapEnabled && activeBasemapId === "cltex") {
    for (const layer of (sourceStyle?.layers ?? []) as StyleLayer[]) {
      const selectableId = String(layer.metadata?.selectable_basemap_id ?? "cltex");
      if (!isBasemapLayer(layer) || isLabelLayer(layer) || selectableId !== "cltex") continue;
      const sourceName = typeof (layer as StyleLayer & { source?: unknown }).source === "string"
        ? String((layer as StyleLayer & { source?: string }).source)
        : "";
      if (sourceName && sourceStyle?.sources?.[sourceName]) {
        sources[sourceName] = cloneStyleValue(sourceStyle.sources[sourceName]);
      }
      const cloned = cloneStyleValue(layer) as StyleLayer;
      cloned.layout = { ...(cloned.layout ?? {}), visibility: "visible" };
      layers.push(cloned);
    }
  } else if (basemapEnabled && activeBasemapId === "mecklenburg-aerial-2025" && aerialBasemapUrl) {
    const aerialSourceId = "failure-consequence-aerial";
    sources[aerialSourceId] = {
      type: "raster",
      tiles: [aerialBasemapUrl],
      tileSize: 512,
      maxzoom: 20,
      attribution: "MeckCoGIS",
    };
    layers.push({
      id: "failure-consequence-aerial",
      type: "raster",
      source: aerialSourceId,
      paint: { "raster-opacity": 1 },
    });
  }
  if (terrainSourceId) {
    layers.push({
      id: "failure-consequence-hillshade",
      type: "hillshade",
      source: terrainSourceId,
      paint: {
        "hillshade-exaggeration": 0.42,
        "hillshade-shadow-color": "#526272",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#8ea09d",
      },
    });
  }
  return {
    terrainSourceId,
    exaggeration: Number.isFinite(exaggeration) && exaggeration > 0 ? exaggeration : 1,
    style: {
      version: 8,
      name: "Failure consequence screening",
      sources,
      layers,
    },
  };
}

async function captureConsequenceBasemap(map: MapLibreMap, geometry: GeoJSON.Geometry): Promise<string | null> {
  const bounds = geometryBounds(geometry);
  if (!bounds || !map.isStyleLoaded()) return null;
  const runtimeLayers = ((map.getStyle().layers ?? []) as StyleLayer[])
    .filter((layer) => String((layer as StyleLayer & { source?: unknown }).source ?? "") === "failure-consequence-analysis")
    .map((layer) => ({ id: layer.id, visibility: map.getLayoutProperty(layer.id, "visibility") as string | undefined }));
  try {
    for (const layer of runtimeLayers) map.setLayoutProperty(layer.id, "visibility", "none");
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 0, duration: 0 });
    await waitForMapIdle(map);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const canvas = map.getCanvas();
    const northWest = map.project([bounds[0], bounds[3]]);
    const southEast = map.project([bounds[2], bounds[1]]);
    const scaleX = canvas.width / Math.max(1, canvas.clientWidth);
    const scaleY = canvas.height / Math.max(1, canvas.clientHeight);
    const sourceX = Math.max(0, Math.floor(Math.min(northWest.x, southEast.x) * scaleX));
    const sourceY = Math.max(0, Math.floor(Math.min(northWest.y, southEast.y) * scaleY));
    const sourceWidth = Math.min(canvas.width - sourceX, Math.max(1, Math.ceil(Math.abs(southEast.x - northWest.x) * scaleX)));
    const sourceHeight = Math.min(canvas.height - sourceY, Math.max(1, Math.ceil(Math.abs(southEast.y - northWest.y) * scaleY)));
    const maximumDimension = 2048;
    const outputScale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(sourceWidth * outputScale));
    output.height = Math.max(1, Math.round(sourceHeight * outputScale));
    const context = output.getContext("2d");
    if (!context) return null;
    context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height);
    return output.toDataURL("image/png");
  } catch (error) {
    console.warn("Could not capture the local basemap for the 3D cutaway.", error);
    return null;
  } finally {
    try {
      for (const layer of runtimeLayers) {
        if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, "visibility", layer.visibility === "none" ? "none" : "visible");
      }
      if (map.isStyleLoaded()) {
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 0, duration: 0 });
      }
    } catch {
      // The panel may have closed while the offscreen capture was finishing.
    }
  }
}

function waitForMapIdle(map: MapLibreMap): Promise<void> {
  if (map.loaded() && !map.isMoving()) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      map.off("idle", finish);
      resolve();
    }, 6000);
    const finish = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    map.once("idle", finish);
  });
}

function geometryBounds(geometry: GeoJSON.Geometry): [number, number, number, number] | null {
  const coordinates: number[][] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      coordinates.push([value[0], value[1]]);
      return;
    }
    value.forEach(collect);
  };
  const collectGeometry = (item: GeoJSON.Geometry): void => {
    if (item.type === "GeometryCollection") item.geometries.forEach(collectGeometry);
    else collect(item.coordinates);
  };
  collectGeometry(geometry);
  if (!coordinates.length) return null;
  return coordinates.reduce<[number, number, number, number]>(
    (result, coordinate) => [
      Math.min(result[0], coordinate[0]),
      Math.min(result[1], coordinate[1]),
      Math.max(result[2], coordinate[0]),
      Math.max(result[3], coordinate[1]),
    ],
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  );
}

function cloneStyleValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyConsequenceMapMode(
  map: MapLibreMap,
  is3d: boolean,
  terrainSourceId: string | null,
  exaggeration: number,
  animate: boolean,
): void {
  if (!map.isStyleLoaded()) return;
  const terrainMap = map as MapLibreMap & {
    getTerrain?: () => { source: string; exaggeration?: number } | null;
    setTerrain?: (terrain: { source: string; exaggeration?: number } | null) => void;
  };
  try {
    if (is3d && terrainSourceId && map.getSource(terrainSourceId)) {
      const currentTerrain = terrainMap.getTerrain?.() ?? null;
      if (currentTerrain?.source !== terrainSourceId || Number(currentTerrain.exaggeration ?? 1) !== exaggeration) {
        terrainMap.setTerrain?.({ source: terrainSourceId, exaggeration });
      }
      if (Math.abs(map.getPitch() - 62) > 0.5 || Math.abs(map.getBearing() + 24) > 0.5) {
        map.easeTo({ pitch: 62, bearing: -24, duration: animate ? 480 : 0 });
      }
      return;
    }
    if (terrainMap.getTerrain?.()) terrainMap.setTerrain?.(null);
    if (Math.abs(map.getPitch()) > 0.5 || Math.abs(map.getBearing()) > 0.5) {
      map.easeTo({ pitch: 0, bearing: 0, duration: animate ? 360 : 0 });
    }
  } catch (error) {
    console.warn("Could not apply the failure-consequence map mode.", error);
  }
}
