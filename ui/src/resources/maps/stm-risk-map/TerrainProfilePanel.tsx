import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as echarts from "echarts";
import type { CustomSeriesOption, CustomSeriesRenderItem, CustomSeriesRenderItemReturn } from "echarts";
import { ChartArea, ChevronDown, Download, ExternalLink, Eye, EyeOff, FileSpreadsheet, Image as ImageIcon, LoaderCircle, RefreshCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { openExternalUrl } from "../../../desktop/runtime";
import { exportTerrainProfile, exportTerrainProfileGraph, type TerrainProfileMode, type TerrainProfileResult } from "./terrainProfile";

type Props = {
  colorScheme: "dark" | "light";
  error: string;
  hoverIndex: number | null;
  loading: boolean;
  mode: TerrainProfileMode;
  open: boolean;
  profile: TerrainProfileResult | null;
  onClear: () => void;
  onClose: () => void;
  onHoverSample: (index: number | null) => void;
  onModeChange: (mode: TerrainProfileMode) => void;
  onReverse: () => void;
};

const MIN_HEIGHT = 270;
const DEFAULT_HEIGHT = 342;
const SCHEMATIC_PIPE_DIAMETER_FEET = 2;
type EngineeringElements = Extract<NonNullable<CustomSeriesRenderItemReturn>, { type: "group" }>["children"];

export default function TerrainProfilePanel({
  colorScheme,
  error,
  hoverIndex,
  loading,
  mode,
  open,
  profile,
  onClear,
  onClose,
  onHoverSample,
  onModeChange,
  onReverse,
}: Props) {
  const chartNodeRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [exporting, setExporting] = useState<"excel" | "jpg" | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [hiddenDefectsFor, setHiddenDefectsFor] = useState<string | null>(null);
  const activeInspectionId = profile?.itpipes?.inspection?.mli_id ?? null;
  const defectsVisible = activeInspectionId === null || hiddenDefectsFor !== activeInspectionId;

  useEffect(() => {
    if (!exportMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [exportMenuOpen]);

  const colors = useMemo(() => colorScheme === "dark"
    ? { text: "#f8fbff", muted: "#aeb9c7", grid: "rgba(174,185,199,.2)", tooltip: "rgba(6,17,29,.96)", labelBackground: "rgba(6,17,29,.82)", structure: "#d5dde7", grass: "#79bd72", tree: "#5fae66", treeTrunk: "#b68b66", pipe: "#1384d4", pipeDark: "#075a99", pipeInner: "#8ecdeb", pipeHighlight: "#d9f2ff", drainage: "#15a89b" }
    : { text: "#1f2933", muted: "#687586", grid: "rgba(104,117,134,.22)", tooltip: "rgba(255,255,255,.98)", labelBackground: "rgba(255,255,255,.84)", structure: "#334155", grass: "#3f8746", tree: "#2f7538", treeTrunk: "#775640", pipe: "#1685cf", pipeDark: "#075a99", pipeInner: "#a8d9ef", pipeHighlight: "#eaf8ff", drainage: "#0f8f83" }, [colorScheme]);

  useEffect(() => {
    if (!open || !chartNodeRef.current) return;
    const chart = echarts.init(chartNodeRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(chartNodeRef.current);
    const handleAxis = (event: unknown) => {
      const axisInfo = (event as { axesInfo?: Array<{ value?: number }> }).axesInfo?.[0];
      if (!axisInfo || typeof axisInfo.value !== "number" || !profile?.samples.length) return;
      let nearest = 0;
      let distance = Number.POSITIVE_INFINITY;
      profile.samples.forEach((sample, index) => {
        const difference = Math.abs(sample.distance_feet - Number(axisInfo.value));
        if (difference < distance) {
          distance = difference;
          nearest = index;
        }
      });
      onHoverSample(nearest);
    };
    chart.on("updateAxisPointer", handleAxis);
    chart.getZr().on("globalout", () => onHoverSample(null));
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [open, profile, onHoverSample]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !profile) return;
    const ground = profile.samples.map((sample) => [sample.distance_feet, sample.ground_elevation]);
    const invert = profile.samples.map((sample) => [sample.distance_feet, sample.asset_elevation]);
    const hasInvert = profile.samples.some((sample) => sample.asset_elevation !== null);
    const groundTextureSeries = buildGroundTextureSeries(profile, {
      grass: colors.grass,
      tree: colors.tree,
      treeTrunk: colors.treeTrunk,
    });
    const engineeringSeries = buildEngineeringSeries(profile, colors);
    const defectSeries = defectsVisible ? buildDefectSeries(profile) : [];
    const assetLegend = profile.mode === "pipe"
      ? [hasInvert ? pipeDiameterFeet(profile) === null ? "Pipe (schematic 2 ft diameter)" : "Pipe profile (true diameter)" : "Pipe (elevation unavailable)"]
      : profile.mode === "drainage" ? ["Drainage (schematic)"] : [];
    chart.setOption({
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 22, right: 18, top: profile.mode === "draw" ? 24 : 42, bottom: 18, containLabel: true },
      legend: {
        top: 0,
        right: 8,
        itemWidth: 18,
        itemHeight: 7,
        textStyle: { color: colors.muted, fontSize: 10, fontWeight: 600 },
        data: ["DEM ground", ...assetLegend, ...(defectSeries.length ? ["Condition-risk defects"] : [])],
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: "#1675bf", width: 1 } },
        backgroundColor: colors.tooltip,
        borderColor: "#8fb5d3",
        textStyle: { color: colors.text, fontSize: 11 },
        formatter: (items: unknown) => profileTooltip(items, profile),
      },
      xAxis: {
        type: "value",
        name: "Distance (ft)",
        nameLocation: "middle",
        nameGap: 24,
        min: 0,
        max: profile.statistics.length_feet,
        axisLabel: { color: colors.muted, fontSize: 9 },
        axisLine: { lineStyle: { color: colors.grid } },
        splitLine: { lineStyle: { color: colors.grid } },
      },
      yAxis: {
        type: "value",
        name: "Elevation (ft)",
        nameTextStyle: { color: colors.muted, fontSize: 9 },
        scale: true,
        axisLabel: { color: colors.muted, fontSize: 9 },
        axisLine: { lineStyle: { color: colors.grid } },
        splitLine: { lineStyle: { color: colors.grid } },
      },
      series: [
        {
          name: "DEM ground",
          type: "line",
          data: ground,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: "#458a48", width: 2 },
          areaStyle: { color: "rgba(111,156,82,.20)" },
          emphasis: { disabled: true },
        },
        ...groundTextureSeries,
        ...engineeringSeries,
        ...(hasInvert ? [{
          name: "Pipe invert",
          type: "line",
          data: invert,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { color: "#1675bf", width: 2.5 },
          emphasis: { disabled: true },
        }] : []),
        ...defectSeries,
      ],
    }, true);
  }, [colors, defectsVisible, profile]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !profile) return;
    if (hoverIndex === null) {
      chart.dispatchAction({ type: "hideTip" });
      return;
    }
    chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: hoverIndex });
  }, [hoverIndex, profile]);

  if (!open) return null;

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const maximum = Math.max(MIN_HEIGHT, Math.min(560, window.innerHeight - 120));
    setHeight(Math.max(MIN_HEIGHT, Math.min(maximum, resize.startHeight + resize.startY - event.clientY)));
  };
  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const runExport = async (format: "excel" | "jpg") => {
    if (!profile || exporting) return;
    setExportMenuOpen(false);
    setExporting(format);
    try {
      if (format === "excel") {
        await exportTerrainProfile(profile);
      } else {
        const dataUrl = chartRef.current?.getDataURL({
          type: "jpeg",
          pixelRatio: 2,
          backgroundColor: colorScheme === "dark" ? "#101c29" : "#ffffff",
          excludeComponents: ["toolbox"],
        });
        if (!dataUrl) throw new Error("The terrain profile graph is not ready to export.");
        await exportTerrainProfileGraph(dataUrl);
      }
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Could not export the terrain profile.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <aside
      className="absolute bottom-3 left-20 right-3 z-30 grid min-w-0 grid-rows-[7px_48px_auto_minmax(0,1fr)] overflow-hidden rounded-md border border-[var(--panel-border)] bg-[var(--popup-bg)] text-[var(--panel-text)] shadow-[0_18px_48px_rgba(0,0,0,.32)] backdrop-blur-xl"
      style={{ height }}
      aria-label="Terrain profile"
    >
      <button
        type="button"
        className="group relative cursor-ns-resize border-0 bg-[var(--panel-toolbar-bg)]"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        title="Drag to resize terrain profile"
        aria-label="Resize terrain profile"
        style={{ touchAction: "none" }}
      >
        <span className="absolute left-1/2 top-0.5 h-1 w-14 -translate-x-1/2 rounded-full bg-[var(--panel-border)] group-hover:bg-[var(--accent)]" />
      </button>
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-[var(--panel-active-bg)] text-[var(--accent)]"><ChartArea className="h-4 w-4" /></span>
          <div className="min-w-0">
            <strong className="block truncate text-[13px] font-semibold">Terrain Profile</strong>
            <span
              className="block truncate text-[9px] font-medium text-[var(--panel-muted)]"
              title="DEM ground elevations are approximate; verify against field or survey data."
            >
              DEM ground elevations are approximate; verify against field or survey data
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(["draw", "pipe", "drainage"] as TerrainProfileMode[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`h-8 rounded-sm border px-3 text-[10px] font-semibold transition ${mode === option ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--panel-border)] bg-[var(--control-bg)] text-[var(--control-text)] hover:border-[var(--accent)] hover:bg-[var(--row-hover)]"}`}
              onClick={() => onModeChange(option)}
            >
              {option === "draw" ? "Draw line" : option === "pipe" ? "Select pipe" : "Select drainage"}
            </button>
          ))}
          <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-[var(--panel-border)] bg-[var(--control-bg)] px-2.5 text-[10px] font-semibold text-[var(--control-text)] hover:border-[var(--accent)] hover:bg-[var(--row-hover)] disabled:opacity-40" disabled={!profile} onClick={onReverse}><RefreshCcw className="h-3.5 w-3.5" />Reverse</button>
          <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-[var(--panel-border)] bg-[var(--control-bg)] px-2.5 text-[10px] font-semibold text-[var(--control-text)] hover:border-[var(--accent)] hover:bg-[var(--row-hover)] disabled:opacity-40" disabled={!profile && !error} onClick={onClear}><Trash2 className="h-3.5 w-3.5" />Clear</button>
          <div ref={exportMenuRef} className="relative">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-[var(--accent)] px-3 text-[10px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
              disabled={!profile || Boolean(exporting)}
              onClick={() => setExportMenuOpen((current) => !current)}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
            >
              {exporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Export
              <ChevronDown className="h-3 w-3" />
            </button>
            {exportMenuOpen ? (
              <div className="absolute right-0 top-[calc(100%+6px)] z-50 grid w-44 overflow-hidden rounded-sm border border-[var(--panel-border)] bg-[var(--popup-bg)] p-1 shadow-[0_10px_28px_rgba(0,0,0,.28)]" role="menu">
                <button type="button" className="flex h-9 items-center gap-2 rounded-sm px-2.5 text-left text-[10px] font-semibold text-[var(--panel-text)] hover:bg-[var(--row-hover)]" role="menuitem" onClick={() => void runExport("excel")}><FileSpreadsheet className="h-4 w-4 text-[var(--accent)]" />Excel workbook</button>
                <button type="button" className="flex h-9 items-center gap-2 rounded-sm px-2.5 text-left text-[10px] font-semibold text-[var(--panel-text)] hover:bg-[var(--row-hover)]" role="menuitem" onClick={() => void runExport("jpg")}><ImageIcon className="h-4 w-4 text-[var(--accent)]" />JPG graph</button>
              </div>
            ) : null}
          </div>
          <button type="button" className="grid h-8 w-8 place-items-center rounded-sm text-[var(--panel-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--panel-text)]" onClick={onClose} title="Close terrain profile" aria-label="Close terrain profile"><X className="h-4 w-4" /></button>
        </div>
      </header>

      <ProfileSummary profile={profile} loading={loading} error={error} mode={mode} defectsVisible={defectsVisible} onToggleDefects={() => setHiddenDefectsFor(defectsVisible ? activeInspectionId : null)} />

      <div className="relative min-h-0 border-t border-[var(--panel-border)] bg-[var(--panel-bg)]">
        {profile ? <div ref={chartNodeRef} className="absolute inset-0" aria-label="Terrain elevation profile chart" /> : null}
        {!profile && !loading && !error ? (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div className="grid max-w-xl justify-items-center gap-2 text-[11px] text-[var(--panel-muted)]">
              <ChartArea className="h-7 w-7 text-[var(--accent)]" />
              <strong className="text-[13px] text-[var(--panel-text)]">{mode === "draw" ? "Click the map to draw a path; double-click to finish." : `Click a storm ${mode} on the map.`}</strong>
              <span>The ground profile is sampled from the active local Mecklenburg DEM.</span>
            </div>
          </div>
        ) : null}
        {loading ? <div className="absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--panel-bg)_82%,transparent)]"><div className="flex items-center gap-2 text-[12px] font-semibold"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent)]" />Generating terrain profile…</div></div> : null}
      </div>
    </aside>
  );
}

