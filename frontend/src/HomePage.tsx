import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Database,
  Grid3X3,
  Info,
  LogIn,
  MapPinned,
  Rows3,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import stormwaterLogo from './assets/stormwater-logo.png'
import {
  CRITICAL_ASSET_TRACKING_ROUTE,
  CRITICAL_TEAM_ROUTE,
  DASHBOARD_CATALOG,
  GIS_FACILITY_ROUTE,
  type DashboardCatalogItem,
} from './dashboardCatalog'
import { fetchGISLayers } from './dashboards/gis/api'
import type { GISLayerMeta } from './dashboards/gis/types'
import ThemeToggle from './ThemeToggle'
import type { AppTheme } from './theme'
import criticalAssetClogAggregateDarkThumb from './assets/portal-thumbnails/critical-asset-clog-aggregate-dark.png'
import criticalAssetClogAggregateThumb from './assets/portal-thumbnails/critical-asset-clog-aggregate.png'
import criticalAssetConditionAggregateDarkThumb from './assets/portal-thumbnails/critical-asset-condition-aggregate-dark.png'
import criticalAssetConditionAggregateThumb from './assets/portal-thumbnails/critical-asset-condition-aggregate.png'
import criticalAssetHistoryTableDarkThumb from './assets/portal-thumbnails/critical-asset-history-table-dark.png'
import criticalAssetHistoryTableThumb from './assets/portal-thumbnails/critical-asset-history-table.png'
import criticalTeamOverviewDarkThumb from './assets/portal-thumbnails/critical-team-overview-dark.png'
import criticalTeamOverviewThumb from './assets/portal-thumbnails/critical-team-overview.png'
import criticalTeamProjectStartDarkThumb from './assets/portal-thumbnails/critical-team-project-start-dark.png'
import criticalTeamProjectStartThumb from './assets/portal-thumbnails/critical-team-project-start.png'
import criticalTeamReportCompletionChartDarkThumb from './assets/portal-thumbnails/critical-team-report-completion-chart-dark.png'
import criticalTeamReportCompletionChartThumb from './assets/portal-thumbnails/critical-team-report-completion-chart.png'
import criticalTeamReportCompletionTableDarkThumb from './assets/portal-thumbnails/critical-team-report-completion-table-dark.png'
import criticalTeamReportCompletionTableThumb from './assets/portal-thumbnails/critical-team-report-completion-table.png'
import criticalTeamReviewsChartDarkThumb from './assets/portal-thumbnails/critical-team-reviews-chart-dark.png'
import criticalTeamReviewsChartThumb from './assets/portal-thumbnails/critical-team-reviews-chart.png'
import criticalTeamReviewsTableDarkThumb from './assets/portal-thumbnails/critical-team-reviews-table-dark.png'
import criticalTeamReviewsTableThumb from './assets/portal-thumbnails/critical-team-reviews-table.png'
import criticalTeamWorkordersDarkThumb from './assets/portal-thumbnails/critical-team-workorders-dark.png'
import criticalTeamWorkordersThumb from './assets/portal-thumbnails/critical-team-workorders.png'
import gisCriticalAssetFacilityThumb from './assets/portal-thumbnails/gis-critical-asset-facility.png'
import gisCriticalAssetFacilityDarkThumb from './assets/portal-thumbnails/gis-critical-asset-facility-dark.png'
import gisCriticalAssetHistoryThumb from './assets/portal-thumbnails/gis-critical-asset-history.png'
import gisCriticalAssetHistoryDarkThumb from './assets/portal-thumbnails/gis-critical-asset-history-dark.png'
import './HomePage.css'

type LayerStatus = 'loading' | 'ready' | 'error'
type ResourceCategory = 'all' | 'dashboards' | 'maps' | 'tables' | 'datasets' | 'documents'
type ResourceType = 'Dataset' | 'Map' | 'Dashboard' | 'Table'
type ResourcePreview = 'facility' | 'pipe' | 'structure' | 'map' | 'history' | 'dashboard' | 'table'

