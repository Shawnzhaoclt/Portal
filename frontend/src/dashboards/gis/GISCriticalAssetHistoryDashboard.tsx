import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import DeckGL from '@deck.gl/react'
import { GeoJsonLayer, PathLayer, TextLayer } from '@deck.gl/layers'
import { Map } from '@vis.gl/react-maplibre'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Activity, Filter, Layers, MapPinned, Search, Target } from 'lucide-react'
import '../critical-team/CriticalTeamDashboard.css'
import './GISCriticalAssetHistoryDashboard.css'
import { Checkbox } from '@/components/ui/checkbox'
import { fetchGISLayerFeatures, fetchGISLayers } from './api'
import type { GISFeature, GISFeatureCollection, GISLayerMeta } from './types'
import type { Geometry } from 'geojson'

type ViewState = {
  longitude: number
  latitude: number
  zoom: number
  pitch: number
  bearing: number
}

type SelectedFeature = {
  layer: GISLayerMeta
  properties: Record<string, unknown>
}

type MapFrameSize = {
  width: number
  height: number
}

type AssetLabelDatum = {
  anchor: [number, number]
  position: [number, number]
  text: string
  color: [number, number, number, number]
  pixelOffset: [number, number]
}

type TopRecordTab = 'structures' | 'pipes'
type TopRecordRiskKey = 'total' | 'condition' | 'flood' | 'clog'
type BooleanFilterValue = 'all' | 'true' | 'false'
type LayerRangeFilterKey =
  | 'inspection_count'
  | 'risk'
  | 'condition_risk'
  | 'flood_risk'
  | 'clog_risk'
  | 'pipe_size'

type AssetLayerFilters = {
  facilityId: string
  assetId: string
  material: string[]
  streetWater: BooleanFilterValue
  mostRecent: BooleanFilterValue
  numeric: Record<LayerRangeFilterKey, { min: string; max: string }>
  flags: Record<string, BooleanFilterValue>
}
type AssetLayerFilterUpdater = (next: AssetLayerFilters | ((current: AssetLayerFilters) => AssetLayerFilters)) => void

type TopRecordItem = {
  id: string
  title: string
  subtitle: string
  value: number | null
  valueLabel: string
  layer: GISLayerMeta
  feature: GISFeature
}

type FlashTarget = {
  layer: GISLayerMeta
  feature: GISFeature
  token: number
}

type MapSearchResult = {
  id: string
  layer: GISLayerMeta
  feature: GISFeature
  title: string
  subtitle: string
  detail: string
}

type CountMetricValue = {
  current: number | null
  format?: 'decimal' | 'integer'
  total: number | null
}

type ScreenPoint = {
  x: number
  y: number
}

type LabelCollisionBox = {
  left: number
  right: number
  top: number
  bottom: number
}

type CompassDragState = {
  centerX: number
  centerY: number
  startAngle: number
  startBearing: number
  moved: boolean
}

const AERIAL_2025_EXPORT_URL =
  'https://meckaerial.mecklenburgcountync.gov/server/rest/services/aerial2025/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=false&f=image'

const MECK_VECTOR_BASEMAP_EXPORT_URL =
  'https://meckgis.mecklenburgcountync.gov/server/rest/services/Basemap/VectorBasemap/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=false&f=image'
const SCALE_5000_ZOOM = 15.85
const FACILITY_LABEL_MAX_SCALE_DENOMINATOR = 20000

type MapLibreStyleObject = {
  version: 8
  sprite?: string
  glyphs?: string
  sources?: Record<string, Record<string, unknown>>
  layers?: Array<Record<string, unknown>>
}

const AERIAL_2025_BASEMAP_SOURCE = {
  type: 'raster',
  tiles: [AERIAL_2025_EXPORT_URL],
  tileSize: 512,
  attribution: 'MeckCoGIS',
}

const MECK_VECTOR_BASEMAP_SOURCE = {
  type: 'raster',
  tiles: [MECK_VECTOR_BASEMAP_EXPORT_URL],
  tileSize: 512,
  attribution: 'Mecklenburg County GIS',
}

const MECK_VECTOR_BASEMAP_LAYER = {
  id: 'meckVectorBasemap',
  type: 'raster',
  source: 'meckVectorBasemap',
  maxzoom: SCALE_5000_ZOOM,
  paint: {
    'raster-opacity': 0.9,
  },
}

const AERIAL_2025_BASEMAP_LAYER = {
  id: 'aerial2025',
  type: 'raster',
  source: 'aerial2025',
  minzoom: SCALE_5000_ZOOM,
  paint: {
    'raster-opacity': 0.92,
  },
}

const GIS_BASEMAP_STYLE: MapLibreStyleObject = {
  version: 8,
  sources: {
    meckVectorBasemap: MECK_VECTOR_BASEMAP_SOURCE,
    aerial2025: AERIAL_2025_BASEMAP_SOURCE,
  },
  layers: [MECK_VECTOR_BASEMAP_LAYER, AERIAL_2025_BASEMAP_LAYER],
}

const DEFAULT_VIEW_STATE: ViewState = {
  longitude: -80.8431,
  latitude: 35.2271,
  zoom: 10.5,
  pitch: 0,
  bearing: 0,
}

const WEB_MERCATOR_EARTH_CIRCUMFERENCE_METERS = 40075016.68557849
const MAPLIBRE_TILE_SIZE = 512
const SCREEN_DPI = 96
const INCHES_PER_METER = 39.37
const FEET_PER_METER = 3.280839895
const FEET_PER_MILE = 5280
const ASSET_LABEL_LAYER_IDS = ['critical_asset_pipes', 'critical_asset_structures']
const FACILITY_RENDERER_LAYER_ID = 'facility_polygons'
const MAP_POINT_SYMBOL_SIZE_PX = 5
const MAP_LINE_SYMBOL_WIDTH_PX = 2
const ASSET_LABEL_TEXT_SIZE_PX = 13
const ASSET_LABEL_BACKGROUND_PADDING: [number, number] = [7, 4]
const DARK_LABEL_LEADER_COLOR: [number, number, number, number] = [15, 23, 42, 215]
const BRIGHT_LABEL_LEADER_COLOR: [number, number, number, number] = [249, 115, 22, 230]
const PIPE_LAYER_ID = 'critical_asset_pipes'
const STRUCTURE_LAYER_ID = 'critical_asset_structures'
const STRUCTURE_POINT_SYMBOL_SIZE_PX = MAP_POINT_SYMBOL_SIZE_PX * 0.75

function isInspectionHistoryLayer(layerId: string) {
  return layerId === PIPE_LAYER_ID || layerId === STRUCTURE_LAYER_ID
}

const PIPE_FEATURE_DETAIL_FIELDS = [
  'FacilityID',
  'ITPIPE_ASSETID',
  'INSPECTIONID',
  'Address',
  'MATERIAL',
  'Size',
  'Pipe_Size',
  'StreetWater',
  'IS_MOST_RECENT',
  'INSPECTION_COUNT',
  'RISK',
  'RISK_DELTA',
  'RISK_DELTA_SUM',
  'COND_RISK',
  'COND_RISK_DELTA',
  'COND_RISK_DELTA_SUM',
  'FLOOD_RISK',
  'FLOOD_RISK_DELTA',
  'FLOOD_RISK_DELTA_SUM',
  'CLOG_RISK',
  'CLOG_RISK_DELTA',
  'CLOG_RISK_DELTA_SUM',
  'investigator',
  'Inspection_Date',
]
const PIPE_MAPTIP_FIELDS = ['FacilityID', 'ITPIPE_ASSETID', 'Address', 'MATERIAL', 'Size', 'Pipe_Size', 'RISK', 'investigator', 'Inspection_Date']
const STRUCTURE_FEATURE_DETAIL_FIELDS = [
  'FacilityID',
  'ITPIPE_ASSETID',
  'Address',
  'MATERIAL',
  'StreetWater',
  'INSPECTIONID',
  'IS_MOST_RECENT',
  'INSPECTION_COUNT',
  'Inspection_Date',
  'investigator',
  'RISK',
  'RISK_DELTA',
  'RISK_DELTA_SUM',
  'COND_RISK',
  'COND_RISK_DELTA',
  'COND_RISK_DELTA_SUM',
  'FLOOD_RISK',
  'FLOOD_RISK_DELTA',
  'FLOOD_RISK_DELTA_SUM',
  'CLOG_RISK',
  'CLOG_RISK_DELTA',
  'CLOG_RISK_DELTA_SUM',
]
const STRUCTURE_MAPTIP_FIELDS = ['FacilityID', 'ITPIPE_ASSETID', 'Address', 'MATERIAL', 'StreetWater', 'INSPECTIONID', 'Inspection_Date', 'investigator']
const CULVERT_FEATURE_DETAIL_FIELDS = [
  'FacilityID',
  'CityMaint',
  'Height',
  'Length',
  'Material',
  'LastInsp',
  'InspectionScore',
  'Next_Inspection_Date',
  'TOTAL_RISK_PIPES_AVG',
  'TOTAL_RISK_PIPES_MAX',
  'TOTAL_RISK_PIPES_TOTAL',
  'CONDITION_RISK_PIPES_AVG',
  'CONDITION_RISK_PIPES_MAX',
  'CONDITION_RISK_PIPES_TOTAL',
  'FLOOD_RISK_PIPES_AVG',
  'FLOOD_RISK_PIPES_MAX',
  'FLOOD_RISK_PIPES_TOTAL',
  'CLOG_RISK_PIPES_AVG',
  'CLOG_RISK_PIPES_MAX',
  'CLOG_RISK_PIPES_TOTAL',
]
const CULVERT_MAPTIP_FIELDS = ['FacilityID', 'CityMaint', 'Height', 'Length', 'Depth', 'Material', 'LastInsp', 'InspectionScore', 'Next_Inspection_Date']
const FEATURE_DETAIL_FIELD_ORDER_BY_LAYER: Record<string, string[]> = {
  [FACILITY_RENDERER_LAYER_ID]: CULVERT_FEATURE_DETAIL_FIELDS,
  [PIPE_LAYER_ID]: PIPE_FEATURE_DETAIL_FIELDS,
  [STRUCTURE_LAYER_ID]: STRUCTURE_FEATURE_DETAIL_FIELDS,
}
const MAPTIP_FIELD_ORDER_BY_LAYER: Record<string, string[]> = {
  [FACILITY_RENDERER_LAYER_ID]: CULVERT_MAPTIP_FIELDS,
  [PIPE_LAYER_ID]: PIPE_MAPTIP_FIELDS,
  [STRUCTURE_LAYER_ID]: STRUCTURE_MAPTIP_FIELDS,
}
const PIPE_FILTER_RANGE_CONFIG: Array<{
  column: string
  fallbackMax: number
  fallbackMin: number
  format?: 'integer' | 'decimal'
  key: LayerRangeFilterKey
  label: string
  step: number
}> = [
  { column: 'INSPECTION_COUNT', fallbackMax: 10, fallbackMin: 1, format: 'integer', key: 'inspection_count', label: 'Inspection Count', step: 1 },
  { column: 'RISK', fallbackMax: 100, fallbackMin: 0, key: 'risk', label: 'Risk', step: 0.1 },
  { column: 'COND_RISK', fallbackMax: 100, fallbackMin: 0, key: 'condition_risk', label: 'Condition', step: 0.1 },
  { column: 'FLOOD_RISK', fallbackMax: 100, fallbackMin: 0, key: 'flood_risk', label: 'Flood', step: 0.1 },
  { column: 'CLOG_RISK', fallbackMax: 100, fallbackMin: 0, key: 'clog_risk', label: 'Clog', step: 0.1 },
  { column: 'Pipe_Size', fallbackMax: 100, fallbackMin: 0, format: 'integer', key: 'pipe_size', label: 'Pipe Size', step: 1 },
]
const STRUCTURE_FILTER_RANGE_CONFIG = PIPE_FILTER_RANGE_CONFIG.filter((filter) => filter.key !== 'pipe_size')
const CULVERT_BOTH_FILTER_RANGE_CONFIG = STRUCTURE_FILTER_RANGE_CONFIG
const PIPE_FILTER_FLAG_PREFIXES = ['INTERSECTS_', 'ZOI_INTERSECTS_']
const TOP_RECORD_RISK_OPTIONS: Array<{
  key: TopRecordRiskKey
  label: string
  fields: Record<TopRecordTab, string>
}> = [
  {
    key: 'total',
    label: 'Total Risk Delta',
    fields: {
      structures: 'RISK_DELTA',
      pipes: 'RISK_DELTA',
    },
  },
  {
    key: 'condition',
    label: 'Condition Risk Delta',
    fields: {
      structures: 'COND_RISK_DELTA',
      pipes: 'COND_RISK_DELTA',
    },
  },
  {
    key: 'flood',
    label: 'Flood Risk Delta',
    fields: {
      structures: 'FLOOD_RISK_DELTA',
      pipes: 'FLOOD_RISK_DELTA',
    },
  },
  {
    key: 'clog',
    label: 'Clog Risk Delta',
    fields: {
      structures: 'CLOG_RISK_DELTA',
      pipes: 'CLOG_RISK_DELTA',
    },
  },
]