function ProfileSummary({ profile, loading, error, mode, defectsVisible, onToggleDefects }: { profile: TerrainProfileResult | null; loading: boolean; error: string; mode: TerrainProfileMode; defectsVisible: boolean; onToggleDefects: () => void }) {
  if (error) return <div className="border-b border-[#d98b86] bg-[#fff1ef] px-4 py-2 text-[11px] font-semibold text-[#9e241d]">{error}</div>;
  if (!profile) return <div className="border-b border-[var(--panel-border)] px-4 py-2 text-[10px] font-medium text-[var(--panel-muted)]">{loading ? "Reading the active local DEM…" : mode === "draw" ? "Draw a single- or multi-segment profile line." : `Select a ${mode} line feature.`}</div>;
  const stats = profile.statistics;
  const upstream = profile.endpoints.start.role === "upstream" ? profile.endpoints.start : profile.endpoints.end.role === "upstream" ? profile.endpoints.end : null;
  const downstream = profile.endpoints.start.role === "downstream" ? profile.endpoints.start : profile.endpoints.end.role === "downstream" ? profile.endpoints.end : null;
  const assetId = profileAssetId(profile);
  const metrics = [
    ...(profile.mode === "pipe" && assetId ? [["Pipe asset ID", assetId]] : []),
    ...(profile.mode === "drainage" && assetId ? [["Drainage asset ID", assetId]] : []),
    ...(upstream ? [["Upstream structure", endpointSummary(upstream.label, upstream.elevation)]] : []),
    ["Length", formatFeet(stats.length_feet)],
    ["Ground range", stats.ground_min === null || stats.ground_max === null ? "—" : `${formatNumber(stats.ground_min)}–${formatNumber(stats.ground_max)} ft`],
    ["Elevation change", formatSignedFeet(stats.ground_change)],
    ...(stats.pipe_grade_percent === null ? [] : [["Pipe grade", `${formatNumber(stats.pipe_grade_percent)}%`]]),
    ...(stats.minimum_ground_to_invert === null ? [] : [["Min. ground to invert", formatFeet(stats.minimum_ground_to_invert)]]),
    ...(downstream ? [["Downstream structure", endpointSummary(downstream.label, downstream.elevation)]] : []),
  ];
  const itpipes = profile.itpipes;
  const inspection = itpipes?.inspection;
  const inspectionUrl = inspection?.mli_id
    ? `https://charlottenc.itpipes.com/Asset/SearchByInspId?assetType=ML&inspID=${encodeURIComponent(inspection.mli_id)}`
    : "";
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] border-b border-[var(--panel-border)] bg-[var(--panel-bg)]">
      {metrics.map(([label, value]) => <div key={label} className="min-w-0 border-r border-[var(--panel-border)] px-3 py-2 last:border-r-0"><span className="block truncate text-[8px] font-semibold uppercase tracking-[.08em] text-[var(--panel-muted)]">{label}</span><strong className="mt-0.5 block truncate text-[11px] font-semibold">{value}</strong></div>)}
      {itpipes ? (
        <div className="col-span-full flex min-w-0 items-center gap-3 border-t border-[var(--panel-border)] px-3 py-1.5 text-[9px]">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-semibold uppercase tracking-[.06em] text-[var(--panel-muted)]">Latest ITPipes inspection</span>
            {inspection ? (
              <>
                <button type="button" className="inline-flex shrink-0 items-center gap-1 font-semibold text-[var(--accent)] underline-offset-2 hover:underline" onClick={() => void openExternalUrl(inspectionUrl).catch((reason) => toast.error(reason instanceof Error ? reason.message : `Could not open ITPipes inspection ${inspection.mli_id}.`))}>MLI {inspection.mli_id}<ExternalLink className="h-3 w-3" /></button>
                <span className="truncate text-[var(--panel-muted)]">{formatInspectionDate(inspection.inspection_date)} · {inspection.inspection_direction_label} · {itpipes.located_count} located{itpipes.unlocated_count ? `, ${itpipes.unlocated_count} unlocated` : ""}</span>
              </>
            ) : <span className="truncate text-[var(--panel-muted)]">{itpipes.message}</span>}
          </div>
          {itpipes.status === "ready" ? (
            <>
              <div className="flex shrink-0 items-center gap-1.5 text-[8px] font-semibold text-[var(--panel-muted)]"><span>0</span><span className="h-2 w-24 rounded-full border border-black/10" style={{ background: "linear-gradient(90deg,#fde68a 0%,#f59e0b 25%,#f97316 50%,#ef4444 75%,#7f1d1d 100%)" }} /><span>100 condition risk</span></div>
              <button type="button" className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-[var(--panel-border)] bg-[var(--control-bg)] px-2 font-semibold text-[var(--control-text)] hover:border-[var(--accent)]" onClick={onToggleDefects}>{defectsVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{defectsVisible ? "Hide defects" : "Show defects"}</button>
            </>
          ) : null}
        </div>
      ) : null}
      {profile.warnings.length ? <div className="col-span-full border-t border-amber-300 bg-amber-50 px-3 py-1.5 text-[9px] font-medium text-amber-900">{profile.warnings.join(" ")}</div> : null}
    </div>
  );
}

