import { type ChangeEvent, type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapGeoJSONFeature, type MapMouseEvent, type MapOptions } from "maplibre-gl";
import { toast } from "sonner";
import "maplibre-gl/dist/maplibre-gl.css";
import "./MapTilesViewer.css";
import {
  Activity,
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  Filter,
  Landmark,
  Layers,
  ListOrdered,
  LocateFixed,
  Map as MapIcon,
  Moon,
  Plus,
  BarChart3,
  Route,
  Search,
  Sun,
  Trash2,
  Type,
  Waves,
  X,
} from "lucide-react";
import { fetchAttributeFilterFields, fetchDuckDbGeoJson, fetchInventoryMetrics, fetchManifest, fetchMapStyle, fetchRiskHistograms, fetchRiskTopList, searchAssets } from "./api";
import stormwaterLogoUrl from "./assets/stormwater-logo.png";
import {
  DEFAULT_VIEW,
  ScaleRatioControl,
  applyView,
  boundsToLngLatBounds,
  isBasemapLayer,
  isLabelLayer,
  labelAvailableByStyle,
  labelEnabledByStyle,
  layerColor,
  layerDefaultVisible,
  layerEnabledByStyle,
  layerLabel,
  layerSubtitle,
  mapOptionsForView,
  normalizeBounds,
  registerPmtilesProtocol,
  viewFromManifest,
  viewFromPmtiles,
  viewPadding,
} from "./mapUtils";
import type {
  AssetSearchResult,
  AttributeFilterField,
  AttributeFilterFieldType,
  AttributeFilterOperator,
  AttributeFilterPayload,
  AttributeFilterRule,
  Bounds,
  DuckDbGeoJsonFeatureCollection,
  InventoryMetric,
  Manifest,
  MapStyle,
  RiskHistogram,
  RiskHistogramBin,
  RiskHistogramResponse,
  RiskLayerGroup,
  RiskLayerSelection,
  RiskSortType,
  RiskTopList,
  RiskTopListItem,
  RiskTopListResponse,
  SelectedFeature,
  StyleLayer,
  ViewConfig,
} from "./types";

const northArrowCompassUrl = new URL("./assets/north-arrow-compass.svg", import.meta.url).href;
const MAP_PDF_FRAME_ASPECT_RATIO = 660 / 584;

type IdentifyFeature = SelectedFeature & {
  featureLabel: string;
  featureSubtitle: string;
  geometry?: AssetSearchResult["geometry"];
  layerId: string;
  order: number;
  originalIndex: number;
  uniqueKey: string;
};

type VisibilityStatus = "visible-current-scale" | "visible-other-scale" | "invisible";
type ColorScheme = "dark" | "light";
type MapViewMode = "single" | "dual" | "swipe";
type CompareTarget = "primary" | "comparison";
type DrawTool = "select" | "polygon" | "circle" | "rectangle";
type DrawShape = Exclude<DrawTool, "select">;
type BasemapId =
  | "cltex"
  | "mecklenburg-aerial-2025"
  | "usgs-topo"
  | "usgs-imagery-topo"
  | "nc-onemap-ortho-2010"
  | "nc-onemap-ortho-2012-2015"
  | "nc-onemap-ortho-2016-2019"
  | "nc-onemap-ortho-2020-2023"
  | "nc-onemap-ortho-2024-2027";

type BasemapOption = {
  id: BasemapId;
  name: string;
  description: string;
  preview: string;
  sourceId?: string;
  layerId?: string;
  tiles?: string[];
  tileSize?: number;
  maxzoom?: number;
  attribution?: string;
};

type ExternalOverlayOption = {
  id: string;
  name: string;
  description: string;
  group: string;
  sourceId: string;
  layerId: string;
  mapServerLayerId: number;
  color: string;
};

type LngLatPair = [number, number];
type DrawGeometry =
  | { type: "Polygon"; coordinates: LngLatPair[][] }
  | { type: "LineString"; coordinates: LngLatPair[] }
  | { type: "Point"; coordinates: LngLatPair };
type DrawGeoJsonFeature = {
  type: "Feature";
  id?: string;
  properties: Record<string, unknown>;
  geometry: DrawGeometry;
};
type DrawFeatureCollection = {
  type: "FeatureCollection";
  features: DrawGeoJsonFeature[];
};
type DrawInteraction =
  | { tool: "polygon"; points: LngLatPair[] }
  | { tool: "circle" | "rectangle"; start: LngLatPair; moved: boolean };
type FloatingWidgetPosition = { x: number; y: number };
type FloatingWidgetDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: FloatingWidgetPosition;
};
type RiskLayerOption = {
  id: string;
  label: string;
  dataset_id: string;
};
type LayerFilterTarget = {
  key: string;
  label: string;
  datasetId: string;
  sourceLayer: string;
  fields: AttributeFilterField[];
};
type LayerAttributeFilter = LayerFilterTarget & {
  rules: AttributeFilterRule[];
};
type LayerFilterEditorState = {
  target: LayerFilterTarget;
  rules: AttributeFilterRule[];
  fieldsLoading?: boolean;
  fieldsError?: string;
};
type RiskClassification = {
  min: number;
  label: string;
  color: string;
  textColor: string;
  softColor: string;
};

const IDENTIFY_TOLERANCE_PX = 3;
const DEFAULT_WIDGET_LAYOUT_X = 64;
const DEFAULT_WIDGET_LAYOUT_TOP = 16;
const DEFAULT_WIDGET_STACK_GAP = 12;
const DEFAULT_LAYER_PANEL_WIDTH = 360;
const DEFAULT_PANEL_EDGE_GAP = 16;
const INVENTORY_WIDGET_DEFAULT_POSITION: FloatingWidgetPosition = {
  x: DEFAULT_WIDGET_LAYOUT_X,
  y: DEFAULT_WIDGET_LAYOUT_TOP,
};
const INVENTORY_WIDGET_WIDTH = 380;
const INVENTORY_WIDGET_HEIGHT = 214;
const RISK_LIST_WIDGET_WIDTH = INVENTORY_WIDGET_WIDTH;
const RISK_LIST_WIDGET_HEIGHT = 524;
const RISK_LIST_WIDGET_DEFAULT_POSITION: FloatingWidgetPosition = {
  x: INVENTORY_WIDGET_DEFAULT_POSITION.x + INVENTORY_WIDGET_WIDTH + DEFAULT_WIDGET_STACK_GAP,
  y: DEFAULT_WIDGET_LAYOUT_TOP,
};
const RISK_HISTOGRAM_WIDGET_WIDTH = RISK_LIST_WIDGET_WIDTH;
const RISK_HISTOGRAM_WIDGET_HEIGHT = 480;
const RISK_HISTOGRAM_WIDGET_DEFAULT_POSITION: FloatingWidgetPosition = {
  x: INVENTORY_WIDGET_DEFAULT_POSITION.x,
  y: INVENTORY_WIDGET_DEFAULT_POSITION.y + INVENTORY_WIDGET_HEIGHT + DEFAULT_WIDGET_STACK_GAP,
};
const RISK_HISTOGRAM_BAR_COLOR = "#374151";
const RISK_SORT_OPTIONS: Array<{ value: RiskSortType; label: string }> = [
  { value: "total", label: "Total Risk" },
  { value: "condition", label: "Condition Risk" },
  { value: "flood", label: "Flooding Risk" },
  { value: "clog", label: "Clogging Risk" },
];
const RISK_ACCEPTABLE: Omit<RiskClassification, "min"> = {
  label: "Acceptable LOS",
  color: "#00b050",
  textColor: "#04743c",
  softColor: "rgba(0, 176, 80, .12)",
};
const RISK_DESIRED: Omit<RiskClassification, "min"> = {
  label: "Design/Maintenance Priority",
  color: "#ffff66",
  textColor: "#7a6a00",
  softColor: "rgba(255, 255, 102, .24)",
};
const RISK_CAPITAL: Omit<RiskClassification, "min"> = {
  label: "Capital Priority",
  color: "#ffc000",
  textColor: "#925800",
  softColor: "rgba(255, 192, 0, .18)",
};
const RISK_HIGH: Omit<RiskClassification, "min"> = {
  label: "High Priority",
  color: "#d00000",
  textColor: "#c30000",
  softColor: "rgba(208, 0, 0, .10)",
};
const CONDITION_RISK_CLASSIFICATION: RiskClassification[] = [
  { min: 0, ...RISK_ACCEPTABLE },
  { min: 15, ...RISK_DESIRED },
  { min: 30, ...RISK_CAPITAL },
  { min: 46, ...RISK_HIGH },
];
const FLOODING_RISK_CLASSIFICATION: RiskClassification[] = [
  { min: 0, ...RISK_ACCEPTABLE },
  { min: 29, ...RISK_DESIRED },
  { min: 49, ...RISK_CAPITAL },
  { min: 69, ...RISK_HIGH },
];
const CLOGGING_RISK_CLASSIFICATION: RiskClassification[] = [
  { min: 0, ...RISK_ACCEPTABLE },
  { min: 31, ...RISK_DESIRED },
  { min: 47, ...RISK_CAPITAL },
  { min: 86, ...RISK_HIGH },
];
const RISK_CLASSIFICATION_SCHEMES: Record<RiskSortType, RiskClassification[]> = {
  total: FLOODING_RISK_CLASSIFICATION,
  condition: CONDITION_RISK_CLASSIFICATION,
  flood: FLOODING_RISK_CLASSIFICATION,
  clog: CLOGGING_RISK_CLASSIFICATION,
};
const RISK_CITYWORKS_LAYER_OPTIONS: RiskLayerOption[] = [
  { id: "cityworks_all", label: "Cityworks Inspections - All", dataset_id: "cw_inspections_all_pt" },
  {
    id: "cityworks_unassigned",
    label: "Cityworks Inspections - Unassigned",
    dataset_id: "ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt",
  },
];
const RISK_ITPIPES_LAYER_OPTIONS: RiskLayerOption[] = [
  { id: "itpipes_top_risk", label: "ITPipes - Top Risk Defects", dataset_id: "itpipes_defects_top_risk_pt" },
  { id: "itpipes_all_defects_point", label: "ITPipes - All Defects - Point", dataset_id: "itpipes_defects_pt" },
  { id: "itpipes_all_defects_continuous", label: "ITPipes - All Defects - Continuous", dataset_id: "itpipes_defects_ln" },
];
const RISK_LIST_LAYER_OPTIONS = [
  ...RISK_CITYWORKS_LAYER_OPTIONS.map((option) => ({ ...option, group: "cityworks" as const })),
  ...RISK_ITPIPES_LAYER_OPTIONS.map((option) => ({ ...option, group: "itpipes" as const })),
];
const DEFAULT_RISK_LIST_LAYER_SELECTION: RiskLayerSelection = {
  cityworks: RISK_CITYWORKS_LAYER_OPTIONS[0].id,
  itpipes: RISK_ITPIPES_LAYER_OPTIONS[0].id,
};
const DEFAULT_RISK_HISTOGRAM_LAYER_SELECTION: RiskLayerSelection = {
  cityworks: RISK_CITYWORKS_LAYER_OPTIONS[0].id,
  itpipes: RISK_ITPIPES_LAYER_OPTIONS[1].id,
};
const TERRAIN_LOCAL_MIN_ZOOM = 10;
const TERRAIN_BOUNDS_BUFFER_DEGREES = 0.04;
const DUCKDB_GEOJSON_SOURCE_CONFIGS = [
  { sourceLayer: "culverts", datasetId: "culverts", sourceId: "duckdb-geojson-culverts", limit: 25_000 },
  { sourceLayer: "cw_inspections_all_pt", datasetId: "cw_inspections_all_pt", sourceId: "duckdb-geojson-cw-inspections-all-pt", limit: 25_000 },
  {
    sourceLayer: "ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt",
    datasetId: "ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt",
    sourceId: "duckdb-geojson-ur-scfilter-cwonly-all-unassigned-allrisk-0101-pt",
    limit: 25_000,
  },
  { sourceLayer: "itpipes_defects_top_risk_pt", datasetId: "itpipes_defects_top_risk_pt", sourceId: "duckdb-geojson-itpipes-defects-top-risk-pt", limit: 25_000 },
  { sourceLayer: "itpipes_defects_pt", datasetId: "itpipes_defects_pt", sourceId: "duckdb-geojson-itpipes-defects-pt", limit: 50_000 },
  { sourceLayer: "itpipes_defects_ln", datasetId: "itpipes_defects_ln", sourceId: "duckdb-geojson-itpipes-defects-ln", limit: 25_000 },
  { sourceLayer: "stormstructure_pt", datasetId: "stormstructure_pt", sourceId: "duckdb-geojson-stormstructure-pt", limit: 50_000 },
  { sourceLayer: "stormpipes_ln", datasetId: "stormpipes_ln", sourceId: "duckdb-geojson-stormpipes-ln", limit: 50_000 },
  { sourceLayer: "stormdrainage_ln", datasetId: "stormdrainage_ln", sourceId: "duckdb-geojson-stormdrainage-ln", limit: 50_000 },
] as const;
const DUCKDB_GEOJSON_CONFIG_BY_SOURCE_LAYER: ReadonlyMap<string, (typeof DUCKDB_GEOJSON_SOURCE_CONFIGS)[number]> = new Map(
  DUCKDB_GEOJSON_SOURCE_CONFIGS.map((config) => [config.sourceLayer, config]),
);
const INVENTORY_FILTER_TARGET_BY_DATASET: Record<string, string> = {
  stormstructure_pt: "active_structures",
  stormpipes_ln: "active_pipes",
  stormdrainage_ln: "active_drainages",
};
const ATTRIBUTE_FILTER_OPERATOR_OPTIONS: Array<{ value: AttributeFilterOperator; label: string; needsValue: boolean }> = [
  { value: "eq", label: "Equals", needsValue: true },
  { value: "ne", label: "Does not equal", needsValue: true },
  { value: "contains", label: "Contains", needsValue: true },
  { value: "starts_with", label: "Starts with", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gte", label: ">=", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "lte", label: "<=", needsValue: true },
  { value: "is_null", label: "Is empty", needsValue: false },
  { value: "is_not_null", label: "Is not empty", needsValue: false },
];
const COMMON_ATTRIBUTE_FILTER_FIELDS_BY_DATASET: Record<string, string[]> = {
  culverts: ["FacilityID", "AssetID", "Active", "Owner", "Status"],
  cw_inspections_all_pt: ["ITPIPE_ASSETID", "INSPECTIONID", "INVESTIGATIONID", "Inspection_Date", "RISK", "COND_RISK", "FLOOD_RISK", "CLOG_RISK"],
  ur_scfilter_cwonly_all_unassigned_allrisk_0101_pt: ["ITPIPE_ASSETID", "INSPECTIONID", "INVESTIGATIONID", "Inspection_Date", "RISK", "COND_RISK", "FLOOD_RISK", "CLOG_RISK"],
  itpipes_defects_top_risk_pt: ["ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID", "Inspection_Date", "Code", "Grade", "RISK", "COND_RISK", "FLOOD_RISK", "CLOG_RISK"],
  itpipes_defects_pt: ["ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID", "Inspection_Date", "Code", "Grade", "RISK", "COND_RISK", "FLOOD_RISK", "CLOG_RISK"],
  itpipes_defects_ln: ["ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID", "Inspection_Date", "Code", "Grade", "RISK", "COND_RISK", "FLOOD_RISK", "CLOG_RISK"],
  stormstructure_pt: ["AssetID", "ITPIPE_ASSETID", "Active", "Status", "StructureType"],
  stormpipes_ln: ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID", "Active", "Status", "shape_length"],
  stormdrainage_ln: ["AssetID", "ITPIPE_ASSETID", "US_ASSETID", "DS_ASSETID", "Active", "Status", "shape_length"],
};
const DRAW_SOURCE_ID = "user-drawings";
const DRAW_DRAFT_SOURCE_ID = "user-draw-draft";
const DRAW_FILL_LAYER_ID = "user-drawings-fill";
const DRAW_LINE_LAYER_ID = "user-drawings-line";
const DRAW_SELECTED_LINE_LAYER_ID = "user-drawings-selected-line";
const DRAW_DRAFT_FILL_LAYER_ID = "user-drawings-draft-fill";
const DRAW_DRAFT_LINE_LAYER_ID = "user-drawings-draft-line";
const DRAW_DRAFT_POINT_LAYER_ID = "user-drawings-draft-point";
const SEARCH_HIGHLIGHT_SOURCE_ID = "asset-search-highlight";
const SEARCH_HIGHLIGHT_LAYER_IDS = [
  "asset-search-highlight-fill",
  "asset-search-highlight-line",
  "asset-search-highlight-point",
] as const;
const DEFAULT_OPEN_LAYER_GROUPS = new Set(["risk data", "critical facilities", "storm water inventory"]);
const USGS_ATTRIBUTION = "USGS The National Map";
const NC_ONEMAP_ATTRIBUTION = "NC OneMap / State of North Carolina";
const NC_ONEMAP_IMAGERY_SERVICE_ROOT = "https://services.nconemap.gov/secure/rest/services/Imagery";
const NC_ONEMAP_ACQUISITION_MAPSERVER =
  "https://services.nconemap.gov/secure/rest/services/NC1Map_Ortho_Acquisition_Related/MapServer";
const MAP_PAGE_QUERY_PARAM = "map";
const THUMBNAIL_VIEW_QUERY_PARAM = "thumbnailView";
const THUMBNAIL_VIEW_PADDING = 92;
const THUMBNAIL_VIEW_BOUNDS_EXPANSION = 0.14;

function ncOneMapImageServerTiles(serviceName: string): string[] {
  return [
    `${NC_ONEMAP_IMAGERY_SERVICE_ROOT}/${serviceName}/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=jpgpng&transparent=false&f=image`,
  ];
}

function selectedMapIdFromUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get(MAP_PAGE_QUERY_PARAM)?.trim() || "";
}

function colorSchemeFromUrl(): ColorScheme {
  if (typeof window === "undefined") {
    return "light";
  }
  const params = new URLSearchParams(window.location.search);
  const requestedTheme = params.get("mapTheme") || params.get("theme");
  return requestedTheme === "dark" ? "dark" : "light";
}

function viewForThumbnailCapture(view: ViewConfig, manifest?: Manifest): ViewConfig {
  if (typeof window === "undefined") {
    return view;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get(THUMBNAIL_VIEW_QUERY_PARAM) !== "charlotte") {
    return view;
  }
  const charlotteBounds = normalizeBounds(manifest?.view?.bounds);
  if (!charlotteBounds) {
    return view;
  }
  const thumbnailBounds = expandThumbnailBounds(charlotteBounds, THUMBNAIL_VIEW_BOUNDS_EXPANSION);
  return {
    ...view,
    bounds: thumbnailBounds,
    protectedBounds: thumbnailBounds,
    padding: THUMBNAIL_VIEW_PADDING,
  };
}

function expandThumbnailBounds(bounds: Bounds, ratio: number): Bounds {
  const longitudePadding = ((bounds[2] - bounds[0]) * ratio) / 2;
  const latitudePadding = ((bounds[3] - bounds[1]) * ratio) / 2;
  return [
    bounds[0] - longitudePadding,
    bounds[1] - latitudePadding,
    bounds[2] + longitudePadding,
    bounds[3] + latitudePadding,
  ];
}

const BASEMAP_OPTIONS: BasemapOption[] = [
  {
    id: "cltex",
    name: "CLTEX",
    description: "Current project basemap",
    preview: "linear-gradient(135deg, #e9e2d5 0%, #f5f0e7 48%, #7aa7c7 49%, #e4edf1 100%)",
  },
  {
    id: "mecklenburg-aerial-2025",
    name: "Mecklenburg Aerial 2025",
    description: "Local county aerial imagery",
    preview: "linear-gradient(135deg, #32492d 0%, #72805f 42%, #a69375 43%, #435e69 100%)",
    sourceId: "basemap-mecklenburg-aerial-2025",
    layerId: "basemap-mecklenburg-aerial-2025",
    tiles: [
      "https://meckaerial.mecklenburgcountync.gov/server/rest/services/aerial2025/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=false&f=image",
    ],
    tileSize: 512,
    maxzoom: 20,
    attribution: "MeckCoGIS",
  },
  {
    id: "usgs-topo",
    name: "USGS Topo",
    description: "National topographic map",
    preview: "linear-gradient(135deg, #f1ead8 0%, #d3e0bd 42%, #8ab4ca 43%, #f7f2e7 100%)",
    sourceId: "basemap-usgs-topo",
    layerId: "basemap-usgs-topo",
    tiles: [
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    ],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: "usgs-imagery-topo",
    name: "USGS Imagery + Topo",
    description: "Imagery with topo reference",
    preview: "linear-gradient(135deg, #26351f 0%, #738463 38%, #d9ddc4 39%, #587082 100%)",
    sourceId: "basemap-usgs-imagery-topo",
    layerId: "basemap-usgs-imagery-topo",
    tiles: [
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
    ],
    tileSize: 256,
    maxzoom: 16,
    attribution: USGS_ATTRIBUTION,
  },
  {
    id: "nc-onemap-ortho-2010",
    name: "NC OneMap Ortho 2010",
    description: "Statewide 6-inch orthoimagery",
    preview: "linear-gradient(135deg, #31402f 0%, #8c946f 43%, #d1c2a0 44%, #60797b 100%)",
    sourceId: "basemap-nc-onemap-ortho-2010",
    layerId: "basemap-nc-onemap-ortho-2010",
    tiles: ncOneMapImageServerTiles("Orthoimagery_2010"),
    tileSize: 512,
    maxzoom: 20,
    attribution: NC_ONEMAP_ATTRIBUTION,
  },
  {
    id: "nc-onemap-ortho-2012-2015",
    name: "NC OneMap Ortho 2012-2015",
    description: "NC orthoimagery collection cycle",
    preview: "linear-gradient(135deg, #2f432e 0%, #75855d 41%, #cab98f 42%, #50696f 100%)",
    sourceId: "basemap-nc-onemap-ortho-2012-2015",
    layerId: "basemap-nc-onemap-ortho-2012-2015",
    tiles: ncOneMapImageServerTiles("Orthoimagery_2012_2015"),
    tileSize: 512,
    maxzoom: 20,
    attribution: NC_ONEMAP_ATTRIBUTION,
  },
  {
    id: "nc-onemap-ortho-2016-2019",
    name: "NC OneMap Ortho 2016-2019",
    description: "NC orthoimagery collection cycle",
    preview: "linear-gradient(135deg, #263924 0%, #697c54 40%, #bfae8a 41%, #405f68 100%)",
    sourceId: "basemap-nc-onemap-ortho-2016-2019",
    layerId: "basemap-nc-onemap-ortho-2016-2019",
    tiles: ncOneMapImageServerTiles("Orthoimagery_2016_2019"),
    tileSize: 512,
    maxzoom: 20,
    attribution: NC_ONEMAP_ATTRIBUTION,
  },
  {
    id: "nc-onemap-ortho-2020-2023",
    name: "NC OneMap Ortho 2020-2023",
    description: "NC orthoimagery collection cycle",
    preview: "linear-gradient(135deg, #23361f 0%, #6f8156 38%, #d3c29c 39%, #4c6970 100%)",
    sourceId: "basemap-nc-onemap-ortho-2020-2023",
    layerId: "basemap-nc-onemap-ortho-2020-2023",
    tiles: ncOneMapImageServerTiles("Orthoimagery_2020_2023"),
    tileSize: 512,
    maxzoom: 20,
    attribution: NC_ONEMAP_ATTRIBUTION,
  },
  {
    id: "nc-onemap-ortho-2024-2027",
    name: "NC OneMap Ortho 2024-2027",
    description: "Current cycle; includes released 2025 imagery",
    preview: "linear-gradient(135deg, #21351f 0%, #64784f 37%, #c6b68f 38%, #3d616a 100%)",
    sourceId: "basemap-nc-onemap-ortho-2024-2027",
    layerId: "basemap-nc-onemap-ortho-2024-2027",
    tiles: ncOneMapImageServerTiles("Orthoimagery_20242027"),
    tileSize: 512,
    maxzoom: 20,
    attribution: NC_ONEMAP_ATTRIBUTION,
  },
];

const NC_ONEMAP_ACQUISITION_OVERLAYS: ExternalOverlayOption[] = [
  {
    id: "nc-onemap-flight-lines-2010",
    name: "Flight Lines - 2010 Imagery",
    description: "NC OneMap acquisition flight lines",
    group: "NC OneMap Ortho Acquisition",
    sourceId: "overlay-nc-onemap-flight-lines-2010",
    layerId: "overlay-nc-onemap-flight-lines-2010",
    mapServerLayerId: 2,
    color: "#8f8f8f",
  },
  ...Array.from({ length: 14 }, (_, index) => {
    const year = 2012 + index;
    const layerId = 3 + index;
    return {
      id: `nc-onemap-ortho-seam-lines-${year}`,
      name: `Ortho Seam Lines - ${year} Imagery`,
      description: "NC OneMap imagery seam lines",
      group: "NC OneMap Ortho Acquisition",
      sourceId: `overlay-nc-onemap-ortho-seam-lines-${year}`,
      layerId: `overlay-nc-onemap-ortho-seam-lines-${year}`,
      mapServerLayerId: layerId,
      color: year >= 2024 ? "#1376d5" : "#71d7ff",
    };
  }),
];

type LayerTreeEntry = { type: "group"; node: LayerTreeNode } | { type: "layer"; layer: StyleLayer };

type LayerTreeNode = {
  key: string;
  name: string;
  entries: LayerTreeEntry[];
  childrenByKey: Map<string, LayerTreeNode>;
};

type MapPdfSelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  overlayWidth: number;
  overlayHeight: number;
};

type MapPdfExportDetails = {
  mapName: string;
  author: string;
};

type MapPdfScaleInfo = {
  groundWidthFeet: number;
  scaleBarFeet: number;
  scaleBarLabel: string;
  scaleBarWidthRatio: number;
};

type MapPdfSelectionDragMode = "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";

type MapPdfSelectionDragState = {
  pointerId: number;
  mode: MapPdfSelectionDragMode;
  startX: number;
  startY: number;
  startFrame: MapPdfSelectionRect;
};