function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  const normalized = hex.replace('#', '')
  const value = normalized.length === 3 ? normalized.split('').map((part) => part + part).join('') : normalized
  const numberValue = Number.parseInt(value, 16)
  if (Number.isNaN(numberValue)) {
    return [78, 121, 167, alpha]
  }
  return [(numberValue >> 16) & 255, (numberValue >> 8) & 255, numberValue & 255, alpha]
}

function combinedBounds(layers: GISLayerMeta[]) {
  const bounds = layers.map((layer) => layer.bounds).filter((layerBounds): layerBounds is [number, number, number, number] => Boolean(layerBounds))
  if (bounds.length === 0) return null
  return bounds.reduce<[number, number, number, number]>(
    (current, layerBounds) => [
      Math.min(current[0], layerBounds[0]),
      Math.min(current[1], layerBounds[1]),
      Math.max(current[2], layerBounds[2]),
      Math.max(current[3], layerBounds[3]),
    ],
    bounds[0],
  )
}

function viewStateForBounds(layers: GISLayerMeta[]): ViewState {
  const bounds = combinedBounds(layers)
  if (!bounds) return DEFAULT_VIEW_STATE
  const [minLng, minLat, maxLng, maxLat] = bounds
  const span = Math.max(maxLng - minLng, maxLat - minLat)
  const zoom = span > 0.45 ? 9 : span > 0.25 ? 10 : span > 0.12 ? 11 : 12
  return {
    ...DEFAULT_VIEW_STATE,
    longitude: (minLng + maxLng) / 2,
    latitude: (minLat + maxLat) / 2,
    zoom,
  }
}

function viewStateForFeatureBounds(bounds: [number, number, number, number], currentViewState: ViewState): ViewState {
  const [minLng, minLat, maxLng, maxLat] = bounds
  const span = Math.max(maxLng - minLng, maxLat - minLat)
  const zoom = span <= 0 ? 18 : span > 0.04 ? 13 : span > 0.018 ? 14 : span > 0.008 ? 15 : span > 0.003 ? 16 : span > 0.001 ? 17 : 18
  return {
    ...currentViewState,
    longitude: (minLng + maxLng) / 2,
    latitude: (minLat + maxLat) / 2,
    zoom,
  }
}

function featureTitle(properties: Record<string, unknown>) {
  return String(properties.ITPIPE_ASSETID ?? properties.FacilityID ?? properties.INSPECTIONID ?? 'Selected Feature')
}

function orderedFeatureEntries(
  layerId: string | undefined,
  properties: Record<string, unknown>,
  fieldOrderByLayer: Record<string, string[]>,
  fallbackLimit: number,
) {
  const orderedFields = layerId ? fieldOrderByLayer[layerId] : undefined
  if (orderedFields) return orderedFields.map((field) => [field, properties[field]] as [string, unknown])
  return Object.entries(properties).slice(0, fallbackLimit)
}

function featureDetailEntries(feature: SelectedFeature | null) {
  if (!feature) return []
  return orderedFeatureEntries(feature.layer.id, feature.properties, FEATURE_DETAIL_FIELD_ORDER_BY_LAYER, 12)
}

function featureTooltipHtml(layerId: string | undefined, properties: Record<string, unknown>) {
  const entries = orderedFeatureEntries(layerId, properties, MAPTIP_FIELD_ORDER_BY_LAYER, 6)
  return `<strong>${featureTitle(properties)}</strong><br/>${entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join('<br/>')}`
}

function dashboardLayerIdFromDeckLayerId(layerId: string | undefined) {
  return layerId?.startsWith('gis-') ? layerId.slice(4) : layerId
}

function createInitialLayerFilters(): AssetLayerFilters {
  return {
    facilityId: '',
    assetId: '',
    material: [],
    streetWater: 'all',
    mostRecent: 'all',
    numeric: Object.fromEntries(PIPE_FILTER_RANGE_CONFIG.map((filter) => [filter.key, { min: '', max: '' }])) as AssetLayerFilters['numeric'],
    flags: {},
  }
}

function createInitialPipeLayerFilters() {
  return createInitialLayerFilters()
}

function createInitialStructureLayerFilters() {
  return createInitialLayerFilters()
}

function hasActiveLayerFilters(filters: AssetLayerFilters) {
  return (
    filters.facilityId.trim() !== '' ||
    filters.assetId.trim() !== '' ||
    filters.material.length > 0 ||
    filters.streetWater !== 'all' ||
    filters.mostRecent !== 'all' ||
    Object.values(filters.numeric).some((range) => range.min !== '' || range.max !== '') ||
    Object.values(filters.flags).some((value) => value !== 'all')
  )
}

function searchResultTitle(layer: GISLayerMeta, properties: Record<string, unknown>) {
  if (layer.id === FACILITY_RENDERER_LAYER_ID) return `Facility ${formatValue(properties.FacilityID)}`
  return String(properties.ITPIPE_ASSETID ?? properties.FacilityID ?? layer.label)
}

function searchResultSubtitle(layer: GISLayerMeta, properties: Record<string, unknown>) {
  const parts = [
    layer.label,
    properties.FacilityID ? `Facility ${formatValue(properties.FacilityID)}` : '',
  ].filter(Boolean)
  return parts.join(' / ')
}

function searchResultDetail(properties: Record<string, unknown>) {
  return String(properties.Address ?? properties.Location ?? '')
}

function searchableFeatureText(layer: GISLayerMeta, feature: GISFeature) {
  return [
    layer.label,
    feature.properties.FacilityID,
    feature.properties.ITPIPE_ASSETID,
    feature.properties.Address,
    feature.properties.Location,
  ]
    .join(' ')
    .toLowerCase()
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '-'
  const dateText = formatUsDateOnly(value)
  if (dateText) return dateText
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return String(value)
}

function normalizeYear(year: string) {
  const parsedYear = Number(year)
  if (!Number.isFinite(parsedYear)) return null
  return year.length === 2 ? 2000 + parsedYear : parsedYear
}

function validDateParts(year: number, month: number, day: number) {
  const candidate = new Date(year, month - 1, day)
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day
}

function formatUsDateParts(year: number, month: number, day: number) {
  return validDateParts(year, month, day) ? `${month}/${day}/${year}` : null
}