function profileTooltip(value: unknown, profile: TerrainProfileResult): string {
  const items = Array.isArray(value) ? value as Array<{ seriesName?: string; value?: [number, number | null] }> : [];
  const distance = items.find((item) => Array.isArray(item.value) && typeof item.value[0] === "number")?.value?.[0];
  const sample = nearestSample(profile, distance);
  const lines = [`<strong>Station ${formatNumber(sample?.distance_feet ?? distance)} ft</strong>`];
  if (sample?.ground_elevation !== null && sample?.ground_elevation !== undefined) lines.push(`DEM ground: <strong>${formatNumber(sample.ground_elevation)} ft</strong>`);
  if (sample?.asset_elevation !== null && sample?.asset_elevation !== undefined) {
    lines.push(`Pipe invert: <strong>${formatNumber(sample.asset_elevation)} ft</strong>`);
    const diameter = pipeDiameterFeet(profile);
    if (diameter !== null) {
      lines.push(`Pipe diameter: <strong>${formatNumber(diameter)} ft</strong>`);
      lines.push(`Pipe crown: <strong>${formatNumber(sample.asset_elevation + diameter)} ft</strong>`);
    } else {
      lines.push(`Diameter unavailable: <strong>${formatNumber(SCHEMATIC_PIPE_DIAMETER_FEET)} ft schematic display</strong>`);
      lines.push(`Schematic crown: <strong>${formatNumber(sample.asset_elevation + SCHEMATIC_PIPE_DIAMETER_FEET)} ft</strong>`);
    }
    if (sample.cover !== null) lines.push(`Ground to invert: <strong>${formatNumber(sample.cover)} ft</strong>`);
  }
  if (profile.mode === "drainage") lines.push("Drainage elevation: <strong>Not available</strong>");
  const defects = defectsNearStation(profile, sample?.distance_feet ?? distance);
  if (defects.length) {
    lines.push("<hr style=\"border:0;border-top:1px solid rgba(127,127,127,.35);margin:6px 0\"/>");
    lines.push(`<strong>${defects.length} ITPipes defect${defects.length === 1 ? "" : "s"}</strong>`);
    defects.slice(0, 5).forEach((defect) => {
      lines.push(`MLO ${escapeHtml(defect.mlo_id)} · Risk <strong>${formatNumber(defect.condition_risk)}</strong> · ${escapeHtml(defect.observation_text || "No observation text")}`);
    });
    if (defects.length > 5) lines.push(`+${defects.length - 5} more at this station`);
  }
  return lines.join("<br/>");
}