export default function App() {
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const splitMapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const splitMapRef = useRef<MapLibreMap | null>(null);
  const activeStyleRef = useRef<MapStyle | null>(null);
  const splitMapSyncingRef = useRef(false);
  const protectedBoundsRef = useRef<Bounds | undefined>(undefined);
  const lastValidCameraRef = useRef<{
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  } | null>(null);
  const restoringProtectedViewRef = useRef(false);
  const assetSearchRequestRef = useRef(0);
  const inventoryMetricsRequestRef = useRef(0);
  const inventoryMetricsRefreshTimeoutRef = useRef<number | null>(null);
  const riskTopListRequestRef = useRef(0);
  const riskTopListRefreshTimeoutRef = useRef<number | null>(null);
  const riskListActiveTabRef = useRef("cityworks_all");
  const riskListLayerSelectionRef = useRef<RiskLayerSelection>(DEFAULT_RISK_LIST_LAYER_SELECTION);
  const riskSortTypeRef = useRef<RiskSortType>("condition");
  const duckDbGeoJsonRefreshRef = useRef<Record<string, number>>({});
  const duckDbGeoJsonLastKeyRef = useRef<Record<string, string>>({});
  const inventoryWidgetDragRef = useRef<FloatingWidgetDrag | null>(null);
  const inventoryWidgetOpenRef = useRef(false);
  const riskListWidgetDragRef = useRef<FloatingWidgetDrag | null>(null);
  const riskListWidgetOpenRef = useRef(false);
  const riskHistogramRequestRef = useRef(0);
  const riskHistogramRefreshTimeoutRef = useRef<number | null>(null);
  const riskHistogramWidgetDragRef = useRef<FloatingWidgetDrag | null>(null);
  const riskHistogramWidgetOpenRef = useRef(false);
  const riskHistogramLayerSelectionRef = useRef<RiskLayerSelection>(DEFAULT_RISK_HISTOGRAM_LAYER_SELECTION);
  const riskHistogramTypeRef = useRef<RiskSortType>("condition");
  const activeBasemapIdRef = useRef<BasemapId>("cltex");
  const basemapEnabledRef = useRef(true);
  const comparisonBasemapIdRef = useRef<BasemapId>("mecklenburg-aerial-2025");
  const comparisonBasemapEnabledRef = useRef(true);
  const layerVisibilityRef = useRef<Record<string, boolean>>({});
  const comparisonLayerVisibilityRef = useRef<Record<string, boolean>>({});
  const attributeFiltersRef = useRef<Record<string, LayerAttributeFilter>>({});
  const filterFieldsRequestRef = useRef(0);
  const searchFlashIntervalRef = useRef<number | null>(null);
  const searchFlashTimeoutRef = useRef<number | null>(null);
  const map3dEnabledRef = useRef(false);
  const middleMouseRotateRef = useRef<{
    map: MapLibreMap;
    startX: number;
    startY: number;
    startBearing: number;
    startPitch: number;
  } | null>(null);
  const middleMouseRotateCleanupRef = useRef<(() => void) | null>(null);
  const stopMiddleMouseRotateRef = useRef<(() => void) | null>(null);
  const drawFeaturesRef = useRef<DrawGeoJsonFeature[]>([]);
  const drawDraftFeaturesRef = useRef<DrawGeoJsonFeature[]>([]);
  const drawInteractionRef = useRef<DrawInteraction | null>(null);
  const drawModeActiveRef = useRef(false);
  const selectedDrawIdRef = useRef<string | null>(null);
  const drawToolRef = useRef<DrawTool>("select");
  const polygonClickRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const swipeDragRef = useRef<{ pointerId: number } | null>(null);
  const mapPdfSelectionDragRef = useRef<MapPdfSelectionDragState | null>(null);
  const mapPdfDetailsRef = useRef<MapPdfExportDetails>({
    mapName: "Storm Water Asset Risk Map",
    author: "",
  });
  const defaultWidgetLayoutAppliedRef = useRef(false);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedMapId, setSelectedMapId] = useState(() => selectedMapIdFromUrl());
  const [activeStyle, setActiveStyle] = useState<MapStyle | null>(null);
  const [activeView, setActiveView] = useState<ViewConfig>(DEFAULT_VIEW);
  const [activeBasemapId, setActiveBasemapId] = useState<BasemapId>("cltex");
  const [basemapEnabled, setBasemapEnabled] = useState(true);
  const [comparisonBasemapId, setComparisonBasemapId] = useState<BasemapId>("mecklenburg-aerial-2025");
  const [comparisonBasemapEnabled, setComparisonBasemapEnabled] = useState(true);
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [basemapPanelOpen, setBasemapPanelOpen] = useState(false);
  const [layerPanelTarget, setLayerPanelTarget] = useState<CompareTarget>("primary");
  const [basemapPanelTarget, setBasemapPanelTarget] = useState<CompareTarget>("primary");
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => colorSchemeFromUrl());
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>("single");
  const [mapViewMenuOpen, setMapViewMenuOpen] = useState(false);
  const [splitMapReadyCounter, setSplitMapReadyCounter] = useState(0);
  const [swipePosition, setSwipePosition] = useState(50);
  const [swipeDragging, setSwipeDragging] = useState(false);
  const [drawModeActive, setDrawModeActive] = useState(false);
  const [drawTool, setDrawTool] = useState<DrawTool>("select");
  const [drawFeatures, setDrawFeatures] = useState<DrawGeoJsonFeature[]>([]);
  const [selectedDrawId, setSelectedDrawId] = useState<string | null>(null);
  const [map3dEnabled, setMap3dEnabled] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetSearchResults, setAssetSearchResults] = useState<AssetSearchResult[]>([]);
  const [assetSearchOpen, setAssetSearchOpen] = useState(false);
  const [assetSearchLoading, setAssetSearchLoading] = useState(false);
  const [assetSearchMessage, setAssetSearchMessage] = useState("");
  const [assetSearchActiveIndex, setAssetSearchActiveIndex] = useState(0);
  const [inventoryMetrics, setInventoryMetrics] = useState<InventoryMetric[]>([]);
  const [inventoryMetricsLoading, setInventoryMetricsLoading] = useState(false);
  const [inventoryMetricsError, setInventoryMetricsError] = useState("");
  const [inventoryWidgetOpen, setInventoryWidgetOpen] = useState(false);
  const [inventoryWidgetPosition, setInventoryWidgetPosition] = useState<FloatingWidgetPosition>(INVENTORY_WIDGET_DEFAULT_POSITION);
  const [riskTopLists, setRiskTopLists] = useState<RiskTopList[]>([]);
  const [riskTopListLoading, setRiskTopListLoading] = useState(false);
  const [riskTopListError, setRiskTopListError] = useState("");
  const [riskListWidgetOpen, setRiskListWidgetOpen] = useState(false);
  const [riskListWidgetPosition, setRiskListWidgetPosition] = useState<FloatingWidgetPosition>(RISK_LIST_WIDGET_DEFAULT_POSITION);
  const [riskListActiveTab, setRiskListActiveTab] = useState("cityworks_all");
  const [riskSortType, setRiskSortType] = useState<RiskSortType>("condition");
  const [riskListLayerSelection, setRiskListLayerSelection] = useState<RiskLayerSelection>(DEFAULT_RISK_LIST_LAYER_SELECTION);
  const [riskHistograms, setRiskHistograms] = useState<RiskHistogram[]>([]);
  const [riskHistogramLoading, setRiskHistogramLoading] = useState(false);
  const [riskHistogramError, setRiskHistogramError] = useState("");
  const [riskHistogramWidgetOpen, setRiskHistogramWidgetOpen] = useState(false);
  const [riskHistogramWidgetPosition, setRiskHistogramWidgetPosition] = useState<FloatingWidgetPosition>(RISK_HISTOGRAM_WIDGET_DEFAULT_POSITION);
  const [riskHistogramType, setRiskHistogramType] = useState<RiskSortType>("condition");
  const [riskHistogramActiveLayer, setRiskHistogramActiveLayer] = useState(DEFAULT_RISK_HISTOGRAM_LAYER_SELECTION.cityworks);
  const [riskHistogramLayerSelection, setRiskHistogramLayerSelection] = useState<RiskLayerSelection>(DEFAULT_RISK_HISTOGRAM_LAYER_SELECTION);
  const [mapPdfExporting, setMapPdfExporting] = useState(false);
  const [mapPdfExportSelecting, setMapPdfExportSelecting] = useState(false);
  const [mapPdfDetailsOpen, setMapPdfDetailsOpen] = useState(false);
  const [mapPdfForm, setMapPdfForm] = useState<MapPdfExportDetails>(mapPdfDetailsRef.current);
  const [mapPdfSelectionFrame, setMapPdfSelectionFrame] = useState<MapPdfSelectionRect | null>(null);
  const [layerRecords, setLayerRecords] = useState<StyleLayer[]>([]);
  const [layerNameFilter, setLayerNameFilter] = useState("");
  const [layerVisibility, setLayerVisibilityState] = useState<Record<string, boolean>>({});
  const [comparisonLayerVisibility, setComparisonLayerVisibilityState] = useState<Record<string, boolean>>({});
  const [attributeFilters, setAttributeFilters] = useState<Record<string, LayerAttributeFilter>>({});
  const [layerFilterEditor, setLayerFilterEditor] = useState<LayerFilterEditorState | null>(null);
  const [currentZoom, setCurrentZoom] = useState(DEFAULT_VIEW.zoom);
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null);
  const [selectedFeatureOptions, setSelectedFeatureOptions] = useState<IdentifyFeature[]>([]);
  const [selectedFeatureOptionIndex, setSelectedFeatureOptionIndex] = useState(0);
  const [selectedFeatureGeometry, setSelectedFeatureGeometry] = useState<AssetSearchResult["geometry"]>(null);
  const [selectedFeatureStreetViewPoint, setSelectedFeatureStreetViewPoint] = useState<LngLatPair | null>(null);
  const [mapBearing, setMapBearing] = useState(0);
  const [northArrowDragging, setNorthArrowDragging] = useState(false);
  const northArrowDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPitch: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    let frameId = 0;
    let attempts = 0;
    const applyDefaultWidgetLayout = () => {
      if (defaultWidgetLayoutAppliedRef.current) {
        return;
      }
      const container = mapNodeRef.current?.closest("main") as HTMLElement | null;
      const containerRect = container?.getBoundingClientRect();
      if (!containerRect?.width && attempts < 30) {
        attempts += 1;
        frameId = window.requestAnimationFrame(applyDefaultWidgetLayout);
        return;
      }

      const leftX = DEFAULT_WIDGET_LAYOUT_X;
      const topY = DEFAULT_WIDGET_LAYOUT_TOP;
      const histogramY = topY + INVENTORY_WIDGET_HEIGHT + DEFAULT_WIDGET_STACK_GAP;
      const preferredRiskListX = containerRect?.width
        ? containerRect.width
          - DEFAULT_PANEL_EDGE_GAP
          - DEFAULT_LAYER_PANEL_WIDTH
          - DEFAULT_WIDGET_STACK_GAP
          - RISK_LIST_WIDGET_WIDTH
        : RISK_LIST_WIDGET_DEFAULT_POSITION.x;
      const minimumRiskListX = leftX + INVENTORY_WIDGET_WIDTH + DEFAULT_WIDGET_STACK_GAP;
      const riskListX = Math.max(minimumRiskListX, preferredRiskListX);

      defaultWidgetLayoutAppliedRef.current = true;
      setInventoryWidgetPosition({ x: leftX, y: topY });
      setRiskHistogramWidgetPosition({ x: leftX, y: histogramY });
      setRiskListWidgetPosition({ x: riskListX, y: topY });
      setPanelOpen(false);
      setBasemapPanelOpen(false);
    };

    frameId = window.requestAnimationFrame(applyDefaultWidgetLayout);
    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  useEffect(() => {
    riskListActiveTabRef.current = riskListActiveTab;
    riskListLayerSelectionRef.current = riskListLayerSelection;
    riskSortTypeRef.current = riskSortType;
    riskHistogramLayerSelectionRef.current = riskHistogramLayerSelection;
    riskHistogramTypeRef.current = riskHistogramType;
  }, [riskHistogramLayerSelection, riskHistogramType, riskListActiveTab, riskListLayerSelection, riskSortType]);

  useEffect(() => {
    registerPmtilesProtocol();
    fetchManifest()
      .then((payload) => {
        setManifest(payload);
        const mapIdFromUrl = selectedMapIdFromUrl();
        const defaultMap = payload.default_map_id && payload.maps.some((entry) => entry.id === payload.default_map_id)
          ? payload.default_map_id
          : payload.maps[0]?.id || "";
        const nextMapId = mapIdFromUrl && payload.maps.some((entry) => entry.id === mapIdFromUrl)
          ? mapIdFromUrl
          : defaultMap;
        setSelectedMapId(nextMapId);
      })
      .catch((error: Error) => showError(error));
  }, []);

  useEffect(() => {
    map3dEnabledRef.current = map3dEnabled;
  }, [map3dEnabled]);

  useEffect(() => {
    drawModeActiveRef.current = drawModeActive;
    if (!drawModeActive) {
      drawInteractionRef.current = null;
      polygonClickRef.current = null;
      drawDraftFeaturesRef.current = [];
      updateDrawDataOnMaps([mapRef.current, splitMapRef.current], drawFeaturesRef.current, [], selectedDrawIdRef.current);
      mapRef.current?.dragPan.enable();
      splitMapRef.current?.dragPan.enable();
      mapRef.current?.doubleClickZoom.enable();
      splitMapRef.current?.doubleClickZoom.enable();
    }
  }, [drawModeActive]);

  useEffect(() => {
    drawToolRef.current = drawTool;
    drawInteractionRef.current = null;
    polygonClickRef.current = null;
    drawDraftFeaturesRef.current = [];
    updateDrawDataOnMaps([mapRef.current, splitMapRef.current], drawFeaturesRef.current, [], selectedDrawIdRef.current);
    const shouldDisableDoubleClickZoom = drawModeActive && drawTool === "polygon";
    const shouldDisableDragPan = drawModeActive && (drawTool === "circle" || drawTool === "rectangle");
    [mapRef.current, splitMapRef.current].forEach((map) => {
      if (!map) {
        return;
      }
      if (shouldDisableDoubleClickZoom) {
        map.doubleClickZoom.disable();
      } else {
        map.doubleClickZoom.enable();
      }
      if (shouldDisableDragPan) {
        map.dragPan.disable();
      } else {
        map.dragPan.enable();
      }
    });
  }, [drawModeActive, drawTool]);

  useEffect(() => {
    layerVisibilityRef.current = layerVisibility;
  }, [layerVisibility]);

  useEffect(() => {
    comparisonLayerVisibilityRef.current = comparisonLayerVisibility;
  }, [comparisonLayerVisibility]);

  useEffect(() => {
    selectedDrawIdRef.current = selectedDrawId;
    updateDrawSelectionOnMaps([mapRef.current, splitMapRef.current], selectedDrawId);
  }, [selectedDrawId]);

  const selectedMap = useMemo(() => {
    return manifest?.maps.find((entry) => entry.id === selectedMapId) || manifest?.maps[0] || null;
  }, [manifest, selectedMapId]);

  const refreshInventoryMetrics = useCallback(() => {
    if (!inventoryWidgetOpenRef.current) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const bounds = map.getBounds();
    const bbox: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const requestId = ++inventoryMetricsRequestRef.current;
    setInventoryMetricsLoading(true);
    fetchInventoryMetrics(bbox, backendAttributeFilterPayload(attributeFiltersRef.current))
      .then((payload) => {
        if (inventoryMetricsRequestRef.current !== requestId) {
          return;
        }
        setInventoryMetrics(payload.metrics || []);
        setInventoryMetricsError("");
      })
      .catch((error: Error) => {
        if (inventoryMetricsRequestRef.current !== requestId) {
          return;
        }
        setInventoryMetricsError(error.message || "Inventory metrics are unavailable.");
      })
      .finally(() => {
        if (inventoryMetricsRequestRef.current === requestId) {
          setInventoryMetricsLoading(false);
        }
      });
  }, []);

  const scheduleInventoryMetricsRefresh = useCallback(
    (delay = 260) => {
      if (!inventoryWidgetOpenRef.current) {
        return;
      }
      if (inventoryMetricsRefreshTimeoutRef.current !== null) {
        window.clearTimeout(inventoryMetricsRefreshTimeoutRef.current);
      }
      inventoryMetricsRefreshTimeoutRef.current = window.setTimeout(() => {
        inventoryMetricsRefreshTimeoutRef.current = null;
        refreshInventoryMetrics();
      }, delay);
    },
    [refreshInventoryMetrics],
  );

  const updateRiskListLayerSelection = useCallback((group: RiskLayerGroup, layerId: string) => {
    setRiskListLayerSelection((current) => {
      const next = { ...current, [group]: layerId };
      riskListLayerSelectionRef.current = next;
      return next;
    });
    riskListActiveTabRef.current = layerId;
    setRiskListActiveTab(layerId);
  }, []);

  const updateRiskHistogramActiveLayer = useCallback((layerId: string) => {
    const layerOption = RISK_LIST_LAYER_OPTIONS.find((option) => option.id === layerId);
    if (!layerOption) {
      return;
    }
    setRiskHistogramActiveLayer(layerId);
    setRiskHistogramLayerSelection((current) => {
      const next = { ...current, [layerOption.group]: layerId };
      riskHistogramLayerSelectionRef.current = next;
      return next;
    });
  }, []);

  const updateRiskSortType = useCallback((risk: RiskSortType) => {
    riskSortTypeRef.current = risk;
    setRiskSortType(risk);
  }, []);

  const updateRiskHistogramType = useCallback((risk: RiskSortType) => {
    riskHistogramTypeRef.current = risk;
    setRiskHistogramType(risk);
  }, []);

  const refreshRiskTopList = useCallback(() => {
    if (!riskListWidgetOpenRef.current) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const bounds = map.getBounds();
    const bbox: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const requestId = ++riskTopListRequestRef.current;
    const selectedRisk = riskSortTypeRef.current;
    const selectedLayers = riskListLayerSelectionRef.current;
    setRiskTopListLoading(true);
    fetchRiskTopList(bbox, selectedRisk, selectedLayers, backendAttributeFilterPayload(attributeFiltersRef.current))
      .then((payload: RiskTopListResponse) => {
        if (riskTopListRequestRef.current !== requestId) {
          return;
        }
        setRiskTopLists(payload.lists || []);
        setRiskTopListError(payload.message || "");
        if (payload.lists?.length && !payload.lists.some((list) => list.id === riskListActiveTabRef.current)) {
          riskListActiveTabRef.current = payload.lists[0].id;
          setRiskListActiveTab(payload.lists[0].id);
        }
      })
      .catch((error: Error) => {
        if (riskTopListRequestRef.current !== requestId) {
          return;
        }
        setRiskTopListError(error.message || "Risk top list is unavailable.");
      })
      .finally(() => {
        if (riskTopListRequestRef.current === requestId) {
          setRiskTopListLoading(false);
        }
      });
  }, []);

  const scheduleRiskTopListRefresh = useCallback(
    (delay = 260) => {
      if (!riskListWidgetOpenRef.current) {
        return;
      }
      if (riskTopListRefreshTimeoutRef.current !== null) {
        window.clearTimeout(riskTopListRefreshTimeoutRef.current);
      }
      riskTopListRefreshTimeoutRef.current = window.setTimeout(() => {
        riskTopListRefreshTimeoutRef.current = null;
        refreshRiskTopList();
      }, delay);
    },
    [refreshRiskTopList],
  );

  const refreshRiskHistograms = useCallback(() => {
    if (!riskHistogramWidgetOpenRef.current) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const bounds = map.getBounds();
    const bbox: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    const requestId = ++riskHistogramRequestRef.current;
    const selectedRisk = riskHistogramTypeRef.current;
    const selectedLayers = riskHistogramLayerSelectionRef.current;
    setRiskHistogramLoading(true);
    fetchRiskHistograms(bbox, selectedRisk, selectedLayers, backendAttributeFilterPayload(attributeFiltersRef.current))
      .then((payload: RiskHistogramResponse) => {
        if (riskHistogramRequestRef.current !== requestId) {
          return;
        }
        const nextHistograms = payload.histograms || [];
        setRiskHistograms(nextHistograms);
        const nextCityworksLayer = nextHistograms.find((histogram) =>
          RISK_CITYWORKS_LAYER_OPTIONS.some((option) => option.id === histogram.id),
        )?.id;
        const nextItpipesLayer = nextHistograms.find((histogram) =>
          RISK_ITPIPES_LAYER_OPTIONS.some((option) => option.id === histogram.id),
        )?.id;
        if (nextCityworksLayer || nextItpipesLayer) {
          setRiskHistogramLayerSelection((current) => {
            const nextSelection = {
              cityworks: nextCityworksLayer || current.cityworks,
              itpipes: nextItpipesLayer || current.itpipes,
            };
            riskHistogramLayerSelectionRef.current = nextSelection;
            return nextSelection.cityworks === current.cityworks && nextSelection.itpipes === current.itpipes
              ? current
              : nextSelection;
          });
        }
        setRiskHistogramError(payload.message || "");
      })
      .catch((error: Error) => {
        if (riskHistogramRequestRef.current !== requestId) {
          return;
        }
        setRiskHistogramError(error.message || "Risk histograms are unavailable.");
      })
      .finally(() => {
        if (riskHistogramRequestRef.current === requestId) {
          setRiskHistogramLoading(false);
        }
      });
  }, []);

  const scheduleRiskHistogramRefresh = useCallback(
    (delay = 260) => {
      if (!riskHistogramWidgetOpenRef.current) {
        return;
      }
      if (riskHistogramRefreshTimeoutRef.current !== null) {
        window.clearTimeout(riskHistogramRefreshTimeoutRef.current);
      }
      riskHistogramRefreshTimeoutRef.current = window.setTimeout(() => {
        riskHistogramRefreshTimeoutRef.current = null;
        refreshRiskHistograms();
      }, delay);
    },
    [refreshRiskHistograms],
  );

  useEffect(() => {
    inventoryWidgetOpenRef.current = inventoryWidgetOpen;
    if (inventoryWidgetOpen) {
      scheduleInventoryMetricsRefresh(0);
    }
  }, [inventoryWidgetOpen, scheduleInventoryMetricsRefresh]);

  useEffect(() => {
    riskListWidgetOpenRef.current = riskListWidgetOpen;
    if (riskListWidgetOpen) {
      scheduleRiskTopListRefresh(0);
    }
  }, [riskListLayerSelection, riskListWidgetOpen, riskSortType, scheduleRiskTopListRefresh]);

  useEffect(() => {
    riskHistogramWidgetOpenRef.current = riskHistogramWidgetOpen;
    if (riskHistogramWidgetOpen) {
      scheduleRiskHistogramRefresh(0);
    }
  }, [riskHistogramLayerSelection, riskHistogramWidgetOpen, riskHistogramType, scheduleRiskHistogramRefresh]);

  useEffect(() => {
    return () => {
      if (inventoryMetricsRefreshTimeoutRef.current !== null) {
        window.clearTimeout(inventoryMetricsRefreshTimeoutRef.current);
      }
      if (riskTopListRefreshTimeoutRef.current !== null) {
        window.clearTimeout(riskTopListRefreshTimeoutRef.current);
      }
      if (riskHistogramRefreshTimeoutRef.current !== null) {
        window.clearTimeout(riskHistogramRefreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const query = assetSearch.trim();
    const requestId = ++assetSearchRequestRef.current;
    if (query.length < 2) {
      setAssetSearchResults([]);
      setAssetSearchLoading(false);
      setAssetSearchMessage("");
      setAssetSearchActiveIndex(0);
      return;
    }

    setAssetSearchLoading(true);
    setAssetSearchMessage("");
    const handle = window.setTimeout(() => {
      searchAssets(query, 12)
        .then((payload) => {
          if (assetSearchRequestRef.current !== requestId) {
            return;
          }
          setAssetSearchResults(payload.results || []);
          setAssetSearchActiveIndex(0);
          setAssetSearchMessage(
            payload.message || (payload.results?.length ? "" : "No matching asset or address"),
          );
          setAssetSearchOpen(true);
        })
        .catch((error: Error) => {
          if (assetSearchRequestRef.current !== requestId) {
            return;
          }
          setAssetSearchResults([]);
          setAssetSearchMessage(error.message || "Search backend unavailable");
          setAssetSearchOpen(true);
        })
        .finally(() => {
          if (assetSearchRequestRef.current === requestId) {
            setAssetSearchLoading(false);
          }
        });
    }, 220);

    return () => window.clearTimeout(handle);
  }, [assetSearch]);

  const currentStyleLayers = useCallback((): StyleLayer[] => {
    const styleLayers = (mapRef.current?.getStyle?.().layers || activeStyleRef.current?.layers || []) as StyleLayer[];
    return styleLayers;
  }, []);

  const getLayerVisibility = useCallback(
    (layerId: string): boolean => {
      try {
        if (mapRef.current?.getLayer(layerId)) {
          return mapRef.current.getLayoutProperty(layerId, "visibility") !== "none";
        }
      } catch {
        return true;
      }
      const styleLayer = currentStyleLayers().find((layer) => layer.id === layerId);
      return styleLayer?.layout?.visibility !== "none";
    },
    [currentStyleLayers],
  );

  const operationalLayers = useCallback((): StyleLayer[] => {
    return currentStyleLayers().filter((layer) => {
      return isUserOperationalLayer(layer);
    });
  }, [currentStyleLayers]);

  const refreshLayerPanel = useCallback(() => {
    const layers = operationalLayers().reverse();
    const nextVisibility = Object.fromEntries(
      currentStyleLayers().map((layer) => [layer.id, getLayerVisibility(layer.id)]),
    );
    setLayerRecords(layers);
    layerVisibilityRef.current = nextVisibility;
    setLayerVisibilityState(nextVisibility);
  }, [currentStyleLayers, getLayerVisibility, operationalLayers]);

  const updateRenderedFeatureMetric = useCallback(() => undefined, []);

  const refreshCurrentZoom = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const nextZoom = map.getZoom();
    setCurrentZoom((current) => (Math.abs(current - nextZoom) > 0.01 ? nextZoom : current));
  }, []);

  const refreshDuckDbGeoJsonSources = useCallback(
    (map: MapLibreMap | null) => {
      if (!map?.isStyleLoaded()) {
        return;
      }
      const layers = operationalLayers();
      const zoom = map.getZoom();
      const bbox = bufferedMapBounds(map);
      DUCKDB_GEOJSON_SOURCE_CONFIGS.forEach((config) => {
        const source = map.getSource(config.sourceId) as GeoJSONSource | undefined;
        if (!source) {
          return;
        }
        const hasVisibleLayer = layers.some((layer) => {
          if (layer.metadata?.duckdb_geojson_source !== config.sourceId || !map.getLayer(layer.id)) {
            return false;
          }
          const visible = map.getLayoutProperty(layer.id, "visibility") !== "none";
          return visible && layerVisibleAtZoom(layer, zoom);
        });
        if (!hasVisibleLayer) {
          if (duckDbGeoJsonLastKeyRef.current[config.sourceId] !== "empty") {
            source.setData(emptyDuckDbGeoJsonFeatureCollection() as unknown as Parameters<GeoJSONSource["setData"]>[0]);
            duckDbGeoJsonLastKeyRef.current[config.sourceId] = "empty";
          }
          return;
        }
        const filterPayload = backendAttributeFilterPayloadForTargets(attributeFiltersRef.current, [config.datasetId]);
        const requestKey = `${config.datasetId}:${bbox.map((value) => value.toFixed(5)).join(",")}:${zoom.toFixed(2)}:${attributeFilterPayloadSignature(filterPayload)}`;
        if (duckDbGeoJsonLastKeyRef.current[config.sourceId] === requestKey) {
          return;
        }
        duckDbGeoJsonLastKeyRef.current[config.sourceId] = requestKey;
        const requestId = (duckDbGeoJsonRefreshRef.current[config.sourceId] || 0) + 1;
        duckDbGeoJsonRefreshRef.current[config.sourceId] = requestId;
        fetchDuckDbGeoJson(config.datasetId, bbox, config.limit, filterPayload)
          .then((featureCollection) => {
            if (duckDbGeoJsonRefreshRef.current[config.sourceId] !== requestId) {
              return;
            }
            const nextSource = map.getSource(config.sourceId) as GeoJSONSource | undefined;
            nextSource?.setData(featureCollection as unknown as Parameters<GeoJSONSource["setData"]>[0]);
          })
          .catch((error: Error) => {
            console.warn(`Could not load DuckDB GeoJSON source ${config.datasetId}.`, error);
          });
      });
    },
    [operationalLayers],
  );

  const refreshDuckDbGeoJsonSourcesOnMaps = useCallback(() => {
    refreshDuckDbGeoJsonSources(mapRef.current);
    refreshDuckDbGeoJsonSources(splitMapRef.current);
  }, [refreshDuckDbGeoJsonSources]);

  const applyAttributeFiltersToMap = useCallback((map: MapLibreMap | null, filters = attributeFiltersRef.current) => {
    if (!map?.isStyleLoaded()) {
      return;
    }
    ((map.getStyle().layers || []) as StyleLayer[]).forEach((layer) => {
      if (!canLayerReceiveAttributeFilter(layer) || !map.getLayer(layer.id)) {
        return;
      }
      const target = layerFilterTarget(layer, true);
      if (!target) {
        return;
      }
      const rules = filters[target.key]?.rules || [];
      const baseFilter = baseMaplibreFilterForLayer(activeStyleRef.current, layer.id);
      const userFilter = maplibreAttributeFilterForRules(rules, target.fields);
      const combinedFilter = combineMaplibreFilters(baseFilter, userFilter);
      try {
        map.setFilter(layer.id, (combinedFilter || undefined) as never);
      } catch (error) {
        console.warn(`Could not apply attribute filter to ${layer.id}.`, error);
      }
    });
  }, []);

  const applyAttributeFiltersToMaps = useCallback((filters = attributeFiltersRef.current) => {
    applyAttributeFiltersToMap(mapRef.current, filters);
    applyAttributeFiltersToMap(splitMapRef.current, filters);
  }, [applyAttributeFiltersToMap]);

  useEffect(() => {
    attributeFiltersRef.current = attributeFilters;
    duckDbGeoJsonLastKeyRef.current = {};
    applyAttributeFiltersToMaps(attributeFilters);
    refreshDuckDbGeoJsonSourcesOnMaps();
    updateRenderedFeatureMetric();
    scheduleInventoryMetricsRefresh(0);
    scheduleRiskTopListRefresh(0);
    scheduleRiskHistogramRefresh(0);
  }, [
    applyAttributeFiltersToMaps,
    attributeFilters,
    refreshDuckDbGeoJsonSourcesOnMaps,
    scheduleInventoryMetricsRefresh,
    scheduleRiskHistogramRefresh,
    scheduleRiskTopListRefresh,
    updateRenderedFeatureMetric,
  ]);

  const rememberValidCamera = useCallback(() => {
    const map = mapRef.current;
    if (!map || (protectedBoundsRef.current && !mapBoundsIntersectProtectedBounds(map, protectedBoundsRef.current))) {
      return;
    }
    const center = map.getCenter();
    lastValidCameraRef.current = {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  }, []);

  const enforceProtectedBounds = useCallback(() => {
    const map = mapRef.current;
    const protectedBounds = protectedBoundsRef.current;
    if (!map || !protectedBounds || restoringProtectedViewRef.current) {
      return;
    }
    if (mapBoundsIntersectProtectedBounds(map, protectedBounds)) {
      rememberValidCamera();
      return;
    }

    restoringProtectedViewRef.current = true;
    if (lastValidCameraRef.current) {
      map.easeTo({ ...lastValidCameraRef.current, duration: 180 });
    } else {
      map.fitBounds(boundsToLngLatBounds(protectedBounds), {
        padding: viewPadding(activeView),
        duration: 180,
      });
    }
    map.once("moveend", () => {
      restoringProtectedViewRef.current = false;
      rememberValidCamera();
    });
  }, [activeView, rememberValidCamera]);

  const configureNavigationConstraints = useCallback((view: ViewConfig) => {
    protectedBoundsRef.current = view.protectedBounds || view.bounds;
    if (mapRef.current && Number.isFinite(view.minZoom)) {
      mapRef.current.setMinZoom(view.minZoom || 0);
    }
    lastValidCameraRef.current = null;
  }, []);

  const showClickedFeature = useCallback(
    (event: MapMouseEvent) => {
      if (drawModeActiveRef.current) {
        return;
      }
      const map = mapRef.current;
      if (!map?.isStyleLoaded()) {
        return;
      }
      const orderedLayers = operationalLayers()
        .reverse()
        .filter((layer) => getLayerVisibility(layer.id) && layer.type !== "raster")
      const orderByLayerId = new Map(orderedLayers.map((layer, index) => [layer.id, index]));
      const queryLayers = orderedLayers.map((layer) => layer.id);
      const queryBox: [[number, number], [number, number]] = [
        [event.point.x - IDENTIFY_TOLERANCE_PX, event.point.y - IDENTIFY_TOLERANCE_PX],
        [event.point.x + IDENTIFY_TOLERANCE_PX, event.point.y + IDENTIFY_TOLERANCE_PX],
      ];
      const features = queryLayers.length ? map.queryRenderedFeatures(queryBox, { layers: queryLayers }) : [];
      const identifyFeatures = dedupeIdentifyFeatures(
        features
          .map((feature, originalIndex) => {
            const layer = map.getLayer(feature.layer.id) as StyleLayer | undefined;
            return identifyFeatureFromMapFeature(feature, layer, orderByLayerId.get(feature.layer.id) ?? 9999, originalIndex);
          })
          .sort((left, right) => left.order - right.order || left.originalIndex - right.originalIndex),
      ).slice(0, 10);

      if (!identifyFeatures.length) {
        setSelectedFeature(null);
        setSelectedFeatureOptions([]);
        setSelectedFeatureOptionIndex(0);
        setSelectedFeatureGeometry(null);
        setSelectedFeatureStreetViewPoint(null);
        return;
      }

      setSelectedFeatureOptions(identifyFeatures);
      setSelectedFeatureOptionIndex(0);
      setSelectedFeature(selectedFeatureFromIdentifyFeature(identifyFeatures[0]));
      setSelectedFeatureGeometry(identifyFeatures[0].geometry || null);
      setSelectedFeatureStreetViewPoint([event.lngLat.lng, event.lngLat.lat]);
    },
    [getLayerVisibility, operationalLayers],
  );

  const syncDrawData = useCallback((draftFeatures = drawDraftFeaturesRef.current) => {
    updateDrawDataOnMaps([mapRef.current, splitMapRef.current], drawFeaturesRef.current, draftFeatures, selectedDrawIdRef.current);
  }, []);

  const setDraftDrawFeatures = useCallback(
    (features: DrawGeoJsonFeature[]) => {
      drawDraftFeaturesRef.current = features;
      syncDrawData(features);
    },
    [syncDrawData],
  );

  const commitDrawFeature = useCallback(
    (shape: DrawShape, geometry: DrawGeometry) => {
      const id = `draw-${Date.now()}-${Math.round(Math.random() * 100000)}`;
      const feature: DrawGeoJsonFeature = {
        type: "Feature",
        id,
        properties: {
          id,
          shape,
          label: shapeLabel(shape),
        },
        geometry,
      };
      const nextFeatures = [...drawFeaturesRef.current, feature];
      drawFeaturesRef.current = nextFeatures;
      drawDraftFeaturesRef.current = [];
      drawInteractionRef.current = null;
      setDrawFeatures(nextFeatures);
      setSelectedDrawId(id);
      updateDrawDataOnMaps([mapRef.current, splitMapRef.current], nextFeatures, [], id);
    },
    [],
  );

  const finishPolygonDraw = useCallback((finalPoint?: LngLatPair) => {
    const interaction = drawInteractionRef.current;
    if (!interaction || interaction.tool !== "polygon") {
      return;
    }
    const rawPoints = finalPoint && !sameLngLat(interaction.points[interaction.points.length - 1], finalPoint)
      ? [...interaction.points, finalPoint]
      : interaction.points;
    const points = removeNearbyDuplicatePoints(rawPoints);
    if (points.length < 3) {
      drawInteractionRef.current = null;
      polygonClickRef.current = null;
      setDraftDrawFeatures([]);
      return;
    }
    polygonClickRef.current = null;
    commitDrawFeature("polygon", polygonGeometry(points));
    setDraftDrawFeatures([]);
  }, [commitDrawFeature, setDraftDrawFeatures]);

  const handleDrawClick = useCallback(
    (event: MapMouseEvent) => {
      if (!drawModeActiveRef.current) {
        return;
      }
      const map = event.target as MapLibreMap;
      const tool = drawToolRef.current;
      event.preventDefault();

      if (tool === "select") {
        const selectableLayers = [DRAW_SELECTED_LINE_LAYER_ID, DRAW_LINE_LAYER_ID, DRAW_FILL_LAYER_ID].filter((layerId) => map.getLayer(layerId));
        const features = selectableLayers.length ? map.queryRenderedFeatures(event.point, { layers: selectableLayers }) : [];
        const featureId = firstDrawFeatureId(features);
        setSelectedDrawId(featureId);
        updateDrawDataOnMaps([mapRef.current, splitMapRef.current], drawFeaturesRef.current, drawDraftFeaturesRef.current, featureId);
        return;
      }

      if (tool !== "polygon") {
        return;
      }

      const point: LngLatPair = [event.lngLat.lng, event.lngLat.lat];
      const current = drawInteractionRef.current?.tool === "polygon" ? drawInteractionRef.current.points : [];
      const now = window.performance.now();
      const previousClick = polygonClickRef.current;
      const isDoubleClickFinish =
        current.length >= 3 &&
        previousClick !== null &&
        now - previousClick.time <= 520 &&
        Math.hypot(previousClick.x - event.point.x, previousClick.y - event.point.y) <= 8;
      if (isDoubleClickFinish) {
        event.originalEvent.preventDefault();
        event.originalEvent.stopPropagation();
        finishPolygonDraw(point);
        return;
      }

      const nextPoints = [...current, point];
      drawInteractionRef.current = { tool: "polygon", points: nextPoints };
      polygonClickRef.current = {
        time: now,
        x: event.point.x,
        y: event.point.y,
      };
      setSelectedDrawId(null);
      setDraftDrawFeatures(polygonDraftFeatures(nextPoints, nextPoints.length >= 3));
    },
    [finishPolygonDraw, setDraftDrawFeatures],
  );

  const handleDrawDoubleClick = useCallback(
    (event: MapMouseEvent) => {
      if (!drawModeActiveRef.current || drawToolRef.current !== "polygon") {
        return;
      }
      event.preventDefault();
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      polygonClickRef.current = null;
      finishPolygonDraw([event.lngLat.lng, event.lngLat.lat]);
    },
    [finishPolygonDraw],
  );

  const handleDrawMouseDown = useCallback(
    (event: MapMouseEvent) => {
      if (!drawModeActiveRef.current || (drawToolRef.current !== "circle" && drawToolRef.current !== "rectangle")) {
        return;
      }
      event.preventDefault();
      const map = event.target as MapLibreMap;
      map.dragPan.disable();
      drawInteractionRef.current = {
        tool: drawToolRef.current,
        start: [event.lngLat.lng, event.lngLat.lat],
        moved: false,
      };
      setSelectedDrawId(null);
      setDraftDrawFeatures([]);
    },
    [setDraftDrawFeatures],
  );

  const handleDrawMouseMove = useCallback(
    (event: MapMouseEvent) => {
      if (!drawModeActiveRef.current) {
        return;
      }
      const interaction = drawInteractionRef.current;
      if (!interaction) {
        return;
      }
      if (interaction.tool === "polygon") {
        if (!interaction.points.length) {
          return;
        }
        const hoverPoint: LngLatPair = [event.lngLat.lng, event.lngLat.lat];
        setDraftDrawFeatures(polygonDraftFeatures([...interaction.points, hoverPoint], true));
        return;
      }
      const edgePoint: LngLatPair = [event.lngLat.lng, event.lngLat.lat];
      interaction.moved = true;
      const geometry = interaction.tool === "rectangle"
        ? rectangleGeometry(interaction.start, edgePoint)
        : circleGeometry(interaction.start, edgePoint);
      setDraftDrawFeatures([{ type: "Feature", properties: { shape: interaction.tool, draft: true }, geometry }]);
    },
    [setDraftDrawFeatures],
  );

  const handleDrawMouseUp = useCallback(
    (event: MapMouseEvent) => {
      const interaction = drawInteractionRef.current;
      if (!drawModeActiveRef.current || !interaction || interaction.tool === "polygon") {
        return;
      }
      event.preventDefault();
      const map = event.target as MapLibreMap;
      const edgePoint: LngLatPair = [event.lngLat.lng, event.lngLat.lat];
      const geometry = interaction.tool === "rectangle"
        ? rectangleGeometry(interaction.start, edgePoint)
        : circleGeometry(interaction.start, edgePoint);
      if (interaction.moved && geometryAreaHint(geometry) > 0) {
        commitDrawFeature(interaction.tool, geometry);
      }
      drawInteractionRef.current = null;
      setDraftDrawFeatures([]);
      if (drawModeActiveRef.current && (drawToolRef.current === "circle" || drawToolRef.current === "rectangle")) {
        map.dragPan.disable();
      }
    },
    [commitDrawFeature, setDraftDrawFeatures],
  );

  const deleteSelectedDrawFeature = useCallback(() => {
    if (!selectedDrawId) {
      return;
    }
    const nextFeatures = drawFeaturesRef.current.filter((feature) => feature.properties.id !== selectedDrawId);
    drawFeaturesRef.current = nextFeatures;
    setDrawFeatures(nextFeatures);
    setSelectedDrawId(null);
    updateDrawDataOnMaps([mapRef.current, splitMapRef.current], nextFeatures, drawDraftFeaturesRef.current, null);
  }, [selectedDrawId]);

  const clearDrawFeatures = useCallback(() => {
    drawFeaturesRef.current = [];
    drawDraftFeaturesRef.current = [];
    drawInteractionRef.current = null;
    setDrawFeatures([]);
    setSelectedDrawId(null);
    updateDrawDataOnMaps([mapRef.current, splitMapRef.current], [], [], null);
  }, []);

  const selectFeatureOption = useCallback((index: number) => {
    const feature = selectedFeatureOptions[index];
    if (!feature) {
      return;
    }
    setSelectedFeatureOptionIndex(index);
    setSelectedFeature(selectedFeatureFromIdentifyFeature(feature));
    setSelectedFeatureGeometry(feature.geometry || null);
  }, [selectedFeatureOptions]);

  const clearSearchFlash = useCallback(() => {
    if (searchFlashIntervalRef.current !== null) {
      window.clearInterval(searchFlashIntervalRef.current);
      searchFlashIntervalRef.current = null;
    }
  if (searchFlashTimeoutRef.current !== null) {
      window.clearTimeout(searchFlashTimeoutRef.current);
      searchFlashTimeoutRef.current = null;
    }
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) {
      return;
    }
    removeSearchHighlightLayers(map);
  }, []);

  const flashGeoJsonFeature = useCallback(
    (feature: Record<string, unknown> | null) => {
      const map = mapRef.current;
      if (!map?.isStyleLoaded() || !feature) {
        return;
      }
      clearSearchFlash();
      ensureSearchHighlightLayers(map);
      const source = map.getSource(SEARCH_HIGHLIGHT_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(
        {
          type: "FeatureCollection",
          features: [feature],
        } as unknown as Parameters<GeoJSONSource["setData"]>[0],
      );
      let visible = true;
      setSearchHighlightOpacity(map, 1);
      searchFlashIntervalRef.current = window.setInterval(() => {
        visible = !visible;
        setSearchHighlightOpacity(map, visible ? 1 : 0.12);
      }, 140);
      searchFlashTimeoutRef.current = window.setTimeout(() => {
        clearSearchFlash();
      }, 1000);
    },
    [clearSearchFlash],
  );

  const flashSearchResult = useCallback(
    (result: AssetSearchResult) => {
      flashGeoJsonFeature(searchResultToFeature(result));
    },
    [flashGeoJsonFeature],
  );

  const flashSelectedFeature = useCallback(() => {
    flashGeoJsonFeature(geometryToHighlightFeature(selectedFeatureGeometry, { source: "selected-feature" }));
  }, [flashGeoJsonFeature, selectedFeatureGeometry]);
  const selectedFeatureStreetViewUrl = useMemo(() => {
    const point = selectedFeatureStreetViewPoint || geometryStreetViewPoint(selectedFeatureGeometry);
    return point ? googleStreetViewUrl(point) : null;
  }, [selectedFeatureGeometry, selectedFeatureStreetViewPoint]);
  const openSelectedFeatureStreetView = useCallback(() => {
    if (!selectedFeatureStreetViewUrl) {
      return;
    }
    window.open(selectedFeatureStreetViewUrl, "_blank", "noopener,noreferrer");
  }, [selectedFeatureStreetViewUrl]);

  const zoomToSearchResult = useCallback((result: AssetSearchResult) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const bounds = searchResultBounds(result);
    if (!bounds) {
      return;
    }
    const isPointLike = Math.abs(bounds[0] - bounds[2]) < 0.000001 && Math.abs(bounds[1] - bounds[3]) < 0.000001;
    if (isPointLike) {
      map.easeTo({
        center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        zoom: Math.max(map.getZoom(), 17),
        duration: 600,
      });
      return;
    }
    map.fitBounds(boundsToLngLatBounds(bounds), {
      padding: 72,
      duration: 650,
      maxZoom: 17,
    });
  }, []);

  const selectAssetSearchResult = useCallback(
    (result: AssetSearchResult) => {
      setAssetSearch(result.label);
      setAssetSearchOpen(false);
      setAssetSearchMessage("");
      setSelectedFeature(selectedFeatureFromSearchResult(result));
      setSelectedFeatureOptions([]);
      setSelectedFeatureOptionIndex(0);
      setSelectedFeatureGeometry(searchResultGeometry(result));
      setSelectedFeatureStreetViewPoint(null);
      zoomToSearchResult(result);
      flashSearchResult(result);
    },
    [flashSearchResult, zoomToSearchResult],
  );

  const zoomToRiskTopListItem = useCallback((item: RiskTopListItem) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const bounds = validSearchBounds(item.bbox) ? item.bbox : geometryBounds(item.geometry || undefined);
    if (!bounds) {
      return;
    }
    const isPointLike = Math.abs(bounds[0] - bounds[2]) < 0.000001 && Math.abs(bounds[1] - bounds[3]) < 0.000001;
    if (isPointLike) {
      map.easeTo({
        center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        zoom: Math.max(map.getZoom(), 17),
        duration: 600,
      });
      return;
    }
    map.fitBounds(boundsToLngLatBounds(bounds), {
      padding: 72,
      duration: 650,
      maxZoom: 17,
    });
  }, []);

  const selectRiskTopListItem = useCallback(
    (item: RiskTopListItem) => {
      setSelectedFeature(selectedFeatureFromRiskTopListItem(item));
      setSelectedFeatureOptions([]);
      setSelectedFeatureOptionIndex(0);
      setSelectedFeatureGeometry(riskTopListItemGeometry(item));
      setSelectedFeatureStreetViewPoint(null);
      zoomToRiskTopListItem(item);
      flashGeoJsonFeature(riskTopListItemToFeature(item));
    },
    [flashGeoJsonFeature, zoomToRiskTopListItem],
  );

  const handleAssetSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        setAssetSearchOpen(false);
        return;
      }
      if (!assetSearchResults.length) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAssetSearchActiveIndex((index) => Math.min(index + 1, assetSearchResults.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setAssetSearchActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        selectAssetSearchResult(assetSearchResults[assetSearchActiveIndex] || assetSearchResults[0]);
      }
    },
    [assetSearchActiveIndex, assetSearchResults, selectAssetSearchResult],
  );

  const rotateMapFromNorthArrowPointer = useCallback((clientX: number, clientY: number, element: HTMLElement) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) < 8) {
      return;
    }
    const arrowAngle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const nextBearing = normalizeBearing(-arrowAngle);
    map.rotateTo(nextBearing, { duration: 0 });
    setMapBearing(nextBearing);
  }, []);

  const tiltMapFromNorthArrowPointer = useCallback((clientY: number) => {
    const map = mapRef.current;
    const drag = northArrowDragRef.current;
    if (!map || !drag || !map3dEnabledRef.current) {
      return;
    }
    const nextPitch = clampNumber(drag.startPitch - (clientY - drag.startY) * 0.35, 0, 70);
    map.setPitch(nextPitch);
  }, []);

  const handleNorthArrowPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    northArrowDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPitch: mapRef.current?.getPitch() ?? 0,
      moved: false,
    };
    setNorthArrowDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleNorthArrowPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = northArrowDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
        drag.moved = true;
      }
      if (drag.moved) {
        rotateMapFromNorthArrowPointer(event.clientX, event.clientY, event.currentTarget);
        tiltMapFromNorthArrowPointer(event.clientY);
      }
    },
    [rotateMapFromNorthArrowPointer, tiltMapFromNorthArrowPointer],
  );

  const handleNorthArrowPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = northArrowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    northArrowDragRef.current = null;
    setNorthArrowDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      mapRef.current?.rotateTo(0, { duration: 250 });
      setMapBearing(0);
    }
  }, []);

  const handleNorthArrowPointerCancel = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = northArrowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    northArrowDragRef.current = null;
    setNorthArrowDragging(false);
  }, []);

  const enableMiddleMouse3dRotation = useCallback((map: MapLibreMap) => {
    middleMouseRotateCleanupRef.current?.();

    const canvas = map.getCanvas();
    const stopRotation = () => {
      middleMouseRotateRef.current = null;
      canvas.style.cursor = "";
      window.removeEventListener("mousemove", handleMouseMove, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("blur", stopRotation);
    };
    const handleMouseMove = (event: MouseEvent) => {
      const drag = middleMouseRotateRef.current;
      if (!drag || drag.map !== map) {
        return;
      }
      if ((event.buttons & 4) === 0) {
        stopRotation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      map.jumpTo({
        bearing: normalizeBearing(drag.startBearing + (event.clientX - drag.startX) * 0.35),
        pitch: clampNumber(drag.startPitch - (event.clientY - drag.startY) * 0.3, 0, 70),
      });
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 1 || middleMouseRotateRef.current?.map !== map) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stopRotation();
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 1 || !map3dEnabledRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      middleMouseRotateRef.current = {
        map,
        startX: event.clientX,
        startY: event.clientY,
        startBearing: map.getBearing(),
        startPitch: map.getPitch(),
      };
      canvas.style.cursor = "grabbing";
      window.addEventListener("mousemove", handleMouseMove, true);
      window.addEventListener("mouseup", handleMouseUp, true);
      window.addEventListener("blur", stopRotation);
    };
    const preventMiddleAuxClick = (event: MouseEvent) => {
      if (event.button === 1 && map3dEnabledRef.current) {
        event.preventDefault();
      }
    };

    canvas.addEventListener("mousedown", handleMouseDown, true);
    canvas.addEventListener("auxclick", preventMiddleAuxClick, true);
    stopMiddleMouseRotateRef.current = stopRotation;
    middleMouseRotateCleanupRef.current = () => {
      stopRotation();
      canvas.removeEventListener("mousedown", handleMouseDown, true);
      canvas.removeEventListener("auxclick", preventMiddleAuxClick, true);
      if (stopMiddleMouseRotateRef.current === stopRotation) {
        stopMiddleMouseRotateRef.current = null;
      }
    };
  }, []);

  const handleInventoryWidgetPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      inventoryWidgetDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPosition: inventoryWidgetPosition,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [inventoryWidgetPosition],
  );

  const handleInventoryWidgetPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = inventoryWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const container = mapNodeRef.current?.closest("main") as HTMLElement | null;
    const containerRect = container?.getBoundingClientRect();
    const nextPosition = {
      x: drag.startPosition.x + event.clientX - drag.startX,
      y: drag.startPosition.y + event.clientY - drag.startY,
    };
    setInventoryWidgetPosition(
      containerRect
        ? clampFloatingWidgetPosition(nextPosition, containerRect, INVENTORY_WIDGET_WIDTH, INVENTORY_WIDGET_HEIGHT)
        : nextPosition,
    );
  }, []);

  const finishInventoryWidgetDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = inventoryWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    inventoryWidgetDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleRiskListWidgetPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      riskListWidgetDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPosition: riskListWidgetPosition,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [riskListWidgetPosition],
  );

  const handleRiskListWidgetPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = riskListWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const container = mapNodeRef.current?.closest("main") as HTMLElement | null;
    const containerRect = container?.getBoundingClientRect();
    const nextPosition = {
      x: drag.startPosition.x + event.clientX - drag.startX,
      y: drag.startPosition.y + event.clientY - drag.startY,
    };
    setRiskListWidgetPosition(
      containerRect
        ? clampFloatingWidgetPosition(nextPosition, containerRect, RISK_LIST_WIDGET_WIDTH, RISK_LIST_WIDGET_HEIGHT)
        : nextPosition,
    );
  }, []);

  const finishRiskListWidgetDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = riskListWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    riskListWidgetDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleRiskHistogramWidgetPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      riskHistogramWidgetDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPosition: riskHistogramWidgetPosition,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [riskHistogramWidgetPosition],
  );

  const handleRiskHistogramWidgetPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = riskHistogramWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const container = mapNodeRef.current?.closest("main") as HTMLElement | null;
    const containerRect = container?.getBoundingClientRect();
    const nextPosition = {
      x: drag.startPosition.x + event.clientX - drag.startX,
      y: drag.startPosition.y + event.clientY - drag.startY,
    };
    setRiskHistogramWidgetPosition(
      containerRect
        ? clampFloatingWidgetPosition(nextPosition, containerRect, RISK_HISTOGRAM_WIDGET_WIDTH, RISK_HISTOGRAM_WIDGET_HEIGHT)
        : nextPosition,
    );
  }, []);

  const finishRiskHistogramWidgetDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = riskHistogramWidgetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    riskHistogramWidgetDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const setSwipePositionFromClientX = useCallback((clientX: number) => {
    const container = mapNodeRef.current?.parentElement;
    if (!container) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    const nextPosition = clampNumber(((clientX - bounds.left) / bounds.width) * 100, 8, 92);
    setSwipePosition(nextPosition);
  }, []);

  const handleSwipePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      swipeDragRef.current = { pointerId: event.pointerId };
      setSwipeDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      setSwipePositionFromClientX(event.clientX);
    },
    [setSwipePositionFromClientX],
  );

  const handleSwipePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = swipeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSwipePositionFromClientX(event.clientX);
    },
    [setSwipePositionFromClientX],
  );

  const finishSwipeDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = swipeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      swipeDragRef.current = null;
      setSwipeDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setSwipePositionFromClientX(event.clientX);
    },
    [setSwipePositionFromClientX],
  );

  const applyBasemapSelection = useCallback((basemapId: BasemapId, visible: boolean) => {
    applyBasemapSelectionToMap(mapRef.current, basemapId, visible);
  }, []);

  const applyComparisonBasemapSelection = useCallback((basemapId: BasemapId, visible: boolean) => {
    applyBasemapSelectionToMap(splitMapRef.current, basemapId, visible);
  }, []);

  const selectBasemap = useCallback(
    (basemapId: BasemapId) => {
      activeBasemapIdRef.current = basemapId;
      basemapEnabledRef.current = true;
      setActiveBasemapId(basemapId);
      setBasemapEnabled(true);
      applyBasemapSelection(basemapId, true);
    },
    [applyBasemapSelection],
  );

  const setBasemapVisibility = useCallback(
    (visible: boolean) => {
      basemapEnabledRef.current = visible;
      setBasemapEnabled(visible);
      applyBasemapSelection(activeBasemapIdRef.current, visible);
    },
    [applyBasemapSelection],
  );

  const selectComparisonBasemap = useCallback(
    (basemapId: BasemapId) => {
      comparisonBasemapIdRef.current = basemapId;
      comparisonBasemapEnabledRef.current = true;
      setComparisonBasemapId(basemapId);
      setComparisonBasemapEnabled(true);
      applyComparisonBasemapSelection(basemapId, true);
    },
    [applyComparisonBasemapSelection],
  );

  const setComparisonBasemapVisibility = useCallback(
    (visible: boolean) => {
      comparisonBasemapEnabledRef.current = visible;
      setComparisonBasemapEnabled(visible);
      applyComparisonBasemapSelection(comparisonBasemapIdRef.current, visible);
    },
    [applyComparisonBasemapSelection],
  );

  useEffect(() => {
    if (!manifest || !selectedMap) {
      return;
    }

    let cancelled = false;
    setSelectedFeature(null);
    setSelectedFeatureOptions([]);
    setSelectedFeatureOptionIndex(0);
    setSelectedFeatureGeometry(null);
    setSelectedFeatureStreetViewPoint(null);

    fetchMapStyle(selectedMap.style)
      .then(async ({ style }) => {
        if (cancelled) {
          return;
        }
        const view = viewForThumbnailCapture(viewFromManifest(manifest) || (await viewFromPmtiles(style)), manifest);
        if (cancelled) {
          return;
        }
        if (await duckDbGeoJsonAvailable(view.bounds)) {
          rewriteDuckDbGeoJsonInventoryLayers(style);
        } else {
          console.warn("DuckDB GeoJSON is unavailable; keeping PMTiles sources for operational layers.");
        }
        if (cancelled) {
          return;
        }
        const nextBasemap = hasDefaultVisibleLayer(style, isBasemapLayer);
        const nextLabels = hasDefaultVisibleLayer(style, isLabelLayer);
        activeBasemapIdRef.current = "cltex";
        basemapEnabledRef.current = nextBasemap;
        comparisonBasemapIdRef.current = "mecklenburg-aerial-2025";
        comparisonBasemapEnabledRef.current = true;
        setActiveBasemapId("cltex");
        setBasemapEnabled(nextBasemap);
        setComparisonBasemapId("mecklenburg-aerial-2025");
        setComparisonBasemapEnabled(true);
        setLabelsEnabled(nextLabels);
        normalizeInitialVisibility(style, nextBasemap, nextLabels);
        activeStyleRef.current = style;
        setActiveStyle(style);
        setActiveView(view);
        const externalOverlays = externalOverlayLayerRecords();
        const nextLayerVisibility = {
          ...Object.fromEntries(style.layers.map((layer) => [layer.id, layerDefaultVisible(layer as StyleLayer)])),
          ...Object.fromEntries(externalOverlays.map((layer) => [layer.id, layerDefaultVisible(layer)])),
        };
        setLayerRecords(operationalLayersFromStyle(style).reverse());
        layerVisibilityRef.current = nextLayerVisibility;
        comparisonLayerVisibilityRef.current = nextLayerVisibility;
        setLayerVisibilityState(nextLayerVisibility);
        setComparisonLayerVisibilityState(nextLayerVisibility);
      })
      .catch((error: Error) => showError(error));

    return () => {
      cancelled = true;
    };
  }, [manifest, operationalLayers, selectedMap]);

  useEffect(() => {
    if (!activeStyle || !mapNodeRef.current) {
      return;
    }
    configureNavigationConstraints(activeView);

    if (!mapRef.current) {
      const mapOptions = mapOptionsForView(activeView, {
        container: mapNodeRef.current,
        style: activeStyle,
        attributionControl: false,
        preserveDrawingBuffer: true,
        renderWorldCopies: false,
      } as MapOptions);
      const map = new maplibregl.Map(mapOptions);
      mapRef.current = map;
      enableMiddleMouse3dRotation(map);
      const updateBearing = () => {
        const nextBearing = map.getBearing();
        setMapBearing((currentBearing) => (Math.abs(currentBearing - nextBearing) > 0.1 ? nextBearing : currentBearing));
      };
      map.addControl(new ScaleRatioControl(), "bottom-left");
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "imperial" }), "bottom-left");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      map.on("load", () => {
        applyBasemapSelection(activeBasemapIdRef.current, basemapEnabledRef.current);
        applyTerrainToMap(map, activeStyleRef.current, map3dEnabledRef.current);
        applyAttributeFiltersToMap(map);
        refreshDuckDbGeoJsonSources(map);
        updateDrawDataOnMaps([map], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
        updateBearing();
        refreshCurrentZoom();
        rememberValidCamera();
        refreshLayerPanel();
        updateRenderedFeatureMetric();
        scheduleInventoryMetricsRefresh(0);
        scheduleRiskTopListRefresh(0);
        scheduleRiskHistogramRefresh(0);
      });
      map.on("rotate", updateBearing);
      map.on("zoom", refreshCurrentZoom);
      map.on("styledata", () => {
        applyBasemapSelection(activeBasemapIdRef.current, basemapEnabledRef.current);
        applyTerrainToMap(map, activeStyleRef.current, map3dEnabledRef.current);
        applyAttributeFiltersToMap(map);
        refreshDuckDbGeoJsonSources(map);
        updateDrawDataOnMaps([map], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
        updateBearing();
        refreshCurrentZoom();
        refreshLayerPanel();
        updateRenderedFeatureMetric();
        scheduleInventoryMetricsRefresh();
        scheduleRiskTopListRefresh();
        scheduleRiskHistogramRefresh();
      });
      map.on("idle", () => {
        refreshLayerPanel();
        updateRenderedFeatureMetric();
      });
      map.on("moveend", () => {
        enforceProtectedBounds();
        applyTerrainToMap(map, activeStyleRef.current, map3dEnabledRef.current);
        applyTerrainToMap(splitMapRef.current, activeStyleRef.current, map3dEnabledRef.current);
        refreshDuckDbGeoJsonSourcesOnMaps();
        updateRenderedFeatureMetric();
        scheduleInventoryMetricsRefresh();
        scheduleRiskTopListRefresh();
        scheduleRiskHistogramRefresh();
      });
      map.on("zoomend", () => {
        enforceProtectedBounds();
        applyTerrainToMap(map, activeStyleRef.current, map3dEnabledRef.current);
        applyTerrainToMap(splitMapRef.current, activeStyleRef.current, map3dEnabledRef.current);
        refreshDuckDbGeoJsonSourcesOnMaps();
      });
      map.on("click", showClickedFeature);
      map.on("click", handleDrawClick);
      map.on("dblclick", handleDrawDoubleClick);
      map.on("mousedown", handleDrawMouseDown);
      map.on("mousemove", handleDrawMouseMove);
      map.on("mouseup", handleDrawMouseUp);
      map.on("error", (event) => showError(new Error(event.error?.message || "MapLibre reported an error.")));
      return;
    }

    mapRef.current.setStyle(activeStyle);
    mapRef.current.once("styledata", () => {
      applyTerrainToMap(mapRef.current, activeStyleRef.current, map3dEnabledRef.current);
      applyBasemapSelection(activeBasemapIdRef.current, basemapEnabledRef.current);
      applyAttributeFiltersToMap(mapRef.current);
      refreshDuckDbGeoJsonSources(mapRef.current);
      updateDrawDataOnMaps([mapRef.current], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
      refreshCurrentZoom();
      refreshLayerPanel();
      updateRenderedFeatureMetric();
      scheduleInventoryMetricsRefresh();
      scheduleRiskTopListRefresh();
      scheduleRiskHistogramRefresh();
    });
    applyView(mapRef.current, activeView, 450);
  }, [
    activeStyle,
    activeView,
    applyAttributeFiltersToMap,
    applyBasemapSelection,
    configureNavigationConstraints,
    enforceProtectedBounds,
    enableMiddleMouse3dRotation,
    handleDrawClick,
    handleDrawDoubleClick,
    handleDrawMouseDown,
    handleDrawMouseMove,
    handleDrawMouseUp,
    refreshDuckDbGeoJsonSources,
    refreshDuckDbGeoJsonSourcesOnMaps,
    refreshCurrentZoom,
    refreshLayerPanel,
    rememberValidCamera,
    scheduleInventoryMetricsRefresh,
    scheduleRiskHistogramRefresh,
    scheduleRiskTopListRefresh,
    showClickedFeature,
    updateRenderedFeatureMetric,
  ]);

  useEffect(() => {
    if (mapViewMode === "single") {
      splitMapRef.current?.remove();
      splitMapRef.current = null;
      window.requestAnimationFrame(() => mapRef.current?.resize());
      return;
    }
    if (!activeStyle || !splitMapNodeRef.current || !mapRef.current) {
      return;
    }

    const primaryMap = mapRef.current;
    if (!splitMapRef.current) {
      const splitOptions = mapOptionsForView(activeView, {
        container: splitMapNodeRef.current,
        style: activeStyle,
        attributionControl: false,
        preserveDrawingBuffer: true,
        renderWorldCopies: false,
      } as MapOptions);
      splitOptions.center = primaryMap.getCenter();
      splitOptions.zoom = primaryMap.getZoom();
      splitOptions.pitch = primaryMap.getPitch();
      splitOptions.bearing = primaryMap.getBearing();
      const splitMap = new maplibregl.Map(splitOptions);
      splitMapRef.current = splitMap;
      splitMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      splitMap.on("load", () => {
        applyBasemapSelectionToMap(splitMap, comparisonBasemapIdRef.current, comparisonBasemapEnabledRef.current);
        applyTerrainToMap(splitMap, activeStyleRef.current, map3dEnabledRef.current);
        mirrorLayerVisibilityToMap(splitMap, comparisonLayerVisibilityRef.current);
        applyAttributeFiltersToMap(splitMap);
        refreshDuckDbGeoJsonSources(splitMap);
        updateDrawDataOnMaps([splitMap], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
        syncMapCamera(primaryMap, splitMap);
        setSplitMapReadyCounter((counter) => counter + 1);
      });
      splitMap.on("styledata", () => {
        applyBasemapSelectionToMap(splitMap, comparisonBasemapIdRef.current, comparisonBasemapEnabledRef.current);
        applyTerrainToMap(splitMap, activeStyleRef.current, map3dEnabledRef.current);
        mirrorLayerVisibilityToMap(splitMap, comparisonLayerVisibilityRef.current);
        applyAttributeFiltersToMap(splitMap);
        refreshDuckDbGeoJsonSources(splitMap);
        updateDrawDataOnMaps([splitMap], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
        setSplitMapReadyCounter((counter) => counter + 1);
      });
      splitMap.on("moveend", () => {
        applyTerrainToMap(splitMap, activeStyleRef.current, map3dEnabledRef.current);
        refreshDuckDbGeoJsonSources(splitMap);
      });
      splitMap.on("zoomend", () => {
        applyTerrainToMap(splitMap, activeStyleRef.current, map3dEnabledRef.current);
        refreshDuckDbGeoJsonSources(splitMap);
      });
      splitMap.on("click", handleDrawClick);
      splitMap.on("dblclick", handleDrawDoubleClick);
      splitMap.on("mousedown", handleDrawMouseDown);
      splitMap.on("mousemove", handleDrawMouseMove);
      splitMap.on("mouseup", handleDrawMouseUp);
      splitMap.on("error", (event) => showError(new Error(event.error?.message || "Split map reported an error.")));
    } else {
      splitMapRef.current.setStyle(activeStyle);
      splitMapRef.current.once("styledata", () => {
        if (!splitMapRef.current) {
          return;
        }
        applyBasemapSelectionToMap(splitMapRef.current, comparisonBasemapIdRef.current, comparisonBasemapEnabledRef.current);
        applyTerrainToMap(splitMapRef.current, activeStyleRef.current, map3dEnabledRef.current);
        mirrorLayerVisibilityToMap(splitMapRef.current, comparisonLayerVisibilityRef.current);
        applyAttributeFiltersToMap(splitMapRef.current);
        refreshDuckDbGeoJsonSources(splitMapRef.current);
        updateDrawDataOnMaps([splitMapRef.current], drawFeaturesRef.current, drawDraftFeaturesRef.current, selectedDrawIdRef.current);
        syncMapCamera(primaryMap, splitMapRef.current);
        setSplitMapReadyCounter((counter) => counter + 1);
      });
    }

    window.setTimeout(() => {
      mapRef.current?.resize();
      splitMapRef.current?.resize();
      if (mapRef.current && splitMapRef.current) {
        syncMapCamera(mapRef.current, splitMapRef.current);
      }
    }, 80);
  }, [
    activeStyle,
    activeView,
    applyAttributeFiltersToMap,
    handleDrawClick,
    handleDrawDoubleClick,
    handleDrawMouseDown,
    handleDrawMouseMove,
    handleDrawMouseUp,
    mapViewMode,
    refreshDuckDbGeoJsonSources,
  ]);

  useEffect(() => {
    if (mapViewMode === "single") {
      return;
    }
    const primaryMap = mapRef.current;
    const splitMap = splitMapRef.current;
    if (!primaryMap || !splitMap) {
      return;
    }

    const syncFromPrimary = () => {
      if (splitMapSyncingRef.current) {
        return;
      }
      splitMapSyncingRef.current = true;
      syncMapCamera(primaryMap, splitMap);
      splitMapSyncingRef.current = false;
    };
    const syncFromSplit = () => {
      if (splitMapSyncingRef.current || mapViewMode !== "dual") {
        return;
      }
      splitMapSyncingRef.current = true;
      syncMapCamera(splitMap, primaryMap);
      splitMapSyncingRef.current = false;
    };

    primaryMap.on("move", syncFromPrimary);
    splitMap.on("move", syncFromSplit);
    syncFromPrimary();
    return () => {
      primaryMap.off("move", syncFromPrimary);
      splitMap.off("move", syncFromSplit);
    };
  }, [mapViewMode, splitMapReadyCounter]);

  useEffect(() => {
    const resizeHandle = window.setTimeout(() => {
      mapRef.current?.resize();
      splitMapRef.current?.resize();
      if (mapRef.current && splitMapRef.current) {
        syncMapCamera(mapRef.current, splitMapRef.current);
      }
    }, 120);
    return () => window.clearTimeout(resizeHandle);
  }, [mapViewMode, swipePosition]);

  useEffect(() => {
    return () => {
      if (searchFlashIntervalRef.current !== null) {
        window.clearInterval(searchFlashIntervalRef.current);
      }
      if (searchFlashTimeoutRef.current !== null) {
        window.clearTimeout(searchFlashTimeoutRef.current);
      }
      if (inventoryMetricsRefreshTimeoutRef.current !== null) {
        window.clearTimeout(inventoryMetricsRefreshTimeoutRef.current);
      }
      splitMapRef.current?.remove();
      splitMapRef.current = null;
      middleMouseRotateCleanupRef.current?.();
      middleMouseRotateCleanupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const showError = (error: Error) => {
    console.error(error);
  };

  const cancelMapPdfSelection = useCallback(() => {
    mapPdfSelectionDragRef.current = null;
    setMapPdfExportSelecting(false);
    setMapPdfSelectionFrame(null);
  }, []);

  const exportSelectedMapPdf = useCallback(async (selection: MapPdfSelectionRect) => {
    const map = mapRef.current;
    if (!map || mapPdfExporting) {
      return;
    }

    setMapPdfExporting(true);
    setMapPdfExportSelecting(false);
    setMapPdfSelectionFrame(null);
    mapPdfSelectionDragRef.current = null;
    try {
      await waitForMapRender(map);
      const canvas = map.getCanvas();
      if (!canvas.width || !canvas.height) {
        throw new Error("The map canvas is not ready for export.");
      }

      const image = await mapCanvasToJpegImage(canvas, selection);
      const northArrowImage = await imageUrlToJpegImage(northArrowCompassUrl, 640);
      const scaleInfo = getMapPdfScaleInfo(map, selection);
      const generatedAt = new Date();
      const details = mapPdfDetailsRef.current;
      const pdf = createMapPdfBlob({
        image,
        northArrowImage,
        details,
        generatedAt,
        mapBearing: map.getBearing(),
        scaleInfo,
      });
      downloadBlob(pdf, `${fileSafeMapName(details.mapName)}_${dateStamp(generatedAt)}.pdf`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not export the current map.";
      showError(new Error(message));
      toast.error("Could not export the selected map area to PDF.", { description: message });
    } finally {
      setMapPdfExporting(false);
    }
  }, [mapPdfExporting]);

  const startMapPdfSelection = useCallback(() => {
    if (mapPdfExporting) {
      return;
    }
    const mapBounds = mapNodeRef.current?.getBoundingClientRect();
    setMapPdfExportSelecting(true);
    setMapPdfSelectionFrame(
      mapBounds?.width && mapBounds.height
        ? createInitialMapPdfSelectionFrame(mapBounds.width, mapBounds.height)
        : null,
    );
    setAssetSearchOpen(false);
    setPanelOpen(false);
    setBasemapPanelOpen(false);
    setLayerFilterEditor(null);
    setMapViewMenuOpen(false);
  }, [mapPdfExporting]);

  const openMapPdfDetailsDialog = useCallback(() => {
    if (mapPdfExporting) {
      return;
    }
    setMapPdfForm(mapPdfDetailsRef.current);
    setMapPdfDetailsOpen(true);
    setAssetSearchOpen(false);
    setPanelOpen(false);
    setBasemapPanelOpen(false);
    setLayerFilterEditor(null);
    setMapViewMenuOpen(false);
  }, [mapPdfExporting]);

  const cancelMapPdfDetailsDialog = useCallback(() => {
    setMapPdfDetailsOpen(false);
  }, []);

  const submitMapPdfDetails = useCallback((details: MapPdfExportDetails) => {
    const nextDetails = {
      mapName: details.mapName.trim() || "Storm Water Asset Risk Map",
      author: details.author.trim(),
    };
    mapPdfDetailsRef.current = nextDetails;
    setMapPdfForm(nextDetails);
    setMapPdfDetailsOpen(false);
    startMapPdfSelection();
  }, [startMapPdfSelection]);

  useEffect(() => {
    if (!mapPdfExportSelecting) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelMapPdfSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelMapPdfSelection, mapPdfExportSelecting]);

  useEffect(() => {
    if (!mapPdfExportSelecting || mapPdfSelectionFrame) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const mapBounds = mapNodeRef.current?.getBoundingClientRect();
      if (mapBounds?.width && mapBounds.height) {
        setMapPdfSelectionFrame(createInitialMapPdfSelectionFrame(mapBounds.width, mapBounds.height));
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [mapPdfExportSelecting, mapPdfSelectionFrame]);

  const startMapPdfSelectionFrameDrag = useCallback((mode: MapPdfSelectionDragMode, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || mapPdfExporting || !mapPdfSelectionFrame) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    mapPdfSelectionDragRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: mapPdfSelectionFrame,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [mapPdfExporting, mapPdfSelectionFrame]);

  const moveMapPdfSelectionFrame = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = mapPdfSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setMapPdfSelectionFrame(
      updateMapPdfSelectionFrameForDrag(
        drag.startFrame,
        drag.mode,
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      ),
    );
  }, []);

  const finishMapPdfSelectionFrameDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = mapPdfSelectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    mapPdfSelectionDragRef.current = null;
  }, []);

  const exportMapPdfSelectionFrame = useCallback(() => {
    if (!mapPdfSelectionFrame || mapPdfExporting) {
      return;
    }
    void exportSelectedMapPdf(mapPdfSelectionFrame);
  }, [exportSelectedMapPdf, mapPdfExporting, mapPdfSelectionFrame]);

  const openLayerFilterEditor = useCallback((layer: StyleLayer) => {
    const target = layerFilterTarget(layer);
    if (!target) {
      return;
    }
    const existing = attributeFiltersRef.current[target.key];
    const initialRules = existing?.rules.length
      ? existing.rules.map((rule) => ({ ...rule }))
      : [emptyAttributeFilterRule(target.fields[0]?.name || "")];
    const requestId = ++filterFieldsRequestRef.current;
    setLayerFilterEditor({
      target,
      rules: sanitizeAttributeFilterRulesForFields(initialRules, target.fields),
      fieldsLoading: true,
    });
    fetchAttributeFilterFields(target.datasetId)
      .then((payload) => {
        if (filterFieldsRequestRef.current !== requestId) {
          return;
        }
        const fields = payload.fields?.length ? payload.fields : target.fields;
        setLayerFilterEditor((current) => {
          if (!current || current.target.key !== target.key) {
            return current;
          }
          const nextTarget = { ...current.target, fields };
          return {
            ...current,
            target: nextTarget,
            fieldsLoading: false,
            fieldsError: payload.message || "",
            rules: sanitizeAttributeFilterRulesForFields(current.rules, fields),
          };
        });
      })
      .catch((error: Error) => {
        if (filterFieldsRequestRef.current !== requestId) {
          return;
        }
        setLayerFilterEditor((current) => (
          current && current.target.key === target.key
            ? { ...current, fieldsLoading: false, fieldsError: error.message || "Could not load fields." }
            : current
        ));
      });
  }, []);

  const applyLayerFilterEditor = useCallback((target: LayerFilterTarget, rules: AttributeFilterRule[]) => {
    const cleanedRules = cleanAttributeFilterRules(sanitizeAttributeFilterRulesForFields(rules, target.fields));
    setAttributeFilters((current) => {
      const next = { ...current };
      if (cleanedRules.length) {
        next[target.key] = { ...target, rules: cleanedRules };
      } else {
        delete next[target.key];
      }
      attributeFiltersRef.current = next;
      return next;
    });
    setLayerFilterEditor(null);
  }, []);

  const clearLayerFilter = useCallback((target: LayerFilterTarget) => {
    setAttributeFilters((current) => {
      if (!current[target.key]) {
        return current;
      }
      const next = { ...current };
      delete next[target.key];
      attributeFiltersRef.current = next;
      return next;
    });
    setLayerFilterEditor(null);
  }, []);

  const setStyleLayerVisibility = useCallback((layerId: string, visible: boolean) => {
    if (mapRef.current?.getLayer(layerId)) {
      mapRef.current.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
    setLayerVisibilityState((current) => {
      const next = { ...current, [layerId]: visible };
      layerVisibilityRef.current = next;
      return next;
    });
    window.setTimeout(() => {
      refreshDuckDbGeoJsonSources(mapRef.current);
      updateRenderedFeatureMetric();
    }, 0);
  }, [refreshDuckDbGeoJsonSources, updateRenderedFeatureMetric]);

  const setStyleLayersVisibility = useCallback((layers: StyleLayer[], visible: boolean) => {
    const nextVisibility = Object.fromEntries(layers.map((layer) => [layer.id, visible]));
    layers.forEach((layer) => {
      if (mapRef.current?.getLayer(layer.id)) {
        mapRef.current.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
      }
    });
    setLayerVisibilityState((current) => {
      const next = { ...current, ...nextVisibility };
      layerVisibilityRef.current = next;
      return next;
    });
    window.setTimeout(() => {
      refreshDuckDbGeoJsonSources(mapRef.current);
      updateRenderedFeatureMetric();
    }, 0);
  }, [refreshDuckDbGeoJsonSources, updateRenderedFeatureMetric]);

  const setComparisonStyleLayerVisibility = useCallback((layerId: string, visible: boolean) => {
    if (splitMapRef.current?.getLayer(layerId)) {
      splitMapRef.current.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
    setComparisonLayerVisibilityState((current) => {
      const next = { ...current, [layerId]: visible };
      comparisonLayerVisibilityRef.current = next;
      return next;
    });
    window.setTimeout(() => refreshDuckDbGeoJsonSources(splitMapRef.current), 0);
  }, [refreshDuckDbGeoJsonSources]);

  const setComparisonStyleLayersVisibility = useCallback((layers: StyleLayer[], visible: boolean) => {
    const nextVisibility = Object.fromEntries(layers.map((layer) => [layer.id, visible]));
    layers.forEach((layer) => {
      if (splitMapRef.current?.getLayer(layer.id)) {
        splitMapRef.current.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
      }
    });
    setComparisonLayerVisibilityState((current) => {
      const next = { ...current, ...nextVisibility };
      comparisonLayerVisibilityRef.current = next;
      return next;
    });
    window.setTimeout(() => refreshDuckDbGeoJsonSources(splitMapRef.current), 0);
  }, [refreshDuckDbGeoJsonSources]);

  const setLabelVisibility = (visible: boolean) => {
    setLabelsEnabled(visible);
    currentStyleLayers().forEach((layer) => {
      if (isLabelLayer(layer)) {
        setStyleLayerVisibility(layer.id, visible && labelAvailableByStyle(layer));
      }
    });
  };

  const toggle3dMap = () => {
    const nextEnabled = !map3dEnabledRef.current;
    map3dEnabledRef.current = nextEnabled;
    setMap3dEnabled(nextEnabled);
    if (nextEnabled) {
      setMapViewMode("single");
      setMapViewMenuOpen(false);
    } else {
      stopMiddleMouseRotateRef.current?.();
    }
    applyTerrainToMap(mapRef.current, activeStyleRef.current, nextEnabled);
    mapRef.current?.easeTo({
      pitch: nextEnabled ? 55 : 0,
      duration: 260,
    });
  };

  const changeMapViewMode = (mode: MapViewMode) => {
    if (mode !== "single" && map3dEnabledRef.current) {
      map3dEnabledRef.current = false;
      setMap3dEnabled(false);
      stopMiddleMouseRotateRef.current?.();
      applyTerrainToMap(mapRef.current, activeStyleRef.current, false);
      mapRef.current?.easeTo({ pitch: 0, duration: 260 });
    }
    setMapViewMode(mode);
    setMapViewMenuOpen(false);
  };

  const resetView = () => {
    if (mapRef.current) {
      configureNavigationConstraints(activeView);
      applyView(mapRef.current, activeView, 450);
    }
  };

  const filteredLayerRecords = useMemo(() => filterLayersByName(layerRecords, layerNameFilter), [layerNameFilter, layerRecords]);
  const layerTree = useMemo(() => buildLayerTree(filteredLayerRecords), [filteredLayerRecords]);
  const selectedFeaturePanelOffset = panelOpen ? "right-[392px]" : "right-4";
  const basemapPanelOffset = panelOpen ? "right-[392px]" : "right-4";
  const compareModeActive = mapViewMode !== "single";
  const effectiveLayerPanelTarget = compareModeActive ? layerPanelTarget : "primary";
  const effectiveBasemapPanelTarget = compareModeActive ? basemapPanelTarget : "primary";
  const displayedLayerVisibility = effectiveLayerPanelTarget === "primary" ? layerVisibility : comparisonLayerVisibility;
  const displayedLayerToggle = effectiveLayerPanelTarget === "primary" ? setStyleLayerVisibility : setComparisonStyleLayerVisibility;
  const displayedGroupToggle = effectiveLayerPanelTarget === "primary" ? setStyleLayersVisibility : setComparisonStyleLayersVisibility;
  const displayedBasemapId = effectiveBasemapPanelTarget === "primary" ? activeBasemapId : comparisonBasemapId;
  const displayedBasemapEnabled = effectiveBasemapPanelTarget === "primary" ? basemapEnabled : comparisonBasemapEnabled;
  const displayedBasemapSelect = effectiveBasemapPanelTarget === "primary" ? selectBasemap : selectComparisonBasemap;
  const displayedBasemapVisibilityToggle = effectiveBasemapPanelTarget === "primary" ? setBasemapVisibility : setComparisonBasemapVisibility;
  const pageTitle = "Storm Water Asset Risk Viewer";

  return (
    <div className={`map-tiles-page theme-${colorScheme} grid h-screen max-h-screen w-full grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)]`}>
      <header className="map-tiles-app-header relative z-30 grid h-12 min-w-0 grid-cols-[minmax(280px,1fr)_minmax(360px,660px)_minmax(160px,1fr)] items-center gap-3 bg-[var(--brand-bg)] px-2 text-[var(--brand-fg)] shadow-[0_3px_12px_rgba(0,0,0,.28)]">
        <div className="flex min-w-0 items-center gap-2 justify-self-start">
          <span className="grid h-10 w-[116px] shrink-0 place-items-center bg-white px-1.5 shadow-sm">
            <img className="max-h-9 w-full object-contain" src={stormwaterLogoUrl} alt="Charlotte-Mecklenburg Storm Water Services" />
          </span>
          <div className="min-w-0">
            <strong className="block truncate text-[18px] font-semibold leading-tight">{pageTitle}</strong>
          </div>
        </div>
        <div className="relative z-40 w-full max-w-[660px] min-w-0 justify-self-center">
          <div className="relative min-w-0">
            <label className="map-tiles-header-search relative block h-8 text-[var(--accent)]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-4 w-4 -translate-y-1/2" />
              <input
                className="map-tiles-header-search-input absolute inset-0 h-full w-full border border-[var(--control-border)] bg-[var(--search-bg)] py-0 pl-9 pr-2 text-[13px] font-medium text-[var(--panel-text)] outline-none placeholder:text-[var(--panel-muted)] focus:border-[var(--accent)]"
                value={assetSearch}
                onBlur={() => window.setTimeout(() => setAssetSearchOpen(false), 140)}
                onChange={(event) => {
                  setAssetSearch(event.target.value);
                  setAssetSearchOpen(true);
                }}
                onFocus={() => {
                  if (assetSearch.trim().length >= 2) {
                    setAssetSearchOpen(true);
                  }
                }}
                onKeyDown={handleAssetSearchKeyDown}
                placeholder="Facility ID, asset ID, address"
                type="search"
              />
            </label>
            {assetSearchOpen && assetSearch.trim().length >= 2 ? (
              <div className="absolute left-0 right-0 top-full mt-1 max-h-72 overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-2xl">
                <AssetSearchResults
                  activeIndex={assetSearchActiveIndex}
                  loading={assetSearchLoading}
                  message={assetSearchMessage}
                  results={assetSearchResults}
                  onSelect={selectAssetSearchResult}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className="map-tiles-header-actions flex shrink-0 items-center gap-1 justify-self-end">
          <HeaderIconButton
            active={inventoryWidgetOpen}
            icon={<BarChart3 />}
            label="Inventory metrics"
            onClick={() => setInventoryWidgetOpen((open) => !open)}
          />
          <HeaderIconButton
            active={riskListWidgetOpen}
            icon={<ListOrdered />}
            label="Risk top 10"
            onClick={() => setRiskListWidgetOpen((open) => !open)}
          />
          <HeaderIconButton
            active={riskHistogramWidgetOpen}
            icon={<Activity />}
            label="Risk histograms"
            onClick={() => setRiskHistogramWidgetOpen((open) => !open)}
          />
          <HeaderIconButton
            active={panelOpen}
            icon={<Layers />}
            label="Map layers"
            onClick={() => setPanelOpen((open) => !open)}
          />
          <HeaderIconButton
            active={basemapPanelOpen}
            icon={<MapIcon />}
            label="Base map"
            onClick={() => setBasemapPanelOpen((open) => !open)}
          />
          <HeaderIconButton
            active={labelsEnabled}
            icon={<Type />}
            label="Labels"
            onClick={() => setLabelVisibility(!labelsEnabled)}
          />
          <HeaderIconButton
            active={colorScheme === "light"}
            icon={colorScheme === "light" ? <Sun /> : <Moon />}
            label={colorScheme === "light" ? "Use dark color scheme" : "Use light color scheme"}
            onClick={() => setColorScheme((current) => (current === "dark" ? "light" : "dark"))}
          />
        </div>
      </header>

      {mapPdfDetailsOpen ? (
        <MapPdfDetailsDialog
          details={mapPdfForm}
          onCancel={cancelMapPdfDetailsDialog}
          onChange={setMapPdfForm}
          onSubmit={submitMapPdfDetails}
        />
      ) : null}

      <main className="relative min-h-0 min-w-0 overflow-hidden bg-[var(--map-bg)]">
        <div className="absolute inset-0 overflow-hidden">
          <div
            className={`absolute ${
              mapViewMode === "dual" ? "inset-y-0 left-0 w-1/2" : "inset-0"
            }`}
          >
            <div ref={mapNodeRef} className="h-full w-full" />
            {mapPdfExportSelecting ? (
              <MapPdfSelectionOverlay
                frame={mapPdfSelectionFrame}
                exporting={mapPdfExporting}
                onCancel={cancelMapPdfSelection}
                onExport={exportMapPdfSelectionFrame}
                onPointerCancel={finishMapPdfSelectionFrameDrag}
                onPointerDown={startMapPdfSelectionFrameDrag}
                onPointerMove={moveMapPdfSelectionFrame}
                onPointerUp={finishMapPdfSelectionFrameDrag}
              />
            ) : null}
          </div>
          {mapViewMode !== "single" ? (
            <div
              className={`absolute bg-[var(--map-bg)] ${
                mapViewMode === "dual"
                  ? "inset-y-0 right-0 w-1/2 border-l border-[var(--control-border)]"
                  : "inset-0"
              }`}
              style={
                mapViewMode === "swipe"
                  ? {
                      clipPath: `inset(0 0 0 ${swipePosition}%)`,
                      pointerEvents: "none",
                    }
                  : undefined
              }
            >
              <div ref={splitMapNodeRef} className="h-full w-full" />
            </div>
          ) : null}
          {mapViewMode === "dual" ? (
            <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px bg-[var(--accent)]/70 shadow-[0_0_18px_rgba(19,118,213,.5)]" />
          ) : null}
          {mapViewMode === "swipe" ? (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-[var(--accent)] shadow-[0_0_18px_rgba(19,118,213,.55)]"
                style={{ left: `${swipePosition}%` }}
              >
                <button
                  className={`pointer-events-auto absolute left-1/2 top-1/2 grid h-11 w-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center border border-[var(--control-border)] bg-[var(--control-bg)] text-[var(--accent)] shadow-lg transition-colors hover:border-[var(--accent)] ${
                    swipeDragging ? "ring-2 ring-[var(--accent)]" : ""
                  }`}
                  type="button"
                  aria-label="Drag to change swipe comparison position"
                  title="Drag to change swipe comparison position"
                  onPointerDown={handleSwipePointerDown}
                  onPointerMove={handleSwipePointerMove}
                  onPointerUp={finishSwipeDrag}
                  onPointerCancel={finishSwipeDrag}
                  style={{ touchAction: "none" }}
                >
                  <span className="text-[13px] font-black leading-none">||</span>
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div className="absolute left-3 top-4 z-20 grid justify-items-center gap-2">
          <NorthArrowControl
            bearing={mapBearing}
            dragging={northArrowDragging}
            map3dActive={map3dEnabled}
            onPointerDown={handleNorthArrowPointerDown}
            onPointerMove={handleNorthArrowPointerMove}
            onPointerUp={handleNorthArrowPointerUp}
            onPointerCancel={handleNorthArrowPointerCancel}
          />
          <MapToolStrip
            drawActive={drawModeActive}
            drawFeatureCount={drawFeatures.length}
            drawTool={drawTool}
            mapPdfExportActive={mapPdfExportSelecting}
            mapPdfExporting={mapPdfExporting}
            map3dActive={map3dEnabled}
            mapViewMenuOpen={mapViewMenuOpen}
            mode={mapViewMode}
            selectedDrawId={selectedDrawId}
            onClearDrawFeatures={clearDrawFeatures}
            onDeleteSelectedDrawFeature={deleteSelectedDrawFeature}
            onDrawToggle={() => setDrawModeActive((active) => !active)}
            onDrawToolChange={setDrawTool}
            onMapPdfExportToggle={mapPdfExportSelecting ? cancelMapPdfSelection : openMapPdfDetailsDialog}
            onMap3dToggle={toggle3dMap}
            onMapViewMenuToggle={() => setMapViewMenuOpen((open) => !open)}
            onModeChange={changeMapViewMode}
          />
          <div className="grid overflow-visible border border-[var(--control-border)] bg-[var(--control-bg)] shadow-[0_8px_24px_rgba(0,0,0,.18)]">
            <MapControlButton label="Zoom in" onClick={() => mapRef.current?.zoomIn({ duration: 180 })}>
              +
            </MapControlButton>
            <MapControlButton label="Zoom out" onClick={() => mapRef.current?.zoomOut({ duration: 180 })}>
              -
            </MapControlButton>
            <MapControlButton label="Reset view" onClick={resetView}>
              <LocateFixed className="h-4 w-4" />
            </MapControlButton>
          </div>
        </div>

        <aside
          className={`map-tiles-layer-panel absolute bottom-4 right-4 top-4 z-20 grid w-[360px] max-w-[calc(100vw-80px)] grid-rows-[42px_minmax(0,1fr)] overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-[0_16px_40px_rgba(0,0,0,.28)] transition-transform duration-200 ${
            panelOpen ? "translate-x-0" : "translate-x-[calc(100%+24px)]"
          }`}
        >
          <header className="flex items-center justify-between gap-2 bg-[var(--brand-bg)] px-3 text-[var(--brand-fg)]">
            <strong className="truncate text-[13px] font-semibold">
              {compareModeActive ? `${effectiveLayerPanelTarget === "primary" ? "Primary" : "Compare"} Layers` : "Map Layers"}
            </strong>
            <button
              className="grid h-8 w-8 place-items-center hover:bg-white/12"
              type="button"
              onClick={() => setPanelOpen(false)}
              title="Close panel"
              aria-label="Close panel"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
            <div className="border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2">
              <label className="map-tiles-layer-filter-control relative block h-8">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-3.5 w-3.5 -translate-y-1/2 text-[var(--panel-muted)]" />
                <input
                  className="map-tiles-layer-filter-input absolute inset-0 h-full w-full border border-[var(--panel-border)] bg-[var(--input-bg)] py-0 pl-9 pr-8 text-[11px] font-semibold text-[var(--panel-text)] outline-none placeholder:text-[var(--panel-muted)] focus:border-[var(--accent)]"
                  type="search"
                  value={layerNameFilter}
                  onChange={(event) => setLayerNameFilter(event.target.value)}
                  placeholder="Filter layers"
                  aria-label="Filter layers by name"
                />
                {layerNameFilter ? (
                  <button
                    className="absolute right-1.5 top-1/2 z-[1] grid h-5 w-5 -translate-y-1/2 place-items-center text-[var(--panel-muted)] hover:text-[var(--accent)]"
                    type="button"
                    onClick={() => setLayerNameFilter("")}
                    title="Clear layer filter"
                    aria-label="Clear layer filter"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </label>
            </div>
            <div className="min-h-0 overflow-auto py-1 [scrollbar-color:var(--scrollbar-thumb)_transparent]">
            {compareModeActive ? (
              <CompareTargetTabs
                label="Layer target"
                value={effectiveLayerPanelTarget}
                onChange={setLayerPanelTarget}
              />
            ) : null}
            <LayerTree
              attributeFilters={attributeFilters}
              currentZoom={currentZoom}
              tree={layerTree}
              layerVisibility={displayedLayerVisibility}
              onEditFilter={openLayerFilterEditor}
              onToggleLayer={displayedLayerToggle}
              onToggleLayers={displayedGroupToggle}
            />
            </div>
          </section>
        </aside>

        {basemapPanelOpen ? (
          <aside
            className={`map-tiles-basemap-panel absolute bottom-4 top-4 z-30 grid w-[360px] max-w-[calc(100vw-80px)] grid-rows-[42px_minmax(0,1fr)] overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-[0_16px_40px_rgba(0,0,0,.28)] ${basemapPanelOffset}`}
          >
            <header className="flex items-center justify-between gap-2 bg-[var(--brand-bg)] px-3 text-[var(--brand-fg)]">
              <strong className="truncate text-[13px] font-semibold">
                {compareModeActive ? `${effectiveBasemapPanelTarget === "primary" ? "Primary" : "Compare"} Base Map` : "Base Map"}
              </strong>
              <button
                className="grid h-8 w-8 place-items-center hover:bg-white/12"
                type="button"
                onClick={() => setBasemapPanelOpen(false)}
                title="Close base map panel"
                aria-label="Close base map panel"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <section className="min-h-0 overflow-auto p-3 [scrollbar-color:var(--scrollbar-thumb)_transparent]">
              {compareModeActive ? (
                <CompareTargetTabs
                  label="Basemap target"
                  value={effectiveBasemapPanelTarget}
                  onChange={setBasemapPanelTarget}
                />
              ) : null}
              <button
                className="map-tiles-basemap-visible-control mb-2 flex h-7 w-full items-center gap-2 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-left text-[10px] font-semibold text-[var(--panel-text)] hover:border-[var(--accent)]"
                type="button"
                role="checkbox"
                aria-checked={displayedBasemapEnabled}
                onClick={() => displayedBasemapVisibilityToggle(!displayedBasemapEnabled)}
              >
                <span
                  className={`grid h-3 w-3 shrink-0 place-items-center border ${
                    displayedBasemapEnabled
                      ? "border-[var(--accent)] bg-[var(--panel-active-bg)] text-[var(--accent)]"
                      : "border-[var(--panel-border)] bg-[var(--input-bg)] text-transparent"
                  }`}
                >
                  <span className="h-1.5 w-1.5 bg-current" />
                </span>
                Basemap visible
              </button>
              <div className="grid gap-1.5" role="radiogroup" aria-label="Base map">
                {BASEMAP_OPTIONS.map((option) => (
                  <BasemapOptionButton
                    key={option.id}
                    active={option.id === displayedBasemapId && displayedBasemapEnabled}
                    option={option}
                    onSelect={displayedBasemapSelect}
                  />
                ))}
              </div>
            </section>
          </aside>
        ) : null}

        {layerFilterEditor ? (
          <LayerFilterEditorPanel
            state={layerFilterEditor}
            onApply={applyLayerFilterEditor}
            onChange={setLayerFilterEditor}
            onClear={clearLayerFilter}
            onClose={() => setLayerFilterEditor(null)}
          />
        ) : null}

        {!panelOpen ? (
          <button
            className="absolute right-0 top-1/2 z-20 flex h-28 w-8 -translate-y-1/2 items-center justify-center gap-1 border border-r-0 border-[var(--control-border)] bg-[var(--control-bg)] text-[var(--accent)] shadow-[0_8px_24px_rgba(0,0,0,.2)] hover:border-[var(--accent)]"
            type="button"
            onClick={() => setPanelOpen(true)}
            title="Open map layers"
            aria-label="Open map layers"
          >
            <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[.08em]" style={{ writingMode: "vertical-rl" }}>
              <Layers className="h-3.5 w-3.5" />
              Layers
            </span>
          </button>
        ) : null}

        {inventoryWidgetOpen ? (
          <InventoryMetricsWidget
            error={inventoryMetricsError}
            loading={inventoryMetricsLoading}
            metrics={inventoryMetrics}
            position={inventoryWidgetPosition}
            onClose={() => setInventoryWidgetOpen(false)}
            onHeaderPointerCancel={finishInventoryWidgetDrag}
            onHeaderPointerDown={handleInventoryWidgetPointerDown}
            onHeaderPointerMove={handleInventoryWidgetPointerMove}
            onHeaderPointerUp={finishInventoryWidgetDrag}
          />
        ) : null}

        {riskListWidgetOpen ? (
          <RiskTopListWidget
            activeTab={riskListActiveTab}
            error={riskTopListError}
            layerSelection={riskListLayerSelection}
            lists={riskTopLists}
            loading={riskTopListLoading}
            position={riskListWidgetPosition}
            riskSort={riskSortType}
            onClose={() => setRiskListWidgetOpen(false)}
            onHeaderPointerCancel={finishRiskListWidgetDrag}
            onHeaderPointerDown={handleRiskListWidgetPointerDown}
            onHeaderPointerMove={handleRiskListWidgetPointerMove}
            onHeaderPointerUp={finishRiskListWidgetDrag}
            onItemSelect={selectRiskTopListItem}
            onLayerSelectionChange={updateRiskListLayerSelection}
            onRiskSortChange={updateRiskSortType}
          />
        ) : null}

        {riskHistogramWidgetOpen ? (
          <RiskHistogramWidget
            activeLayer={riskHistogramActiveLayer}
            error={riskHistogramError}
            histograms={riskHistograms}
            loading={riskHistogramLoading}
            position={riskHistogramWidgetPosition}
            riskSort={riskHistogramType}
            onClose={() => setRiskHistogramWidgetOpen(false)}
            onHeaderPointerCancel={finishRiskHistogramWidgetDrag}
            onHeaderPointerDown={handleRiskHistogramWidgetPointerDown}
            onHeaderPointerMove={handleRiskHistogramWidgetPointerMove}
            onHeaderPointerUp={finishRiskHistogramWidgetDrag}
            onLayerChange={updateRiskHistogramActiveLayer}
            onRiskSortChange={updateRiskHistogramType}
          />
        ) : null}

        {selectedFeature ? (
          <aside className={`absolute bottom-4 z-20 grid max-h-[42vh] w-[330px] max-w-[calc(100vw-32px)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden border border-[var(--panel-border)] bg-[var(--popup-bg)] text-[var(--panel-text)] shadow-[0_18px_45px_rgba(0,0,0,.34)] backdrop-blur-xl transition-[right] duration-200 ${selectedFeaturePanelOffset}`}>
            <PanelHeading eyebrow="Selected" title="Feature Details" />
            <div className="min-h-0 overflow-auto p-4">
              {selectedFeatureOptions.length > 1 ? (
                <label className="mb-3 grid gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-[var(--accent)]">
                    Selected Feature
                  </span>
                  <select
                    className="h-8 min-w-0 rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px] font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
                    value={selectedFeatureOptionIndex}
                    onChange={(event) => selectFeatureOption(Number(event.target.value))}
                    aria-label="Selected feature"
                  >
                    {selectedFeatureOptions.map((feature, index) => (
                      <option key={feature.uniqueKey} value={index}>
                        {index + 1}. {feature.layerLabel} - {feature.featureLabel}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="mb-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1.5 border border-[var(--accent)] bg-[var(--panel-active-bg)] px-2.5 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--accent)] transition hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:border-[var(--panel-border)] disabled:bg-transparent disabled:text-[var(--panel-disabled)]"
                  onClick={flashSelectedFeature}
                  disabled={!selectedFeatureGeometry}
                >
                  <Activity className="h-3.5 w-3.5" />
                  Flash feature
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1.5 border border-[var(--accent)] bg-[var(--panel-active-bg)] px-2.5 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--accent)] transition hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:border-[var(--panel-border)] disabled:bg-transparent disabled:text-[var(--panel-disabled)]"
                  onClick={openSelectedFeatureStreetView}
                  disabled={!selectedFeatureStreetViewUrl}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Street View
                </button>
              </div>
              <FeatureDetails feature={selectedFeature} />
            </div>
          </aside>
        ) : null}
      </main>
    </div>
  );
}

function AssetSearchResults({
  activeIndex,
  loading,
  message,
  results,
  onSelect,
}: {
  activeIndex: number;
  loading: boolean;
  message: string;
  results: AssetSearchResult[];
  onSelect: (result: AssetSearchResult) => void;
}) {
  if (loading && !results.length) {
    return <div className="px-3 py-2 text-[11px] font-bold text-[var(--panel-muted)]">Searching...</div>;
  }
  if (!results.length) {
    return <div className="px-3 py-2 text-[11px] font-bold text-[var(--panel-muted)]">{message || "No matching asset or address"}</div>;
  }
  return (
    <div className="max-h-72 overflow-auto py-1 [scrollbar-color:rgba(146,184,210,.7)_transparent]">
      {results.map((result, index) => (
        <button
          key={result.id}
          className={`grid w-full grid-cols-[1fr_auto] gap-2 px-3 py-2 text-left hover:bg-[var(--row-hover)] ${
            index === activeIndex ? "bg-[var(--panel-active-bg)]" : ""
          }`}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(result);
          }}
        >
          <span className="min-w-0">
            <strong className="block truncate text-[11px] font-black text-[var(--panel-text)]">{result.label}</strong>
            <span className="block truncate text-[10px] font-semibold text-[var(--panel-muted)]">{result.subtitle}</span>
          </span>
          <span className="self-center rounded-full border border-[var(--accent)] px-2 py-0.5 text-[9px] font-black uppercase text-[var(--accent)]">
            {result.kind}
          </span>
        </button>
      ))}
      {loading ? <div className="px-3 pb-2 text-[10px] font-bold text-[var(--panel-muted)]">Refreshing...</div> : null}
    </div>
  );
}

function InventoryMetricsWidget({
  error,
  loading,
  metrics,
  position,
  onClose,
  onHeaderPointerCancel,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
}: {
  error: string;
  loading: boolean;
  metrics: InventoryMetric[];
  position: FloatingWidgetPosition;
  onClose: () => void;
  onHeaderPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <aside
      className="absolute z-20 grid max-w-[calc(100vw-24px)] grid-rows-[38px_minmax(0,1fr)] overflow-hidden rounded-sm border border-[var(--panel-border)] bg-[var(--popup-bg)] text-[var(--panel-text)] shadow-[0_18px_45px_rgba(0,0,0,.28)] backdrop-blur-xl"
      style={{ left: position.x, top: position.y, width: INVENTORY_WIDGET_WIDTH }}
    >
      <header
        className="flex cursor-move select-none items-center gap-2 bg-[var(--brand-bg)] px-2.5 text-[var(--brand-fg)]"
        onPointerCancel={onHeaderPointerCancel}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        style={{ touchAction: "none" }}
      >
        <strong className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold leading-none">
          Inventory Metrics
        </strong>
        <div className="shrink-0 text-right text-[8px] font-black uppercase tracking-[.1em] text-white/75">
          Visible extent <span className="text-white">/</span> total dataset
        </div>
        <button
          className="grid h-6 w-6 shrink-0 place-items-center text-white/80 hover:bg-white/12 hover:text-white"
          type="button"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          title="Close inventory metrics"
          aria-label="Close inventory metrics"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 overflow-auto px-2.5 pb-2.5 [scrollbar-color:var(--scrollbar-thumb)_transparent]">
        <div className="grid grid-cols-2 gap-2 pt-2.5">
          {metrics.map((metric) => (
            <InventoryMetricCard
              key={metric.id}
              metric={metric}
            />
          ))}
        </div>
        {!metrics.length && loading ? (
          <div className="rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[11px] font-semibold text-[var(--panel-muted)]">
            Loading inventory metrics...
          </div>
        ) : null}
        {error ? (
          <div className="mt-2 rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[10px] font-semibold text-[var(--panel-muted)]">
            {error}
          </div>
        ) : null}
        {loading && metrics.length ? (
          <div className="mt-2 text-right text-[9px] font-black uppercase tracking-[.12em] text-[var(--panel-muted)]">
            Updating...
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function InventoryMetricCard({ metric }: { metric: InventoryMetric }) {
  return (
    <article
      className="grid min-h-[74px] grid-rows-[auto_1fr_auto] rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,.08)]"
      title={metric.source_table}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center text-[var(--accent)] [&>svg]:h-3.5 [&>svg]:w-3.5">
          {inventoryMetricIcon(metric.id)}
        </span>
        <strong className="min-w-0 text-[9px] font-semibold uppercase leading-[1.05] tracking-[.01em] text-[var(--panel-muted)]">
          {metric.label}
        </strong>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-1 self-center whitespace-nowrap">
        <strong className={`${metric.unit === "ft" ? "text-[12px]" : "text-[16px]"} min-w-0 truncate font-black leading-none text-[var(--panel-text)]`}>
          {formatInventoryMetricNumber(metric, metric.visible_extent)}
        </strong>
        <span className="text-[11px] font-black leading-none text-[var(--accent)]">/</span>
        <strong className={`${metric.unit === "ft" ? "text-[9px]" : "text-[11px]"} min-w-0 truncate font-black leading-none text-[var(--accent)]`}>
          {formatInventoryMetricNumber(metric, metric.total)}
        </strong>
      </div>
      <span className="truncate text-center text-[8px] font-semibold uppercase tracking-[.03em] text-[var(--panel-muted)]">
        {metric.unit === "mi" ? "miles" : metric.unit === "ft" ? "feet" : "visible / total"}
      </span>
    </article>
  );
}

function riskLayerOption(options: RiskLayerOption[], id: string): RiskLayerOption {
  return options.find((option) => option.id === id) || options[0];
}

function emptyRiskTopList(option: RiskLayerOption): RiskTopList {
  return {
    id: option.id,
    label: option.label,
    dataset_id: option.dataset_id,
    risk_field: "",
    items: [],
  };
}

function RiskTopListWidget({
  activeTab,
  error,
  layerSelection,
  lists,
  loading,
  position,
  riskSort,
  onClose,
  onHeaderPointerCancel,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
  onItemSelect,
  onLayerSelectionChange,
  onRiskSortChange,
}: {
  activeTab: string;
  error: string;
  layerSelection: RiskLayerSelection;
  lists: RiskTopList[];
  loading: boolean;
  position: FloatingWidgetPosition;
  riskSort: RiskSortType;
  onClose: () => void;
  onHeaderPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onItemSelect: (item: RiskTopListItem) => void;
  onLayerSelectionChange: (group: RiskLayerGroup, layerId: string) => void;
  onRiskSortChange: (risk: RiskSortType) => void;
}) {
  const cityworksOption = riskLayerOption(RISK_CITYWORKS_LAYER_OPTIONS, layerSelection.cityworks);
  const itpipesOption = riskLayerOption(RISK_ITPIPES_LAYER_OPTIONS, layerSelection.itpipes);
  const fallbackLists: RiskTopList[] = [
    emptyRiskTopList(cityworksOption),
    emptyRiskTopList(itpipesOption),
  ];
  const listsById = new Map(lists.map((list) => [list.id, list]));
  const displayLists = fallbackLists.map((fallback) => listsById.get(fallback.id) || fallback);
  const selectedList = displayLists.find((list) => list.id === activeTab) || displayLists[0];
  const selectedLayerId = selectedList?.id || activeTab || displayLists[0]?.id || RISK_LIST_LAYER_OPTIONS[0].id;
  const selectedRiskLabel = RISK_SORT_OPTIONS.find((option) => option.value === riskSort)?.label || "Risk";
  const handleLayerChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const layerId = event.target.value;
    const layerOption = RISK_LIST_LAYER_OPTIONS.find((option) => option.id === layerId);
    if (!layerOption) {
      return;
    }
    onLayerSelectionChange(layerOption.group, layerId);
  };

  return (
    <aside
      className="absolute z-20 grid max-h-[calc(100vh-72px)] max-w-[calc(100vw-24px)] grid-rows-[38px_auto_auto] overflow-hidden rounded-sm border border-[var(--panel-border)] bg-[var(--popup-bg)] text-[var(--panel-text)] shadow-[0_18px_45px_rgba(0,0,0,.28)] backdrop-blur-xl"
      style={{ left: position.x, top: position.y, width: RISK_LIST_WIDGET_WIDTH }}
    >
      <header
        className="flex cursor-move select-none items-center gap-2 bg-[var(--brand-bg)] px-2.5 text-[var(--brand-fg)]"
        onPointerCancel={onHeaderPointerCancel}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        style={{ touchAction: "none" }}
      >
        <ListOrdered className="h-4 w-4 shrink-0" />
        <strong className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold leading-none">
          Top Risk List
        </strong>
        <div className="shrink-0 text-right text-[8px] font-black uppercase tracking-[.1em] text-white/75">
          Current map extent
        </div>
        <button
          className="grid h-6 w-6 shrink-0 place-items-center text-white/80 hover:bg-white/12 hover:text-white"
          type="button"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          title="Close risk top list"
          aria-label="Close risk top list"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="map-tiles-top-risk-controls grid grid-cols-[auto_minmax(0,1.45fr)_auto_minmax(0,1fr)] items-center gap-1.5 border-b border-[var(--panel-border)] bg-[var(--panel-bg)]/80 px-2 py-2">
        <span className="map-tiles-top-risk-label text-[9px] font-semibold uppercase tracking-[.05em] text-[var(--panel-muted)]">
          Layer
        </span>
        <select
          className="map-tiles-risk-select map-tiles-top-risk-select h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-1 font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
          value={selectedLayerId}
          onChange={handleLayerChange}
          aria-label="Top risk list layer"
        >
          {RISK_LIST_LAYER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="map-tiles-top-risk-label text-[9px] font-semibold uppercase tracking-[.05em] text-[var(--panel-muted)]">
          Risk Type
        </span>
        <select
          className="map-tiles-risk-select map-tiles-top-risk-select h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-1 font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
          value={riskSort}
          onChange={(event) => onRiskSortChange(event.target.value as RiskSortType)}
          aria-label="Risk score sort"
        >
          {RISK_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 overflow-hidden px-2.5 py-2">
        {selectedList?.items.length ? (
          <div className="grid gap-1.5">
            {selectedList.items.slice(0, 10).map((item) => (
              <RiskTopListRow
                key={item.id}
                item={item}
                riskLabel={selectedRiskLabel}
                riskSort={riskSort}
                onSelect={onItemSelect}
              />
            ))}
          </div>
        ) : loading ? (
          <div className="rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[11px] font-semibold text-[var(--panel-muted)]">
            Loading top risk records...
          </div>
        ) : (
          <div className="rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[11px] font-semibold text-[var(--panel-muted)]">
            No records in the current map extent.
          </div>
        )}
        {error ? (
          <div className="mt-2 rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[10px] font-semibold text-[var(--panel-muted)]">
            {error}
          </div>
        ) : null}
        {loading && selectedList?.items.length ? (
          <div className="mt-2 text-right text-[9px] font-black uppercase tracking-[.12em] text-[var(--panel-muted)]">
            Updating...
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function RiskTopListRow({
  item,
  riskLabel,
  riskSort,
  onSelect,
}: {
  item: RiskTopListItem;
  riskLabel: string;
  riskSort: RiskSortType;
  onSelect: (item: RiskTopListItem) => void;
}) {
  const riskClass = riskClassForScore(riskSort, item.risk_score);
  const riskNumberColor = riskClass.textColor;
  return (
    <button
      className="grid w-full grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-2 rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-1.5 text-left transition hover:border-[var(--accent)] hover:bg-[var(--row-hover)]"
      type="button"
      title={`${item.layer_label} - ${riskClass.label}`}
      onClick={() => onSelect(item)}
    >
      <span
        className="grid h-6 w-6 place-items-center rounded-sm border text-[10px] font-black"
        style={{
          backgroundColor: riskClass.softColor,
          borderColor: riskNumberColor,
          color: riskNumberColor,
        }}
      >
        {item.rank}
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[11px] font-semibold text-[var(--panel-text)]">{item.title}</strong>
        <span className="block truncate text-[10px] font-semibold text-[var(--panel-muted)]">
          {item.subtitle || item.layer_label}
        </span>
      </span>
      <span className="text-right">
        <strong className="block text-[13px] font-black leading-none" style={{ color: riskNumberColor }}>
          {formatRiskScore(item.risk_score)}
        </strong>
        <span className="block text-[8px] font-black uppercase tracking-[.08em] text-[var(--panel-muted)]">
          {riskLabel}
        </span>
      </span>
    </button>
  );
}

function RiskHistogramWidget({
  activeLayer,
  error,
  histograms,
  loading,
  position,
  riskSort,
  onClose,
  onHeaderPointerCancel,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
  onLayerChange,
  onRiskSortChange,
}: {
  activeLayer: string;
  error: string;
  histograms: RiskHistogram[];
  loading: boolean;
  position: FloatingWidgetPosition;
  riskSort: RiskSortType;
  onClose: () => void;
  onHeaderPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onLayerChange: (layerId: string) => void;
  onRiskSortChange: (risk: RiskSortType) => void;
}) {
  const activeLayerOption = RISK_LIST_LAYER_OPTIONS.find((option) => option.id === activeLayer) || RISK_LIST_LAYER_OPTIONS[0];
  const histogramsById = new Map(histograms.map((histogram) => [histogram.id, histogram]));
  const displayHistogram = histogramsById.get(activeLayerOption.id)
    || emptyRiskHistogram(activeLayerOption.id, activeLayerOption.label, activeLayerOption.dataset_id);

  return (
    <aside
      className="absolute z-20 grid max-h-[calc(100vh-72px)] max-w-[calc(100vw-24px)] grid-rows-[38px_auto_minmax(0,1fr)] overflow-hidden rounded-sm border border-[var(--panel-border)] bg-[var(--popup-bg)] text-[var(--panel-text)] shadow-[0_18px_45px_rgba(0,0,0,.28)] backdrop-blur-xl"
      style={{ left: position.x, top: position.y, width: RISK_HISTOGRAM_WIDGET_WIDTH, height: RISK_HISTOGRAM_WIDGET_HEIGHT }}
    >
      <header
        className="flex cursor-move select-none items-center gap-2 bg-[var(--brand-bg)] px-2.5 text-[var(--brand-fg)]"
        onPointerCancel={onHeaderPointerCancel}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        style={{ touchAction: "none" }}
      >
        <Activity className="h-4 w-4 shrink-0" />
        <strong className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold leading-none">
          Risk Histogram
        </strong>
        <div className="shrink-0 text-right text-[8px] font-black uppercase tracking-[.1em] text-white/75">
          Current map extent
        </div>
        <button
          className="grid h-6 w-6 shrink-0 place-items-center text-white/80 hover:bg-white/12 hover:text-white"
          type="button"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          title="Close risk histograms"
          aria-label="Close risk histograms"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="grid grid-cols-[auto_minmax(0,1.45fr)_auto_minmax(0,1fr)] items-center gap-1.5 border-b border-[var(--panel-border)] bg-[var(--panel-bg)]/80 px-2 py-2">
        <span className="text-[9px] font-semibold uppercase tracking-[.05em] text-[var(--panel-muted)]">
          Layer
        </span>
        <select
          className="map-tiles-risk-select h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-1 font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
          value={activeLayerOption.id}
          onChange={(event) => onLayerChange(event.target.value)}
          aria-label="Histogram layer"
        >
          {RISK_LIST_LAYER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="text-[9px] font-semibold uppercase tracking-[.05em] text-[var(--panel-muted)]">
          Risk Type
        </span>
        <select
          className="map-tiles-risk-select h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-1 font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
          value={riskSort}
          onChange={(event) => onRiskSortChange(event.target.value as RiskSortType)}
          aria-label="Histogram risk type"
        >
          {RISK_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto_auto] gap-2 overflow-hidden px-2.5 pb-2.5 pt-2">
        <RiskHistogramChart
          key={displayHistogram.id}
          histogram={displayHistogram}
          loading={loading}
          riskSort={riskSort}
        />
        {error ? (
          <div className="rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[10px] font-semibold text-[var(--panel-muted)]">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="text-right text-[9px] font-black uppercase tracking-[.12em] text-[var(--panel-muted)]">
            Updating...
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function RiskHistogramChart({
  histogram,
  loading,
  riskSort,
}: {
  histogram: RiskHistogram;
  loading: boolean;
  riskSort: RiskSortType;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) {
      return;
    }
    const chart = echarts.init(node);
    chartRef.current = chart;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    resizeObserver?.observe(node);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const counts = histogram.bins.map((bin) => bin.count);
    const barData = histogram.bins.map((bin, binIndex) => {
      const riskClass = riskClassForHistogramBin(riskSort, bin);
      return {
        value: [bin.start, bin.end, counts[binIndex] || 0],
        binLabel: bin.label,
        count: counts[binIndex] || 0,
        itemStyle: { color: RISK_HISTOGRAM_BAR_COLOR },
        riskClass: riskClass.label,
      };
    });
    chart.clear();
    chart.setOption({
      animationDuration: 280,
      grid: { left: 24, right: 0, top: 22, bottom: 24 },
      graphic: histogram.total === 0
        ? {
            type: "text",
            left: "center",
            top: "middle",
            style: {
              text: "No records in extent",
              fill: "#64748b",
              fontSize: 11,
              fontWeight: 700,
            },
          }
        : undefined,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const item = Array.isArray(params)
            ? params[0] as { value?: [number, number, number]; data?: { binLabel?: string; count?: number; riskClass?: string } }
            : null;
          return item
            ? `${histogram.label}<br/>${item.data?.binLabel || ""}: ${item.data?.count ?? item.value?.[2] ?? 0}<br/>${item.data?.riskClass || ""}`
            : histogram.label;
        },
      },
      xAxis: {
        type: "value",
        min: 0,
        max: 100,
        interval: 10,
        boundaryGap: [0, 0],
        axisLabel: {
          color: "#64748b",
          fontSize: 9,
          margin: 5,
          formatter: (value: number) => value >= 100 ? "" : `${value}-${value + 10}`,
        },
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        boundaryGap: [0, "14%"],
        splitLine: { lineStyle: { color: "rgba(148, 163, 184, .25)" } },
        axisLabel: { color: "#64748b", fontSize: 9, margin: 3 },
      },
      series: [
        {
          type: "custom",
          data: barData,
          encode: { x: [0, 1], y: 2 },
          renderItem: renderHistogramBar,
          markArea: {
            silent: true,
            label: { show: false },
            data: riskThresholdMarkAreas(riskSort),
          },
          z: 2,
        },
      ],
    }, { notMerge: true });
  }, [histogram, riskSort]);

  return (
    <section className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <strong className="min-w-0 truncate text-[11px] font-semibold text-[var(--panel-text)]">{histogram.label}</strong>
        <span className="shrink-0 text-[9px] font-black uppercase tracking-[.08em] text-[var(--panel-muted)]">
          {loading ? "Loading" : `${histogram.total.toLocaleString()} records`}
        </span>
      </div>
      <RiskBandLegend riskSort={riskSort} />
      <div ref={nodeRef} className="min-h-0 w-full" />
    </section>
  );
}

function RiskBandLegend({ riskSort }: { riskSort: RiskSortType }) {
  const scheme = riskClassificationScheme(riskSort);
  return (
    <div className="mb-1 grid grid-cols-4 gap-1">
      {scheme.map((riskClass, index) => {
        const nextClass = scheme[index + 1];
        const rangeLabel = `${riskClass.min}-${nextClass ? nextClass.min : 100}`;
        return (
          <span
            key={riskClass.label}
            className="min-w-0 truncate rounded-[2px] px-1.5 py-0.5 text-center text-[8px] font-black uppercase tracking-[.02em]"
            style={{
              backgroundColor: riskBandBackgroundColor(riskClass),
              color: riskClass.textColor,
            }}
            title={`${riskClass.label}: ${rangeLabel}`}
          >
            {riskBandShortLabel(riskClass)}
          </span>
        );
      })}
    </div>
  );
}

function emptyRiskHistogram(id: string, label: string, datasetId: string): RiskHistogram {
  return {
    id,
    label,
    dataset_id: datasetId,
    risk_field: "",
    total: 0,
    out_of_range: 0,
    bins: Array.from({ length: 10 }, (_, index) => {
      const start = index * 10;
      const end = start + 10;
      return {
        label: `${start}-${end}`,
        start,
        end,
        count: 0,
      };
    }),
  };
}

function HeaderIconButton({
  active,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`grid h-8 w-8 place-items-center transition-colors disabled:cursor-wait disabled:opacity-70 ${
        active ? "bg-white/20 text-white" : "text-white/80 hover:bg-white/12 hover:text-white"
      }`}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="[&>svg]:h-4 [&>svg]:w-4">{icon}</span>
    </button>
  );
}

function MapPdfDetailsDialog({
  details,
  onCancel,
  onChange,
  onSubmit,
}: {
  details: MapPdfExportDetails;
  onCancel: () => void;
  onChange: (details: MapPdfExportDetails) => void;
  onSubmit: (details: MapPdfExportDetails) => void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(details);
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-[#001827]/35 px-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <form
        className="grid w-full max-w-[440px] border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-[0_18px_50px_rgba(0,0,0,.32)]"
        onSubmit={handleSubmit}
      >
        <header className="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--brand-bg)] px-4 py-3 text-[var(--brand-fg)]">
          <strong className="text-[13px] font-black uppercase tracking-[.08em]">Export Map PDF</strong>
          <button
            className="grid h-8 w-8 place-items-center hover:bg-white/12"
            type="button"
            title="Cancel export"
            aria-label="Cancel export"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <section className="grid gap-4 p-4">
          <label className="grid gap-1">
            <span className="text-[11px] font-black uppercase tracking-[.08em] text-[var(--panel-muted)]">Map name</span>
            <input
              className="h-10 border border-[var(--control-border)] bg-[var(--control-bg)] px-3 text-[14px] font-semibold text-[var(--control-text)] outline-none focus:border-[var(--accent)]"
              value={details.mapName}
              onChange={(event) => onChange({ ...details, mapName: event.target.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] font-black uppercase tracking-[.08em] text-[var(--panel-muted)]">Author</span>
            <input
              className="h-10 border border-[var(--control-border)] bg-[var(--control-bg)] px-3 text-[14px] font-semibold text-[var(--control-text)] outline-none focus:border-[var(--accent)]"
              value={details.author}
              onChange={(event) => onChange({ ...details, author: event.target.value })}
            />
          </label>
        </section>
        <footer className="flex justify-end gap-2 border-t border-[var(--panel-border)] p-4">
          <button
            className="h-9 border border-[var(--control-border)] px-4 text-[12px] font-black text-[var(--accent)] hover:bg-[var(--row-hover)]"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="h-9 bg-[var(--accent)] px-4 text-[12px] font-black text-white hover:brightness-105" type="submit">
            Set export area
          </button>
        </footer>
      </form>
    </div>
  );
}

function MapPdfSelectionOverlay({
  frame,
  exporting,
  onCancel,
  onExport,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  frame: MapPdfSelectionRect | null;
  exporting: boolean;
  onCancel: () => void;
  onExport: () => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDown: (mode: MapPdfSelectionDragMode, event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  const handles: Array<{ mode: MapPdfSelectionDragMode; className: string; label: string }> = [
    { mode: "resize-nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize", label: "Resize export area from top left" },
    { mode: "resize-ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize", label: "Resize export area from top right" },
    { mode: "resize-sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize", label: "Resize export area from bottom left" },
    { mode: "resize-se", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize", label: "Resize export area from bottom right" },
  ];

  return (
    <div
      className="absolute inset-0 z-30 bg-[#001827]/10"
      role="presentation"
      style={{ touchAction: "none" }}
    >
      <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-2 border border-[var(--control-border)] bg-[var(--control-bg)] px-3 py-2 text-[11px] font-semibold text-[var(--control-text)] shadow-[0_8px_24px_rgba(0,0,0,.22)]">
        <span>
          {exporting
            ? "Exporting selected map area..."
            : "Move or resize the PDF export frame, then export."}
        </span>
        <button
          className="h-7 bg-[var(--accent)] px-3 text-[10px] font-black uppercase tracking-[.08em] text-white disabled:cursor-wait disabled:opacity-70"
          type="button"
          disabled={exporting || !frame}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onExport();
          }}
        >
          Export PDF
        </button>
        <button
          className="h-7 border border-[var(--control-border)] px-2 text-[10px] font-black uppercase tracking-[.08em] text-[var(--accent)] hover:bg-[var(--row-hover)]"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
      {frame ? (
        <div
          className="absolute cursor-move border-2 border-[var(--accent)] bg-[var(--accent)]/10 shadow-[0_0_0_9999px_rgba(0,24,39,.18)]"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
          }}
          onPointerCancel={onPointerCancel}
          onPointerDown={(event) => onPointerDown("move", event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="pointer-events-none absolute left-0 right-0 top-1/2 border-t border-dashed border-white/80" />
          <div className="pointer-events-none absolute bottom-0 top-0 left-1/2 border-l border-dashed border-white/80" />
          <span className="pointer-events-none absolute left-2 top-2 bg-[#001827]/80 px-2 py-1 text-[10px] font-black uppercase tracking-[.08em] text-white">
            PDF map area
          </span>
          {handles.map((handle) => (
            <button
              key={handle.mode}
              className={`absolute h-4 w-4 border-2 border-white bg-[var(--accent)] shadow-[0_1px_6px_rgba(0,0,0,.35)] ${handle.className}`}
              type="button"
              title={handle.label}
              aria-label={handle.label}
              onPointerCancel={onPointerCancel}
              onPointerDown={(event) => onPointerDown(handle.mode, event)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MapControlButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="group relative grid h-9 w-9 place-items-center border-b border-[var(--control-border)] text-base font-semibold text-[var(--control-text)] last:border-b-0 hover:bg-[var(--row-hover)]"
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
      <span
        className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-[#29323d] px-2 py-1 text-[11px] font-semibold leading-none text-[#f5f8fb] opacity-0 shadow-[0_6px_18px_rgba(0,0,0,.28)] transition-opacity duration-150 before:absolute before:right-full before:top-1/2 before:h-0 before:w-0 before:-translate-y-1/2 before:border-y-[5px] before:border-r-[5px] before:border-y-transparent before:border-r-[#29323d] group-hover:opacity-100 group-focus-visible:opacity-100"
        role="tooltip"
      >
        {label}
      </span>
    </button>
  );
}

function MapToolStrip({
  drawActive,
  drawFeatureCount,
  drawTool,
  mapPdfExportActive,
  mapPdfExporting,
  map3dActive,
  mapViewMenuOpen,
  mode,
  selectedDrawId,
  onClearDrawFeatures,
  onDeleteSelectedDrawFeature,
  onDrawToggle,
  onDrawToolChange,
  onMapPdfExportToggle,
  onMap3dToggle,
  onMapViewMenuToggle,
  onModeChange,
}: {
  drawActive: boolean;
  drawFeatureCount: number;
  drawTool: DrawTool;
  mapPdfExportActive: boolean;
  mapPdfExporting: boolean;
  map3dActive: boolean;
  mapViewMenuOpen: boolean;
  mode: MapViewMode;
  selectedDrawId: string | null;
  onClearDrawFeatures: () => void;
  onDeleteSelectedDrawFeature: () => void;
  onDrawToggle: () => void;
  onDrawToolChange: (tool: DrawTool) => void;
  onMapPdfExportToggle: () => void;
  onMap3dToggle: () => void;
  onMapViewMenuToggle: () => void;
  onModeChange: (mode: MapViewMode) => void;
}) {
  const options: Array<{ id: MapViewMode; label: string }> = [
    { id: "single", label: "Single" },
    { id: "dual", label: "Dual" },
    { id: "swipe", label: "Swipe" },
  ];

  return (
    <div className="relative z-20 h-[144px] w-9">
      <div className="grid border border-[var(--control-border)] bg-[var(--control-bg)] shadow-[0_8px_24px_rgba(0,0,0,.18)]">
        <MapToolButton active={mapViewMenuOpen} label="Select map view mode" onClick={onMapViewMenuToggle}>
          <KeplerSplitIcon className="h-[18px] w-[18px]" />
        </MapToolButton>
        <MapToolButton active={map3dActive} label={map3dActive ? "Disable 3D Map" : "3D Map"} onClick={onMap3dToggle}>
          <KeplerCubeIcon className="h-[18px] w-[18px]" />
        </MapToolButton>
        <MapToolButton active={drawActive} label="Draw on map" onClick={onDrawToggle}>
          <KeplerDrawIcon className="h-[18px] w-[18px]" />
        </MapToolButton>
        <MapToolButton
          active={mapPdfExportActive || mapPdfExporting}
          disabled={mapPdfExporting}
          label={
            mapPdfExporting
              ? "Exporting map PDF"
              : mapPdfExportActive
                ? "Cancel map PDF export"
                : "Export map PDF"
          }
          onClick={onMapPdfExportToggle}
        >
          <Download className="h-[18px] w-[18px]" />
        </MapToolButton>
      </div>
      {mapViewMenuOpen ? (
        <div className="absolute left-full top-0 ml-2 grid w-[140px] overflow-hidden rounded-sm border border-[var(--panel-border)] bg-[var(--panel-bg)] py-1 text-[12px] font-semibold text-[var(--panel-muted)] shadow-[0_8px_24px_rgba(0,0,0,.2)]">
          {options.map((option) => (
            <button
              key={option.id}
              className={`h-9 px-4 text-left transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--panel-text)] ${
                mode === option.id ? "text-[var(--accent)]" : ""
              }`}
              type="button"
              aria-pressed={mode === option.id}
              onClick={() => onModeChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {drawActive ? (
        <DrawToolPanel
          featureCount={drawFeatureCount}
          selectedDrawId={selectedDrawId}
          tool={drawTool}
          onClear={onClearDrawFeatures}
          onDeleteSelected={onDeleteSelectedDrawFeature}
          onToolChange={onDrawToolChange}
        />
      ) : null}
    </div>
  );
}

function MapToolButton({
  active,
  children,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`group relative grid h-9 w-9 place-items-center border-b border-[var(--control-border)] text-[var(--control-text)] transition-colors last:border-b-0 hover:bg-[var(--row-hover)] disabled:cursor-wait disabled:opacity-70 ${
        active ? "bg-[var(--panel-active-bg)] text-[var(--accent)]" : ""
      }`}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <span
        className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-[#29323d] px-2 py-1 text-[11px] font-semibold leading-none text-[#f5f8fb] opacity-0 shadow-[0_6px_18px_rgba(0,0,0,.28)] transition-opacity duration-150 before:absolute before:right-full before:top-1/2 before:h-0 before:w-0 before:-translate-y-1/2 before:border-y-[5px] before:border-r-[5px] before:border-y-transparent before:border-r-[#29323d] group-hover:opacity-100 group-focus-visible:opacity-100"
        role="tooltip"
      >
        {label}
      </span>
    </button>
  );
}

function DrawToolPanel({
  featureCount,
  selectedDrawId,
  tool,
  onClear,
  onDeleteSelected,
  onToolChange,
}: {
  featureCount: number;
  selectedDrawId: string | null;
  tool: DrawTool;
  onClear: () => void;
  onDeleteSelected: () => void;
  onToolChange: (tool: DrawTool) => void;
}) {
  return (
    <div className="absolute left-full top-[72px] z-50 ml-2 grid w-[144px] overflow-visible border border-[var(--panel-border)] bg-[var(--control-bg)] shadow-[0_8px_24px_rgba(0,0,0,.22)]">
      <div className="grid grid-cols-4 border-b border-[var(--panel-border)]">
        <DrawPanelButton active={tool === "select"} label="Select drawings" onClick={() => onToolChange("select")}>
          <SelectDrawIcon className="h-[17px] w-[17px]" />
        </DrawPanelButton>
        <DrawPanelButton active={tool === "polygon"} label="Draw polygon" onClick={() => onToolChange("polygon")}>
          <KeplerDrawIcon className="h-[17px] w-[17px]" />
        </DrawPanelButton>
        <DrawPanelButton active={tool === "circle"} label="Draw circle" onClick={() => onToolChange("circle")}>
          <CircleDrawIcon className="h-[17px] w-[17px]" />
        </DrawPanelButton>
        <DrawPanelButton active={tool === "rectangle"} label="Draw rectangle" onClick={() => onToolChange("rectangle")}>
          <RectangleDrawIcon className="h-[17px] w-[17px]" />
        </DrawPanelButton>
      </div>
      <div className="grid grid-cols-2">
        <DrawPanelButton disabled={!selectedDrawId} label="Delete selected drawing" onClick={onDeleteSelected}>
          <TrashDrawIcon className="h-[16px] w-[16px]" />
        </DrawPanelButton>
        <DrawPanelButton disabled={featureCount === 0} label="Clear drawings" onClick={onClear}>
          <ClearDrawIcon className="h-[16px] w-[16px]" />
        </DrawPanelButton>
      </div>
    </div>
  );
}

function DrawPanelButton({
  active = false,
  children,
  disabled = false,
  label,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`group relative grid h-9 w-full place-items-center border-r border-[var(--panel-border)] text-[var(--control-text)] transition-colors last:border-r-0 hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:text-[var(--panel-disabled)] ${
        active ? "bg-[var(--panel-active-bg)] text-[var(--accent)]" : ""
      }`}
      type="button"
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
      <span
        className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-[#29323d] px-2 py-1 text-[11px] font-semibold leading-none text-[#f5f8fb] opacity-0 shadow-[0_6px_18px_rgba(0,0,0,.28)] transition-opacity duration-150 before:absolute before:right-full before:top-1/2 before:h-0 before:w-0 before:-translate-y-1/2 before:border-y-[5px] before:border-r-[5px] before:border-y-transparent before:border-r-[#29323d] group-hover:opacity-100 group-focus-visible:opacity-100"
        role="tooltip"
      >
        {label}
      </span>
    </button>
  );
}

function KeplerDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path
        d="M4.25 7.05 8.6 3.85l5 2.25 1.05 5.35-3.95 2.75-5.45-1.35-1.8-3.75.8-2.05Z"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
      <circle cx="4.25" cy="7.05" r="0.95" fill="currentColor" />
      <circle cx="8.6" cy="3.85" r="0.95" fill="currentColor" />
      <circle cx="13.6" cy="6.1" r="0.95" fill="currentColor" />
      <circle cx="14.65" cy="11.45" r="0.95" fill="currentColor" />
      <circle cx="10.7" cy="14.2" r="0.95" fill="currentColor" />
      <circle cx="5.25" cy="12.85" r="0.95" fill="currentColor" />
    </svg>
  );
}

function KeplerCubeIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path
        d="M9 2.75 14.2 5.7v6.55L9 15.25l-5.2-3V5.7L9 2.75Z"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
      <path d="M3.8 5.7 9 8.7l5.2-3M9 8.7v6.55" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
    </svg>
  );
}

function KeplerSplitIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path d="M3.35 3.65h11.3v10.7H3.35V3.65Z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M7.05 4.05v9.9M10.95 4.05v9.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function SelectDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path d="M4.1 2.8 12.9 9l-4.1 1.1-1.85 3.95L4.1 2.8Z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M9.1 10.1 12 14.8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function CircleDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <circle cx="9" cy="9" r="5.6" stroke="currentColor" strokeWidth="1.45" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
    </svg>
  );
}

function RectangleDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path d="M3.6 4.4h10.8v9.2H3.6V4.4Z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <circle cx="3.6" cy="4.4" r="0.85" fill="currentColor" />
      <circle cx="14.4" cy="4.4" r="0.85" fill="currentColor" />
      <circle cx="14.4" cy="13.6" r="0.85" fill="currentColor" />
      <circle cx="3.6" cy="13.6" r="0.85" fill="currentColor" />
    </svg>
  );
}

function TrashDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path d="M4.1 5.2h9.8M7.1 5.2V3.6h3.8v1.6M6 7.2l.45 6.5h5.1L12 7.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClearDrawIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" aria-hidden="true" fill="none">
      <path d="M4.1 4.1 13.9 13.9M13.9 4.1 4.1 13.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function BasemapOptionButton({
  active,
  option,
  onSelect,
}: {
  active: boolean;
  option: BasemapOption;
  onSelect: (id: BasemapId) => void;
}) {
  return (
    <button
      className={`map-tiles-basemap-option grid min-h-[48px] grid-cols-[34px_minmax(0,1fr)_12px] items-center gap-2 border px-2 py-1.5 text-left transition-colors ${
        active
          ? "border-[var(--accent)] bg-[var(--panel-active-bg)] text-[var(--panel-text)]"
          : "border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] hover:border-[var(--accent)] hover:bg-[var(--row-hover)]"
      }`}
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(option.id)}
    >
      <span className="h-7 w-8 border border-white/10 shadow-inner" style={{ background: option.preview }} />
      <span className="min-w-0">
        <strong className="block truncate text-[11px] font-semibold tracking-wide">{option.name}</strong>
        <span className="block truncate text-[9px] font-medium text-[var(--panel-muted)]">{option.description}</span>
      </span>
      <span className={`grid h-3 w-3 place-items-center border ${active ? "border-[var(--accent)]" : "border-[var(--panel-muted)]"}`}>
        {active ? <span className="h-1.5 w-1.5 bg-[var(--accent)]" /> : null}
      </span>
    </button>
  );
}

function CompareTargetTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CompareTarget;
  onChange: (value: CompareTarget) => void;
}) {
  return (
    <div className="sticky top-0 z-10 mb-2 grid grid-cols-2 gap-1 border-b border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 pb-2" role="tablist" aria-label={label}>
      {(["primary", "comparison"] as CompareTarget[]).map((target) => (
        <button
          key={target}
          className={`h-8 border text-[11px] font-semibold transition-colors ${
            value === target
              ? "border-[var(--accent)] bg-[var(--panel-active-bg)] text-[var(--accent)]"
              : "border-[var(--panel-border)] bg-[var(--input-bg)] text-[var(--panel-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--panel-text)]"
          }`}
          type="button"
          role="tab"
          aria-selected={value === target}
          onClick={() => onChange(target)}
        >
          {target === "primary" ? "Primary" : "Compare"}
        </button>
      ))}
    </div>
  );
}

function VisibilityCheckbox({
  status,
  title,
  onToggle,
}: {
  status: VisibilityStatus;
  title: string;
  onToggle: () => void;
}) {
  const visible = status === "visible-current-scale";
  const mixed = status === "visible-other-scale";

  return (
    <button
      className={`relative z-[1] mr-1 grid h-3.5 w-3.5 shrink-0 place-items-center border ${
        visible || mixed
          ? "border-[var(--accent)] bg-[var(--panel-active-bg)] text-[var(--accent)]"
          : "border-[var(--panel-border)] bg-[var(--input-bg)] text-transparent"
      }`}
      aria-checked={mixed ? "mixed" : visible}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      role="checkbox"
      title={title}
      type="button"
    >
      <span className={`${mixed ? "h-0.5 w-2" : "h-2 w-2"} bg-current`} />
    </button>
  );
}

function LayerFilterEditorPanel({
  state,
  onApply,
  onChange,
  onClear,
  onClose,
}: {
  state: LayerFilterEditorState;
  onApply: (target: LayerFilterTarget, rules: AttributeFilterRule[]) => void;
  onChange: (state: LayerFilterEditorState) => void;
  onClear: (target: LayerFilterTarget) => void;
  onClose: () => void;
}) {
  const fields = state.target.fields;
  const updateRule = (ruleId: string, patch: Partial<AttributeFilterRule>) => {
    onChange({
      ...state,
      rules: state.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    });
  };
  const removeRule = (ruleId: string) => {
    const nextRules = state.rules.filter((rule) => rule.id !== ruleId);
    onChange({
      ...state,
      rules: nextRules.length ? nextRules : [emptyAttributeFilterRule(fields[0]?.name || "")],
    });
  };
  const addRule = () => {
    onChange({
      ...state,
      rules: [...state.rules, emptyAttributeFilterRule(fields[0]?.name || "")],
    });
  };

  return (
    <aside className="map-tiles-layer-filter-editor absolute right-[392px] top-16 z-40 grid w-[430px] max-w-[calc(100vw-112px)] grid-rows-[42px_minmax(0,1fr)_auto] overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-[0_18px_45px_rgba(0,0,0,.3)]">
      <header className="flex items-center justify-between gap-2 bg-[var(--brand-bg)] px-3 text-[var(--brand-fg)]">
        <div className="min-w-0">
          <strong className="block truncate text-[13px] font-semibold">Attribute Filter</strong>
          <span className="block truncate text-[9px] font-semibold uppercase tracking-[.08em] text-white/75">
            {state.target.label}
          </span>
        </div>
        <button
          className="grid h-8 w-8 shrink-0 place-items-center hover:bg-white/12"
          type="button"
          onClick={onClose}
          title="Close filter editor"
          aria-label="Close filter editor"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 overflow-auto p-3 [scrollbar-color:var(--scrollbar-thumb)_transparent]">
        <div className="mb-3 rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-2.5 py-2 text-[10px] font-semibold text-[var(--panel-muted)]">
          Filters are shared by layers using this data source. Risk and inventory widgets will use the same rules.
        </div>
        {state.fieldsLoading ? (
          <div className="mb-2 text-[10px] font-semibold text-[var(--panel-muted)]">Loading available fields...</div>
        ) : null}
        {state.fieldsError ? (
          <div className="mb-2 text-[10px] font-semibold text-[var(--panel-muted)]">{state.fieldsError}</div>
        ) : null}
        {!fields.length ? (
          <div className="rounded-sm border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 py-2 text-[11px] font-semibold text-[var(--panel-muted)]">
            No filterable numeric, text, or date fields are available for this layer.
          </div>
        ) : null}
        <div className="grid gap-2">
          {state.rules.map((rule, index) => {
            const field = attributeFilterFieldForRule(state.target, rule);
            const operatorOptions = attributeFilterOperatorsForField(field);
            const operator = operatorOptions.find((option) => option.value === rule.operator) || operatorOptions[0];
            return (
              <div
                key={rule.id}
                className="grid grid-cols-[minmax(0,1.15fr)_minmax(118px,.8fr)_minmax(0,1fr)_24px] items-center gap-1.5"
              >
                <select
                  className="h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px] font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
                  disabled={!fields.length}
                  value={rule.field}
                  onChange={(event) => {
                    const nextField = fields.find((item) => item.name === event.target.value) || fields[0];
                    const nextOperators = attributeFilterOperatorsForField(nextField);
                    updateRule(rule.id, {
                      field: nextField?.name || "",
                      operator: nextOperators[0]?.value || "eq",
                      value: "",
                    });
                  }}
                  aria-label={`Filter ${index + 1} field`}
                >
                  {fields.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <select
                  className="h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px] font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)]"
                  disabled={!fields.length}
                  value={rule.operator}
                  onChange={(event) => {
                    const nextOperator = event.target.value as AttributeFilterOperator;
                    updateRule(rule.id, {
                      operator: nextOperator,
                      value: attributeFilterOperatorNeedsValue(nextOperator) ? rule.value : "",
                    });
                  }}
                  aria-label={`Filter ${index + 1} operator`}
                >
                  {operatorOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className="h-8 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px] font-semibold text-[var(--panel-text)] outline-none focus:border-[var(--accent)] disabled:opacity-45"
                  disabled={!fields.length || !operator.needsValue}
                  placeholder={operator.needsValue ? valuePlaceholderForField(field) : ""}
                  type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text"}
                  value={operator.needsValue ? rule.value : ""}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateRule(rule.id, { value: event.target.value })}
                  aria-label={`Filter ${index + 1} value`}
                />
                <button
                  className="grid h-8 w-6 place-items-center text-[var(--panel-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--accent)]"
                  type="button"
                  onClick={() => removeRule(rule.id)}
                  title="Remove rule"
                  aria-label="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="mt-2 inline-flex h-8 items-center gap-1.5 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2.5 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--accent)] hover:bg-[var(--row-hover)] disabled:cursor-not-allowed disabled:text-[var(--panel-disabled)]"
          type="button"
          disabled={!fields.length}
          onClick={addRule}
        >
          <Plus className="h-3.5 w-3.5" />
          Add rule
        </button>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] px-3 py-2">
        <button
          className="h-8 border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--panel-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--panel-text)]"
          type="button"
          onClick={() => onClear(state.target)}
        >
          Clear
        </button>
        <div className="flex items-center gap-2">
          <button
            className="h-8 border border-[var(--panel-border)] bg-[var(--input-bg)] px-3 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--panel-text)] hover:bg-[var(--row-hover)]"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="h-8 border border-[var(--accent)] bg-[var(--accent)] px-3 text-[10px] font-black uppercase tracking-[.08em] text-white hover:brightness-110 disabled:cursor-not-allowed disabled:border-[var(--panel-border)] disabled:bg-[var(--input-bg)] disabled:text-[var(--panel-disabled)]"
            type="button"
            disabled={!fields.length}
            onClick={() => onApply(state.target, state.rules)}
          >
            Apply
          </button>
        </div>
      </footer>
    </aside>
  );
}

function LayerTree({
  attributeFilters,
  currentZoom,
  tree,
  layerVisibility,
  onEditFilter,
  onToggleLayer,
  onToggleLayers,
}: {
  attributeFilters: Record<string, LayerAttributeFilter>;
  currentZoom: number;
  tree: LayerTreeNode;
  layerVisibility: Record<string, boolean>;
  onEditFilter: (layer: StyleLayer) => void;
  onToggleLayer: (layerId: string, visible: boolean) => void;
  onToggleLayers: (layers: StyleLayer[], visible: boolean) => void;
}) {
  if (!tree.entries.length) {
    return <div className="px-3 py-2 text-[11px] font-semibold text-[var(--panel-muted)]">No layers</div>;
  }
  return (
    <div className="min-w-full py-1 text-[11px]" role="tree" aria-label="Map layers">
      <LayerTreeEntries
        attributeFilters={attributeFilters}
        currentZoom={currentZoom}
        depth={0}
        entries={tree.entries}
        layerVisibility={layerVisibility}
        onEditFilter={onEditFilter}
        onToggleLayer={onToggleLayer}
        onToggleLayers={onToggleLayers}
      />
    </div>
  );
}

function LayerTreeEntries({
  attributeFilters,
  currentZoom,
  depth,
  entries,
  layerVisibility,
  onEditFilter,
  onToggleLayer,
  onToggleLayers,
}: {
  attributeFilters: Record<string, LayerAttributeFilter>;
  currentZoom: number;
  depth: number;
  entries: LayerTreeEntry[];
  layerVisibility: Record<string, boolean>;
  onEditFilter: (layer: StyleLayer) => void;
  onToggleLayer: (layerId: string, visible: boolean) => void;
  onToggleLayers: (layers: StyleLayer[], visible: boolean) => void;
}) {
  return (
    <>
      {entries.map((entry) =>
        entry.type === "group" ? (
          <LayerTreeGroup
            attributeFilters={attributeFilters}
            key={entry.node.key}
            currentZoom={currentZoom}
            depth={depth}
            node={entry.node}
            layerVisibility={layerVisibility}
            onEditFilter={onEditFilter}
            onToggleLayers={onToggleLayers}
            onToggleLayer={onToggleLayer}
          />
        ) : (
          <LayerTreeLayer
            attributeFilters={attributeFilters}
            key={entry.layer.id}
            currentZoom={currentZoom}
            depth={depth}
            layer={entry.layer}
            layerVisibility={layerVisibility}
            onEditFilter={onEditFilter}
            onToggle={onToggleLayer}
          />
        ),
      )}
    </>
  );
}

function LayerTreeGroup({
  attributeFilters,
  currentZoom,
  depth,
  node,
  layerVisibility,
  onEditFilter,
  onToggleLayer,
  onToggleLayers,
}: {
  attributeFilters: Record<string, LayerAttributeFilter>;
  currentZoom: number;
  depth: number;
  node: LayerTreeNode;
  layerVisibility: Record<string, boolean>;
  onEditFilter: (layer: StyleLayer) => void;
  onToggleLayer: (layerId: string, visible: boolean) => void;
  onToggleLayers: (layers: StyleLayer[], visible: boolean) => void;
}) {
  const layers = collectTreeLayers(node);
  const [open, setOpen] = useState(() => shouldDefaultOpenLayerGroup(node, depth));
  const activeCount = layers.filter((layer) => layerVisibility[layer.id]).length;
  const totalCount = layers.length;
  const status = groupVisibilityStatus(layers, layerVisibility, currentZoom);
  const nextVisible = status === "invisible";
  return (
    <details
      className="group/tree-row text-[var(--panel-text)] [&>summary::-webkit-details-marker]:hidden"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="flex min-h-[26px] cursor-pointer select-none items-center gap-1 px-2 hover:bg-[var(--row-hover)]"
        title={node.name}
      >
        <span className="relative flex min-w-0 flex-1 items-center" style={treeCellIndentStyle(depth)}>
          <TreeGuides depth={depth} />
          <ChevronRight className="relative z-[1] mr-0.5 h-3.5 w-3.5 shrink-0 text-[var(--panel-muted)] transition-transform group-open/tree-row:rotate-90" />
          <VisibilityCheckbox
            status={status}
            title={visibilityStatusLabel(status)}
            onToggle={() => onToggleLayers(layers, nextVisible)}
          />
          <span className="relative z-[1] mr-1 grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] text-[9px] text-[var(--accent)]">
            <Layers className="h-3 w-3" />
          </span>
          <span className={`relative z-[1] truncate font-semibold ${visibilityTextClass(status)}`}>{node.name}</span>
        </span>
        <span className={`shrink-0 rounded-sm border border-[var(--panel-border)] px-1.5 py-0.5 text-[9px] font-semibold ${visibilityCountClass(status)}`}>{activeCount}/{totalCount}</span>
      </summary>
      <LayerTreeEntries
        attributeFilters={attributeFilters}
        currentZoom={currentZoom}
        depth={depth + 1}
        entries={node.entries}
        layerVisibility={layerVisibility}
        onEditFilter={onEditFilter}
        onToggleLayer={onToggleLayer}
        onToggleLayers={onToggleLayers}
      />
    </details>
  );
}

function LayerTreeLayer({
  attributeFilters,
  currentZoom,
  depth,
  layer,
  layerVisibility,
  onEditFilter,
  onToggle,
}: {
  attributeFilters: Record<string, LayerAttributeFilter>;
  currentZoom: number;
  depth: number;
  layer: StyleLayer;
  layerVisibility: Record<string, boolean>;
  onEditFilter: (layer: StyleLayer) => void;
  onToggle: (layerId: string, visible: boolean) => void;
}) {
  const title = String(layer.metadata?.aprx_layer || layer.id);
  const sourceLayer = String(layer.metadata?.tile_source_layer || layer["source-layer"] || "");
  const filterTarget = layerFilterTarget(layer);
  const filterable = Boolean(filterTarget);
  const filterRuleCount = filterTarget ? attributeFilters[filterTarget.key]?.rules.length || 0 : 0;
  const status = layerVisibilityStatus(layer, layerVisibility, currentZoom);
  const nextVisible = status === "invisible";
  return (
    <label
      className="flex min-h-[26px] cursor-pointer items-center gap-1 px-2 text-[var(--panel-text)] hover:bg-[var(--row-hover)]"
      title={`${title}${sourceLayer ? `\nSource: ${sourceLayer}` : ""}\nType: ${layer.type}\n${visibilityStatusLabel(status)}`}
    >
      <span className="relative flex min-w-0 flex-1 items-center" style={treeCellIndentStyle(depth)}>
        <TreeGuides depth={depth} />
        <span className="relative z-[1] mr-0.5 h-3.5 w-3.5 shrink-0" />
        <VisibilityCheckbox
          status={status}
          title={visibilityStatusLabel(status)}
          onToggle={() => onToggle(layer.id, nextVisible)}
        />
        <span className="relative z-[1] mr-1 grid h-4 w-4 shrink-0 place-items-center rounded-sm border border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)]">
          <LayerSwatch layer={layer} />
        </span>
        <span className={`relative z-[1] truncate font-medium ${visibilityTextClass(status)}`}>{layerLabel(layer)}</span>
      </span>
      {filterable ? (
        <button
          className={`relative z-[1] grid h-5 min-w-5 shrink-0 place-items-center rounded-sm px-0.5 text-[var(--accent)] hover:bg-[var(--panel-active-bg)] ${
            filterRuleCount ? "bg-[var(--panel-active-bg)]" : ""
          }`}
          title={filterRuleCount ? `${filterRuleCount} attribute filter rule(s)` : "Add attribute filter"}
          aria-label={filterRuleCount ? `${filterRuleCount} attribute filter rule(s)` : "Add attribute filter"}
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEditFilter(layer);
          }}
        >
          <Filter className="h-3.5 w-3.5" />
          {filterRuleCount ? (
            <span className="absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[var(--accent)] px-0.5 text-[8px] font-black text-white">
              {filterRuleCount}
            </span>
          ) : null}
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden="true" />
      )}
    </label>
  );
}

function LayerSwatch({ layer }: { layer: StyleLayer }) {
  const color = layerColor(layer);
  const legendIcon = String(layer.metadata?.legend_icon || "");
  if (legendIcon === "pin") {
    return (
      <span className="relative block h-3.5 w-3">
        <span className="absolute left-1/2 top-[6px] h-2.5 w-[2px] -translate-x-1/2 rounded-full bg-black" />
        <span className="absolute left-1/2 top-[6px] h-2.5 w-px -translate-x-1/2 rounded-full" style={{ backgroundColor: color }} />
        <span className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-black" style={{ backgroundColor: color }} />
      </span>
    );
  }
  if (legendIcon === "storm-water-easement") {
    return (
      <span className="relative block h-4 w-4">
        <span className="absolute left-[5px] top-[11px] h-1.5 w-1 rotate-12 bg-[#262626]" />
        <span className="absolute left-[2px] top-[1px] grid h-3.5 w-3.5 place-items-center border border-[#1f2933] bg-[#f00000] text-[8px] font-black leading-none text-white">
          E
        </span>
      </span>
    );
  }
  if (legendIcon === "pending-structure") {
    return (
      <span className="grid h-4 w-4 place-items-center">
        <span className="grid h-2.5 w-2.5 place-items-center border border-[#807b00] bg-[#ffff00]">
          <span className="h-1 w-1 bg-[#4f5012]" />
        </span>
      </span>
    );
  }
  if (legendIcon === "storm-structure") {
    return (
      <span className="grid h-4 w-4 place-items-center">
        <span className="grid h-2.5 w-2.5 rotate-45 place-items-center border border-black bg-[#e60000]">
          <span className="h-1 w-1 rounded-full bg-black" />
        </span>
      </span>
    );
  }
  if (legendIcon === "diamond") {
    return (
      <svg className="block h-4 w-4" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 1.2L18.8 10 10 18.8 1.2 10z" fill="#697078" />
        <path d="M10 3.2L16.8 10 10 16.8 3.2 10z" fill={color} />
      </svg>
    );
  }
  if (legendIcon === "star") {
    return (
      <svg className="block h-4 w-4" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3.2l1.45 4.35h4.65l-3.75 2.7 1.45 4.45L10 11.95 6.2 14.7l1.45-4.45-3.75-2.7h4.65z" fill="#1f2933" />
        <path d="M10 4.8l1.05 3.15h3.35l-2.7 1.95 1.05 3.2L10 11.15 7.25 13.1l1.05-3.2-2.7-1.95h3.35z" fill={color} />
      </svg>
    );
  }
  if (legendIcon === "dam") {
    const glyphColor = String(layer.metadata?.legend_glyph_color || "#ffffff");
    return (
      <svg className="block h-4 w-4" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.7" fill="#a6a6a6" />
        <circle cx="10" cy="10" r="7.5" fill={color} />
        <rect x="13" y="4.7" width="2.8" height="10.6" rx="0.35" fill={glyphColor} />
        <path d="M4.4 6.4l1.4-1.2 1.5 1.2 1.5-1.2 1.5 1.2M4.4 9.3l1.4-1.2 1.5 1.2 1.5-1.2 1.5 1.2M4.4 12.2l1.4-1.2 1.5 1.2 1.5-1.2 1.5 1.2" fill="none" stroke={glyphColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
      </svg>
    );
  }
  if (legendIcon === "hollow-triangle-down") {
    return (
      <span className="relative block h-3.5 w-3.5">
        <span className="absolute left-1/2 top-[2px] h-0 w-0 -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[10px] border-l-transparent border-r-transparent" style={{ borderTopColor: "#111827" }} />
        <span className="absolute left-1/2 top-[3px] h-0 w-0 -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent" style={{ borderTopColor: color }} />
        <span
          className="absolute left-1/2 top-[5px] h-0 w-0 -translate-x-1/2 border-l-[3px] border-r-[3px] border-t-[5px] border-l-transparent border-r-transparent"
          style={{ borderTopColor: "var(--panel-bg)" }}
        />
      </span>
    );
  }
  if (legendIcon === "triangle-down") {
    return (
      <span className="relative block h-3.5 w-3.5">
        <span className="absolute left-1/2 top-[3px] h-0 w-0 -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent" style={{ borderTopColor: "#111827" }} />
        <span className="absolute left-1/2 top-[4px] h-0 w-0 -translate-x-1/2 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent" style={{ borderTopColor: color }} />
      </span>
    );
  }
  if (layer.type === "line") {
    return <span className="h-1 w-3 rounded-full" style={{ backgroundColor: color }} />;
  }
  return <span className={`h-2 w-2 ${layer.type === "fill" ? "rounded-sm" : "rounded-full"}`} style={{ backgroundColor: color }} />;
}

function layerVisibilityStatus(layer: StyleLayer, layerVisibility: Record<string, boolean>, currentZoom: number): VisibilityStatus {
  if (!layerVisibility[layer.id]) {
    return "invisible";
  }
  return layerVisibleAtZoom(layer, currentZoom) ? "visible-current-scale" : "visible-other-scale";
}

function groupVisibilityStatus(layers: StyleLayer[], layerVisibility: Record<string, boolean>, currentZoom: number): VisibilityStatus {
  const enabledLayers = layers.filter((layer) => layerVisibility[layer.id]);
  if (!enabledLayers.length) {
    return "invisible";
  }
  return enabledLayers.some((layer) => layerVisibleAtZoom(layer, currentZoom)) ? "visible-current-scale" : "visible-other-scale";
}

function layerVisibleAtZoom(layer: StyleLayer, currentZoom: number): boolean {
  const minZoom = numericLayerZoom((layer as StyleLayer & { minzoom?: unknown }).minzoom, 0);
  const maxZoom = numericLayerZoom((layer as StyleLayer & { maxzoom?: unknown }).maxzoom, Infinity);
  return currentZoom >= minZoom && currentZoom < maxZoom;
}

function numericLayerZoom(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function visibilityStatusLabel(status: VisibilityStatus): string {
  if (status === "visible-current-scale") {
    return "Visible at current scale";
  }
  if (status === "visible-other-scale") {
    return "Visible at another scale range";
  }
  return "Not visible";
}

function visibilityTextClass(status: VisibilityStatus): string {
  if (status === "visible-current-scale") {
    return "text-[var(--panel-text)]";
  }
  if (status === "visible-other-scale") {
    return "text-[var(--panel-muted)]";
  }
  return "text-[var(--panel-disabled)]";
}

function visibilityCountClass(status: VisibilityStatus): string {
  if (status === "visible-current-scale") {
    return "text-[var(--accent)]";
  }
  if (status === "visible-other-scale") {
    return "text-[var(--panel-muted)]";
  }
  return "text-[var(--panel-disabled)]";
}

function shouldDefaultOpenLayerGroup(node: LayerTreeNode, depth: number): boolean {
  return depth === 0 && DEFAULT_OPEN_LAYER_GROUPS.has(node.name.trim().toLowerCase());
}

function buildLayerTree(layers: StyleLayer[]): LayerTreeNode {
  const root = createLayerTreeNode("root", "Layers");
  layers.forEach((layer) => {
    const segments = layerTreeSegments(layer);
    let parent = root;
    segments.forEach((segment, index) => {
      const key = `${parent.key}/${index}:${segment}`;
      parent = ensureTreeChild(parent, key, segment);
    });
    parent.entries.push({ type: "layer", layer });
  });
  return root;
}

function filterLayersByName(layers: StyleLayer[], query: string): StyleLayer[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return layers;
  }
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return layers.filter((layer) => {
    const haystack = [
      layer.id,
      layerLabel(layer),
      layerSubtitle(layer),
      layer.metadata?.aprx_layer,
      layer.metadata?.parent_group,
      layer.metadata?.tile_source_layer,
      layer.metadata?.dataset_id,
      layer["source-layer"],
    ]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function createLayerTreeNode(key: string, name: string): LayerTreeNode {
  return {
    key,
    name,
    entries: [],
    childrenByKey: new Map<string, LayerTreeNode>(),
  };
}

function ensureTreeChild(parent: LayerTreeNode, key: string, name: string): LayerTreeNode {
  const existing = parent.childrenByKey.get(key);
  if (existing) {
    return existing;
  }
  const child = createLayerTreeNode(key, name);
  parent.childrenByKey.set(key, child);
  parent.entries.push({ type: "group", node: child });
  return child;
}

function layerTreeSegments(layer: StyleLayer): string[] {
  const aprxPath = String(layer.metadata?.aprx_layer || "").trim();
  if (aprxPath) {
    const segments = aprxPath.split("\\").map(cleanTreeSegment).filter(Boolean);
    if (segments.length > 1) {
      return segments.slice(0, -1);
    }
  }

  const parentGroup = String(layer.metadata?.parent_group || "").trim();
  if (parentGroup) {
    return parentGroup.split(/\s+\/\s+|\\/).map(cleanTreeSegment).filter(Boolean);
  }

  const sourceLayer = String(layer.metadata?.tile_source_layer || layer["source-layer"] || "").trim();
  return sourceLayer ? [sourceLayer] : [];
}

function cleanTreeSegment(segment: string): string {
  return segment.trim().replace(/\s+/g, " ");
}

function collectTreeLayers(node: LayerTreeNode): StyleLayer[] {
  return node.entries.flatMap((entry) => (entry.type === "layer" ? [entry.layer] : collectTreeLayers(entry.node)));
}

function TreeGuides({ depth }: { depth: number }) {
  if (depth <= 0) {
    return null;
  }
  return (
    <span className="pointer-events-none absolute inset-y-0 left-0 z-0" style={{ width: `${depth * 18}px` }}>
      {Array.from({ length: depth }).map((_, index) => (
        <span
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="absolute bottom-0 top-0 border-l border-dotted border-[var(--tree-guide)]"
          style={{ left: `${index * 18 + 5}px` }}
        />
      ))}
      <span
        className="absolute top-1/2 w-3 border-t border-dotted border-[var(--tree-guide)]"
        style={{ left: `${(depth - 1) * 18 + 5}px` }}
      />
    </span>
  );
}

function treeCellIndentStyle(depth: number): React.CSSProperties {
  return {
    paddingLeft: `${Math.min(depth * 18 + 2, 92)}px`,
  };
}

function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] px-4 py-3 text-[10px] font-semibold uppercase tracking-[.16em] text-[var(--accent)]">
      <span>{eyebrow}</span>
      <strong className="text-[13px] font-semibold normal-case tracking-normal text-[var(--panel-text)]">{title}</strong>
    </header>
  );
}

function NorthArrowControl({
  bearing,
  dragging,
  map3dActive,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  bearing: number;
  dragging: boolean;
  map3dActive: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const displayBearing = Math.round(normalizeBearingForDisplay(bearing));
  const tooltip = map3dActive
    ? "Drag around to rotate. Drag up or down to tilt in 3D. Click to reset north."
    : "Drag around to rotate the map. Click to reset north.";

  return (
    <div className="pointer-events-none">
      <button
        className={`group relative pointer-events-auto grid h-[64px] w-[48px] cursor-grab select-none grid-rows-[1fr_12px] place-items-center border bg-[var(--control-bg)] text-[var(--accent)] shadow-xl backdrop-blur-sm transition-colors active:cursor-grabbing ${
          dragging ? "border-[var(--accent)] ring-2 ring-[var(--accent)]" : "border-[var(--control-border)] hover:border-[var(--accent)]"
        }`}
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title={tooltip}
        aria-label={`North arrow. Map bearing ${displayBearing} degrees. ${tooltip}`}
        style={{ touchAction: "none" }}
      >
        <img
          className="h-11 w-11 origin-center select-none"
          src={northArrowCompassUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{
            transform: `rotate(${-bearing}deg)`,
            transition: dragging ? "none" : "transform 150ms ease-out",
          }}
        />
        <span className="text-[9px] font-black leading-none text-[var(--control-text)]">{displayBearing} deg</span>
        <span
          className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-[#29323d] px-2 py-1 text-[11px] font-semibold leading-none text-[#f5f8fb] opacity-0 shadow-[0_6px_18px_rgba(0,0,0,.28)] transition-opacity duration-150 before:absolute before:right-full before:top-1/2 before:h-0 before:w-0 before:-translate-y-1/2 before:border-y-[5px] before:border-r-[5px] before:border-y-transparent before:border-r-[#29323d] group-hover:opacity-100 group-focus-visible:opacity-100"
          role="tooltip"
        >
          {tooltip}
        </span>
      </button>
    </div>
  );
}

function FeatureDetails({ feature }: { feature: SelectedFeature }) {
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1 border-b border-[var(--panel-border)] pb-2.5">
        <span className="text-sm font-semibold leading-snug text-[var(--panel-text)]">{feature.layerLabel}</span>
        <strong className="text-[10px] font-semibold uppercase text-[var(--accent)]">{feature.layerType}</strong>
      </div>
      {feature.properties.length ? (
        <dl className="grid grid-cols-[minmax(82px,42%)_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
          {feature.properties.map(([key, value]) => (
            <div key={`${key}:${value}`} className="contents">
              <dt className="min-w-0 [overflow-wrap:anywhere] text-[10px] font-semibold text-[var(--panel-muted)]">{key}</dt>
              <dd className="m-0 min-w-0 break-words text-[11px] font-medium text-[var(--panel-text)]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="m-0 text-[11px] font-semibold text-[var(--panel-muted)]">No properties</p>
      )}
    </div>
  );
}

function selectedFeatureFromMapFeature(feature: MapGeoJSONFeature, layer: StyleLayer | undefined, propertyLimit?: number): SelectedFeature {
  return {
    layerLabel: layer ? layerLabel(layer) : feature.layer.id,
    layerType: feature.layer.type,
    properties: readableFeatureProperties(feature, propertyLimit),
  };
}

function identifyFeatureFromMapFeature(
  feature: MapGeoJSONFeature,
  layer: StyleLayer | undefined,
  order: number,
  originalIndex: number,
): IdentifyFeature {
  const selectedFeature = selectedFeatureFromMapFeature(feature, layer);
  const featureLabel = featureDisplayLabel(feature.properties || {}, originalIndex);
  const sourceLayer = typeof feature.sourceLayer === "string" ? feature.sourceLayer : layer?.["source-layer"] || "";
  const featureId = feature.id === undefined || feature.id === null ? "" : String(feature.id);
  return {
    ...selectedFeature,
    featureLabel,
    featureSubtitle: sourceLayer || selectedFeature.layerType,
    geometry: mapFeatureGeometry(feature),
    layerId: feature.layer.id,
    order,
    originalIndex,
    uniqueKey: [
      feature.layer.id,
      sourceLayer,
      featureId,
      stablePropertiesKey(selectedFeature.properties),
      originalIndex,
    ].join("|"),
  };
}

function selectedFeatureFromIdentifyFeature(feature: IdentifyFeature): SelectedFeature {
  return {
    layerLabel: feature.layerLabel,
    layerType: feature.layerType,
    properties: feature.properties,
  };
}

function selectedFeatureFromSearchResult(result: AssetSearchResult): SelectedFeature {
  const properties = Object.entries(result.properties || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [key, formatPropertyValue(value)] as [string, string]);
  const matchEntry: [string, string] = ["Matched", `${result.match_field}: ${result.match_value}`];
  return {
    layerLabel: result.layer_name,
    layerType: result.geometry_type || result.kind,
    properties: [matchEntry, ...properties.filter(([key]) => key !== result.match_field)],
  };
}

function selectedFeatureFromRiskTopListItem(item: RiskTopListItem): SelectedFeature {
  const properties = Object.entries(item.properties || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [key, formatPropertyValue(value)] as [string, string]);
  const riskEntry: [string, string] = [item.risk_field, formatRiskScore(item.risk_score)];
  return {
    layerLabel: item.layer_label,
    layerType: item.geometry_type || "Risk feature",
    properties: [riskEntry, ...properties.filter(([key]) => key !== item.risk_field)],
  };
}

function readableFeatureProperties(feature: MapGeoJSONFeature, propertyLimit?: number): Array<[string, string]> {
  const entries = Object.entries(feature.properties || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [key, formatPropertyValue(value)] as [string, string]);
  return Number.isFinite(propertyLimit) ? entries.slice(0, propertyLimit) : entries;
}

function formatPropertyValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function featureDisplayLabel(properties: MapGeoJSONFeature["properties"], originalIndex: number): string {
  const entries = Object.entries(properties || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  const priorityPatterns = [
    /^(facility|asset|investigation|observation|work_?order|itpipes).*id$/i,
    /.*(facility|asset|investigation|observation|work_?order|itpipes).*id$/i,
    /^name$/i,
    /name$/i,
    /^id$/i,
    /_id$/i,
  ];
  for (const pattern of priorityPatterns) {
    const match = entries.find(([key]) => pattern.test(key));
    if (match) {
      return `${match[0]}: ${formatPropertyValue(match[1])}`;
    }
  }
  const first = entries[0];
  return first ? `${first[0]}: ${formatPropertyValue(first[1])}` : `Feature ${originalIndex + 1}`;
}

function dedupeIdentifyFeatures(features: IdentifyFeature[]): IdentifyFeature[] {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const key = `${feature.layerId}|${feature.featureLabel}|${stablePropertiesKey(feature.properties)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stablePropertiesKey(properties: Array<[string, string]>): string {
  return properties
    .slice(0, 16)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampFloatingWidgetPosition(
  position: FloatingWidgetPosition,
  containerRect: DOMRect,
  width: number,
  height: number,
): FloatingWidgetPosition {
  const margin = 8;
  return {
    x: clampNumber(position.x, margin, Math.max(margin, containerRect.width - width - margin)),
    y: clampNumber(position.y, margin, Math.max(margin, containerRect.height - height - margin)),
  };
}

function inventoryMetricIcon(metricId: string): React.ReactNode {
  if (metricId.includes("city")) {
    return <Landmark />;
  }
  if (metricId.includes("structure")) {
    return <CircleDot />;
  }
  if (metricId.includes("pipe")) {
    return <Route />;
  }
  if (metricId.includes("drainage")) {
    return <Waves />;
  }
  return <BarChart3 />;
}

function formatRiskScore(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
  }).format(value);
}

function riskClassForScore(riskSort: RiskSortType, value: number): RiskClassification {
  const scheme = riskClassificationScheme(riskSort);
  const score = Number.isFinite(value) ? value : 0;
  for (let index = scheme.length - 1; index >= 0; index -= 1) {
    if (score >= scheme[index].min) {
      return scheme[index];
    }
  }
  return scheme[0];
}

function riskClassificationScheme(riskSort: RiskSortType): RiskClassification[] {
  return RISK_CLASSIFICATION_SCHEMES[riskSort] || FLOODING_RISK_CLASSIFICATION;
}

function riskClassForHistogramBin(riskSort: RiskSortType, bin: RiskHistogramBin): RiskClassification {
  return riskClassForScore(riskSort, (bin.start + bin.end) / 2);
}

function riskThresholdMarkAreas(riskSort: RiskSortType): Array<[Record<string, unknown>, Record<string, unknown>]> {
  const scheme = riskClassificationScheme(riskSort);
  return scheme.map((riskClass, index) => {
    const nextClass = scheme[index + 1];
    const start = index === 0 ? -0.01 : riskClass.min;
    const end = nextClass ? nextClass.min : 100.01;
    return [
      {
        name: riskClass.label,
        xAxis: start,
        itemStyle: {
          color: riskBandBackgroundColor(riskClass),
          borderWidth: 0,
        },
      },
      {
        xAxis: end,
      },
    ];
  });
}

function riskBandShortLabel(riskClass: RiskClassification): string {
  if (riskClass.label === RISK_DESIRED.label) {
    return "Design/Maint.";
  }
  if (riskClass.label === RISK_ACCEPTABLE.label) {
    return "Acceptable";
  }
  if (riskClass.label === RISK_CAPITAL.label) {
    return "Capital";
  }
  return "High";
}

function renderHistogramBar(params: any, api: any): any {
  const start = Number(api.value(0));
  const end = Number(api.value(1));
  const count = Number(api.value(2));
  const topCoord = api.coord([start, count]);
  const endCoord = api.coord([end, 0]);
  const zeroCoord = api.coord([start, 0]);
  const gap = 1;
  const rect = echarts.graphic.clipRectByRect(
    {
      x: topCoord[0] + gap / 2,
      y: topCoord[1],
      width: Math.max(1, endCoord[0] - topCoord[0] - gap),
      height: Math.max(0, zeroCoord[1] - topCoord[1]),
    },
    {
      x: params.coordSys.x,
      y: params.coordSys.y,
      width: params.coordSys.width,
      height: params.coordSys.height,
    },
  );
  if (!rect) {
    return null;
  }
  const children: any[] = [
    {
      type: "rect",
      shape: rect,
      style: {
        fill: RISK_HISTOGRAM_BAR_COLOR,
      },
    },
  ];
  const label = formatHistogramBarCount(count);
  if (label) {
    children.push({
      type: "text",
      x: rect.x + rect.width / 2,
      y: rect.y - 3,
      style: {
        text: label,
        align: "center",
        verticalAlign: "bottom",
        fill: RISK_HISTOGRAM_BAR_COLOR,
        font: "800 8px sans-serif",
      },
    });
  }
  return {
    type: "group",
    children,
  };
}

function formatHistogramBarCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function riskBandBackgroundColor(riskClass: RiskClassification): string {
  if (riskClass.label === RISK_HIGH.label) {
    return rgbaFromHex(riskClass.color, 0.12);
  }
  if (riskClass.label === RISK_DESIRED.label) {
    return rgbaFromHex(riskClass.color, 0.24);
  }
  return rgbaFromHex(riskClass.color, 0.18);
}

function rgbaFromHex(hexColor: string, alpha: number): string {
  const hex = hexColor.replace("#", "").trim();
  const normalized = hex.length === 3
    ? hex.split("").map((character) => `${character}${character}`).join("")
    : hex;
  const value = Number.parseInt(normalized, 16);
  if (!Number.isFinite(value)) {
    return hexColor;
  }
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function formatInventoryMetricNumber(metric: InventoryMetric, value: number): string {
  const precision = Number.isFinite(metric.precision) ? metric.precision : 0;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
  }).format(Number.isFinite(value) ? value : 0);
}

function emptyDrawFeatureCollection(): DrawFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function drawFeatureCollection(features: DrawGeoJsonFeature[]): DrawFeatureCollection {
  return {
    type: "FeatureCollection",
    features,
  };
}

function updateDrawDataOnMaps(
  maps: Array<MapLibreMap | null>,
  features: DrawGeoJsonFeature[],
  draftFeatures: DrawGeoJsonFeature[],
  selectedDrawId: string | null,
): void {
  maps.forEach((map) => {
    if (!map?.isStyleLoaded()) {
      return;
    }
    ensureDrawLayers(map);
    const drawSource = map.getSource(DRAW_SOURCE_ID) as GeoJSONSource | undefined;
    drawSource?.setData(drawFeatureCollection(features) as unknown as Parameters<GeoJSONSource["setData"]>[0]);
    const draftSource = map.getSource(DRAW_DRAFT_SOURCE_ID) as GeoJSONSource | undefined;
    draftSource?.setData(drawFeatureCollection(draftFeatures) as unknown as Parameters<GeoJSONSource["setData"]>[0]);
    updateDrawSelectionOnMap(map, selectedDrawId);
  });
}

function updateDrawSelectionOnMaps(maps: Array<MapLibreMap | null>, selectedDrawId: string | null): void {
  maps.forEach((map) => {
    if (map?.isStyleLoaded()) {
      updateDrawSelectionOnMap(map, selectedDrawId);
    }
  });
}

function updateDrawSelectionOnMap(map: MapLibreMap, selectedDrawId: string | null): void {
  if (map.getLayer(DRAW_SELECTED_LINE_LAYER_ID)) {
    map.setFilter(DRAW_SELECTED_LINE_LAYER_ID, ["==", ["get", "id"], selectedDrawId || "__none__"]);
  }
}

function ensureDrawLayers(map: MapLibreMap): void {
  if (!map.getSource(DRAW_SOURCE_ID)) {
    map.addSource(DRAW_SOURCE_ID, {
      type: "geojson",
      data: emptyDrawFeatureCollection(),
    });
  }
  if (!map.getSource(DRAW_DRAFT_SOURCE_ID)) {
    map.addSource(DRAW_DRAFT_SOURCE_ID, {
      type: "geojson",
      data: emptyDrawFeatureCollection(),
    });
  }
  if (!map.getLayer(DRAW_FILL_LAYER_ID)) {
    map.addLayer({
      id: DRAW_FILL_LAYER_ID,
      type: "fill",
      source: DRAW_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#38bdf8",
        "fill-opacity": 0.18,
      },
    });
  }
  if (!map.getLayer(DRAW_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_LINE_LAYER_ID,
      type: "line",
      source: DRAW_SOURCE_ID,
      paint: {
        "line-color": "#38bdf8",
        "line-opacity": 0.95,
        "line-width": 2,
      },
    });
  }
  if (!map.getLayer(DRAW_SELECTED_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_SELECTED_LINE_LAYER_ID,
      type: "line",
      source: DRAW_SOURCE_ID,
      filter: ["==", ["get", "id"], "__none__"],
      paint: {
        "line-color": "#facc15",
        "line-opacity": 1,
        "line-width": 4,
      },
    });
  }
  if (!map.getLayer(DRAW_DRAFT_FILL_LAYER_ID)) {
    map.addLayer({
      id: DRAW_DRAFT_FILL_LAYER_ID,
      type: "fill",
      source: DRAW_DRAFT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#67dbff",
        "fill-opacity": 0.14,
      },
    });
  }
  if (!map.getLayer(DRAW_DRAFT_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_DRAFT_LINE_LAYER_ID,
      type: "line",
      source: DRAW_DRAFT_SOURCE_ID,
      paint: {
        "line-color": "#67dbff",
        "line-dasharray": [1.4, 1.1],
        "line-opacity": 1,
        "line-width": 2,
      },
    });
  }
  if (!map.getLayer(DRAW_DRAFT_POINT_LAYER_ID)) {
    map.addLayer({
      id: DRAW_DRAFT_POINT_LAYER_ID,
      type: "circle",
      source: DRAW_DRAFT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": "#67dbff",
        "circle-radius": 5,
        "circle-stroke-color": "#001827",
        "circle-stroke-width": 2,
      },
    });
  }
}

function firstDrawFeatureId(features: MapGeoJSONFeature[]): string | null {
  for (const feature of features) {
    const id = feature.properties?.id;
    if (typeof id === "string" && id.startsWith("draw-")) {
      return id;
    }
  }
  return null;
}

function polygonDraftFeatures(points: LngLatPair[], includePolygon = false): DrawGeoJsonFeature[] {
  const cleanPoints = removeNearbyDuplicatePoints(points);
  if (!cleanPoints.length) {
    return [];
  }
  if (includePolygon && cleanPoints.length >= 3) {
    return [
      {
        type: "Feature",
        properties: { shape: "polygon", draft: true },
        geometry: polygonGeometry(cleanPoints),
      },
    ];
  }
  if (cleanPoints.length === 1) {
    return [
      {
        type: "Feature",
        properties: { shape: "polygon", draft: true },
        geometry: { type: "Point", coordinates: cleanPoints[0] },
      },
    ];
  }
  return [
    {
      type: "Feature",
      properties: { shape: "polygon", draft: true },
      geometry: { type: "LineString", coordinates: cleanPoints },
    },
  ];
}

function removeNearbyDuplicatePoints(points: LngLatPair[]): LngLatPair[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !sameLngLat(previous, point);
  });
}

function sameLngLat(left: LngLatPair | undefined, right: LngLatPair | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return Math.abs(left[0] - right[0]) <= 0.0000001 && Math.abs(left[1] - right[1]) <= 0.0000001;
}

function polygonGeometry(points: LngLatPair[]): DrawGeometry {
  const ring = removeNearbyDuplicatePoints(points);
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closedRing = first && last && (first[0] !== last[0] || first[1] !== last[1]) ? [...ring, first] : ring;
  return {
    type: "Polygon",
    coordinates: [closedRing],
  };
}

function rectangleGeometry(start: LngLatPair, end: LngLatPair): DrawGeometry {
  const west = Math.min(start[0], end[0]);
  const east = Math.max(start[0], end[0]);
  const south = Math.min(start[1], end[1]);
  const north = Math.max(start[1], end[1]);
  return {
    type: "Polygon",
    coordinates: [[
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ]],
  };
}

function circleGeometry(center: LngLatPair, edge: LngLatPair, steps = 72): DrawGeometry {
  const radiusMeters = distanceMeters(center, edge);
  const coordinates: LngLatPair[] = [];
  for (let index = 0; index <= steps; index += 1) {
    coordinates.push(destinationPoint(center, radiusMeters, (index / steps) * 360));
  }
  return {
    type: "Polygon",
    coordinates: [coordinates],
  };
}

function distanceMeters(from: LngLatPair, to: LngLatPair): number {
  const earthRadius = 6371008.8;
  const phi1 = degreesToRadians(from[1]);
  const phi2 = degreesToRadians(to[1]);
  const deltaPhi = degreesToRadians(to[1] - from[1]);
  const deltaLambda = degreesToRadians(to[0] - from[0]);
  const haversine = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function destinationPoint(center: LngLatPair, distanceMetersValue: number, bearingDegrees: number): LngLatPair {
  const earthRadius = 6371008.8;
  const angularDistance = distanceMetersValue / earthRadius;
  const bearing = degreesToRadians(bearingDegrees);
  const lat1 = degreesToRadians(center[1]);
  const lng1 = degreesToRadians(center[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [radiansToDegrees(lng2), radiansToDegrees(lat2)];
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function geometryAreaHint(geometry: DrawGeometry): number {
  if (geometry.type !== "Polygon") {
    return 0;
  }
  const ring = geometry.coordinates[0] || [];
  if (ring.length < 4) {
    return 0;
  }
  const bounds = geometryBounds({ type: "Polygon", coordinates: geometry.coordinates });
  if (!bounds) {
    return 0;
  }
  return Math.abs(bounds[2] - bounds[0]) * Math.abs(bounds[3] - bounds[1]);
}

function shapeLabel(shape: DrawShape): string {
  if (shape === "circle") {
    return "Circle";
  }
  if (shape === "rectangle") {
    return "Rectangle";
  }
  return "Polygon";
}

function syncMapCamera(sourceMap: MapLibreMap, targetMap: MapLibreMap): void {
  const center = sourceMap.getCenter();
  targetMap.jumpTo({
    center,
    zoom: sourceMap.getZoom(),
    bearing: sourceMap.getBearing(),
    pitch: sourceMap.getPitch(),
  });
}

function applyTerrainToMap(map: MapLibreMap | null, style: MapStyle | null, enabled: boolean): void {
  if (!map?.isStyleLoaded()) {
    return;
  }
  const terrain = terrainMetadataFromStyle(style);
  const terrainMap = map as MapLibreMap & {
    setTerrain?: (terrain: { source: string; exaggeration?: number } | null) => void;
  };
  if (!terrainMap.setTerrain) {
    return;
  }
  if (!enabled || !terrain || !map.getSource(terrain.source) || !terrainAllowedForCurrentView(map, terrain)) {
    terrainMap.setTerrain(null);
    return;
  }
  terrainMap.setTerrain({
    source: terrain.source,
    exaggeration: terrain.exaggeration,
  });
}

function terrainMetadataFromStyle(
  style: MapStyle | null,
): { source: string; exaggeration: number; bounds?: Bounds; minzoom?: number } | null {
  const rawTerrain = style?.metadata?.terrain;
  if (!rawTerrain || typeof rawTerrain !== "object") {
    return null;
  }
  const terrain = rawTerrain as { source?: unknown; exaggeration?: unknown; bounds?: unknown; minzoom?: unknown };
  const source = typeof terrain.source === "string" ? terrain.source : "";
  if (!source) {
    return null;
  }
  const exaggeration = Number(terrain.exaggeration);
  const minzoom = Number(terrain.minzoom);
  return {
    source,
    exaggeration: Number.isFinite(exaggeration) && exaggeration > 0 ? exaggeration : 1,
    bounds: normalizeTerrainBounds(terrain.bounds),
    minzoom: Number.isFinite(minzoom) ? minzoom : undefined,
  };
}

function terrainAllowedForCurrentView(
  map: MapLibreMap,
  terrain: { bounds?: Bounds; minzoom?: number },
): boolean {
  const activationZoom = Math.max(TERRAIN_LOCAL_MIN_ZOOM, terrain.minzoom ?? 0);
  if (map.getZoom() < activationZoom) {
    return false;
  }
  if (!terrain.bounds) {
    return true;
  }
  const mapBounds = map.getBounds();
  const terrainBounds = expandBounds(terrain.bounds, TERRAIN_BOUNDS_BUFFER_DEGREES);
  return (
    mapBounds.getWest() >= terrainBounds[0] &&
    mapBounds.getSouth() >= terrainBounds[1] &&
    mapBounds.getEast() <= terrainBounds[2] &&
    mapBounds.getNorth() <= terrainBounds[3]
  );
}

function normalizeTerrainBounds(value: unknown): Bounds | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined;
  }
  const bounds = value.map((item) => Number(item)) as Bounds;
  if (bounds.some((item) => !Number.isFinite(item)) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    return undefined;
  }
  return bounds;
}

function expandBounds(bounds: Bounds, degrees: number): Bounds {
  return [bounds[0] - degrees, bounds[1] - degrees, bounds[2] + degrees, bounds[3] + degrees];
}

function mirrorLayerVisibilityToMap(map: MapLibreMap, layerVisibility: Record<string, boolean>): void {
  Object.entries(layerVisibility).forEach(([layerId, visible]) => {
    const layer = map.getLayer(layerId) as StyleLayer | undefined;
    if (layer && !basemapIdForLayer(layer)) {
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  });
}

function applyBasemapSelectionToMap(map: MapLibreMap | null, basemapId: BasemapId, visible: boolean): void {
  if (!map?.isStyleLoaded()) {
    return;
  }
  ensureSelectableBasemapLayers(map);
  ensureExternalOverlayLayers(map);
  ((map.getStyle().layers || []) as StyleLayer[]).forEach((layer) => {
    const layerBasemapId = basemapIdForLayer(layer);
    if (!layerBasemapId || !map.getLayer(layer.id)) {
      return;
    }
    const shouldShow = visible && layerBasemapId === basemapId && layerEnabledByStyle(layer);
    map.setLayoutProperty(layer.id, "visibility", shouldShow ? "visible" : "none");
  });
}

function ensureSelectableBasemapLayers(map: MapLibreMap): void {
  const beforeId = firstOperationalStyleLayerId(((map.getStyle().layers || []) as StyleLayer[]));
  BASEMAP_OPTIONS.forEach((option) => {
    if (!option.sourceId || !option.layerId || !option.tiles?.length) {
      return;
    }
    if (!map.getSource(option.sourceId)) {
      map.addSource(option.sourceId, {
        type: "raster",
        tiles: option.tiles,
        tileSize: option.tileSize || 256,
        maxzoom: option.maxzoom || 20,
        attribution: option.attribution,
      });
    }
    if (!map.getLayer(option.layerId)) {
      const layer = {
        id: option.layerId,
        type: "raster",
        source: option.sourceId,
        layout: {
          visibility: "none",
        },
        paint: {
          "raster-opacity": 1,
        },
        metadata: {
          basemap_service: true,
          selectable_basemap_id: option.id,
          basemap_label: option.name,
          service_type: "raster_xyz_service",
        },
      };
      if (beforeId) {
        map.addLayer(layer as never, beforeId);
      } else {
        map.addLayer(layer as never);
      }
    }
  });
}

function ensureExternalOverlayLayers(map: MapLibreMap): void {
  if (!map.isStyleLoaded()) {
    return;
  }
  NC_ONEMAP_ACQUISITION_OVERLAYS.forEach((option) => {
    if (!map.getSource(option.sourceId)) {
      map.addSource(option.sourceId, {
        type: "raster",
        tiles: [
          `${NC_ONEMAP_ACQUISITION_MAPSERVER}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&layers=show:${option.mapServerLayerId}&f=image`,
        ],
        tileSize: 512,
        maxzoom: 20,
        attribution: NC_ONEMAP_ATTRIBUTION,
      });
    }
    if (!map.getLayer(option.layerId)) {
      map.addLayer({
        id: option.layerId,
        type: "raster",
        source: option.sourceId,
        layout: {
          visibility: "none",
        },
        paint: {
          "raster-opacity": 0.85,
        },
        metadata: {
          external_overlay_service: true,
          aprx_layer: `${option.group}\\${option.name}`,
          parent_group: option.group,
          tile_source_layer: option.name,
          legend_color: option.color,
          service_type: "arcgis_mapserver_export",
          source_url: `${NC_ONEMAP_ACQUISITION_MAPSERVER}/${option.mapServerLayerId}`,
        },
      } as never);
    }
  });
}

function externalOverlayLayerRecords(): StyleLayer[] {
  return NC_ONEMAP_ACQUISITION_OVERLAYS.map((option) => ({
    id: option.layerId,
    type: "raster",
    source: option.sourceId,
    layout: {
      visibility: "none",
    },
    paint: {
      "raster-opacity": 0.85,
    },
    metadata: {
      external_overlay_service: true,
      aprx_layer: `${option.group}\\${option.name}`,
      parent_group: option.group,
      tile_source_layer: option.name,
      legend_color: option.color,
      service_type: "arcgis_mapserver_export",
      source_url: `${NC_ONEMAP_ACQUISITION_MAPSERVER}/${option.mapServerLayerId}`,
    },
  }) as StyleLayer);
}

function firstOperationalStyleLayerId(layers: StyleLayer[]): string | undefined {
  return layers.find((layer) => layer.id !== "background" && !isBasemapLayer(layer))?.id;
}

function basemapIdForLayer(layer: StyleLayer): BasemapId | null {
  const configuredId = layer.metadata?.selectable_basemap_id;
  if (isBasemapId(configuredId)) {
    return configuredId;
  }
  return isBasemapLayer(layer) ? "cltex" : null;
}

function isBasemapId(value: unknown): value is BasemapId {
  return typeof value === "string" && BASEMAP_OPTIONS.some((option) => option.id === value);
}

function emptyAttributeFilterRule(defaultField = ""): AttributeFilterRule {
  return {
    id: `filter-${Date.now()}-${Math.round(Math.random() * 100000)}`,
    field: defaultField,
    operator: "eq",
    value: "",
  };
}

function cleanAttributeFilterRules(rules: AttributeFilterRule[]): AttributeFilterRule[] {
  return rules
    .map((rule) => ({
      ...rule,
      field: rule.field.trim(),
      value: rule.value.trim(),
    }))
    .filter((rule) => {
      if (!rule.field || !ATTRIBUTE_FILTER_OPERATOR_OPTIONS.some((option) => option.value === rule.operator)) {
        return false;
      }
      return !attributeFilterOperatorNeedsValue(rule.operator) || rule.value !== "";
    });
}

function attributeFilterOperatorNeedsValue(operator: AttributeFilterOperator): boolean {
  return ATTRIBUTE_FILTER_OPERATOR_OPTIONS.find((option) => option.value === operator)?.needsValue !== false;
}

function attributeFilterOperatorsForField(field: AttributeFilterField | undefined): typeof ATTRIBUTE_FILTER_OPERATOR_OPTIONS {
  if (field?.type === "number") {
    return ATTRIBUTE_FILTER_OPERATOR_OPTIONS.filter((option) =>
      ["eq", "ne", "gt", "gte", "lt", "lte", "is_null", "is_not_null"].includes(option.value),
    );
  }
  if (field?.type === "date") {
    return ATTRIBUTE_FILTER_OPERATOR_OPTIONS.filter((option) =>
      ["eq", "ne", "gt", "gte", "lt", "lte", "is_null", "is_not_null"].includes(option.value),
    );
  }
  return ATTRIBUTE_FILTER_OPERATOR_OPTIONS.filter((option) =>
    ["eq", "ne", "contains", "starts_with", "is_null", "is_not_null"].includes(option.value),
  );
}

function attributeFilterFieldForRule(target: LayerFilterTarget, rule: AttributeFilterRule): AttributeFilterField | undefined {
  return target.fields.find((field) => field.name === rule.field) || target.fields[0];
}

function sanitizeAttributeFilterRulesForFields(
  rules: AttributeFilterRule[],
  fields: AttributeFilterField[],
): AttributeFilterRule[] {
  if (!fields.length) {
    return [];
  }
  const fieldNames = new Set(fields.map((field) => field.name));
  return rules.map((rule) => {
    const field = fieldNames.has(rule.field) ? fields.find((item) => item.name === rule.field) || fields[0] : fields[0];
    const operators = attributeFilterOperatorsForField(field);
    const operator = operators.some((option) => option.value === rule.operator) ? rule.operator : operators[0].value;
    return {
      ...rule,
      field: field.name,
      operator,
      value: attributeFilterOperatorNeedsValue(operator) ? rule.value : "",
    };
  });
}

function valuePlaceholderForField(field: AttributeFilterField | undefined): string {
  if (field?.type === "number") {
    return "Number";
  }
  if (field?.type === "date") {
    return "Date";
  }
  return "Value";
}

function backendAttributeFilterPayload(filters: Record<string, LayerAttributeFilter>): AttributeFilterPayload {
  const payload: AttributeFilterPayload = {};
  Object.values(filters).forEach((filter) => {
    const rules = cleanAttributeFilterRules(filter.rules);
    if (!rules.length) {
      return;
    }
    payload[filter.key] = rules;
    const inventoryTarget = INVENTORY_FILTER_TARGET_BY_DATASET[filter.datasetId.toLowerCase()];
    if (inventoryTarget) {
      payload[inventoryTarget] = rules;
    }
  });
  return payload;
}

function backendAttributeFilterPayloadForTargets(
  filters: Record<string, LayerAttributeFilter>,
  targetKeys: string[],
): AttributeFilterPayload {
  const allowed = new Set(targetKeys.map(normalizeLayerFilterKey));
  const payload: AttributeFilterPayload = {};
  Object.values(filters).forEach((filter) => {
    if (!allowed.has(filter.key) && !allowed.has(normalizeLayerFilterKey(filter.datasetId))) {
      return;
    }
    const rules = cleanAttributeFilterRules(filter.rules);
    if (rules.length) {
      payload[filter.key] = rules;
    }
  });
  return payload;
}

function attributeFilterPayloadSignature(payload: AttributeFilterPayload): string {
  const normalized = Object.fromEntries(
    Object.entries(payload)
      .filter(([, rules]) => rules.length)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(normalized);
}

function layerFilterTarget(layer: StyleLayer, includeLabelLayer = false): LayerFilterTarget | null {
  if (includeLabelLayer ? !canLayerReceiveAttributeFilter(layer) : !supportsLayerAttributeFilter(layer)) {
    return null;
  }
  const datasetId = String(
    layer.metadata?.duckdb_geojson_dataset
      || layer.metadata?.dataset_id
      || layer.metadata?.tile_source_layer
      || layer["source-layer"]
      || "",
  ).trim();
  const sourceLayer = String(layer.metadata?.tile_source_layer || layer["source-layer"] || datasetId).trim();
  const key = normalizeLayerFilterKey(datasetId || sourceLayer || layer.id);
  if (!key) {
    return null;
  }
  return {
    key,
    label: layerLabel(layer),
    datasetId: datasetId || sourceLayer || layer.id,
    sourceLayer,
    fields: filterFieldSuggestions(layer, datasetId || sourceLayer),
  };
}

function supportsLayerAttributeFilter(layer: StyleLayer): boolean {
  return canLayerReceiveAttributeFilter(layer) && !isLabelLayer(layer);
}

function canLayerReceiveAttributeFilter(layer: StyleLayer): boolean {
  return (
    layer.id !== "background" &&
    layer.type !== "raster" &&
    !isBasemapLayer(layer) &&
    !isLayerManagerHiddenLayer(layer)
  );
}

function filterFieldSuggestions(layer: StyleLayer, datasetId: string): AttributeFilterField[] {
  const fields = new Set<string>();
  const normalizedDataset = datasetId.toLowerCase();
  (COMMON_ATTRIBUTE_FILTER_FIELDS_BY_DATASET[normalizedDataset] || []).forEach((field) => fields.add(field));
  collectMaplibreGetFields((layer as StyleLayer & { filter?: unknown }).filter, fields);
  collectMaplibreGetFields(layer.layout?.["text-field"], fields);
  collectSqlLikeFields(String(layer.metadata?.definition_query || ""), fields);
  collectSqlLikeFields(String(layer.metadata?.label_sql_query || ""), fields);
  Array.from(String(layer.metadata?.label_expression || "").matchAll(/\$feature\.([A-Za-z_][A-Za-z0-9_]*)/g)).forEach((match) => {
    fields.add(match[1]);
  });
  return Array.from(fields)
    .map(fallbackAttributeFilterField)
    .filter((field) => !isExcludedFrontendFilterField(field.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function fallbackAttributeFilterField(name: string): AttributeFilterField {
  return {
    name,
    type: fallbackAttributeFilterFieldType(name),
  };
}

function fallbackAttributeFilterFieldType(name: string): AttributeFilterFieldType {
  const normalized = name.toLowerCase();
  if (/(date|time)$/.test(normalized) || normalized.includes("date_")) {
    return "date";
  }
  if (/(risk|score|grade|length|count|num|number|height|width|area|miles?)$/i.test(name)) {
    return "number";
  }
  return "text";
}

function isExcludedFrontendFilterField(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  return ["shape", "objectid", "oid", "fid", "geometry"].includes(normalized) || normalized.startsWith("__");
}

function collectMaplibreGetFields(value: unknown, fields: Set<string>): void {
  if (!Array.isArray(value)) {
    return;
  }
  if (value[0] === "get" && typeof value[1] === "string") {
    fields.add(value[1]);
  }
  value.forEach((item) => collectMaplibreGetFields(item, fields));
}

function collectSqlLikeFields(value: string, fields: Set<string>): void {
  Array.from(value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b\s*(?:=|<>|>=|<=|>|<|\bLIKE\b|\bIN\b)/gi)).forEach((match) => {
    fields.add(match[1]);
  });
}

function maplibreAttributeFilterForRules(
  rules: AttributeFilterRule[],
  fields: AttributeFilterField[] = [],
): unknown[] | undefined {
  const expressions = cleanAttributeFilterRules(rules)
    .map((rule) => maplibreAttributeFilterForRule(rule, fields))
    .filter((expression): expression is unknown[] => Array.isArray(expression));
  if (!expressions.length) {
    return undefined;
  }
  return expressions.length === 1 ? expressions[0] : ["all", ...expressions];
}

function maplibreAttributeFilterForRule(rule: AttributeFilterRule, fields: AttributeFilterField[]): unknown[] | undefined {
  const field = rule.field.trim();
  if (!field) {
    return undefined;
  }
  const fieldType = fields.find((item) => item.name === field)?.type || fallbackAttributeFilterFieldType(field);
  const value = rule.value.trim();
  const stringValue = ["to-string", ["get", field]];
  const lowerStringValue = ["downcase", stringValue];
  const numericValueExpression = ["to-number", ["get", field]];
  if (rule.operator === "eq") {
    if (fieldType === "number") {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) ? ["==", numericValueExpression, numericValue] : undefined;
    }
    return ["==", stringValue, value];
  }
  if (rule.operator === "ne") {
    if (fieldType === "number") {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) ? ["!=", numericValueExpression, numericValue] : undefined;
    }
    return ["!=", stringValue, value];
  }
  if (rule.operator === "contains") {
    if (fieldType !== "text") {
      return undefined;
    }
    return ["in", value.toLowerCase(), lowerStringValue];
  }
  if (rule.operator === "starts_with") {
    if (fieldType !== "text") {
      return undefined;
    }
    return ["==", ["slice", lowerStringValue, 0, value.length], value.toLowerCase()];
  }
  if (["gt", "gte", "lt", "lte"].includes(rule.operator)) {
    const numericValue = Number(value);
    const comparator = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[rule.operator as "gt" | "gte" | "lt" | "lte"];
    if (fieldType === "number") {
      return Number.isFinite(numericValue) ? [comparator, numericValueExpression, numericValue] : undefined;
    }
    if (fieldType === "date") {
      return [comparator, stringValue, value];
    }
    return undefined;
  }
  if (rule.operator === "is_null") {
    return ["any", ["!", ["has", field]], ["==", stringValue, ""]];
  }
  if (rule.operator === "is_not_null") {
    return ["all", ["has", field], ["!=", stringValue, ""]];
  }
  return undefined;
}

function baseMaplibreFilterForLayer(style: MapStyle | null, layerId: string): unknown[] | undefined {
  const layer = style?.layers?.find((item) => item.id === layerId) as (StyleLayer & { filter?: unknown }) | undefined;
  return Array.isArray(layer?.filter) ? structuredCloneSafe(layer.filter) : undefined;
}

function combineMaplibreFilters(...filters: Array<unknown[] | undefined>): unknown[] | undefined {
  const cleaned = filters.filter((filter): filter is unknown[] => Array.isArray(filter) && filter.length > 0);
  if (!cleaned.length) {
    return undefined;
  }
  return cleaned.length === 1 ? cleaned[0] : ["all", ...cleaned];
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeLayerFilterKey(value: string): string {
  return value.trim().toLowerCase();
}

function emptyDuckDbGeoJsonFeatureCollection(): DuckDbGeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

async function duckDbGeoJsonAvailable(bounds?: Bounds): Promise<boolean> {
  const probeBounds = bounds || [-81.1, 35.0, -80.55, 35.55];
  try {
    await fetchDuckDbGeoJson(DUCKDB_GEOJSON_SOURCE_CONFIGS[0].datasetId, probeBounds, 1);
    return true;
  } catch (error) {
    console.warn("DuckDB GeoJSON availability probe failed.", error);
    return false;
  }
}

function rewriteDuckDbGeoJsonInventoryLayers(style: MapStyle): void {
  style.sources ||= {};
  DUCKDB_GEOJSON_SOURCE_CONFIGS.forEach((config) => {
    style.sources[config.sourceId] = {
      type: "geojson",
      data: emptyDuckDbGeoJsonFeatureCollection(),
      promoteId: "__feature_id",
    } as never;
  });

  (style.layers as StyleLayer[]).forEach((layer) => {
    const sourceLayer = String(layer["source-layer"] || layer.metadata?.tile_source_layer || "");
    const config = DUCKDB_GEOJSON_CONFIG_BY_SOURCE_LAYER.get(sourceLayer);
    if (!config || !isDuckDbGeoJsonReplacementLayer(layer)) {
      return;
    }
    layer.metadata = {
      ...(layer.metadata || {}),
      tile_source_layer: sourceLayer,
      duckdb_geojson_dataset: config.datasetId,
      duckdb_geojson_source: config.sourceId,
    };
    (layer as StyleLayer & { source?: string }).source = config.sourceId;
    delete (layer as StyleLayer & { "source-layer"?: string })["source-layer"];
  });
}

function isDuckDbGeoJsonReplacementLayer(layer: StyleLayer): boolean {
  const aprxLayer = String(layer.metadata?.aprx_layer || "");
  return (
    aprxLayer.startsWith("Storm Water Inventory\\Culverts") ||
    aprxLayer.startsWith("Storm Water Inventory\\Storm Structures") ||
    aprxLayer.startsWith("Storm Water Inventory\\Storm Pipes") ||
    aprxLayer.startsWith("Storm Water Inventory\\Storm Channels") ||
    aprxLayer.startsWith("Risk Data\\Cityworks Inspections - Unassigned") ||
    aprxLayer.startsWith("Risk Data\\Cityworks Inspections - All") ||
    aprxLayer.startsWith("Risk Data\\ITPipes - Top Risk Defects") ||
    aprxLayer.startsWith("Risk Data\\ITPipes - All Defects - Point") ||
    aprxLayer.startsWith("Risk Data\\ITPipes - All Defects - Continuous")
  );
}

function normalizeInitialVisibility(style: MapStyle, basemapVisible: boolean, labelsVisible: boolean): void {
  style.layers.forEach((layer) => {
    const typedLayer = layer as StyleLayer;
    if (isBasemapLayer(typedLayer) && !basemapVisible) {
      typedLayer.layout = { ...(typedLayer.layout || {}), visibility: "none" };
    }
    if (isLabelLayer(typedLayer) && (!labelsVisible || !labelEnabledByStyle(typedLayer))) {
      typedLayer.layout = { ...(typedLayer.layout || {}), visibility: "none" };
    }
  });
}

function hasDefaultVisibleLayer(style: MapStyle, predicate: (layer: StyleLayer) => boolean): boolean {
  return style.layers.some((layer) => {
    const typedLayer = layer as StyleLayer;
    return predicate(typedLayer) && layerDefaultVisible(typedLayer);
  });
}

function operationalLayersFromStyle(style: MapStyle): StyleLayer[] {
  return (style.layers as StyleLayer[]).filter((layer) => {
    return isUserOperationalLayer(layer);
  });
}

function isUserOperationalLayer(layer: StyleLayer): boolean {
  return layer.id !== "background" && !isBasemapLayer(layer) && !isLabelLayer(layer) && !isLayerManagerHiddenLayer(layer);
}

function isLayerManagerHiddenLayer(layer: StyleLayer): boolean {
  return isRuntimeHelperLayer(layer) || isTemporalOverlayLayer(layer);
}

function isRuntimeHelperLayer(layer: StyleLayer): boolean {
  return layer.id.startsWith(`${DRAW_SOURCE_ID}-`) || layer.id.startsWith(`${SEARCH_HIGHLIGHT_SOURCE_ID}-`);
}

function isTemporalOverlayLayer(layer: StyleLayer): boolean {
  const metadata = layer.metadata || {};
  if (metadata.external_overlay_service === true || metadata.temporal_layer === true) {
    return true;
  }
  const searchableText = [
    layer.id,
    metadata.aprx_layer,
    metadata.parent_group,
    metadata.tile_source_layer,
    metadata.source_url,
    metadata.service_type,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    searchableText.includes("ortho acquisition") ||
    searchableText.includes("flight lines") ||
    searchableText.includes("seam lines")
  );
}

function normalizeBearing(bearing: number): number {
  const normalized = ((((bearing + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function normalizeBearingForDisplay(bearing: number): number {
  const normalized = ((bearing % 360) + 360) % 360;
  return normalized > 359.5 ? 0 : normalized;
}

function mapBoundsIntersectProtectedBounds(map: MapLibreMap, protectedBounds: Bounds): boolean {
  const bounds = map.getBounds();
  return (
    bounds.getEast() >= protectedBounds[0] &&
    bounds.getWest() <= protectedBounds[2] &&
    bounds.getNorth() >= protectedBounds[1] &&
    bounds.getSouth() <= protectedBounds[3]
  );
}

function bufferedMapBounds(map: MapLibreMap): Bounds {
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  const lngBuffer = Math.min(0.03, Math.max(0.002, (east - west) * 0.15));
  const latBuffer = Math.min(0.03, Math.max(0.002, (north - south) * 0.15));
  return [
    clampLng(west - lngBuffer),
    clampLat(south - latBuffer),
    clampLng(east + lngBuffer),
    clampLat(north + latBuffer),
  ];
}

function clampLng(value: number): number {
  return Math.min(180, Math.max(-180, value));
}

function clampLat(value: number): number {
  return Math.min(90, Math.max(-90, value));
}

function searchResultToFeature(result: AssetSearchResult): Record<string, unknown> | null {
  const geometry = searchResultGeometry(result);
  if (!geometry) {
    return null;
  }
  return {
    type: "Feature",
    geometry,
    properties: {
      id: result.id,
      label: result.label,
      layer: result.layer_name,
    },
  };
}

function riskTopListItemToFeature(item: RiskTopListItem): Record<string, unknown> | null {
  const geometry = riskTopListItemGeometry(item);
  if (!geometry) {
    return null;
  }
  return {
    type: "Feature",
    geometry,
    properties: {
      id: item.id,
      label: item.title,
      layer: item.layer_label,
      risk: item.risk_score,
    },
  };
}

function searchResultGeometry(result: AssetSearchResult): AssetSearchResult["geometry"] {
  return result.geometry || pointGeometryFromBounds(result.bbox || undefined);
}

function riskTopListItemGeometry(item: RiskTopListItem): AssetSearchResult["geometry"] {
  return item.geometry || pointGeometryFromBounds(item.bbox || undefined);
}

function mapFeatureGeometry(feature: MapGeoJSONFeature): AssetSearchResult["geometry"] {
  return feature.geometry && typeof feature.geometry.type === "string"
    ? (feature.geometry as AssetSearchResult["geometry"])
    : null;
}

function geometryToHighlightFeature(
  geometry: AssetSearchResult["geometry"],
  properties: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (!geometry) {
    return null;
  }
  return {
    type: "Feature",
    geometry,
    properties,
  };
}

function searchResultBounds(result: AssetSearchResult): Bounds | null {
  if (validSearchBounds(result.bbox)) {
    return result.bbox;
  }
  return geometryBounds(result.geometry || undefined);
}

function pointGeometryFromBounds(bounds?: Bounds | null): { type: string; coordinates: [number, number] } | null {
  if (!validSearchBounds(bounds)) {
    return null;
  }
  return {
    type: "Point",
    coordinates: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
  };
}

function validSearchBounds(bounds?: Bounds | null): bounds is Bounds {
  return Boolean(bounds && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[0] <= bounds[2] && bounds[1] <= bounds[3]);
}

function geometryBounds(geometry?: AssetSearchResult["geometry"]): Bounds | null {
  if (!geometry) {
    return null;
  }
  const coordinates: Array<[number, number]> = [];
  collectCoordinates(geometry.coordinates, coordinates);
  collectCoordinates(geometry.geometries, coordinates);
  if (!coordinates.length) {
    return null;
  }
  const lngs = coordinates.map(([lng]) => lng);
  const lats = coordinates.map(([, lat]) => lat);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function geometryStreetViewPoint(geometry?: AssetSearchResult["geometry"]): LngLatPair | null {
  const bounds = geometryBounds(geometry);
  if (!bounds) {
    return null;
  }
  const point: LngLatPair = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  return validLngLatPair(point) ? point : null;
}

function validLngLatPair(point: LngLatPair): boolean {
  const [lng, lat] = point;
  return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function googleStreetViewUrl(point: LngLatPair): string {
  const [lng, lat] = point;
  const params = new URLSearchParams({
    api: "1",
    map_action: "pano",
    viewpoint: `${lat.toFixed(7)},${lng.toFixed(7)}`,
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}

function collectCoordinates(value: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(value)) {
    return;
  }
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    out.push([value[0], value[1]]);
    return;
  }
  value.forEach((item) => collectCoordinates(item, out));
}

function createInitialMapPdfSelectionFrame(overlayWidth: number, overlayHeight: number): MapPdfSelectionRect {
  const edgePadding = Math.min(48, Math.max(16, Math.min(overlayWidth, overlayHeight) * 0.08));
  const maxWidth = Math.max(1, overlayWidth - edgePadding * 2);
  const maxHeight = Math.max(1, overlayHeight - edgePadding * 2);
  const width = clampNumber(
    Math.min(maxWidth * 0.72, maxHeight * 0.72 * MAP_PDF_FRAME_ASPECT_RATIO),
    Math.min(maxWidth, 120),
    maxWidth,
  );
  const height = width / MAP_PDF_FRAME_ASPECT_RATIO;

  return {
    left: (overlayWidth - width) / 2,
    top: (overlayHeight - height) / 2,
    width,
    height,
    overlayWidth,
    overlayHeight,
  };
}

function updateMapPdfSelectionFrameForDrag(
  frame: MapPdfSelectionRect,
  mode: MapPdfSelectionDragMode,
  deltaX: number,
  deltaY: number,
): MapPdfSelectionRect {
  if (mode === "move") {
    return {
      ...frame,
      left: clampNumber(frame.left + deltaX, 0, Math.max(0, frame.overlayWidth - frame.width)),
      top: clampNumber(frame.top + deltaY, 0, Math.max(0, frame.overlayHeight - frame.height)),
    };
  }

  const right = frame.left + frame.width;
  const bottom = frame.top + frame.height;
  const resizingFromLeft = mode === "resize-nw" || mode === "resize-sw";
  const resizingFromTop = mode === "resize-nw" || mode === "resize-ne";
  const widthFromHorizontalDrag = resizingFromLeft ? frame.width - deltaX : frame.width + deltaX;
  const heightFromVerticalDrag = resizingFromTop ? frame.height - deltaY : frame.height + deltaY;
  const widthFromVerticalDrag = heightFromVerticalDrag * MAP_PDF_FRAME_ASPECT_RATIO;
  const preferredWidth = Math.abs(deltaX) >= Math.abs(deltaY)
    ? widthFromHorizontalDrag
    : widthFromVerticalDrag;
  const maxWidthFromX = resizingFromLeft ? right : frame.overlayWidth - frame.left;
  const maxWidthFromY = resizingFromTop ? bottom * MAP_PDF_FRAME_ASPECT_RATIO : (frame.overlayHeight - frame.top) * MAP_PDF_FRAME_ASPECT_RATIO;
  const maxWidth = Math.max(1, Math.min(maxWidthFromX, maxWidthFromY));
  const minWidth = Math.min(maxWidth, 120);
  const width = clampNumber(preferredWidth, minWidth, maxWidth);
  const height = width / MAP_PDF_FRAME_ASPECT_RATIO;

  return {
    ...frame,
    left: resizingFromLeft ? right - width : frame.left,
    top: resizingFromTop ? bottom - height : frame.top,
    width,
    height,
  };
}

type MapPdfImage = {
  data: Uint8Array;
  width: number;
  height: number;
};

function waitForMapRender(map: MapLibreMap): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = 0;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      map.off("idle", finish);
      window.requestAnimationFrame(() => resolve());
    };

    timeoutId = window.setTimeout(finish, 2200);
    map.once("idle", finish);
    map.triggerRepaint();
    if (map.loaded()) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
    }
  });
}

async function mapCanvasToJpegImage(canvas: HTMLCanvasElement, selection: MapPdfSelectionRect): Promise<MapPdfImage> {
  const scaleX = canvas.width / Math.max(1, selection.overlayWidth);
  const scaleY = canvas.height / Math.max(1, selection.overlayHeight);
  const sourceX = clampNumber(Math.round(selection.left * scaleX), 0, canvas.width - 1);
  const sourceY = clampNumber(Math.round(selection.top * scaleY), 0, canvas.height - 1);
  const sourceWidth = clampNumber(Math.round(selection.width * scaleX), 1, canvas.width - sourceX);
  const sourceHeight = clampNumber(Math.round(selection.height * scaleY), 1, canvas.height - sourceY);
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = sourceWidth;
  exportCanvas.height = sourceHeight;
  const context = exportCanvas.getContext("2d");
  if (!context) {
    throw new Error("The browser could not prepare a map image for export.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

  const blob = await new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("The browser could not encode the map image."));
      }
    }, "image/jpeg", 0.92);
  });

  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    width: exportCanvas.width,
    height: exportCanvas.height,
  };
}

async function imageUrlToJpegImage(url: string, targetWidth: number): Promise<MapPdfImage> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.decoding = "async";
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("The north arrow image could not be loaded for the PDF."));
    nextImage.src = url;
  });
  const sourceWidth = image.naturalWidth || targetWidth;
  const sourceHeight = image.naturalHeight || targetWidth;
  const targetHeight = Math.max(1, Math.round(targetWidth * (sourceHeight / Math.max(1, sourceWidth))));
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = targetWidth;
  exportCanvas.height = targetHeight;
  const context = exportCanvas.getContext("2d");
  if (!context) {
    throw new Error("The browser could not prepare the north arrow image for export.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  context.drawImage(image, 0, 0, exportCanvas.width, exportCanvas.height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("The browser could not encode the north arrow image."));
      }
    }, "image/jpeg", 0.94);
  });

  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    width: exportCanvas.width,
    height: exportCanvas.height,
  };
}

function getMapPdfScaleInfo(map: MapLibreMap, selection: MapPdfSelectionRect): MapPdfScaleInfo {
  const centerY = selection.top + selection.height / 2;
  const westPoint = map.unproject([selection.left, centerY]);
  const eastPoint = map.unproject([selection.left + selection.width, centerY]);
  const groundWidthFeet = Math.max(
    1,
    distanceFeetBetween(westPoint.lng, westPoint.lat, eastPoint.lng, eastPoint.lat),
  );
  const scaleBarFeet = niceScaleBarFeet(groundWidthFeet * 0.22);

  return {
    groundWidthFeet,
    scaleBarFeet,
    scaleBarLabel: formatScaleDistance(scaleBarFeet),
    scaleBarWidthRatio: clampNumber(scaleBarFeet / groundWidthFeet, 0.04, 0.45),
  };
}

function createMapPdfBlob({
  image,
  northArrowImage,
  details,
  generatedAt,
  mapBearing,
  scaleInfo,
}: {
  image: MapPdfImage;
  northArrowImage: MapPdfImage;
  details: MapPdfExportDetails;
  generatedAt: Date;
  mapBearing: number;
  scaleInfo: MapPdfScaleInfo;
}) {
  type PdfObject = Array<string | Uint8Array>;

  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 14;
  const titleBlockWidth = 96;
  const titleBlockGap = 8;
  const mapFrameX = margin;
  const mapFrameY = margin;
  const mapFrameWidth = pageWidth - margin * 2 - titleBlockGap - titleBlockWidth;
  const mapFrameHeight = pageHeight - margin * 2;
  const imageScale = Math.min(mapFrameWidth / image.width, mapFrameHeight / image.height);
  const imageWidth = image.width * imageScale;
  const imageHeight = image.height * imageScale;
  const imageX = mapFrameX + (mapFrameWidth - imageWidth) / 2;
  const imageY = mapFrameY + (mapFrameHeight - imageHeight) / 2;
  const rightBlockX = mapFrameX + mapFrameWidth + titleBlockGap;
  const rightBlockY = mapFrameY;
  const rightBlockTop = mapFrameY + mapFrameHeight;
  const northArrowBoxHeight = 108;
  const detailsBoxY = rightBlockY;
  const detailsBoxHeight = mapFrameHeight - northArrowBoxHeight;
  const scaleDenominator = Math.max(1, Math.round((scaleInfo.groundWidthFeet * 12) / Math.max(1, imageWidth / 72)));
  const scaleText = `Scale 1:${scaleDenominator.toLocaleString("en-US")}`;
  const generatedText = `Generated ${formatPdfTimestamp(generatedAt)}`;
  const encoder = new TextEncoder();
  const objects: PdfObject[] = [
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    [""],
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"],
  ];
  const imageObjectId = objects.length + 1;
  objects.push([
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`,
    image.data,
    "\nendstream",
  ]);
  const northArrowObjectId = objects.length + 1;
  objects.push([
    `<< /Type /XObject /Subtype /Image /Width ${northArrowImage.width} /Height ${northArrowImage.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${northArrowImage.data.length} >>\nstream\n`,
    northArrowImage.data,
    "\nendstream",
  ]);

  const contentParts: string[] = [];
  const addText = (
    value: string,
    x: number,
    y: number,
    size: number,
    font: "F1" | "F2" = "F1",
    align: "left" | "center" = "left",
  ) => {
    const textX = align === "center" ? x - approximatePdfTextWidth(value, size) / 2 : x;
    contentParts.push(`0 0 0 rg BT /${font} ${pdfNumber(size)} Tf ${pdfNumber(textX)} ${pdfNumber(y)} Td (${pdfEscape(value)}) Tj ET`);
  };
  const strokeRect = (x: number, y: number, width: number, height: number, stroke = "0 0 0 RG", lineWidth = 0.7) => {
    contentParts.push(`${stroke} ${pdfNumber(lineWidth)} w ${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re S`);
  };
  const fillRect = (x: number, y: number, width: number, height: number, fill = "1 1 1 rg") => {
    contentParts.push(`${fill} ${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re f`);
  };

  fillRect(0, 0, pageWidth, pageHeight, "1 1 1 rg");
  fillRect(mapFrameX, mapFrameY, mapFrameWidth, mapFrameHeight, "0.98 0.98 0.98 rg");
  contentParts.push(pdfImageCommand("ImMap", imageX, imageY, imageWidth, imageHeight));
  strokeRect(mapFrameX, mapFrameY, mapFrameWidth, mapFrameHeight, "0 0 0 RG", 1);
  strokeRect(imageX, imageY, imageWidth, imageHeight, "0.35 0.35 0.35 RG", 0.5);

  const scaleBarWidth = clampNumber(
    imageWidth * scaleInfo.scaleBarWidthRatio,
    42,
    Math.min(170, Math.max(42, imageWidth * 0.4)),
  );
  const scaleBarHeight = 7;
  const scaleBarX = imageX + imageWidth - scaleBarWidth - 18;
  const scaleBarY = imageY + 20;
  fillRect(scaleBarX - 8, scaleBarY - 8, scaleBarWidth + 16, 32, "1 1 1 rg");
  strokeRect(scaleBarX - 8, scaleBarY - 8, scaleBarWidth + 16, 32, "0 0 0 RG", 0.5);
  const segmentWidth = scaleBarWidth / 4;
  for (let index = 0; index < 4; index += 1) {
    fillRect(scaleBarX + segmentWidth * index, scaleBarY, segmentWidth, scaleBarHeight, index % 2 === 0 ? "0 0 0 rg" : "1 1 1 rg");
    strokeRect(scaleBarX + segmentWidth * index, scaleBarY, segmentWidth, scaleBarHeight, "0 0 0 RG", 0.4);
  }
  addText("0", scaleBarX, scaleBarY - 6, 5, "F1", "center");
  addText(scaleInfo.scaleBarLabel, scaleBarX + scaleBarWidth, scaleBarY - 6, 5, "F1", "center");
  addText(scaleText, scaleBarX + scaleBarWidth / 2, scaleBarY + 12, 6, "F2", "center");

  strokeRect(rightBlockX, rightBlockY, titleBlockWidth, mapFrameHeight, "0 0 0 RG", 1);
  strokeRect(rightBlockX, rightBlockTop - northArrowBoxHeight, titleBlockWidth, northArrowBoxHeight, "0 0 0 RG", 1);
  const northArrowPadding = 8;
  const northArrowMaxWidth = titleBlockWidth - northArrowPadding * 2;
  const northArrowMaxHeight = northArrowBoxHeight - northArrowPadding * 2;
  const northArrowScale = Math.min(northArrowMaxWidth / northArrowImage.width, northArrowMaxHeight / northArrowImage.height);
  const northArrowWidth = northArrowImage.width * northArrowScale;
  const northArrowHeight = northArrowImage.height * northArrowScale;
  const northArrowX = rightBlockX + titleBlockWidth / 2 - northArrowWidth / 2;
  const northArrowY = rightBlockTop - northArrowBoxHeight + northArrowBoxHeight / 2 - northArrowHeight / 2;
  contentParts.push(pdfImageCommand("ImNorth", northArrowX, northArrowY, northArrowWidth, northArrowHeight, -mapBearing));

  strokeRect(rightBlockX, detailsBoxY, titleBlockWidth, detailsBoxHeight, "0 0 0 RG", 1);
  let detailY = rightBlockTop - northArrowBoxHeight - 20;
  wrapPdfText(details.mapName || "Storm Water Asset Risk Map", 17).forEach((line, index) => {
    addText(line, rightBlockX + titleBlockWidth / 2, detailY - index * 11, 8.5, "F2", "center");
  });
  detailY -= Math.max(2, wrapPdfText(details.mapName || "Storm Water Asset Risk Map", 17).length) * 11 + 8;
  addText("Author", rightBlockX + 8, detailY, 6.5, "F2");
  detailY -= 10;
  wrapPdfText(details.author || "-", 18).slice(0, 3).forEach((line) => {
    addText(line, rightBlockX + 8, detailY, 7, "F1");
    detailY -= 9;
  });
  detailY -= 6;
  addText("Map Scale", rightBlockX + 8, detailY, 6.5, "F2");
  detailY -= 10;
  addText(scaleText, rightBlockX + 8, detailY, 7.5, "F1");
  detailY -= 10;
  addText(`Scale Bar: ${scaleInfo.scaleBarLabel}`, rightBlockX + 8, detailY, 7, "F1");
  detailY -= 16;
  addText("Generated", rightBlockX + 8, detailY, 6.5, "F2");
  detailY -= 10;
  wrapPdfText(generatedText, 19).slice(0, 3).forEach((line) => {
    addText(line, rightBlockX + 8, detailY, 6.5, "F1");
    detailY -= 8;
  });
  detailY -= 8;
  addText(`Rotation ${Math.round(normalizeBearingDegrees(mapBearing))} deg`, rightBlockX + 8, detailY, 6.5, "F1");

  const content = contentParts.join("\n");
  const contentObjectId = objects.length + 1;
  objects.push([`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`]);
  const pageObjectId = objects.length + 1;
  objects.push([
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /ImMap ${imageObjectId} 0 R /ImNorth ${northArrowObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
  ]);
  objects[1] = [`<< /Type /Pages /Kids [${pageObjectId} 0 R] /Count 1 >>`];

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const appendChunk = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const offsets = [0];
  appendChunk("%PDF-1.4\n");
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    appendChunk(`${index + 1} 0 obj\n`);
    object.forEach(appendChunk);
    appendChunk("\nendobj\n");
  });
  const xrefOffset = byteLength;
  appendChunk(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index < offsets.length; index += 1) {
    appendChunk(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  appendChunk(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(
    chunks.map((chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer),
    { type: "application/pdf" },
  );
}

function distanceFeetBetween(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const earthRadiusFeet = 20925524.9;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const startLat = toRadians(lat1);
  const endLat = toRadians(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(startLat) * Math.cos(endLat) * Math.sin(dLng / 2) ** 2;
  return earthRadiusFeet * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function niceScaleBarFeet(targetFeet: number): number {
  if (!Number.isFinite(targetFeet) || targetFeet <= 0) {
    return 100;
  }
  const magnitude = 10 ** Math.floor(Math.log10(targetFeet));
  let best = magnitude;
  [1, 2, 5, 10].forEach((multiplier) => {
    const candidate = multiplier * magnitude;
    if (candidate <= targetFeet) {
      best = candidate;
    }
  });
  return best;
}

function formatScaleDistance(feet: number): string {
  if (feet >= 5280) {
    const miles = feet / 5280;
    const digits = miles >= 10 ? 0 : miles >= 1 ? 1 : 2;
    return `${miles.toFixed(digits)} mi`;
  }
  if (feet >= 1) {
    return `${Math.round(feet).toLocaleString("en-US")} ft`;
  }
  return `${feet.toFixed(1)} ft`;
}

function normalizeBearingDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function pdfImageCommand(name: string, x: number, y: number, width: number, height: number, rotationDegrees = 0): string {
  if (!rotationDegrees) {
    return `q ${pdfNumber(width)} 0 0 ${pdfNumber(height)} ${pdfNumber(x)} ${pdfNumber(y)} cm /${name} Do Q`;
  }
  const angle = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const a = width * cos;
  const b = width * sin;
  const c = -height * sin;
  const d = height * cos;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const e = centerX - (a + c) / 2;
  const f = centerY - (b + d) / 2;
  return `q ${pdfNumber(a)} ${pdfNumber(b)} ${pdfNumber(c)} ${pdfNumber(d)} ${pdfNumber(e)} ${pdfNumber(f)} cm /${name} Do Q`;
}

function wrapPdfText(value: string, maxCharacters: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return ["-"];
  }
  const lines: string[] = [];
  let current = "";
  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }
    if (`${current} ${word}`.length <= maxCharacters) {
      current = `${current} ${word}`;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) {
    lines.push(current);
  }
  return lines;
}

function approximatePdfTextWidth(value: string, size: number): number {
  return value.length * size * 0.48;
}

function fileSafeMapName(value: string): string {
  const safeName = value.trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return safeName || "Storm_Water_Asset_Risk_Map";
}

function downloadBlob(blob: Blob, fileName: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function dateStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatPdfTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function pdfNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function ensureSearchHighlightLayers(map: MapLibreMap): void {
  if (!map.getSource(SEARCH_HIGHLIGHT_SOURCE_ID)) {
    map.addSource(SEARCH_HIGHLIGHT_SOURCE_ID, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }
  if (!map.getLayer("asset-search-highlight-fill")) {
    map.addLayer({
      id: "asset-search-highlight-fill",
      type: "fill",
      source: SEARCH_HIGHLIGHT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": "#facc15",
        "fill-opacity": 0.34,
      },
    });
  }
  if (!map.getLayer("asset-search-highlight-line")) {
    map.addLayer({
      id: "asset-search-highlight-line",
      type: "line",
      source: SEARCH_HIGHLIGHT_SOURCE_ID,
      paint: {
        "line-color": "#facc15",
        "line-opacity": 1,
        "line-width": 7,
      },
    });
  }
  if (!map.getLayer("asset-search-highlight-point")) {
    map.addLayer({
      id: "asset-search-highlight-point",
      type: "circle",
      source: SEARCH_HIGHLIGHT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": "#facc15",
        "circle-opacity": 0.92,
        "circle-radius": 14,
        "circle-stroke-color": "#001827",
        "circle-stroke-width": 3,
      },
    });
  }
}

function setSearchHighlightOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer("asset-search-highlight-fill")) {
    map.setPaintProperty("asset-search-highlight-fill", "fill-opacity", opacity * 0.34);
  }
  if (map.getLayer("asset-search-highlight-line")) {
    map.setPaintProperty("asset-search-highlight-line", "line-opacity", opacity);
  }
  if (map.getLayer("asset-search-highlight-point")) {
    map.setPaintProperty("asset-search-highlight-point", "circle-opacity", opacity * 0.92);
    map.setPaintProperty("asset-search-highlight-point", "circle-stroke-opacity", opacity);
  }
}

function removeSearchHighlightLayers(map: MapLibreMap): void {
  SEARCH_HIGHLIGHT_LAYER_IDS.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  });
  if (map.getSource(SEARCH_HIGHLIGHT_SOURCE_ID)) {
    map.removeSource(SEARCH_HIGHLIGHT_SOURCE_ID);
  }
}