type PortalResource = {
  id: string
  title: string
  description: string
  href: string
  category: Exclude<ResourceCategory, 'all'>
  type: ResourceType
  preview: ResourcePreview
  thumbnail: string
  darkThumbnail?: string
  meta?: string
  color?: string
}

type HomePageProps = {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
}

const CATEGORY_OPTIONS: Array<{ key: ResourceCategory; label: string }> = [
  { key: 'all', label: 'All resources' },
  { key: 'dashboards', label: 'Dashboards' },
  { key: 'maps', label: 'Maps' },
  { key: 'tables', label: 'Tables' },
  { key: 'datasets', label: 'Datasets' },
  { key: 'documents', label: 'Documents' },
]

function sheetHref(path: string, sheetId: string) {
  return `${path}?sheet=${encodeURIComponent(sheetId)}`
}

const FALLBACK_SPATIAL_MAPS: PortalResource[] = []

const HIDDEN_SPATIAL_RESOURCE_LABELS = new Set(['culvert facility', 'critical asset pipes', 'critical asset structures'])
const FEATURED_TABLE_RESOURCE_ORDER = [
  'critical-team-work-order-detail',
  'critical-team-report-completion-table',
  'critical-team-review-table',
  'critical-asset-history-table',
]
const FEATURED_DASHBOARD_RESOURCE_ORDER = [
  'critical-team-inspection-project-start',
  'critical-team-report-completion-chart',
  'critical-team-review-chart',
  'critical-asset-condition-aggregate',
]
const FEATURED_ALL_RESOURCE_ORDER = [
  'critical-team-inspection-project-start',
  'critical-team-report-completion-chart',
  'gis_critical_asset_facility',
  'critical-team-work-order-detail',
]
const DASHBOARD_ALL_RESOURCE_ORDER = [
  'critical-team-overview',
  'critical-team-inspection-project-start',
  'critical-team-report-completion-chart',
  'critical-team-review-chart',
  'critical-asset-condition-aggregate',
  'critical-asset-clog-aggregate',
]
const ALL_RESOURCE_CATEGORY_ORDER: Array<Exclude<ResourceCategory, 'all'>> = [
  'dashboards',
  'maps',
  'tables',
  'datasets',
  'documents',
]

const CRITICAL_TEAM_RESOURCES: PortalResource[] = [
  {
    id: 'critical-team-overview',
    title: 'Critical Team Overview',
    description: 'Cityworks Critical Asset Inspection work-order source and completion summary.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'overview'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamOverviewThumb,
    darkThumbnail: criticalTeamOverviewDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical-team-inspection-project-start',
    title: 'Inspection Project Start Date',
    description: 'Count of inspection work orders by project start month and assigned submitter.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'insp-proj-start-date'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamProjectStartThumb,
    darkThumbnail: criticalTeamProjectStartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical-team-report-completion-chart',
    title: 'Report Completion Date Chart',
    description: 'Report completion date counts grouped by submitter.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'report-comp-date-chart'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamReportCompletionChartThumb,
    darkThumbnail: criticalTeamReportCompletionChartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical-team-review-chart',
    title: 'Inspection Completion Date Reviews',
    description: 'Ready-for-review and review-complete work orders by closed date and reviewer.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'insp-comp-date-reviews'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamReviewsChartThumb,
    darkThumbnail: criticalTeamReviewsChartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical-team-report-completion-table',
    title: 'Report Completion Date',
    description: 'Report completion date cross-tab by submitter.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'report-comp-date-table'),
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamReportCompletionTableThumb,
    darkThumbnail: criticalTeamReportCompletionTableDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical-team-review-table',
    title: 'Review Completion Date',
    description: 'Review-complete cross-tab by reviewer and closed month.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'insp-comp-date-reviews-table'),
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamReviewsTableThumb,
    darkThumbnail: criticalTeamReviewsTableDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical-team-work-order-detail',
    title: 'Work Order Detail',
    description: 'Operational detail rows from the Cityworks Critical Asset Inspection source.',
    href: sheetHref(CRITICAL_TEAM_ROUTE, 'workorders'),
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamWorkordersThumb,
    darkThumbnail: criticalTeamWorkordersDarkThumb,
    meta: 'Critical Team',
  },
]