type DefectCluster = {
  distance: number;
  elevation: number;
  maximumRisk: number;
  count: number;
};

function buildDefectSeries(profile: TerrainProfileResult): CustomSeriesOption[] {
  const clusters = defectClusters(profile);
  if (!clusters.length) return [];
  const renderItem: CustomSeriesRenderItem = (params, api) => {
    const cluster = clusters[params.dataIndex];
    if (!cluster) return { type: "group", children: [] };
    const anchor = api.coord([cluster.distance, cluster.elevation]);
    const markerY = anchor[1] - 20;
    const color = conditionRiskColor(cluster.maximumRisk);
    const children: EngineeringElements = [
      { type: "line", shape: { x1: anchor[0], y1: anchor[1], x2: anchor[0], y2: markerY + 5 }, style: { stroke: color, lineWidth: 2 }, silent: true },
      { type: "circle", shape: { cx: anchor[0], cy: markerY, r: cluster.count > 1 ? 7 : 6 }, style: { fill: color, stroke: "#ffffff", lineWidth: 2, shadowBlur: 3, shadowColor: "rgba(0,0,0,.35)" }, silent: true },
    ];
    if (cluster.count > 1) {
      children.push({ type: "text", style: { text: String(cluster.count), x: anchor[0], y: markerY, fill: "#ffffff", font: "700 8px Geist, sans-serif", align: "center", verticalAlign: "middle" }, silent: true });
    }
    return { type: "group", children };
  };
  return [{
    name: "Condition-risk defects",
    type: "custom",
    coordinateSystem: "cartesian2d",
    renderItem,
    data: clusters.map((cluster) => [cluster.distance, cluster.elevation, cluster.maximumRisk]),
    itemStyle: { color: "#ef4444" },
    tooltip: { show: false },
    silent: true,
    clip: false,
    z: 20,
  }];
}