function formatUsDateOnly(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getMonth() + 1}/${value.getDate()}/${value.getFullYear()}`
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/)
  if (isoMatch) {
    return formatUsDateParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
  }
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+.*)?$/)
  if (slashMatch) {
    const year = normalizeYear(slashMatch[3])
    return year === null ? null : formatUsDateParts(year, Number(slashMatch[1]), Number(slashMatch[2]))
  }
  return null
}

function normalizeFeatureKey(value: unknown) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value).trim()
  return String(value).trim()
}

function numberFromProperty(value: unknown) {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : null
}

function stringMatches(value: unknown, query: string) {
  return String(value ?? '').toLowerCase().includes(query.trim().toLowerCase())
}

function truthyValue(value: unknown) {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', 't', 'yes', 'y'].includes(normalized)
}

function booleanFilterMatches(value: unknown, filter: BooleanFilterValue) {
  if (filter === 'all') return true
  return truthyValue(value) === (filter === 'true')
}

function rangeFilterMatches(value: unknown, range: { min: string; max: string }) {
  const numericValue = numberFromProperty(value)
  if (numericValue === null) return range.min === '' && range.max === ''
  const minValue = range.min === '' ? null : Number(range.min)
  const maxValue = range.max === '' ? null : Number(range.max)
  if (minValue !== null && Number.isFinite(minValue) && numericValue < minValue) return false
  if (maxValue !== null && Number.isFinite(maxValue) && numericValue > maxValue) return false
  return true
}

function filterLayerFeature(feature: GISFeature, filters: AssetLayerFilters, rangeConfig: typeof PIPE_FILTER_RANGE_CONFIG) {
  const properties = feature.properties
  if (filters.facilityId.trim() && !stringMatches(properties.FacilityID, filters.facilityId)) return false
  if (filters.assetId.trim() && !stringMatches(properties.ITPIPE_ASSETID, filters.assetId)) return false
  if (filters.material.length && !filters.material.includes(String(properties.MATERIAL ?? ''))) return false
  if (!booleanFilterMatches(properties.StreetWater, filters.streetWater)) return false
  if (!booleanFilterMatches(properties.IS_MOST_RECENT, filters.mostRecent)) return false

  for (const filter of rangeConfig) {
    const propertyValue = filter.key === 'pipe_size' ? properties.Pipe_Size ?? properties.Size : properties[filter.column]
    if (!rangeFilterMatches(propertyValue, filters.numeric[filter.key])) return false
  }

  for (const [flag, value] of Object.entries(filters.flags)) {
    if (!booleanFilterMatches(properties[flag], value)) return false
  }

  return true
}

function facilityIdsMatchingAssetFilters(features: GISFeature[], filters: AssetLayerFilters, rangeConfig: typeof PIPE_FILTER_RANGE_CONFIG) {
  const facilityIds = new Set<string>()
  features.forEach((feature) => {
    if (!filterLayerFeature(feature, filters, rangeConfig)) return
    const facilityId = normalizeFeatureKey(feature.properties.FacilityID)
    if (facilityId) {
      facilityIds.add(facilityId)
    }
  })
  return facilityIds
}

function filterFacilityFeatureByAssetMatches(feature: GISFeature, matchingFacilityIds: Set<string>) {
  const facilityId = normalizeFeatureKey(feature.properties.FacilityID)
  return Boolean(facilityId && matchingFacilityIds.has(facilityId))
}

function isCountMetricValue(value: unknown): value is CountMetricValue {
  return Boolean(value && typeof value === 'object' && 'current' in value && 'total' in value)
}

function formatMetricPairValue(value: number | null, format: CountMetricValue['format']) {
  if (value === null) return '-'
  if (format === 'decimal') return value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatMetric(value: number | null, digits = 1) {
  if (value === null) return '-'
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function niceScaleValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const multiplier = normalized >= 5 ? 5 : normalized >= 2 ? 2 : normalized >= 1 ? 1 : 0.5
  return multiplier * magnitude
}

function scaleInfoForView(viewState: ViewState) {
  const latitudeRadians = (viewState.latitude * Math.PI) / 180
  const metersPerPixel =
    (Math.cos(latitudeRadians) * WEB_MERCATOR_EARTH_CIRCUMFERENCE_METERS) / (MAPLIBRE_TILE_SIZE * 2 ** viewState.zoom)
  const denominator = metersPerPixel * SCREEN_DPI * INCHES_PER_METER
  const targetWidthPx = 118
  const targetFeet = metersPerPixel * targetWidthPx * FEET_PER_METER
  const useMiles = targetFeet >= FEET_PER_MILE
  const rawValue = useMiles ? targetFeet / FEET_PER_MILE : targetFeet
  const niceValue = niceScaleValue(rawValue)
  const distanceFeet = niceValue * (useMiles ? FEET_PER_MILE : 1)
  const widthPx = Math.max(34, distanceFeet / (metersPerPixel * FEET_PER_METER))
  const labelValue = useMiles
    ? niceValue >= 10
      ? niceValue.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : niceValue.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : niceValue.toLocaleString(undefined, { maximumFractionDigits: 0 })

  return {
    denominator: Math.max(1, Math.round(denominator)),
    barWidth: Math.min(targetWidthPx, widthPx),
    barLabel: `${labelValue} ${useMiles ? 'mi' : 'ft'}`,
  }
}

function labelLeaderColorForBasemap(viewState: ViewState): [number, number, number, number] {
  return viewState.zoom < SCALE_5000_ZOOM ? DARK_LABEL_LEADER_COLOR : BRIGHT_LABEL_LEADER_COLOR
}

function normalizeMapBearing(value: number) {
  const normalized = ((value % 360) + 360) % 360
  return normalized > 180 ? normalized - 360 : normalized
}

function mapBearingDisplay(value: number) {
  return Math.round(((value % 360) + 360) % 360)
}

function pointerAngleFromNorth(clientX: number, clientY: number, centerX: number, centerY: number) {
  return (Math.atan2(clientX - centerX, centerY - clientY) * 180) / Math.PI
}

function lngLatToWorld(lng: number, lat: number, zoom: number) {
  const scale = MAPLIBRE_TILE_SIZE * 2 ** zoom
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const sinLatitude = Math.sin((clampedLat * Math.PI) / 180)
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  }
}

function worldToLngLat(x: number, y: number, zoom: number) {
  const scale = MAPLIBRE_TILE_SIZE * 2 ** zoom
  const lng = (x / scale) * 360 - 180
  const mercatorY = Math.PI * (1 - (2 * y) / scale)
  const lat = (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI
  return { lng, lat }
}

function visibleBboxForView(viewState: ViewState, size: MapFrameSize): [number, number, number, number] | null {
  if (size.width <= 0 || size.height <= 0) return null
  const center = lngLatToWorld(viewState.longitude, viewState.latitude, viewState.zoom)
  const northwest = worldToLngLat(center.x - size.width / 2, center.y - size.height / 2, viewState.zoom)
  const southeast = worldToLngLat(center.x + size.width / 2, center.y + size.height / 2, viewState.zoom)
  return [
    Math.max(-180, Math.min(northwest.lng, southeast.lng)),
    Math.max(-90, Math.min(northwest.lat, southeast.lat)),
    Math.min(180, Math.max(northwest.lng, southeast.lng)),
    Math.min(90, Math.max(northwest.lat, southeast.lat)),
  ]
}

function screenPositionForLngLat(position: [number, number], viewState: ViewState, size: MapFrameSize, pixelOffset: [number, number] = [0, 0]): ScreenPoint | null {
  if (size.width <= 0 || size.height <= 0) return null
  const center = lngLatToWorld(viewState.longitude, viewState.latitude, viewState.zoom)
  const point = lngLatToWorld(position[0], position[1], viewState.zoom)
  return {
    x: size.width / 2 + point.x - center.x + pixelOffset[0],
    y: size.height / 2 + point.y - center.y + pixelOffset[1],
  }
}

function lngLatForScreenPosition(screen: ScreenPoint, viewState: ViewState, size: MapFrameSize): [number, number] {
  const center = lngLatToWorld(viewState.longitude, viewState.latitude, viewState.zoom)
  const position = worldToLngLat(center.x + screen.x - size.width / 2, center.y + screen.y - size.height / 2, viewState.zoom)
  return [position.lng, position.lat]
}

function labelTextSize(text: string, fontSize: number, lineHeight = 1, paddingX = 0, paddingY = 0) {
  const lines = text.split('\n')
  return {
    width: Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.62 + paddingX * 2,
    height: lines.length * fontSize * lineHeight + paddingY * 2,
  }
}

function labelBoxForCenter(center: ScreenPoint, text: string, fontSize: number, padding: [number, number]): LabelCollisionBox {
  const textSize = labelTextSize(text, fontSize, 1, padding[0], padding[1])
  return {
    left: center.x - textSize.width / 2,
    right: center.x + textSize.width / 2,
    top: center.y - textSize.height / 2,
    bottom: center.y + textSize.height / 2,
  }
}

function boxesOverlap(first: LabelCollisionBox, second: LabelCollisionBox) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
}

function reserveCollisionBox(box: LabelCollisionBox, reservedBoxes: LabelCollisionBox[], size: MapFrameSize, padding = 4) {
  if (box.right < 0 || box.left > size.width || box.bottom < 0 || box.top > size.height) return false
  const paddedBox = {
    left: box.left - padding,
    right: box.right + padding,
    top: box.top - padding,
    bottom: box.bottom + padding,
  }
  if (reservedBoxes.some((reservedBox) => boxesOverlap(paddedBox, reservedBox))) return false
  reservedBoxes.push(paddedBox)
  return true
}

function assetLabelCollisionBox(item: AssetLabelDatum, viewState: ViewState, size: MapFrameSize): LabelCollisionBox | null {
  const screen = screenPositionForLngLat(item.position, viewState, size)
  if (!screen) return null
  return labelBoxForCenter(screen, item.text, ASSET_LABEL_TEXT_SIZE_PX, ASSET_LABEL_BACKGROUND_PADDING)
}

function updateCoordinateBounds(value: unknown, bounds: [number, number, number, number] | null): [number, number, number, number] | null {
  if (!Array.isArray(value)) return bounds
  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    const lng = Number(value[0])
    const lat = Number(value[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return bounds
    return bounds ? [Math.min(bounds[0], lng), Math.min(bounds[1], lat), Math.max(bounds[2], lng), Math.max(bounds[3], lat)] : [lng, lat, lng, lat]
  }
  return value.reduce<[number, number, number, number] | null>((current, child) => updateCoordinateBounds(child, current), bounds)
}

function geometryBounds(geometry: Geometry | null | undefined): [number, number, number, number] | null {
  if (!geometry) return null
  const coordinatePayload = geometry.type === 'GeometryCollection' ? geometry.geometries.map((item) => ('coordinates' in item ? item.coordinates : [])) : geometry.coordinates
  return updateCoordinateBounds(coordinatePayload, null)
}

function geometryScreenBounds(bounds: [number, number, number, number], viewState: ViewState, size: MapFrameSize): LabelCollisionBox | null {
  const corners: Array<[number, number]> = [
    [bounds[0], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[2], bounds[3]],
  ]
  const points = corners.map((corner) => screenPositionForLngLat(corner, viewState, size)).filter((point): point is ScreenPoint => Boolean(point))
  if (!points.length) return null
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  }
}

function assetLabelPositionOutsideFacility(
  assetPosition: [number, number],
  facilityBounds: [number, number, number, number] | null | undefined,
  text: string,
  viewState: ViewState,
  size: MapFrameSize,
): [number, number] | null {
  const assetScreen = screenPositionForLngLat(assetPosition, viewState, size)
  if (!assetScreen) return null
  const facilityBox = facilityBounds ? geometryScreenBounds(facilityBounds, viewState, size) : null
  if (!facilityBox) return offsetLngLat(assetPosition, viewState.zoom, 0, -30)
  const margin = 14
  const labelSize = labelTextSize(text, ASSET_LABEL_TEXT_SIZE_PX, 1, ASSET_LABEL_BACKGROUND_PADDING[0], ASSET_LABEL_BACKGROUND_PADDING[1])
  const halfWidth = labelSize.width / 2
  const halfHeight = labelSize.height / 2
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  const insideX = clamp(assetScreen.x, facilityBox.left + halfWidth, facilityBox.right - halfWidth)
  const insideY = clamp(assetScreen.y, facilityBox.top + halfHeight, facilityBox.bottom - halfHeight)
  const candidates: ScreenPoint[] = [
    { x: facilityBox.right + halfWidth + margin, y: insideY },
    { x: facilityBox.left - halfWidth - margin, y: insideY },
    { x: insideX, y: facilityBox.top - halfHeight - margin },
    { x: insideX, y: facilityBox.bottom + halfHeight + margin },
    { x: facilityBox.right + halfWidth + margin, y: facilityBox.top - halfHeight - margin },
    { x: facilityBox.right + halfWidth + margin, y: facilityBox.bottom + halfHeight + margin },
    { x: facilityBox.left - halfWidth - margin, y: facilityBox.top - halfHeight - margin },
    { x: facilityBox.left - halfWidth - margin, y: facilityBox.bottom + halfHeight + margin },
  ].sort(
    (first, second) =>
      (first.x - assetScreen.x) ** 2 + (first.y - assetScreen.y) ** 2 - ((second.x - assetScreen.x) ** 2 + (second.y - assetScreen.y) ** 2),
  )
  const candidate =
    candidates.find((item) => {
      const box = labelBoxForCenter(item, text, ASSET_LABEL_TEXT_SIZE_PX, ASSET_LABEL_BACKGROUND_PADDING)
      return box.left >= 0 && box.right <= size.width && box.top >= 0 && box.bottom <= size.height && !boxesOverlap(box, facilityBox)
    }) ?? candidates[0]
  return lngLatForScreenPosition(candidate, viewState, size)
}

function offsetLngLat(position: [number, number], zoom: number, offsetX: number, offsetY: number): [number, number] {
  const world = lngLatToWorld(position[0], position[1], zoom)
  const offsetPosition = worldToLngLat(world.x + offsetX, world.y + offsetY, zoom)
  return [offsetPosition.lng, offsetPosition.lat]
}

function geometryCenterPosition(geometry: Geometry | null | undefined): [number, number] | null {
  const bounds = geometryBounds(geometry)
  if (!bounds) return null
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
}

export default function GISCriticalAssetHistoryDashboard() {
  const [layers, setLayers] = useState<GISLayerMeta[]>([])
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({})
  const [featureData, setFeatureData] = useState<Record<string, GISFeatureCollection>>({})
  const [searchFeatureData, setSearchFeatureData] = useState<Record<string, GISFeatureCollection>>({})
  const [viewState, setViewState] = useState<ViewState>(DEFAULT_VIEW_STATE)
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null)
  const [spatialFilterEnabled, setSpatialFilterEnabled] = useState(true)
  const [spatialLoading, setSpatialLoading] = useState(false)
  const [mapFrameSize, setMapFrameSize] = useState<MapFrameSize>({ width: 0, height: 0 })
  const [mapSearchTerm, setMapSearchTerm] = useState('')
  const [mapSearchOpen, setMapSearchOpen] = useState(false)
  const [culvertLayerFilters, setCulvertLayerFilters] = useState<AssetLayerFilters>(createInitialLayerFilters)
  const [pipeLayerFilters, setPipeLayerFilters] = useState<AssetLayerFilters>(createInitialPipeLayerFilters)
  const [structureLayerFilters, setStructureLayerFilters] = useState<AssetLayerFilters>(createInitialStructureLayerFilters)
  const [layerFilterPanelOpen, setLayerFilterPanelOpen] = useState<string | null>(null)
  const [riskFocusPanelOpen, setRiskFocusPanelOpen] = useState(false)
  const [activeHistoryRisk, setActiveHistoryRisk] = useState<TopRecordRiskKey>('total')
  const [topRecordTab, setTopRecordTab] = useState<TopRecordTab>('structures')
  const [flashTarget, setFlashTarget] = useState<FlashTarget | null>(null)
  const [flashVisible, setFlashVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mapFrameRef = useRef<HTMLDivElement | null>(null)
  const featureRequestIdRef = useRef(0)
  const compassDragRef = useRef<CompassDragState | null>(null)
  const compassClickBlockedRef = useRef(false)

  useEffect(() => {
    document.documentElement.classList.add('gis-dashboard-active')
    return () => {
      document.documentElement.classList.remove('gis-dashboard-active')
    }
  }, [])

  useEffect(() => {
    loadDashboard()
  }, [])

  useEffect(() => {
    const element = mapFrameRef.current
    if (!element) return

    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      setMapFrameSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    }
    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const spatialBbox = useMemo(
    () => (spatialFilterEnabled ? visibleBboxForView(viewState, mapFrameSize) : null),
    [mapFrameSize, spatialFilterEnabled, viewState],
  )
  const spatialBboxKey = spatialBbox ? spatialBbox.map((value) => value.toFixed(6)).join(',') : ''

  useEffect(() => {
    if (layers.length === 0) return
    if (spatialFilterEnabled && !spatialBbox) return

    const timeoutId = window.setTimeout(
      () => {
        loadLayerFeatures(layers, spatialBbox, true)
      },
      spatialFilterEnabled ? 350 : 0,
    )
    return () => window.clearTimeout(timeoutId)
  }, [layers, spatialBboxKey, spatialFilterEnabled])

  useEffect(() => {
    if (!flashTarget) {
      setFlashVisible(false)
      return undefined
    }

    setFlashVisible(true)
    const intervalId = window.setInterval(() => {
      setFlashVisible((current) => !current)
    }, 180)
    const timeoutId = window.setTimeout(() => {
      window.clearInterval(intervalId)
      setFlashVisible(false)
      setFlashTarget(null)
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [flashTarget?.token])

  async function loadDashboard() {
    setLoading(true)
    setError(null)
    try {
      const metadata = await fetchGISLayers()
      const nextVisible = Object.fromEntries(metadata.layers.map((layer) => [layer.id, true]))
      setLayers(metadata.layers)
      setVisibleLayers(nextVisible)
      setViewState(viewStateForBounds(metadata.layers))
      void loadSearchFeatures(metadata.layers)
      if (!spatialFilterEnabled) {
        await loadLayerFeatures(metadata.layers, null, false)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  async function loadSearchFeatures(nextLayers: GISLayerMeta[]) {
    try {
      const layerFeatures = await Promise.all(
        nextLayers.map(async (layer) => [layer.id, await fetchGISLayerFeatures(layer.id, { limit: 5000, bbox: null, history: isInspectionHistoryLayer(layer.id) })] as const),
      )
      setSearchFeatureData(Object.fromEntries(layerFeatures))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function loadLayerFeatures(nextLayers: GISLayerMeta[], bbox: [number, number, number, number] | null, showLoading: boolean) {
    const requestId = featureRequestIdRef.current + 1
    featureRequestIdRef.current = requestId
    if (showLoading) {
      setSpatialLoading(true)
    }
    try {
      const layerFeatures = await Promise.all(
        nextLayers.map(async (layer) => [layer.id, await fetchGISLayerFeatures(layer.id, { limit: 5000, bbox, history: isInspectionHistoryLayer(layer.id) })] as const),
      )
      if (featureRequestIdRef.current === requestId) {
        setFeatureData(Object.fromEntries(layerFeatures))
      }
    } catch (nextError) {
      if (featureRequestIdRef.current === requestId) {
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      }
    } finally {
      if (featureRequestIdRef.current === requestId && showLoading) {
        setSpatialLoading(false)
      }
    }
  }

  const scaleInfo = useMemo(() => scaleInfoForView(viewState), [viewState])
  const culvertFiltersActive = useMemo(() => hasActiveLayerFilters(culvertLayerFilters), [culvertLayerFilters])
  const pipeFiltersActive = useMemo(() => hasActiveLayerFilters(pipeLayerFilters), [pipeLayerFilters])
  const structureFiltersActive = useMemo(() => hasActiveLayerFilters(structureLayerFilters), [structureLayerFilters])
  const pipeFilterSourceFeatures = searchFeatureData[PIPE_LAYER_ID]?.features ?? featureData[PIPE_LAYER_ID]?.features ?? []
  const structureFilterSourceFeatures = searchFeatureData[STRUCTURE_LAYER_ID]?.features ?? featureData[STRUCTURE_LAYER_ID]?.features ?? []
  const culvertFilterSourceFeatures = useMemo(
    () => [...pipeFilterSourceFeatures, ...structureFilterSourceFeatures],
    [pipeFilterSourceFeatures, structureFilterSourceFeatures],
  )
  const culvertMatchingFacilityIds = useMemo(
    () =>
      culvertFiltersActive
        ? facilityIdsMatchingAssetFilters(culvertFilterSourceFeatures, culvertLayerFilters, CULVERT_BOTH_FILTER_RANGE_CONFIG)
        : null,
    [culvertFilterSourceFeatures, culvertFiltersActive, culvertLayerFilters],
  )
  const filteredFeatureData = useMemo(() => {
    let nextFeatureData = featureData
    const facilityCollection = featureData[FACILITY_RENDERER_LAYER_ID]
    if (culvertFiltersActive && culvertMatchingFacilityIds && facilityCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [FACILITY_RENDERER_LAYER_ID]: {
          ...facilityCollection,
          features: facilityCollection.features.filter((feature) => filterFacilityFeatureByAssetMatches(feature, culvertMatchingFacilityIds)),
        },
      }
    }
    const pipeCollection = featureData[PIPE_LAYER_ID]
    if (pipeFiltersActive && pipeCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [PIPE_LAYER_ID]: {
          ...pipeCollection,
          features: pipeCollection.features.filter((feature) => filterLayerFeature(feature, pipeLayerFilters, PIPE_FILTER_RANGE_CONFIG)),
        },
      }
    }
    const structureCollection = featureData[STRUCTURE_LAYER_ID]
    if (structureFiltersActive && structureCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [STRUCTURE_LAYER_ID]: {
          ...structureCollection,
          features: structureCollection.features.filter((feature) =>
            filterLayerFeature(feature, structureLayerFilters, STRUCTURE_FILTER_RANGE_CONFIG),
          ),
        },
      }
    }
    return nextFeatureData
  }, [
    culvertFiltersActive,
    culvertMatchingFacilityIds,
    featureData,
    pipeFiltersActive,
    pipeLayerFilters,
    structureFiltersActive,
    structureLayerFilters,
  ])
  const filteredSearchFeatureData = useMemo(() => {
    let nextFeatureData = searchFeatureData
    const facilityCollection = searchFeatureData[FACILITY_RENDERER_LAYER_ID]
    if (culvertFiltersActive && culvertMatchingFacilityIds && facilityCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [FACILITY_RENDERER_LAYER_ID]: {
          ...facilityCollection,
          features: facilityCollection.features.filter((feature) => filterFacilityFeatureByAssetMatches(feature, culvertMatchingFacilityIds)),
        },
      }
    }
    const pipeCollection = searchFeatureData[PIPE_LAYER_ID]
    if (pipeFiltersActive && pipeCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [PIPE_LAYER_ID]: {
          ...pipeCollection,
          features: pipeCollection.features.filter((feature) => filterLayerFeature(feature, pipeLayerFilters, PIPE_FILTER_RANGE_CONFIG)),
        },
      }
    }
    const structureCollection = searchFeatureData[STRUCTURE_LAYER_ID]
    if (structureFiltersActive && structureCollection) {
      nextFeatureData = {
        ...nextFeatureData,
        [STRUCTURE_LAYER_ID]: {
          ...structureCollection,
          features: structureCollection.features.filter((feature) =>
            filterLayerFeature(feature, structureLayerFilters, STRUCTURE_FILTER_RANGE_CONFIG),
          ),
        },
      }
    }
    return nextFeatureData
  }, [
    culvertFiltersActive,
    culvertMatchingFacilityIds,
    pipeFiltersActive,
    pipeLayerFilters,
    searchFeatureData,
    structureFiltersActive,
    structureLayerFilters,
  ])

  const deckLayers = useMemo(
    () => {
      const labelLeaderColor = labelLeaderColorForBasemap(viewState)
      const spatialLayers: Array<
        GeoJsonLayer | PathLayer<AssetLabelDatum> | TextLayer<AssetLabelDatum>
      > = layers
        .filter((layer) => visibleLayers[layer.id] && filteredFeatureData[layer.id])
        .map((layer) => {
          const geometryType = layer.geometry_type?.toUpperCase() ?? ''
          const isPoint = geometryType.includes('POINT')
          const color = hexToRgba(layer.color, 220)
          return new GeoJsonLayer({
            id: `gis-${layer.id}`,
            data: filteredFeatureData[layer.id],
            pickable: true,
            autoHighlight: true,
            filled: true,
            stroked: true,
            pointRadiusUnits: 'pixels',
            getPointRadius: layer.id === STRUCTURE_LAYER_ID ? STRUCTURE_POINT_SYMBOL_SIZE_PX : MAP_POINT_SYMBOL_SIZE_PX,
            lineWidthUnits: 'pixels',
            getLineWidth: MAP_LINE_SYMBOL_WIDTH_PX,
            getFillColor: hexToRgba(layer.color, isPoint ? 170 : 72) as never,
            getLineColor: color as never,
            getTextColor: color,
            onClick: ({ object }) => {
              if (object?.properties) {
                setSelectedFeature({ layer, properties: object.properties })
              }
            },
          })
        })
      if (flashTarget && flashVisible) {
        const geometryType = flashTarget.layer.geometry_type?.toUpperCase() ?? flashTarget.feature.geometry.type.toUpperCase()
        const isPoint = geometryType.includes('POINT')
        const flashData: GISFeatureCollection = {
          type: 'FeatureCollection',
          features: [flashTarget.feature],
        }
        spatialLayers.push(
          new GeoJsonLayer({
            id: `gis-top-record-flash-${flashTarget.token}`,
            data: flashData,
            pickable: false,
            filled: true,
            stroked: true,
            pointRadiusUnits: 'pixels',
            getPointRadius: isPoint ? 18 : MAP_POINT_SYMBOL_SIZE_PX,
            lineWidthUnits: 'pixels',
            getLineWidth: isPoint ? 3 : 7,
            getFillColor: isPoint ? [255, 214, 10, 235] : [255, 214, 10, 96],
            getLineColor: [255, 255, 255, 255],
          })
        )
      }
      const assetReservedLabelBoxes: LabelCollisionBox[] = []
      const facilityBoundsById = new globalThis.Map<string, [number, number, number, number]>()
      ;(filteredFeatureData.facility_polygons?.features ?? []).forEach((feature) => {
        const key = normalizeFeatureKey(feature.properties.FacilityID)
        const bounds = geometryBounds(feature.geometry)
        if (key && bounds) {
          facilityBoundsById.set(key, bounds)
        }
      })

      const showAssetLabels = scaleInfo.denominator <= FACILITY_LABEL_MAX_SCALE_DENOMINATOR
      if (showAssetLabels) {
        ASSET_LABEL_LAYER_IDS.forEach((layerId) => {
          if (!visibleLayers[layerId]) return
          const layer = layers.find((item) => item.id === layerId)
          const features = filteredFeatureData[layerId]?.features ?? []
          if (!layer || !features.length) return

          const labelColor = hexToRgba(layer.color, 255)
          const labelData = features
            .map((feature): AssetLabelDatum | null => {
              const assetId = feature.properties.ITPIPE_ASSETID
              const anchor = geometryCenterPosition(feature.geometry)
              if (!assetId || !anchor) return null
              const text = String(assetId)
              const facilityBounds = facilityBoundsById.get(normalizeFeatureKey(feature.properties.FacilityID))
              const position = assetLabelPositionOutsideFacility(anchor, facilityBounds, text, viewState, mapFrameSize)
              if (!position) return null
              return {
                anchor,
                position,
                text,
                color: labelColor,
                pixelOffset: [0, 0],
              }
            })
            .filter((item): item is AssetLabelDatum => Boolean(item))
            .filter((item) => {
              const box = assetLabelCollisionBox(item, viewState, mapFrameSize)
              return Boolean(box && reserveCollisionBox(box, assetReservedLabelBoxes, mapFrameSize, 1))
            })

          if (!labelData.length) return

          spatialLayers.push(
            new PathLayer<AssetLabelDatum>({
              id: `gis-${layerId}-asset-label-leaders`,
              data: labelData,
              pickable: false,
              getPath: (item: AssetLabelDatum) => [item.anchor, item.position],
              getColor: labelLeaderColor,
              getWidth: 1,
              widthUnits: 'pixels',
              widthMinPixels: 1,
              widthMaxPixels: 1,
            } as never),
            new TextLayer<AssetLabelDatum>({
              id: `gis-${layerId}-asset-labels`,
              data: labelData,
              pickable: false,
              getPosition: (item: AssetLabelDatum) => item.position,
              getText: (item: AssetLabelDatum) => item.text,
              getSize: ASSET_LABEL_TEXT_SIZE_PX,
              sizeUnits: 'pixels',
              getPixelOffset: (item: AssetLabelDatum) => item.pixelOffset,
              getColor: [255, 255, 255, 255],
              fontSettings: { sdf: true },
              outlineColor: [15, 23, 42, 230],
              outlineWidth: 1,
              background: true,
              backgroundPadding: ASSET_LABEL_BACKGROUND_PADDING,
              getBackgroundColor: [4, 12, 24, 216],
              getBorderColor: (item: AssetLabelDatum) => item.color,
              getBorderWidth: 1,
              fontWeight: 760,
              getTextAnchor: 'middle',
              getAlignmentBaseline: 'center',
            } as never),
          )
        })
      }

      return spatialLayers
    },
    [filteredFeatureData, flashTarget, flashVisible, layers, mapFrameSize, scaleInfo.denominator, viewState, visibleLayers],
  )

  const visibleLayerList = useMemo(() => layers.filter((layer) => visibleLayers[layer.id]), [layers, visibleLayers])
  const layerRenderedCounts = useMemo(
    () => Object.fromEntries(layers.map((layer) => [layer.id, filteredFeatureData[layer.id]?.features.length ?? 0])),
    [filteredFeatureData, layers],
  )
  const visibleFeatures = useMemo(
    () =>
      visibleLayerList.flatMap((layer) =>
        (filteredFeatureData[layer.id]?.features ?? []).map((feature) => ({
          layer,
          feature,
        })),
      ),
    [filteredFeatureData, visibleLayerList],
  )
  const mapSearchResults = useMemo(() => {
    const term = mapSearchTerm.trim().toLowerCase()
    if (term.length < 2) return []
    return layers.flatMap((layer) =>
      (filteredSearchFeatureData[layer.id]?.features ?? [])
        .map((feature, index): MapSearchResult | null => {
          if (!searchableFeatureText(layer, feature).includes(term)) return null
          return {
            id: `${layer.id}-${featureTitle(feature.properties)}-${index}`,
            layer,
            feature,
            title: searchResultTitle(layer, feature.properties),
            subtitle: searchResultSubtitle(layer, feature.properties),
            detail: searchResultDetail(feature.properties),
          }
        })
        .filter((item): item is MapSearchResult => Boolean(item)),
    )
  }, [filteredSearchFeatureData, layers, mapSearchTerm])
  const loadedRecordCount = visibleFeatures.length
  const culvertFeatures = filteredFeatureData[FACILITY_RENDERER_LAYER_ID]?.features ?? []
  const pipeFeatures = filteredFeatureData[PIPE_LAYER_ID]?.features ?? []
  const structureFeatures = filteredFeatureData[STRUCTURE_LAYER_ID]?.features ?? []
  const culvertFilterMaterials = useMemo(
    () =>
      Array.from(
        new Set(
          culvertFilterSourceFeatures
            .map((feature) => String(feature.properties.MATERIAL ?? '').trim())
            .filter((value) => value !== ''),
        ),
      ).sort((first, second) => first.localeCompare(second)),
    [culvertFilterSourceFeatures],
  )
  const pipeFilterMaterials = useMemo(
    () =>
      Array.from(
        new Set(
          pipeFilterSourceFeatures
            .map((feature) => String(feature.properties.MATERIAL ?? '').trim())
            .filter((value) => value !== ''),
        ),
      ).sort((first, second) => first.localeCompare(second)),
    [pipeFilterSourceFeatures],
  )
  const structureFilterMaterials = useMemo(
    () =>
      Array.from(
        new Set(
          structureFilterSourceFeatures
            .map((feature) => String(feature.properties.MATERIAL ?? '').trim())
            .filter((value) => value !== ''),
        ),
      ).sort((first, second) => first.localeCompare(second)),
    [structureFilterSourceFeatures],
  )
  const pipeFilterFlags = useMemo(() => {
    const columns = new Set<string>()
    pipeFilterSourceFeatures.forEach((feature) => {
      Object.keys(feature.properties).forEach((column) => {
        if (PIPE_FILTER_FLAG_PREFIXES.some((prefix) => column.startsWith(prefix))) {
          columns.add(column)
        }
      })
    })
    return Array.from(columns).sort((first, second) => first.localeCompare(second))
  }, [pipeFilterSourceFeatures])
  const pipeFilterRanges = useMemo(() => {
    return Object.fromEntries(
      PIPE_FILTER_RANGE_CONFIG.map((filter) => {
        const values = pipeFilterSourceFeatures
          .map((feature) => numberFromProperty(filter.key === 'pipe_size' ? feature.properties.Pipe_Size ?? feature.properties.Size : feature.properties[filter.column]))
          .filter((value): value is number => value !== null)
        return [
          filter.key,
          values.length
            ? {
                min: Math.min(...values),
                max: Math.max(...values),
              }
            : {
                min: filter.fallbackMin,
                max: filter.fallbackMax,
              },
        ]
      }),
    ) as Record<LayerRangeFilterKey, { min: number; max: number }>
  }, [pipeFilterSourceFeatures])
  const culvertFilterRanges = useMemo(() => {
    return Object.fromEntries(
      CULVERT_BOTH_FILTER_RANGE_CONFIG.map((filter) => {
        const values = culvertFilterSourceFeatures
          .map((feature) => numberFromProperty(feature.properties[filter.column]))
          .filter((value): value is number => value !== null)
        return [
          filter.key,
          values.length
            ? {
                min: Math.min(...values),
                max: Math.max(...values),
              }
            : {
                min: filter.fallbackMin,
                max: filter.fallbackMax,
              },
        ]
      }),
    ) as Record<LayerRangeFilterKey, { min: number; max: number }>
  }, [culvertFilterSourceFeatures])
  const structureFilterRanges = useMemo(() => {
    return Object.fromEntries(
      STRUCTURE_FILTER_RANGE_CONFIG.map((filter) => {
        const values = structureFilterSourceFeatures
          .map((feature) => numberFromProperty(feature.properties[filter.column]))
          .filter((value): value is number => value !== null)
        return [
          filter.key,
          values.length
            ? {
                min: Math.min(...values),
                max: Math.max(...values),
              }
            : {
                min: filter.fallbackMin,
                max: filter.fallbackMax,
              },
        ]
      }),
    ) as Record<LayerRangeFilterKey, { min: number; max: number }>
  }, [structureFilterSourceFeatures])
  const layerTotalCount = (layerId: string) => layers.find((layer) => layer.id === layerId)?.row_count ?? 0
  const historyLayerTotalCount = (layerId: string) =>
    isInspectionHistoryLayer(layerId) ? searchFeatureData[layerId]?.features.length ?? layerTotalCount(layerId) : layerTotalCount(layerId)
  const recordCountPair = (current: number, total: number): CountMetricValue => ({ current, format: 'integer', total })
  const deltaValuePair = (current: number | null, total: number | null): CountMetricValue => ({ current, format: 'decimal', total })
  const valuesFromFeatures = (features: GISFeatureCollection['features'], field: string) =>
    features.map((feature) => numberFromProperty(feature.properties[field])).filter((value): value is number => value !== null)
  const activeHistoryRiskOption = TOP_RECORD_RISK_OPTIONS.find((option) => option.key === activeHistoryRisk) ?? TOP_RECORD_RISK_OPTIONS[0]
  const fullPipeHistoryFeatures = searchFeatureData[PIPE_LAYER_ID]?.features ?? featureData[PIPE_LAYER_ID]?.features ?? []
  const fullStructureHistoryFeatures = searchFeatureData[STRUCTURE_LAYER_ID]?.features ?? featureData[STRUCTURE_LAYER_ID]?.features ?? []
  const filteredHistoryDeltaValues = [
    ...valuesFromFeatures(pipeFeatures, activeHistoryRiskOption.fields.pipes),
    ...valuesFromFeatures(structureFeatures, activeHistoryRiskOption.fields.structures),
  ]
  const activeHistoryDeltaValues = [
    ...valuesFromFeatures(fullPipeHistoryFeatures, activeHistoryRiskOption.fields.pipes),
    ...valuesFromFeatures(fullStructureHistoryFeatures, activeHistoryRiskOption.fields.structures),
  ]
  const riskValues = visibleFeatures.map(({ feature }) => numberFromProperty(feature.properties.RISK)).filter((value): value is number => value !== null)
  const conditionValues = visibleFeatures
    .map(({ feature }) => numberFromProperty(feature.properties.COND_RISK))
    .filter((value): value is number => value !== null)
  const floodValues = visibleFeatures.map(({ feature }) => numberFromProperty(feature.properties.FLOOD_RISK)).filter((value): value is number => value !== null)
  const clogValues = visibleFeatures.map(({ feature }) => numberFromProperty(feature.properties.CLOG_RISK)).filter((value): value is number => value !== null)
  const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
  const min = (values: number[]) => (values.length ? Math.min(...values) : null)
  const max = (values: number[]) => (values.length ? Math.max(...values) : null)
  const topRiskFeatures = useMemo(
    () =>
      visibleFeatures
        .map((item) => ({ ...item, risk: numberFromProperty(item.feature.properties.RISK) ?? 0 }))
        .sort((a, b) => b.risk - a.risk)
        .slice(0, 5),
    [visibleFeatures],
  )
  const metricCards = [
    {
      label: 'Number of Pipes',
      value: recordCountPair(pipeFeatures.length, historyLayerTotalCount('critical_asset_pipes')),
      detail: 'Filtered / all records',
      icon: Layers,
    },
    {
      label: 'Number of Structures',
      value: recordCountPair(structureFeatures.length, historyLayerTotalCount('critical_asset_structures')),
      detail: 'Filtered / all records',
      icon: Layers,
    },
    {
      label: `Max ${activeHistoryRiskOption.label}`,
      value: deltaValuePair(max(filteredHistoryDeltaValues), max(activeHistoryDeltaValues)),
      detail: 'Filtered / all records',
      icon: Target,
    },
    {
      label: `Min ${activeHistoryRiskOption.label}`,
      value: deltaValuePair(min(filteredHistoryDeltaValues), min(activeHistoryDeltaValues)),
      detail: 'Filtered / all records',
      icon: Activity,
    },
  ]
  const selectedEntries = featureDetailEntries(selectedFeature)

  const topRecordTabs = useMemo(() => {
    const topLayerItems = (layerId: string, valueField: string, subtitleField: string, valueLabel: string, titleField?: string): TopRecordItem[] => {
      const layer = layers.find((item) => item.id === layerId)
      if (!layer) return []
      return (filteredFeatureData[layerId]?.features ?? [])
        .map((feature, index): TopRecordItem | null => {
          const value = numberFromProperty(feature.properties[valueField])
          if (value === null) return null
          return {
            id: `${layerId}-${featureTitle(feature.properties)}-${index}`,
            title: String(feature.properties[titleField ?? 'ITPIPE_ASSETID'] ?? featureTitle(feature.properties)),
            subtitle: `${subtitleField}: ${formatValue(feature.properties[subtitleField])}`,
            value,
            valueLabel,
            layer,
            feature,
          }
        })
        .filter((item): item is TopRecordItem => Boolean(item))
        .sort((first, second) => Math.abs(second.value ?? 0) - Math.abs(first.value ?? 0))
        .slice(0, 10)
    }

    return {
      structures: topLayerItems(
        'critical_asset_structures',
        activeHistoryRiskOption.fields.structures,
        'FacilityID',
        activeHistoryRiskOption.label,
      ),
      pipes: topLayerItems('critical_asset_pipes', activeHistoryRiskOption.fields.pipes, 'FacilityID', activeHistoryRiskOption.label),
    } satisfies Record<TopRecordTab, TopRecordItem[]>
  }, [activeHistoryRiskOption, filteredFeatureData, layers])

  const currentTopRecords = topRecordTabs[topRecordTab]

  function zoomToTopRecord(item: TopRecordItem) {
    const bounds = geometryBounds(item.feature.geometry)
    setSelectedFeature({ layer: item.layer, properties: item.feature.properties })
    setVisibleLayers((current) => ({ ...current, [item.layer.id]: true }))
    setFlashTarget({ layer: item.layer, feature: item.feature, token: Date.now() })
    if (bounds) {
      setViewState((current) => viewStateForFeatureBounds(bounds, current))
    }
  }

  function zoomToSearchResult(item: MapSearchResult) {
    const bounds = geometryBounds(item.feature.geometry)
    setSelectedFeature({ layer: item.layer, properties: item.feature.properties })
    setVisibleLayers((current) => ({ ...current, [item.layer.id]: true }))
    setFlashTarget({ layer: item.layer, feature: item.feature, token: Date.now() })
    setMapSearchTerm(item.title)
    setMapSearchOpen(false)
    if (bounds) {
      setViewState((current) => viewStateForFeatureBounds(bounds, current))
    }
  }

  function resetMapBearing() {
    setViewState((current) => ({ ...current, bearing: 0 }))
  }

  function handleNorthArrowPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const centerX = bounds.left + bounds.width / 2
    const centerY = bounds.top + bounds.height / 2
    compassDragRef.current = {
      centerX,
      centerY,
      startAngle: pointerAngleFromNorth(event.clientX, event.clientY, centerX, centerY),
      startBearing: viewState.bearing,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleNorthArrowPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const dragState = compassDragRef.current
    if (!dragState) return
    const nextAngle = pointerAngleFromNorth(event.clientX, event.clientY, dragState.centerX, dragState.centerY)
    const angleDelta = nextAngle - dragState.startAngle
    if (Math.abs(angleDelta) > 2) {
      dragState.moved = true
      compassClickBlockedRef.current = true
    }
    setViewState((current) => ({ ...current, bearing: normalizeMapBearing(dragState.startBearing - angleDelta) }))
  }

  function handleNorthArrowPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    compassDragRef.current = null
  }

  function handleNorthArrowClick() {
    if (compassClickBlockedRef.current) {
      compassClickBlockedRef.current = false
      return
    }
    resetMapBearing()
  }

  return (
    <div className="gis-dashboard gis-control-room gis-history-dashboard">
      <main className="gis-control-grid">
        <section className="gis-panel gis-overview-panel">
          <div className="gis-panel-header">
            <span>Connections</span>
            <strong>Spatial Layers</strong>
          </div>
          <button
            className="gis-system-card gis-renderer-summary-card"
            type="button"
            onClick={() => setRiskFocusPanelOpen(true)}
            title="Choose dashboard risk focus"
          >
            <MapPinned size={24} />
            <div>
              <span>Active Facility View</span>
              <strong>{activeHistoryRiskOption.label}</strong>
              <small>Top records and history focus</small>
            </div>
          </button>

          <div className="gis-layer-list">
            {layers.filter((layer) => layer.id !== FACILITY_RENDERER_LAYER_ID).map((layer) => (
              <div className="gis-layer-item" key={layer.id}>
                <label className="gis-layer-toggle">
                  <Checkbox
                    checked={Boolean(visibleLayers[layer.id])}
                    onCheckedChange={(checked) => setVisibleLayers((current) => ({ ...current, [layer.id]: Boolean(checked) }))}
                  />
                  <i style={{ background: layer.color }} />
                  <span>{layer.label}</span>
                  <em>{(spatialFilterEnabled ? layerRenderedCounts[layer.id] ?? 0 : historyLayerTotalCount(layer.id)).toLocaleString()}</em>
                  {(() => {
                    const isFilterableLayer = layer.id === PIPE_LAYER_ID || layer.id === STRUCTURE_LAYER_ID
                    const isActiveFilterLayer =
                      (layer.id === PIPE_LAYER_ID && pipeFiltersActive) ||
                      (layer.id === STRUCTURE_LAYER_ID && structureFiltersActive)
                    return (
                      <button
                        className={`gis-layer-filter-button ${isActiveFilterLayer ? 'active' : ''}`}
                        disabled={!isFilterableLayer}
                        type="button"
                        title={isFilterableLayer ? `Filter ${layer.label}` : 'Attribute filters are available for culverts, pipes, and structures'}
                        aria-label={isFilterableLayer ? `Filter ${layer.label}` : `Filter ${layer.label}`}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (isFilterableLayer) {
                            setLayerFilterPanelOpen(layer.id)
                          }
                        }}
                      >
                        <Filter size={13} />
                      </button>
                    )
                  })()}
                </label>
              </div>
            ))}
          </div>

          <div className="gis-top-records">
            <div className="gis-top-records-header">
              <span>TOP 10</span>
              <strong>{currentTopRecords.length.toLocaleString()}</strong>
            </div>
            <div className="gis-top-record-tabs" role="tablist" aria-label="Top filtered records">
              {[
                ['structures', 'Structures'],
                ['pipes', 'Pipes'],
              ].map(([tab, label]) => (
                <button
                  aria-selected={topRecordTab === tab}
                  className={topRecordTab === tab ? 'active' : ''}
                  key={tab}
                  role="tab"
                  type="button"
                  onClick={() => setTopRecordTab(tab as TopRecordTab)}
                >
                  {label}
                  <small>{topRecordTabs[tab as TopRecordTab].length}</small>
                </button>
              ))}
            </div>
            <div className="gis-top-record-list" role="tabpanel">
              {currentTopRecords.length ? (
                currentTopRecords.map((item, index) => (
                  <button key={item.id} type="button" onClick={() => zoomToTopRecord(item)}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                    </div>
                    <em>
                      {formatMetric(item.value)}
                      <small>{item.valueLabel}</small>
                    </em>
                  </button>
                ))
              ) : (
                <div className="gis-top-record-empty">No filtered records with risk values.</div>
              )}
            </div>
          </div>
        </section>

        <section className="gis-panel gis-map-panel">
          <div className="gis-map-toolbar">
            <div>
              <span>Critical Asset Spatial Intelligence</span>
              <strong>{selectedFeature ? featureTitle(selectedFeature.properties) : 'Critical Asset'}</strong>
            </div>
            <div>
              <div className="gis-map-search">
                <div className="gis-map-search-box">
                  <Search size={16} />
                  <input
                    id="gis-map-search-input"
                    type="search"
                    value={mapSearchTerm}
                    placeholder="Facility, asset, address"
                    autoComplete="off"
                    aria-label="Search facility, asset, or address"
                    onFocus={() => setMapSearchOpen(true)}
                    onChange={(event) => {
                      setMapSearchTerm(event.target.value)
                      setMapSearchOpen(true)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setMapSearchOpen(false)
                      }
                    }}
                  />
                  {mapSearchTerm.trim() ? (
                    <button
                      type="button"
                      aria-label="Clear map search"
                      onClick={() => {
                        setMapSearchTerm('')
                        setMapSearchOpen(false)
                      }}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
                {mapSearchOpen && mapSearchTerm.trim() ? (
                  <div className="gis-map-search-results">
                    {mapSearchTerm.trim().length < 2 ? (
                      <div className="gis-map-search-empty">Type at least 2 characters.</div>
                    ) : mapSearchResults.length ? (
                      <>
                        <div className="gis-map-search-count">{mapSearchResults.length.toLocaleString()} matched records</div>
                        <div className="gis-map-search-list">
                          {mapSearchResults.map((item) => (
                            <button key={item.id} type="button" onClick={() => zoomToSearchResult(item)}>
                              <strong>{item.title}</strong>
                              <span>{item.subtitle}</span>
                              {item.detail ? <small>{item.detail}</small> : null}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="gis-map-search-empty">No matched records.</div>
                    )}
                  </div>
                ) : null}
              </div>
              <button
                aria-pressed={spatialFilterEnabled}
                className={`gis-spatial-filter-switch ${spatialFilterEnabled ? 'active' : ''}`}
                title="Use current visible map area as a spatial filter"
                type="button"
                onClick={() => setSpatialFilterEnabled((current) => !current)}
              >
                <span>Spatial filter</span>
                <i aria-hidden="true" />
              </button>
              <span>{loadedRecordCount.toLocaleString()} rendered</span>
              <span>{visibleLayerList.length.toLocaleString()} active layers</span>
            </div>
          </div>
          {error ? <div className="gis-error-banner">{error}</div> : null}
          <div className="gis-map-frame" ref={mapFrameRef}>
            <DeckGL
              controller
              layers={deckLayers}
              viewState={viewState}
              onViewStateChange={({ viewState: nextViewState }) => setViewState(nextViewState as ViewState)}
              getTooltip={({ object, layer }) => {
                if (!object?.properties) return null
                return {
                  html: featureTooltipHtml(dashboardLayerIdFromDeckLayerId(layer?.id), object.properties),
                }
              }}
            >
              <Map attributionControl={false} mapLib={maplibregl} mapStyle={GIS_BASEMAP_STYLE as never} />
            </DeckGL>

            <button
              aria-label={`Map north arrow. Current bearing ${mapBearingDisplay(viewState.bearing)} degrees. Drag to rotate or click to reset north.`}
              className="gis-map-north-arrow"
              title="Drag to rotate map. Click to reset north."
              type="button"
              onClick={handleNorthArrowClick}
              onPointerCancel={handleNorthArrowPointerUp}
              onPointerDown={handleNorthArrowPointerDown}
              onPointerMove={handleNorthArrowPointerMove}
              onPointerUp={handleNorthArrowPointerUp}
            >
              <span
                className="gis-map-north-arrow-needle"
                style={{ transform: `rotate(${-viewState.bearing}deg)` } as CSSProperties}
              >
                <i aria-hidden="true" />
                <b>N</b>
              </span>
              <small>{mapBearingDisplay(viewState.bearing)}°</small>
            </button>

            <div className="gis-map-scale" aria-label={`Map scale 1:${scaleInfo.denominator.toLocaleString()}`}>
              <span className="gis-scale-number">1:{scaleInfo.denominator.toLocaleString()}</span>
              <span className="gis-scale-bar-label">{scaleInfo.barLabel}</span>
              <span className="gis-scale-bar" style={{ width: `${scaleInfo.barWidth}px` }} />
            </div>

            {loading ? <div className="gis-loading">Loading spatial layers...</div> : null}
            {!loading && spatialLoading ? <div className="gis-loading">Applying spatial filter...</div> : null}
          </div>
        </section>

        <section className="gis-panel gis-metrics-panel">
          <div className="gis-panel-header">
            <span>Realtime</span>
            <strong>Risk Metrics</strong>
          </div>
          <div className="gis-metric-grid">
            {metricCards.map((metric, index) => {
              const Icon = metric.icon
              const lowerDetailLine = index >= 3 && index < metricCards.length - 1
              return (
                <div className={`gis-metric-card ${lowerDetailLine ? 'gis-metric-card-lower-detail' : ''}`} key={metric.label}>
                  <Icon size={17} />
                  <span>{metric.label}</span>
                  <strong className={isCountMetricValue(metric.value) ? 'gis-record-count-value' : undefined}>
                    {isCountMetricValue(metric.value) ? (
                      <>
                        {formatMetricPairValue(metric.value.current, metric.value.format)}
                        <small>/ {formatMetricPairValue(metric.value.total, metric.value.format)}</small>
                      </>
                    ) : typeof metric.value === 'number' ? (
                      formatMetric(metric.value)
                    ) : (
                      metric.value
                    )}
                  </strong>
                  {metric.detail ? <small>{metric.detail}</small> : null}
                </div>
              )
            })}
          </div>
        </section>

        <section className="gis-panel gis-risk-panel">
          <div className="gis-panel-header">
            <span>Risk Profile</span>
            <strong>Loaded Feature Sample</strong>
          </div>
          {[
            ['Risk', average(riskValues), '#38bdf8'],
            ['Condition', average(conditionValues), '#60a5fa'],
            ['Flood', average(floodValues), '#4ade80'],
            ['Clog', average(clogValues), '#fb923c'],
          ].map(([label, value, color]) => (
            <div className="gis-risk-row" key={label as string}>
              <span>{label}</span>
              <div>
                <i style={{ width: `${Math.min(100, Number(value ?? 0))}%`, background: color as string }} />
              </div>
              <strong>{formatMetric(value as number | null)}</strong>
            </div>
          ))}
        </section>

        <section className="gis-panel gis-selection-panel">
          <div className="gis-panel-header">
            <span>Selected</span>
            <strong>Feature Details</strong>
          </div>
          {selectedFeature ? (
            <>
              <div className="gis-selected-title">
                <strong>{featureTitle(selectedFeature.properties)}</strong>
                <span>{selectedFeature.layer.label}</span>
              </div>
              <dl className="gis-details-list">
                {selectedEntries.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{formatValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <div className="gis-empty-selection">
              <MapPinned size={28} />
              <strong>No feature selected</strong>
            </div>
          )}
        </section>

        <section className="gis-panel gis-ranked-panel">
          <div className="gis-panel-header">
            <span>Priority</span>
            <strong>Highest Risk Assets</strong>
          </div>
          <div className="gis-ranked-list">
            {topRiskFeatures.map(({ feature, layer, risk }, index) => (
              <div key={`${layer.id}-${index}`}>
                <span>{index + 1}</span>
                <strong>{featureTitle(feature.properties)}</strong>
                <em>{layer.label}</em>
                <b>{formatMetric(risk)}</b>
              </div>
            ))}
          </div>
        </section>
      </main>
      {layerFilterPanelOpen === FACILITY_RENDERER_LAYER_ID ? (
        <AssetLayerFilterPanel
          active={culvertFiltersActive}
          ariaLabel="Culvert Facility attribute filters"
          filteredCount={culvertFeatures.length}
          filters={culvertLayerFilters}
          flags={[]}
          materials={culvertFilterMaterials}
          onChange={setCulvertLayerFilters}
          onClear={() => setCulvertLayerFilters(createInitialLayerFilters())}
          onClose={() => setLayerFilterPanelOpen(null)}
          rangeConfig={CULVERT_BOTH_FILTER_RANGE_CONFIG}
          ranges={culvertFilterRanges}
          title="Culvert Facility"
          totalCount={searchFeatureData[FACILITY_RENDERER_LAYER_ID]?.features.length ?? layerTotalCount(FACILITY_RENDERER_LAYER_ID)}
        />
      ) : null}
      {layerFilterPanelOpen === PIPE_LAYER_ID ? (
        <AssetLayerFilterPanel
          active={pipeFiltersActive}
          ariaLabel="Critical Asset Pipes attribute filters"
          filteredCount={pipeFeatures.length}
          filters={pipeLayerFilters}
          flags={pipeFilterFlags}
          materials={pipeFilterMaterials}
          onChange={setPipeLayerFilters}
          onClear={() => setPipeLayerFilters(createInitialPipeLayerFilters())}
          onClose={() => setLayerFilterPanelOpen(null)}
          rangeConfig={PIPE_FILTER_RANGE_CONFIG}
          ranges={pipeFilterRanges}
          title="Critical Asset Pipes"
          totalCount={searchFeatureData[PIPE_LAYER_ID]?.features.length ?? layerTotalCount(PIPE_LAYER_ID)}
        />
      ) : null}
      {layerFilterPanelOpen === STRUCTURE_LAYER_ID ? (
        <AssetLayerFilterPanel
          active={structureFiltersActive}
          ariaLabel="Critical Asset Structures attribute filters"
          filteredCount={structureFeatures.length}
          filters={structureLayerFilters}
          flags={[]}
          materials={structureFilterMaterials}
          onChange={setStructureLayerFilters}
          onClear={() => setStructureLayerFilters(createInitialStructureLayerFilters())}
          onClose={() => setLayerFilterPanelOpen(null)}
          rangeConfig={STRUCTURE_FILTER_RANGE_CONFIG}
          ranges={structureFilterRanges}
          title="Critical Asset Structures"
          totalCount={searchFeatureData[STRUCTURE_LAYER_ID]?.features.length ?? layerTotalCount(STRUCTURE_LAYER_ID)}
        />
      ) : null}
      {riskFocusPanelOpen ? (
        <div className="gis-renderer-modal-backdrop" role="presentation" onClick={() => setRiskFocusPanelOpen(false)}>
          <section
            aria-modal="true"
            className="gis-renderer-modal"
            role="dialog"
            aria-label="History risk focus selector"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="gis-renderer-modal-header">
              <div>
                <span>Risk Focus</span>
                <strong>Active Facility View</strong>
              </div>
              <button type="button" onClick={() => setRiskFocusPanelOpen(false)} aria-label="Close risk focus selector">
                Close
              </button>
            </header>

            <div className="gis-risk-focus-grid" role="radiogroup" aria-label="Dashboard risk focus">
              {TOP_RECORD_RISK_OPTIONS.map((option) => (
                <button
                  aria-checked={activeHistoryRisk === option.key}
                  className={activeHistoryRisk === option.key ? 'active' : ''}
                  key={option.key}
                  role="radio"
                  type="button"
                  onClick={() => setActiveHistoryRisk(option.key)}
                >
                  <strong>{option.label} Risk</strong>
                  <span>Use {option.label.toLowerCase()} values for ranking and history focus.</span>
                </button>
              ))}
            </div>

            <footer className="gis-renderer-modal-footer">
              <button type="button" onClick={() => setRiskFocusPanelOpen(false)}>
                Done
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function AssetLayerFilterPanel({
  active,
  ariaLabel,
  filteredCount,
  filters,
  flags,
  materials,
  onChange,
  onClear,
  onClose,
  rangeConfig,
  ranges,
  title,
  totalCount,
}: {
  active: boolean
  ariaLabel: string
  filteredCount: number
  filters: AssetLayerFilters
  flags: string[]
  materials: string[]
  onChange: AssetLayerFilterUpdater
  onClear: () => void
  onClose: () => void
  rangeConfig: typeof PIPE_FILTER_RANGE_CONFIG
  ranges: Record<LayerRangeFilterKey, { min: number; max: number }>
  title: string
  totalCount: number
}) {
  return (
    <div className="gis-layer-filter-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-label={ariaLabel}
        aria-modal="true"
        className="gis-layer-filter-panel"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="gis-layer-filter-header">
          <div>
            <span>Attribute Filter</span>
            <strong>{title}</strong>
            <small>
              {filteredCount.toLocaleString()} / {totalCount.toLocaleString()} records
            </small>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="gis-layer-filter-body">
          <div className="gis-layer-filter-grid">
            <label>
              <span>Facility ID</span>
              <input
                type="text"
                value={filters.facilityId}
                onChange={(event) => onChange((current) => ({ ...current, facilityId: event.target.value }))}
              />
            </label>
            <label>
              <span>Asset ID</span>
              <input
                type="text"
                value={filters.assetId}
                onChange={(event) => onChange((current) => ({ ...current, assetId: event.target.value }))}
              />
            </label>
          </div>

          <PipeSliderRangeFilter
            config={rangeConfig[0]}
            onChange={onChange}
            range={filters.numeric.inspection_count}
            rangeBounds={ranges.inspection_count}
          />

          <PipeMaterialFilter materials={materials} onChange={onChange} selected={filters.material} />

          <div className="gis-layer-filter-grid">
            <PipeBooleanSegment
              label="Street Water"
              value={filters.streetWater}
              onChange={(value) => onChange((current) => ({ ...current, streetWater: value }))}
            />
            <PipeBooleanSegment
              label="Most Recent"
              value={filters.mostRecent}
              onChange={(value) => onChange((current) => ({ ...current, mostRecent: value }))}
            />
          </div>

          <div className="gis-layer-filter-ranges">
            {rangeConfig.slice(1).map((config) => (
              <PipeSliderRangeFilter
                config={config}
                key={config.key}
                onChange={onChange}
                range={filters.numeric[config.key]}
                rangeBounds={ranges[config.key]}
              />
            ))}
          </div>

          {flags.length ? (
            <div className="gis-layer-filter-section">
              <div className="gis-layer-filter-section-title">
                <span>Spatial Intersections</span>
                <small>{Object.values(filters.flags).filter((value) => value !== 'all').length || 'All'}</small>
              </div>
              <div className="gis-layer-flag-list">
                {flags.map((flag) => (
                  <label key={flag}>
                    <Checkbox
                      checked={filters.flags[flag] === 'true'}
                      onCheckedChange={(checked) =>
                        onChange((current) => ({
                          ...current,
                          flags: {
                            ...current.flags,
                            [flag]: checked === true ? 'true' : 'all',
                          },
                        }))
                      }
                    />
                    <span>{flag.replaceAll('_', ' ')}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <footer className="gis-layer-filter-footer">
          <button disabled={!active} type="button" onClick={onClear}>
            Reset filters
          </button>
        </footer>
      </section>
    </div>
  )
}

function PipeBooleanSegment({
  label,
  onChange,
  value,
}: {
  label: string
  onChange: (value: BooleanFilterValue) => void
  value: BooleanFilterValue
}) {
  return (
    <div className="gis-layer-boolean-filter">
      <span>{label}</span>
      <div>
        {[
          ['all', 'All'],
          ['true', 'Yes'],
          ['false', 'No'],
        ].map(([key, text]) => (
          <button className={value === key ? 'active' : ''} key={key} type="button" onClick={() => onChange(key as BooleanFilterValue)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function PipeMaterialFilter({
  materials,
  onChange,
  selected,
}: {
  materials: string[]
  onChange: AssetLayerFilterUpdater
  selected: string[]
}) {
  function toggle(value: string, checked: boolean) {
    onChange((current) => {
      const nextMaterial = checked ? Array.from(new Set([...current.material, value])) : current.material.filter((item) => item !== value)
      return { ...current, material: nextMaterial }
    })
  }

  return (
    <div className="gis-layer-filter-section">
      <div className="gis-layer-filter-section-title">
        <span>Material</span>
        <small>{selected.length ? `${selected.length} selected` : 'All'}</small>
      </div>
      <div className="gis-layer-material-list">
        {materials.map((material) => (
          <label key={material}>
            <Checkbox checked={selected.includes(material)} onCheckedChange={(checked) => toggle(material, checked === true)} />
            <span>{material}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function pipeSliderText(value: number, format?: 'integer' | 'decimal') {
  return format === 'integer' ? String(Math.round(value)) : value.toFixed(1)
}

function PipeSliderRangeFilter({
  config,
  onChange,
  range,
  rangeBounds,
}: {
  config: (typeof PIPE_FILTER_RANGE_CONFIG)[number]
  onChange: AssetLayerFilterUpdater
  range: { min: string; max: string }
  rangeBounds: { min: number; max: number }
}) {
  const minBound = Number.isFinite(rangeBounds.min) ? rangeBounds.min : config.fallbackMin
  const maxBound = Number.isFinite(rangeBounds.max) ? rangeBounds.max : config.fallbackMax
  const canSlide = maxBound > minBound
  const rawMin = range.min === '' ? minBound : Number(range.min)
  const rawMax = range.max === '' ? maxBound : Number(range.max)
  const selectedMinValue = Math.min(Math.max(Number.isFinite(rawMin) ? rawMin : minBound, minBound), maxBound)
  const selectedMaxValue = Math.max(Math.min(Number.isFinite(rawMax) ? rawMax : maxBound, maxBound), minBound)
  const displayMinValue = Math.min(selectedMinValue, selectedMaxValue)
  const displayMaxValue = Math.max(selectedMinValue, selectedMaxValue)
  const minPercent = canSlide ? ((displayMinValue - minBound) / (maxBound - minBound)) * 100 : 0
  const maxPercent = canSlide ? ((displayMaxValue - minBound) / (maxBound - minBound)) * 100 : 100

  function setRange(next: { min?: number; max?: number }) {
    onChange((current) => ({
      ...current,
      numeric: {
        ...current.numeric,
        [config.key]: {
          min: next.min === undefined ? current.numeric[config.key]?.min ?? '' : pipeSliderText(next.min, config.format),
          max: next.max === undefined ? current.numeric[config.key]?.max ?? '' : pipeSliderText(next.max, config.format),
        },
      },
    }))
  }

  return (
    <div className="gis-layer-slider-filter">
      <div className="gis-layer-filter-section-title">
        <span>{config.label}</span>
        <small>
          {pipeSliderText(displayMinValue, config.format)} - {pipeSliderText(displayMaxValue, config.format)}
        </small>
      </div>
      <div
        className="gis-layer-dual-range"
        style={{ '--min-pct': `${minPercent}%`, '--max-pct': `${maxPercent}%` } as CSSProperties}
      >
        <input
          aria-label={`${config.label} minimum`}
          disabled={!canSlide}
          max={maxBound}
          min={minBound}
          onChange={(event) => setRange({ min: Math.min(Number(event.target.value), displayMaxValue) })}
          step={config.step}
          type="range"
          value={displayMinValue}
        />
        <input
          aria-label={`${config.label} maximum`}
          disabled={!canSlide}
          max={maxBound}
          min={minBound}
          onChange={(event) => setRange({ max: Math.max(Number(event.target.value), displayMinValue) })}
          step={config.step}
          type="range"
          value={displayMaxValue}
        />
      </div>
    </div>
  )
}