const CRITICAL_ASSET_RESOURCES: PortalResource[] = [
  {
    id: 'critical-asset-condition-aggregate',
    title: 'Condition Risk Facility Aggregate - Both',
    description: 'Condition risk summarized by facility across pipes and structures.',
    href: sheetHref(CRITICAL_ASSET_TRACKING_ROUTE, 'condition-facility-aggregate-both'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalAssetConditionAggregateThumb,
    darkThumbnail: criticalAssetConditionAggregateDarkThumb,
    meta: 'Critical Asset Tracking',
  },
  {
    id: 'critical-asset-clog-aggregate',
    title: 'Clog Risk Facility Aggregate - Pipes',
    description: 'Clog risk summarized by facility for pipe assets.',
    href: sheetHref(CRITICAL_ASSET_TRACKING_ROUTE, 'clog-facility-aggregate-pipes'),
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalAssetClogAggregateThumb,
    darkThumbnail: criticalAssetClogAggregateDarkThumb,
    meta: 'Critical Asset Tracking',
  },
  {
    id: 'critical-asset-history-table',
    title: 'History - Both',
    description: 'Paged, sortable inspection history across pipes and structures.',
    href: sheetHref(CRITICAL_ASSET_TRACKING_ROUTE, 'history-table-both'),
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalAssetHistoryTableThumb,
    darkThumbnail: criticalAssetHistoryTableDarkThumb,
    meta: 'Critical Asset Tracking',
  },
]

function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  return value.toLocaleString()
}

function previewForLayer(layer: GISLayerMeta): ResourcePreview {
  const text = `${layer.id} ${layer.label} ${layer.geometry_type ?? ''}`.toLowerCase()
  if (text.includes('pipe')) return 'pipe'
  if (text.includes('structure') || text.includes('point')) return 'structure'
  return 'facility'
}

function thumbnailForLayer(layer: GISLayerMeta) {
  const preview = previewForLayer(layer)
  return preview === 'facility' ? gisCriticalAssetFacilityThumb : gisCriticalAssetHistoryThumb
}

function darkThumbnailForLayer(layer: GISLayerMeta) {
  const preview = previewForLayer(layer)
  return preview === 'facility' ? gisCriticalAssetFacilityDarkThumb : gisCriticalAssetHistoryDarkThumb
}

function thumbnailForMapResource(item: DashboardCatalogItem) {
  return item.id.includes('history') ? gisCriticalAssetHistoryThumb : gisCriticalAssetFacilityThumb
}

function darkThumbnailForMapResource(item: DashboardCatalogItem) {
  return item.id.includes('history') ? gisCriticalAssetHistoryDarkThumb : gisCriticalAssetFacilityDarkThumb
}

function dashboardResource(item: DashboardCatalogItem): PortalResource {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    href: item.path,
    category: 'maps',
    type: 'Map',
    preview: item.id.includes('history') ? 'history' : 'map',
    thumbnail: thumbnailForMapResource(item),
    darkThumbnail: darkThumbnailForMapResource(item),
    meta: item.category,
  }
}

function layerMapResource(layer: GISLayerMeta): PortalResource {
  return {
    id: `map-${layer.id}`,
    title: layer.label,
    description: `${layer.geometry_type ?? 'Spatial'} layer with ${formatCount(layer.row_count)} records.`,
    href: GIS_FACILITY_ROUTE,
    category: 'maps',
    type: 'Map',
    preview: previewForLayer(layer),
    thumbnail: thumbnailForLayer(layer),
    darkThumbnail: darkThumbnailForLayer(layer),
    meta: `${formatCount(layer.row_count)} records`,
    color: layer.color,
  }
}

function isVisibleSpatialResource(layer: GISLayerMeta) {
  return !HIDDEN_SPATIAL_RESOURCE_LABELS.has(layer.label.trim().toLowerCase())
}

function resourceMatches(resource: PortalResource, category: ResourceCategory, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  const categoryMatch = category === 'all' || resource.category === category
  const textMatch =
    normalizedQuery === '' ||
    [resource.title, resource.description, resource.type, resource.meta]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery)
  return categoryMatch && textMatch
}