function defectClusters(profile: TerrainProfileResult): DefectCluster[] {
  const diameter = displayedPipeDiameterFeet(profile);
  const located = (profile.itpipes?.defects ?? [])
    .filter((defect) => defect.profile_distance_feet !== null)
    .sort((left, right) => Number(left.profile_distance_feet) - Number(right.profile_distance_feet));
  const clusters: Array<{ distances: number[]; risks: number[] }> = [];
  located.forEach((defect) => {
    const distance = Number(defect.profile_distance_feet);
    const current = clusters[clusters.length - 1];
    const currentMean = current ? current.distances.reduce((sum, item) => sum + item, 0) / current.distances.length : Number.NaN;
    if (!current || Math.abs(distance - currentMean) > 0.5) clusters.push({ distances: [distance], risks: [defect.condition_risk] });
    else {
      current.distances.push(distance);
      current.risks.push(defect.condition_risk);
    }
  });
  return clusters.map((cluster) => {
    const distance = cluster.distances.reduce((sum, item) => sum + item, 0) / cluster.distances.length;
    const sample = nearestSample(profile, distance);
    const baseElevation = sample?.asset_elevation ?? sample?.ground_elevation ?? 0;
    return {
      distance,
      elevation: baseElevation + diameter,
      maximumRisk: Math.max(...cluster.risks),
      count: cluster.distances.length,
    };
  });
}

function defectsNearStation(profile: TerrainProfileResult, station: number | undefined) {
  if (station === undefined || !Number.isFinite(station)) return [];
  const tolerance = Math.max(0.6, profile.sample_interval_feet / 2);
  return (profile.itpipes?.defects ?? []).filter((defect) => defect.profile_distance_feet !== null && Math.abs(defect.profile_distance_feet - station) <= tolerance);
}

function conditionRiskColor(value: number): string {
  const stops = [
    [0, [253, 230, 138]],
    [25, [245, 158, 11]],
    [50, [249, 115, 22]],
    [75, [239, 68, 68]],
    [100, [127, 29, 29]],
  ] as const;
  const risk = Math.max(0, Math.min(100, value));
  const upperIndex = Math.max(1, stops.findIndex(([stop]) => risk <= stop));
  const [lowStop, lowColor] = stops[upperIndex - 1];
  const [highStop, highColor] = stops[upperIndex];
  const ratio = highStop === lowStop ? 0 : (risk - lowStop) / (highStop - lowStop);
  const channels = lowColor.map((channel, index) => Math.round(channel + (highColor[index] - channel) * ratio));
  return `rgb(${channels.join(",")})`;
}

function buildGroundTextureSeries(
  profile: TerrainProfileResult,
  colors: { grass: string; tree: string; treeTrunk: string },
): CustomSeriesOption[] {
  const validSamples = profile.samples.filter((sample) => sample.ground_elevation !== null);
  if (validSamples.length < 3) return [];
  const targetCount = Math.max(60, Math.min(288, Math.round(profile.statistics.length_feet / (2 / 1.5))));
  const grassSamples = Array.from({ length: targetCount }, (_value, index) => {
    const distance = profile.statistics.length_feet * ((index + 1) / (targetCount + 1));
    const elevation = groundElevationAtDistance(profile.samples, distance);
    return elevation === null ? null : { distance_feet: distance, ground_elevation: elevation };
  }).filter((sample): sample is { distance_feet: number; ground_elevation: number } => sample !== null);
  const renderGrass: CustomSeriesRenderItem = (params, api) => {
    const sample = grassSamples[params.dataIndex];
    if (!sample || sample.ground_elevation === null) return { type: "group", children: [] };
    const point = api.coord([sample.distance_feet, sample.ground_elevation]);
    const height = 3.5 + (params.dataIndex % 3);
    return {
      type: "group",
      children: [
        { type: "line", shape: { x1: point[0], y1: point[1], x2: point[0] - 2.5, y2: point[1] - height + 1 }, style: { stroke: colors.grass, lineWidth: 1.1, opacity: 0.78 }, silent: true },
        { type: "line", shape: { x1: point[0], y1: point[1], x2: point[0], y2: point[1] - height - 1 }, style: { stroke: colors.grass, lineWidth: 1.25, opacity: 0.86 }, silent: true },
        { type: "line", shape: { x1: point[0], y1: point[1], x2: point[0] + 2.5, y2: point[1] - height + 2 }, style: { stroke: colors.grass, lineWidth: 1.1, opacity: 0.78 }, silent: true },
      ],
      silent: true,
    };
  };

  const desiredTreeCount = Math.max(2, Math.min(8, Math.round(profile.statistics.length_feet / 45)));
  const treeCount = Math.min(desiredTreeCount, validSamples.length - 2);
  const treeIndexes = Array.from({ length: treeCount }, (_value, index) =>
    Math.max(1, Math.min(validSamples.length - 2, Math.round(((index + 1) / (treeCount + 1)) * (validSamples.length - 1)))),
  );
  const treeSamples = [...new Set(treeIndexes)].map((index) => validSamples[index]);
  const renderTree: CustomSeriesRenderItem = (params, api) => {
    const sample = treeSamples[params.dataIndex];
    if (!sample || sample.ground_elevation === null) return { type: "group", children: [] };
    const point = api.coord([sample.distance_feet, sample.ground_elevation]);
    const scale = 0.9 + (params.dataIndex % 3) * 0.12;
    const trunkHeight = 7 * scale;
    const crownY = point[1] - trunkHeight - 4 * scale;
    return {
      type: "group",
      children: [
        { type: "line", shape: { x1: point[0], y1: point[1], x2: point[0], y2: point[1] - trunkHeight }, style: { stroke: colors.treeTrunk, lineWidth: 2.2 * scale, opacity: 0.9 }, silent: true },
        { type: "circle", shape: { cx: point[0] - 4 * scale, cy: crownY + 1.5 * scale, r: 4.4 * scale }, style: { fill: colors.tree, stroke: colors.tree, lineWidth: 0.8, opacity: 0.82 }, silent: true },
        { type: "circle", shape: { cx: point[0] + 4 * scale, cy: crownY + 1.5 * scale, r: 4.4 * scale }, style: { fill: colors.tree, stroke: colors.tree, lineWidth: 0.8, opacity: 0.82 }, silent: true },
        { type: "circle", shape: { cx: point[0], cy: crownY - 2.5 * scale, r: 5.2 * scale }, style: { fill: colors.tree, stroke: colors.tree, lineWidth: 0.8, opacity: 0.9 }, silent: true },
      ],
      silent: true,
    };
  };

  return [
    {
      name: "Ground texture",
      type: "custom",
      coordinateSystem: "cartesian2d",
      renderItem: renderGrass,
      data: grassSamples.map((sample) => [sample.distance_feet, sample.ground_elevation]),
      tooltip: { show: false },
      silent: true,
      clip: false,
      z: 4,
    },
    {
      name: "Terrain context",
      type: "custom",
      coordinateSystem: "cartesian2d",
      renderItem: renderTree,
      data: treeSamples.map((sample) => [sample.distance_feet, sample.ground_elevation]),
      tooltip: { show: false },
      silent: true,
      clip: false,
      z: 4,
    },
  ];
}