function orderFeaturedResources(resources: PortalResource[], category: ResourceCategory) {
  if (category === 'all') {
    return FEATURED_ALL_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
  }

  if (category === 'dashboards') {
    return FEATURED_DASHBOARD_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
  }

  if (category !== 'tables') return resources

  const orderedResources = FEATURED_TABLE_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
    (resource): resource is PortalResource => Boolean(resource),
  )
  const orderedIds = new Set(orderedResources.map((resource) => resource.id))

  return [...orderedResources, ...resources.filter((resource) => !orderedIds.has(resource.id))]
}

function orderAllResources(resources: PortalResource[], category: ResourceCategory): PortalResource[] {
  if (category === 'all') {
    return ALL_RESOURCE_CATEGORY_ORDER.flatMap((resourceCategory) =>
      orderAllResources(
        resources.filter((resource) => resource.category === resourceCategory),
        resourceCategory,
      ),
    )
  }

  if (category === 'dashboards') {
    const orderedResources = DASHBOARD_ALL_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
    const orderedIds = new Set(orderedResources.map((resource) => resource.id))

    return [...orderedResources, ...resources.filter((resource) => !orderedIds.has(resource.id))]
  }

  if (category === 'tables') {
    const orderedResources = FEATURED_TABLE_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
    const orderedIds = new Set(orderedResources.map((resource) => resource.id))

    return [...orderedResources, ...resources.filter((resource) => !orderedIds.has(resource.id))]
  }

  return resources
}

function ResourceTypeIcon({ type }: { type: ResourceType }) {
  if (type === 'Dataset') return <Database size={18} aria-hidden="true" />
  if (type === 'Map') return <MapPinned size={18} aria-hidden="true" />
  if (type === 'Table') return <Rows3 size={18} aria-hidden="true" />
  return <BarChart3 size={18} aria-hidden="true" />
}

function ResourceCard({ resource, theme }: { resource: PortalResource; theme: AppTheme }) {
  const thumbnail = theme === 'dark' && resource.darkThumbnail ? resource.darkThumbnail : resource.thumbnail

  return (
    <article className="home-resource-card">
      <a className={`home-resource-preview image-preview ${resource.preview}`} href={resource.href} aria-label={`Open ${resource.title}`}>
        <img src={thumbnail} alt="" loading="lazy" />
      </a>
      <div className="home-resource-body">
        <a className="home-resource-title" href={resource.href}>
          <ResourceTypeIcon type={resource.type} />
          <span>{resource.title}</span>
        </a>
        <div className="home-resource-footer">
          <a href={resource.href} aria-label={`${resource.title} details`}>
            <Info size={17} />
          </a>
        </div>
      </div>
    </article>
  )
}