function buildEngineeringSeries(profile: TerrainProfileResult, colors: { text: string; muted: string; labelBackground: string; structure: string; pipe: string; pipeDark: string; pipeInner: string; pipeHighlight: string; drainage: string }): CustomSeriesOption[] {
  if (profile.mode === "draw" || !profile.samples.length) return [];
  const start = profile.samples[0];
  const end = profile.samples[profile.samples.length - 1];
  const length = profile.statistics.length_feet;
  const flowsRight = profile.endpoints.start.role === "upstream";
  const assetId = profileAssetId(profile);
  const hasPipeElevation = profile.mode === "pipe" && start.asset_elevation !== null && end.asset_elevation !== null;
  const renderItem: CustomSeriesRenderItem = (_params, api) => {
    const children: EngineeringElements = [];
    if (hasPipeElevation && start.asset_elevation !== null && end.asset_elevation !== null) {
      const startInvert = api.coord([0, start.asset_elevation]);
      const endInvert = api.coord([length, end.asset_elevation]);
      const diameter = pipeDiameterFeet(profile);
      const displayDiameter = diameter ?? SCHEMATIC_PIPE_DIAMETER_FEET;
      const startCrown = api.coord([0, start.asset_elevation + displayDiameter]);
      const endCrown = api.coord([length, end.asset_elevation + displayDiameter]);
      const innerStartCrown = insetScreenPoint(startCrown, startInvert, 3.5);
      const innerEndCrown = insetScreenPoint(endCrown, endInvert, 3.5);
      const innerStartInvert = insetScreenPoint(startInvert, startCrown, 3.5);
      const innerEndInvert = insetScreenPoint(endInvert, endCrown, 3.5);
      children.push({
        type: "polygon",
        shape: { points: [startCrown, endCrown, endInvert, startInvert] },
        style: { fill: colors.pipeDark, stroke: colors.pipeDark, lineWidth: 2.5, opacity: 0.96 },
        silent: true,
      });
      children.push({
        type: "polygon",
        shape: { points: [innerStartCrown, innerEndCrown, innerEndInvert, innerStartInvert] },
        style: { fill: colors.pipeInner, stroke: colors.pipe, lineWidth: 1.25, opacity: 0.98 },
        silent: true,
      });
      children.push({ type: "line", shape: { x1: innerStartCrown[0], y1: innerStartCrown[1], x2: innerEndCrown[0], y2: innerEndCrown[1] }, style: { stroke: colors.pipeHighlight, lineWidth: 1.5, opacity: 0.9 }, silent: true });
      [0.055, 0.945].forEach((fraction) => {
        const ringCrown = interpolateScreenPoint(startCrown, endCrown, fraction);
        const ringInvert = interpolateScreenPoint(startInvert, endInvert, fraction);
        children.push({ type: "line", shape: { x1: ringCrown[0], y1: ringCrown[1], x2: ringInvert[0], y2: ringInvert[1] }, style: { stroke: colors.pipeHighlight, lineWidth: 2.25, opacity: 0.78 }, silent: true });
      });
      children.push(flowArrows(startInvert, endInvert, startCrown, endCrown, flowsRight, colors.pipe));
      addProfileAssetLabel(
        children,
        midpointBetween(startInvert, endInvert),
        diameter === null ? `Pipe · schematic ${formatNumber(SCHEMATIC_PIPE_DIAMETER_FEET)} ft diameter` : "Pipe",
        assetId,
        colors.pipeDark,
        colors.labelBackground,
      );
    } else if (profile.mode === "pipe") {
      const points = profile.samples
        .filter((sample) => sample.ground_elevation !== null)
        .map((sample) => {
          const point = api.coord([sample.distance_feet, sample.ground_elevation]);
          return [point[0], point[1] + 18];
        });
      if (points.length > 1) {
        children.push({ type: "polyline", shape: { points }, style: { fill: "none", stroke: colors.pipeDark, lineWidth: 9, lineDash: [9, 6], opacity: 0.55 }, silent: true });
        children.push({ type: "polyline", shape: { points }, style: { fill: "none", stroke: colors.pipe, lineWidth: 4.5, lineDash: [9, 6], opacity: 0.9 }, silent: true });
        children.push(flowArrows(points[0], points[points.length - 1], [points[0][0], points[0][1] - 4], [points[points.length - 1][0], points[points.length - 1][1] - 4], flowsRight, colors.pipe));
        addProfileAssetLabel(children, points[Math.floor(points.length / 2)], "Pipe · schematic elevation", assetId, colors.pipeDark, colors.labelBackground);
      }
    } else if (profile.mode === "drainage") {
      const points = profile.samples
        .filter((sample) => sample.ground_elevation !== null)
        .map((sample) => {
          const point = api.coord([sample.distance_feet, sample.ground_elevation]);
          return [point[0], point[1] + 11];
        });
      if (points.length > 1) {
        children.push({ type: "polyline", shape: { points }, style: { fill: "none", stroke: colors.drainage, lineWidth: 7, opacity: 0.24 }, silent: true });
        children.push({ type: "polyline", shape: { points }, style: { fill: "none", stroke: colors.drainage, lineWidth: 2, lineDash: [7, 4] }, silent: true });
        const midpoint = points[Math.floor(points.length / 2)];
        children.push(openChannelSymbol(midpoint, colors.drainage));
        children.push(flowArrows(points[0], points[points.length - 1], [points[0][0], points[0][1] - 1], [points[points.length - 1][0], points[points.length - 1][1] - 1], flowsRight, colors.drainage));
        addProfileAssetLabel(children, midpoint, "Drainage", assetId, colors.drainage, colors.labelBackground);
      }
    }

    addEndpointStructure(children, api, profile.endpoints.start, 0, start.ground_elevation, start.asset_elevation, true, colors);
    addEndpointStructure(children, api, profile.endpoints.end, length, end.ground_elevation, end.asset_elevation, false, colors);
    return { type: "group", children };
  };
  return [{
    name: profile.mode === "pipe"
      ? !hasPipeElevation ? "Pipe (elevation unavailable)" : pipeDiameterFeet(profile) === null ? "Pipe (schematic 2 ft diameter)" : "Pipe profile (true diameter)"
      : "Drainage (schematic)",
    type: "custom",
    coordinateSystem: "cartesian2d",
    renderItem,
    data: [[0, start.ground_elevation ?? start.asset_elevation ?? 0]],
    itemStyle: { color: profile.mode === "pipe" ? colors.pipe : colors.drainage },
    tooltip: { show: false },
    silent: true,
    clip: false,
    z: 5,
  }];
}

function midpointBetween(start: number[], end: number[]): number[] {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function interpolateScreenPoint(start: number[], end: number[], fraction: number): number[] {
  return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
}

function insetScreenPoint(point: number[], opposite: number[], pixels: number): number[] {
  const dx = opposite[0] - point[0];
  const dy = opposite[1] - point[1];
  const span = Math.hypot(dx, dy);
  if (span <= 1) return midpointBetween(point, opposite);
  const distance = Math.min(pixels, span * 0.34);
  return [point[0] + (dx / span) * distance, point[1] + (dy / span) * distance];
}

function addProfileAssetLabel(
  children: EngineeringElements,
  point: number[],
  kind: string,
  assetId: string,
  color: string,
  backgroundColor: string,
) {
  children.push({
    type: "text",
    style: {
      text: assetId ? `${kind} · ${assetId}` : kind,
      x: point[0],
      y: point[1] + 18,
      fill: color,
      font: "700 10px Geist, sans-serif",
      align: "center",
      verticalAlign: "top",
      backgroundColor,
      padding: [3, 5],
      borderRadius: 2,
    },
    silent: true,
  });
}

function addEndpointStructure(
  children: EngineeringElements,
  api: Parameters<CustomSeriesRenderItem>[1],
  endpoint: TerrainProfileResult["endpoints"]["start"],
  distance: number,
  groundElevation: number | null,
  invertElevation: number | null,
  isStart: boolean,
  colors: { text: string; muted: string; labelBackground: string; structure: string },
) {
  const anchorElevation = groundElevation ?? invertElevation;
  if (anchorElevation === null) return;
  const groundPoint = api.coord([distance, anchorElevation]);
  const invertPoint = invertElevation === null ? [groundPoint[0], groundPoint[1] + 28] : api.coord([distance, invertElevation]);
  const bottomY = Math.max(groundPoint[1] + 12, invertPoint[1]);
  const chamberWidth = 14;
  const chamberTop = groundPoint[1] + 2;
  children.push({
    type: "rect",
    shape: { x: groundPoint[0] - chamberWidth / 2, y: chamberTop, width: chamberWidth, height: Math.max(10, bottomY - chamberTop), r: 2 },
    style: { fill: "rgba(91,112,130,.18)", stroke: colors.structure, lineWidth: 3, lineDash: invertElevation === null ? [5, 3] : undefined },
    silent: true,
  });
  children.push({
    type: "ellipse",
    shape: { cx: groundPoint[0], cy: groundPoint[1], rx: 10, ry: 3.5 },
    style: { fill: colors.structure, stroke: "#ffffff", lineWidth: 1.5, shadowBlur: 3, shadowColor: "rgba(0,0,0,.3)" },
    silent: true,
  });
  children.push({ type: "line", shape: { x1: groundPoint[0] - 5, y1: bottomY, x2: groundPoint[0] + 5, y2: bottomY }, style: { stroke: colors.structure, lineWidth: 4 }, silent: true });
  if (bottomY - chamberTop > 30) {
    [0.38, 0.62].forEach((fraction) => {
      const rungY = chamberTop + (bottomY - chamberTop) * fraction;
      children.push({ type: "line", shape: { x1: groundPoint[0] - 4, y1: rungY, x2: groundPoint[0] + 4, y2: rungY }, style: { stroke: colors.structure, lineWidth: 1.5, opacity: 0.75 }, silent: true });
    });
  }
  const role = endpoint.role === "upstream" ? "US" : endpoint.role === "downstream" ? "DS" : endpoint.role === "start" ? "START" : "END";
  children.push({
    type: "text",
    style: {
      text: `${role} · ${endpoint.label}`,
      x: groundPoint[0] + (isStart ? 13 : -13),
      y: groundPoint[1] - 13,
      fill: colors.text,
      font: "600 10px Geist, sans-serif",
      align: isStart ? "left" : "right",
      verticalAlign: "middle",
      backgroundColor: colors.labelBackground,
      padding: [2, 4],
      borderRadius: 2,
    },
    silent: true,
  });
  if (endpoint.elevation !== null) {
    children.push({
      type: "text",
      style: {
        text: `Inv ${formatNumber(endpoint.elevation)} ft`,
        x: groundPoint[0] + (isStart ? 13 : -13),
        y: bottomY + 8,
        fill: colors.muted,
        font: "500 9px Geist, sans-serif",
        align: isStart ? "left" : "right",
        verticalAlign: "top",
      },
      silent: true,
    });
  }
}

function flowArrows(startBottom: number[], endBottom: number[], startTop: number[], endTop: number[], flowsRight: boolean, color: string) {
  const startX = (startBottom[0] + startTop[0]) / 2;
  const startY = (startBottom[1] + startTop[1]) / 2;
  const endX = (endBottom[0] + endTop[0]) / 2;
  const endY = (endBottom[1] + endTop[1]) / 2;
  const fromX = flowsRight ? startX : endX;
  const fromY = flowsRight ? startY : endY;
  const toX = flowsRight ? endX : startX;
  const toY = flowsRight ? endY : startY;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span;
  const uy = dy / span;
  const arrowCount = Math.max(1, Math.min(7, Math.floor(span / 145)));
  const arrowLength = Math.max(12, Math.min(20, span / Math.max(4, arrowCount * 4)));
  const children: EngineeringElements = [];
  for (let index = 0; index < arrowCount; index += 1) {
    const centerFraction = (index + 1) / (arrowCount + 1);
    const centerX = fromX + dx * centerFraction;
    const centerY = fromY + dy * centerFraction;
    const tail = [centerX - ux * arrowLength / 2, centerY - uy * arrowLength / 2];
    const head = [centerX + ux * arrowLength / 2, centerY + uy * arrowLength / 2];
    const baseX = head[0] - ux * 5;
    const baseY = head[1] - uy * 5;
    const perpendicularX = -uy * 2.6;
    const perpendicularY = ux * 2.6;
    children.push(
      { type: "line", shape: { x1: tail[0], y1: tail[1], x2: baseX + ux, y2: baseY + uy }, style: { stroke: color, lineWidth: 3.2, opacity: 0.98 }, silent: true },
      { type: "polygon", shape: { points: [head, [baseX + perpendicularX, baseY + perpendicularY], [baseX - perpendicularX, baseY - perpendicularY]] }, style: { fill: color, stroke: color, lineWidth: 0.5, opacity: 0.98 }, silent: true },
    );
  }
  return {
    type: "group" as const,
    children,
    silent: true,
  };
}

function groundElevationAtDistance(samples: TerrainProfileResult["samples"], distance: number): number | null {
  if (!samples.length) return null;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    if (distance > end.distance_feet) continue;
    if (start.ground_elevation === null || end.ground_elevation === null) return null;
    const span = end.distance_feet - start.distance_feet;
    if (span <= 0) return start.ground_elevation;
    const ratio = Math.max(0, Math.min(1, (distance - start.distance_feet) / span));
    return start.ground_elevation + (end.ground_elevation - start.ground_elevation) * ratio;
  }
  return samples[samples.length - 1].ground_elevation;
}