export default function HomePage({ theme, onThemeChange }: HomePageProps) {
  const [layers, setLayers] = useState<GISLayerMeta[]>([])
  const [layerStatus, setLayerStatus] = useState<LayerStatus>('loading')
  const [activeCategory, setActiveCategory] = useState<ResourceCategory>('all')
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    let cancelled = false

    fetchGISLayers()
      .then((response) => {
        if (cancelled) return
        setLayers(response.layers)
        setLayerStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setLayerStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const spatialMapResources = useMemo(
    () => (layerStatus === 'ready' ? layers.filter(isVisibleSpatialResource).map(layerMapResource) : FALLBACK_SPATIAL_MAPS),
    [layerStatus, layers],
  )
  const mapResources = useMemo(() => DASHBOARD_CATALOG.filter((item) => item.category === 'Maps').map(dashboardResource), [])
  const dashboardResources = useMemo(() => [...CRITICAL_ASSET_RESOURCES, ...CRITICAL_TEAM_RESOURCES], [])
  const allResources = useMemo(
    () => [...mapResources, ...dashboardResources, ...spatialMapResources],
    [dashboardResources, mapResources, spatialMapResources],
  )
  const filteredResources = useMemo(
    () => orderAllResources(allResources.filter((resource) => resourceMatches(resource, activeCategory, searchTerm)), activeCategory),
    [activeCategory, allResources, searchTerm],
  )
  const featuredResourceMatches = useMemo(
    () =>
      orderFeaturedResources(
        [...mapResources, ...dashboardResources].filter((resource) => resourceMatches(resource, activeCategory, searchTerm)),
        activeCategory,
      ),
    [activeCategory, dashboardResources, mapResources, searchTerm],
  )
  const featuredResources = useMemo(() => featuredResourceMatches.slice(0, 4), [featuredResourceMatches])

  return (
    <main className="home-page">
      <header className="home-header">
        <div className="home-nav-row">
          <a className="home-brand" href="/" aria-label="Storm Water Asset Intelligence Portal">
            <span className="home-logo-mark">
              <img src={stormwaterLogo} alt="" />
            </span>
          </a>

          <nav className="home-category-nav" aria-label="Resource categories">
            {CATEGORY_OPTIONS.map((option) => (
              <button
                className={activeCategory === option.key ? 'active' : ''}
                key={option.key}
                type="button"
                onClick={() => setActiveCategory(option.key)}
              >
                {option.label}
              </button>
            ))}
          </nav>

          <label className="home-search-bar">
            <Search size={23} aria-hidden="true" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search"
              type="search"
            />
          </label>

          <div className="home-utility-nav" aria-label="Portal utilities">
            <span>
              <LogIn size={17} />
              Sign in
            </span>
            <ThemeToggle placement="inline" theme={theme} onThemeChange={onThemeChange} />
          </div>
        </div>
      </header>

      <section className="home-hero">
        <div className="home-hero-content">
          <span className="home-hero-logo" aria-hidden="true">
            <img src={stormwaterLogo} alt="" />
          </span>
          <div className="home-hero-copy">
            <h1>Storm Water Asset Intelligence Portal</h1>
            <p>sharing asset risk data, maps, and dashboards for strategic planning and analysis.</p>
          </div>
        </div>
      </section>

      <section className="home-featured">
        <div className="home-featured-heading">
          <h2>Featured</h2>
          <p>
            {featuredResources.length.toLocaleString()} {featuredResources.length === 1 ? 'Resource' : 'Resources'} found
          </p>
        </div>

        {featuredResources.length ? (
          <div className="home-resource-grid">
            {featuredResources.map((resource) => (
              <ResourceCard key={resource.id} resource={resource} theme={theme} />
            ))}
          </div>
        ) : (
          <div className="home-empty-results">
            <Search size={28} />
            <strong>No resources found</strong>
          </div>
        )}

        {featuredResourceMatches.length > 4 ? (
          <nav className="home-pagination" aria-label="Featured resource pages">
            <button type="button" disabled>
              <ChevronLeft size={26} />
            </button>
            <button className="active" type="button">
              1
            </button>
            <button type="button">
              <ChevronRight size={26} />
            </button>
          </nav>
        ) : null}

        <section className="home-all-resources">
          <div className="home-all-heading">
            <h2>All resources</h2>
            <div className="home-all-toolbar">
              <div>
                <button className="home-filter-button" type="button">
                  Filter
                </button>
                <span>
                  {filteredResources.length.toLocaleString()} {filteredResources.length === 1 ? 'Resource' : 'Resources'} found
                </span>
              </div>
              <div>
                <button className="home-icon-button" type="button" aria-label="Grid view">
                  <Grid3X3 size={21} />
                </button>
                <button className="home-order-button" type="button">
                  <Rows3 size={18} />
                  Order by
                </button>
              </div>
            </div>
          </div>

          <div className="home-resource-grid">
            {filteredResources.map((resource) => (
              <ResourceCard key={`all-${resource.id}`} resource={resource} theme={theme} />
            ))}
          </div>

          {filteredResources.length > 8 ? (
            <nav className="home-pagination all" aria-label="All resource pages">
              <button type="button" disabled>
                <ChevronLeft size={26} />
              </button>
              <button className="active" type="button">
                1
              </button>
              <button type="button">
                <ChevronRight size={26} />
              </button>
            </nav>
          ) : null}
        </section>
      </section>
    </main>
  )
}