function openChannelSymbol(point: number[], color: string) {
  return {
    type: "polyline" as const,
    shape: { points: [[point[0] - 8, point[1] - 7], [point[0] - 4, point[1] + 5], [point[0] + 4, point[1] + 5], [point[0] + 8, point[1] - 7]] },
    style: { fill: "none", stroke: color, lineWidth: 2.5 },
    silent: true,
  };
}

function pipeDiameterFeet(profile: TerrainProfileResult): number | null {
  const diameter = assetNumber(profile.asset, "DIAMETER");
  return diameter !== null && diameter > 0 ? diameter : null;
}

function displayedPipeDiameterFeet(profile: TerrainProfileResult): number {
  return pipeDiameterFeet(profile) ?? SCHEMATIC_PIPE_DIAMETER_FEET;
}

function profileAssetId(profile: TerrainProfileResult): string {
  const value = profile.asset?.asset_id
    ?? profile.asset?.ITPIPE_ASSETID
    ?? profile.asset?.PIPE_ID
    ?? profile.asset?.CHAN_ID
    ?? profile.asset?.AssetID;
  return value === null || value === undefined ? "" : String(value).trim();
}

function assetNumber(asset: Record<string, unknown> | null, key: string): number | null {
  const value = asset?.[key];
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function nearestSample(profile: TerrainProfileResult, distance: number | undefined) {
  if (distance === undefined || !Number.isFinite(distance)) return profile.samples[0];
  return profile.samples.reduce((nearest, sample) => Math.abs(sample.distance_feet - distance) < Math.abs(nearest.distance_feet - distance) ? sample : nearest, profile.samples[0]);
}

function endpointSummary(label: string, elevation: number | null): string {
  return elevation === null ? label : `${label} · Inv ${formatNumber(elevation)} ft`;
}

function formatInspectionDate(value: string | null): string {
  if (!value) return "Date unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatFeet(value: number | null | undefined): string {
  const formatted = formatNumber(value);
  return formatted === "—" ? formatted : `${formatted} ft`;
}

function formatSignedFeet(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value)} ft`;
}
