import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Check,
  ChevronDown,
  Database,
  FileText,
  Grid3X3,
  CircleHelp,
  Info,
  LogIn,
  LogOut,
  MapPinned,
  Rows3,
  Search,
  Settings,
  ShieldCheck,
  Star,
  UserRound,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import stormwaterLogo from './assets/stormwater-logo.png'
import {
  ADMIN_MANAGEMENT_ROUTE,
  ACCOUNT_ROUTE,
  CRITICAL_ASSET_SHEET_ROUTES,
  CRITICAL_TEAM_SHEET_ROUTES,
  DASHBOARD_CATALOG,
  PORTAL_LOGIN_ROUTE,
  type DashboardCatalogItem,
} from './dashboardCatalog'
import {
  clearManagementToken,
  addMyFavorite,
  fetchMe,
  fetchMyFeaturedResources,
  fetchMyFavorites,
  fetchMyResources,
  fetchUsers,
  loadMyTeamFavoriteSettings,
  managementSessionTransferUrl,
  saveManagementToken,
  saveManagementUser,
  removeMyFavorite,
  storedManagementToken,
  storedManagementUser,
  switchRole,
  type PortalFeaturedCategory,
  type PortalFeaturedResourcesByCategory,
  type PortalResource as ManagedPortalResource,
  type PortalRole,
  type PortalUser,
} from './management/api'
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
import criticalTeamInspectionCompletionChartDarkThumb from './assets/portal-thumbnails/critical-team-inspection-completion-chart-dark.png'
import criticalTeamInspectionCompletionChartThumb from './assets/portal-thumbnails/critical-team-inspection-completion-chart.png'
import criticalTeamInspectionCompletionTableDarkThumb from './assets/portal-thumbnails/critical-team-inspection-completion-table-dark.png'
import criticalTeamInspectionCompletionTableThumb from './assets/portal-thumbnails/critical-team-inspection-completion-table.png'
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
import proactiveTeamCctvReviewThumb from './assets/portal-thumbnails/proactive-team-cctv-review.png'
import proactiveTeamCctvReviewDarkThumb from './assets/portal-thumbnails/proactive-team-cctv-review-dark.png'
import stmRiskMapThumb from './assets/portal-thumbnails/stm-risk-map.png'
import stmRiskMapDarkThumb from './assets/portal-thumbnails/stm-risk-map-dark.png'
import './HomePage.css'
import { isDesktopRuntime } from './desktop/runtime'
import {
  clearPortalTestAccess,
  savePortalTestAccess,
  storedPortalTestAccess,
  type PortalTestAccess,
} from './desktop/request'

type ResourceCategory = 'all' | 'dashboards' | 'maps' | 'tables' | 'datasets' | 'documents' | 'reports'
type ResourceType = 'Dataset' | 'Document' | 'Map' | 'Dashboard' | 'Report' | 'Table'
type ResourcePreview = 'facility' | 'pipe' | 'structure' | 'map' | 'history' | 'dashboard' | 'table'

type PortalResource = {
  id: string
  resourceId?: string
  effectivePermission?: ManagedPortalResource['effective_permission']
  title: string
  description: string
  href: string
  helpUrl?: string
  category: Exclude<ResourceCategory, 'all'>
  type: ResourceType
  preview: ResourcePreview
  thumbnail: string
  darkThumbnail?: string
  meta?: string
  color?: string
}

type PortalResourceLaunchContext = {
  portal_email: string
  portal_employeeid: string
  portal_first_name: string
  portal_last_name: string
  portal_team_name: string
  portal_is_manager: string
  portal_user_role: string
  portal_permission: string
  portal_permission_level: string
  portal_permission_types: string
  portal_permission_source: string
  portal_test_access: string
}

type HomePageProps = {
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
}

const CATEGORY_OPTIONS: Array<{ key: ResourceCategory; label: string }> = [
  { key: 'all', label: 'All Resources' },
  { key: 'dashboards', label: 'Dashboards' },
  { key: 'maps', label: 'Maps' },
  { key: 'tables', label: 'Tables' },
  { key: 'datasets', label: 'Datasets' },
  { key: 'documents', label: 'Documents' },
  { key: 'reports', label: 'Reports' },
]

const FEATURED_TABLE_RESOURCE_ORDER = [
  'critical_team_work_order_detail',
  'critical_team_report_completion_date',
  'critical_team_review_completion_date',
  'critical_asset_history_both',
]
const FEATURED_DASHBOARD_RESOURCE_ORDER = [
  'critical_team_inspection_project_start_date',
  'critical_team_report_completion_date_chart',
  'critical_team_inspection_completion_date_reviews',
  'critical_asset_condition_facility_aggregate_both',
]
const FEATURED_ALL_RESOURCE_ORDER = [
  'critical_team_inspection_project_start_date',
  'critical_team_report_completion_date_chart',
  'gis_critical_asset_facility',
  'critical_team_work_order_detail',
]
const DASHBOARD_ALL_RESOURCE_ORDER = [
  'critical_team_overview',
  'critical_team_inspection_project_start_date',
  'critical_team_inspection_completion_date_chart',
  'critical_team_report_completion_date_chart',
  'critical_team_inspection_completion_date_reviews',
  'critical_asset_condition_facility_aggregate_both',
  'critical_asset_clog_facility_aggregate_pipes',
]
const ALL_RESOURCE_CATEGORY_ORDER: Array<Exclude<ResourceCategory, 'all'>> = [
  'dashboards',
  'maps',
  'tables',
  'datasets',
  'documents',
  'reports',
]
const FEATURED_CATEGORY_COMPOSE_ORDER: Exclude<PortalFeaturedCategory, 'all'>[] = [
  'dashboard',
  'map',
  'tab',
  'dataset',
  'doc',
  'report',
]

const CRITICAL_TEAM_RESOURCES: PortalResource[] = [
  {
    id: 'critical_team_overview',
    title: 'Critical Team Overview',
    description: 'Cityworks Critical Asset Inspection work-order source and completion summary.',
    href: CRITICAL_TEAM_SHEET_ROUTES.overview,
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamOverviewThumb,
    darkThumbnail: criticalTeamOverviewDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical_team_inspection_project_start_date',
    title: 'Inspection Project Start Date',
    description: 'Count of inspection work orders by project start month and assigned submitter.',
    href: CRITICAL_TEAM_SHEET_ROUTES['insp-proj-start-date'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamInspectionCompletionChartThumb,
    darkThumbnail: criticalTeamInspectionCompletionChartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical_team_inspection_completion_date_chart',
    title: 'Inspection Completion Date Chart',
    description: 'Inspection completion date counts grouped by submitter.',
    href: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-bar-chart'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamProjectStartThumb,
    darkThumbnail: criticalTeamProjectStartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical_team_report_completion_date_chart',
    title: 'Report Completion Date Chart',
    description: 'Report completion date counts grouped by submitter.',
    href: CRITICAL_TEAM_SHEET_ROUTES['report-comp-date-chart'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamReportCompletionChartThumb,
    darkThumbnail: criticalTeamReportCompletionChartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical_team_inspection_completion_date_reviews',
    title: 'Inspection Completion Date Reviews',
    description: 'Ready-for-review and review-complete work orders by closed date and reviewer.',
    href: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-reviews'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalTeamReviewsChartThumb,
    darkThumbnail: criticalTeamReviewsChartDarkThumb,
    meta: 'Chart',
  },
  {
    id: 'critical_team_inspection_completion_date',
    title: 'Inspection Completion Date',
    description: 'Inspection completion date cross-tab by submitter.',
    href: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-table'],
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamInspectionCompletionTableThumb,
    darkThumbnail: criticalTeamInspectionCompletionTableDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical_team_report_completion_date',
    title: 'Report Completion Date',
    description: 'Report completion date cross-tab by submitter.',
    href: CRITICAL_TEAM_SHEET_ROUTES['report-comp-date-table'],
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamReportCompletionTableThumb,
    darkThumbnail: criticalTeamReportCompletionTableDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical_team_review_completion_date',
    title: 'Review Completion Date',
    description: 'Review-complete cross-tab by reviewer and closed month.',
    href: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-reviews-table'],
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalTeamReviewsTableThumb,
    darkThumbnail: criticalTeamReviewsTableDarkThumb,
    meta: 'Critical Team',
  },
  {
    id: 'critical_team_work_order_detail',
    title: 'Work Order Detail',
    description: 'Operational detail rows from the Cityworks Critical Asset Inspection source.',
    href: CRITICAL_TEAM_SHEET_ROUTES.workorders,
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
    id: 'critical_asset_condition_facility_aggregate_both',
    title: 'Condition Risk Facility Aggregate - Both',
    description: 'Condition risk summarized by facility across pipes and structures.',
    href: CRITICAL_ASSET_SHEET_ROUTES['condition-facility-aggregate-both'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalAssetConditionAggregateThumb,
    darkThumbnail: criticalAssetConditionAggregateDarkThumb,
    meta: 'Critical Asset Tracking',
  },
  {
    id: 'critical_asset_clog_facility_aggregate_pipes',
    title: 'Clog Risk Facility Aggregate - Pipes',
    description: 'Clog risk summarized by facility for pipe assets.',
    href: CRITICAL_ASSET_SHEET_ROUTES['clog-facility-aggregate-pipes'],
    category: 'dashboards',
    type: 'Dashboard',
    preview: 'dashboard',
    thumbnail: criticalAssetClogAggregateThumb,
    darkThumbnail: criticalAssetClogAggregateDarkThumb,
    meta: 'Critical Asset Tracking',
  },
  {
    id: 'critical_asset_history_both',
    title: 'History - Both',
    description: 'Paged, sortable inspection history across pipes and structures.',
    href: CRITICAL_ASSET_SHEET_ROUTES['history-table-both'],
    category: 'tables',
    type: 'Table',
    preview: 'table',
    thumbnail: criticalAssetHistoryTableThumb,
    darkThumbnail: criticalAssetHistoryTableDarkThumb,
    meta: 'Critical Asset Tracking',
  },
]

function thumbnailForMapResource(item: DashboardCatalogItem) {
  if (item.id === 'stm_risk_map') return stmRiskMapThumb
  return item.id.includes('history') ? gisCriticalAssetHistoryThumb : gisCriticalAssetFacilityThumb
}

function darkThumbnailForMapResource(item: DashboardCatalogItem) {
  if (item.id === 'stm_risk_map') return stmRiskMapDarkThumb
  return item.id.includes('history') ? gisCriticalAssetHistoryDarkThumb : gisCriticalAssetFacilityDarkThumb
}

function categoryForCatalogItem(item: DashboardCatalogItem): Exclude<ResourceCategory, 'all'> {
  if (item.kind === 'map') return 'maps'
  if (item.kind === 'tab') return 'tables'
  if (item.kind === 'doc') return 'documents'
  if (item.kind === 'report') return 'reports'
  return 'dashboards'
}

function typeForCatalogItem(item: DashboardCatalogItem): ResourceType {
  if (item.kind === 'map') return 'Map'
  if (item.kind === 'tab') return 'Table'
  if (item.kind === 'doc') return 'Document'
  if (item.kind === 'report') return 'Report'
  return 'Dashboard'
}

function previewForCatalogItem(item: DashboardCatalogItem): ResourcePreview {
  if (item.kind === 'map') return item.id.includes('history') ? 'history' : 'map'
  if (item.kind === 'tab') return 'table'
  return 'dashboard'
}

function thumbnailForCatalogItem(item: DashboardCatalogItem) {
  if (item.kind === 'map') return thumbnailForMapResource(item)
  if (item.id === 'proactive_team_cctv_review') return proactiveTeamCctvReviewThumb
  if (item.id === 'planning_pending_aif_qa') return criticalTeamWorkordersThumb
  if (item.id === 'critical_team_inspection_completion_date_chart') return criticalTeamInspectionCompletionChartThumb
  if (item.id === 'critical_team_inspection_completion_date') return criticalTeamInspectionCompletionTableThumb
  if (item.id.includes('history')) return criticalAssetHistoryTableThumb
  if (item.id.includes('clog')) return criticalAssetClogAggregateThumb
  if (item.id.includes('critical_asset')) return criticalAssetConditionAggregateThumb
  if (item.id.includes('work_order')) return criticalTeamWorkordersThumb
  if (item.id.includes('report_completion')) return criticalTeamReportCompletionChartThumb
  if (item.id.includes('review')) return criticalTeamReviewsChartThumb
  if (item.id.includes('critical_team')) return criticalTeamOverviewThumb
  return criticalTeamProjectStartThumb
}

function darkThumbnailForCatalogItem(item: DashboardCatalogItem) {
  if (item.kind === 'map') return darkThumbnailForMapResource(item)
  if (item.id === 'proactive_team_cctv_review') return proactiveTeamCctvReviewDarkThumb
  if (item.id === 'planning_pending_aif_qa') return criticalTeamWorkordersDarkThumb
  if (item.id === 'critical_team_inspection_completion_date_chart') return criticalTeamInspectionCompletionChartDarkThumb
  if (item.id === 'critical_team_inspection_completion_date') return criticalTeamInspectionCompletionTableDarkThumb
  if (item.id.includes('history')) return criticalAssetHistoryTableDarkThumb
  if (item.id.includes('clog')) return criticalAssetClogAggregateDarkThumb
  if (item.id.includes('critical_asset')) return criticalAssetConditionAggregateDarkThumb
  if (item.id.includes('work_order')) return criticalTeamWorkordersDarkThumb
  if (item.id.includes('report_completion')) return criticalTeamReportCompletionChartDarkThumb
  if (item.id.includes('review')) return criticalTeamReviewsChartDarkThumb
  if (item.id.includes('critical_team')) return criticalTeamOverviewDarkThumb
  return criticalTeamProjectStartDarkThumb
}

function catalogResource(item: DashboardCatalogItem): PortalResource {
  return {
    id: item.id,
    resourceId: item.resource_id,
    title: item.title,
    description: item.description,
    href: item.path,
    helpUrl: item.helpUrl,
    category: categoryForCatalogItem(item),
    type: typeForCatalogItem(item),
    preview: previewForCatalogItem(item),
    thumbnail: thumbnailForCatalogItem(item),
    darkThumbnail: darkThumbnailForCatalogItem(item),
    meta: item.category,
  }
}

function categoryForManagedResource(resource: ManagedPortalResource): Exclude<ResourceCategory, 'all'> {
  if (resource.resource_type === 'map') return 'maps'
  if (resource.resource_type === 'tab') return 'tables'
  if (resource.resource_type === 'doc') return 'documents'
  if (resource.resource_type === 'report') return 'reports'
  if (resource.resource_type === 'dataset') return 'datasets'
  return 'dashboards'
}

function featuredCategoryForPortalCategory(category: ResourceCategory): PortalFeaturedCategory {
  if (category === 'dashboards') return 'dashboard'
  if (category === 'maps') return 'map'
  if (category === 'tables') return 'tab'
  if (category === 'documents') return 'doc'
  if (category === 'datasets') return 'dataset'
  if (category === 'reports') return 'report'
  return 'all'
}

function composeAllFeaturedResources(featured: PortalFeaturedResourcesByCategory): ManagedPortalResource[] {
  const orderedResources: ManagedPortalResource[] = []
  const resourceKeys = new Set<string>()

  for (const category of FEATURED_CATEGORY_COMPOSE_ORDER) {
    for (const resource of featured[category] ?? []) {
      if (resourceKeys.has(resource.resource_key)) continue
      resourceKeys.add(resource.resource_key)
      orderedResources.push(resource)
    }
  }

  return orderedResources
}

function featuredResourcesForDisplay(
  resources: ManagedPortalResource[] | undefined,
  existingResources: PortalResource[],
  availableResourceKeys: Set<string>,
  activeCategory: ResourceCategory,
  searchTerm: string,
) {
  return (resources ?? [])
    .filter((resource) => isPortalCardResource(resource) && availableResourceKeys.has(resource.resource_key))
    .map((resource) => managedResourceCard(resource, existingResources))
    .filter((resource) => resourceMatches(resource, activeCategory, searchTerm))
}

function typeForManagedResource(resource: ManagedPortalResource): ResourceType {
  if (resource.resource_type === 'map') return 'Map'
  if (resource.resource_type === 'tab') return 'Table'
  if (resource.resource_type === 'doc') return 'Document'
  if (resource.resource_type === 'report') return 'Report'
  if (resource.resource_type === 'dataset' || resource.resource_type === 'api' || resource.resource_type === 'service') return 'Dataset'
  return 'Dashboard'
}

function previewForManagedResource(resource: ManagedPortalResource): ResourcePreview {
  if (resource.resource_type === 'map') return resource.resource_key.includes('history') ? 'history' : 'map'
  if (resource.resource_type === 'tab') return 'table'
  return 'dashboard'
}

function isStmRiskMapResource(resource: ManagedPortalResource) {
  return resource.resource_key === 'stm_risk_map' || resource.url.includes('/map_stm_risk')
}

function thumbnailForManagedResource(resource: ManagedPortalResource) {
  if (isStmRiskMapResource(resource)) return stmRiskMapThumb
  if (resource.resource_key === 'proactive_team_cctv_review') return proactiveTeamCctvReviewThumb
  if (resource.resource_key === 'planning_pending_aif_qa') return criticalTeamWorkordersThumb
  if (resource.resource_key === 'critical_team_inspection_completion_date_chart') return criticalTeamInspectionCompletionChartThumb
  if (resource.resource_key === 'critical_team_inspection_completion_date') return criticalTeamInspectionCompletionTableThumb
  if (resource.resource_key.includes('history')) return gisCriticalAssetHistoryThumb
  if (resource.resource_key.includes('facility') || resource.resource_key.includes('map')) return gisCriticalAssetFacilityThumb
  if (resource.resource_key.includes('critical_asset')) return criticalAssetConditionAggregateThumb
  if (resource.resource_key.includes('critical_team')) return criticalTeamOverviewThumb
  return criticalTeamProjectStartThumb
}

function darkThumbnailForManagedResource(resource: ManagedPortalResource) {
  if (isStmRiskMapResource(resource)) return stmRiskMapDarkThumb
  if (resource.resource_key === 'proactive_team_cctv_review') return proactiveTeamCctvReviewDarkThumb
  if (resource.resource_key === 'planning_pending_aif_qa') return criticalTeamWorkordersDarkThumb
  if (resource.resource_key === 'critical_team_inspection_completion_date_chart') return criticalTeamInspectionCompletionChartDarkThumb
  if (resource.resource_key === 'critical_team_inspection_completion_date') return criticalTeamInspectionCompletionTableDarkThumb
  if (resource.resource_key.includes('history')) return gisCriticalAssetHistoryDarkThumb
  if (resource.resource_key.includes('facility') || resource.resource_key.includes('map')) return gisCriticalAssetFacilityDarkThumb
  if (resource.resource_key.includes('critical_asset')) return criticalAssetConditionAggregateDarkThumb
  if (resource.resource_key.includes('critical_team')) return criticalTeamOverviewDarkThumb
  return criticalTeamProjectStartDarkThumb
}

function managedResourceCard(resource: ManagedPortalResource, existingResources: PortalResource[]): PortalResource {
  const existing = existingResources.find((item) => item.id === resource.resource_key)
  if (existing) {
    return {
      ...existing,
      resourceId: resource.resource_id,
      effectivePermission: resource.effective_permission,
      helpUrl: resource.help_url ?? existing.helpUrl,
    }
  }
  return {
    id: resource.resource_key,
    resourceId: resource.resource_id,
    effectivePermission: resource.effective_permission,
    title: resource.name,
    description: resource.description ?? resource.name,
    href: resource.url,
    helpUrl: resource.help_url ?? undefined,
    category: categoryForManagedResource(resource),
    type: typeForManagedResource(resource),
    preview: previewForManagedResource(resource),
    thumbnail: thumbnailForManagedResource(resource),
    darkThumbnail: darkThumbnailForManagedResource(resource),
    meta: resource.category ?? resource.resource_type,
  }
}

function isPortalCardResource(resource: ManagedPortalResource) {
  return resource.is_active && resource.resource_type !== 'admin' && resource.resource_type !== 'api' && resource.resource_type !== 'service'
}

function portalCardResourcesFromResponse(resources: ManagedPortalResource[]) {
  return resources.filter(isPortalCardResource)
}

function mergeResources(resources: PortalResource[]) {
  const merged = new Map<string, PortalResource>()
  for (const resource of resources) {
    if (!merged.has(resource.id)) merged.set(resource.id, resource)
  }
  return [...merged.values()]
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
    const orderedResources = FEATURED_ALL_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
    const orderedIds = new Set(orderedResources.map((resource) => resource.id))
    return [...orderedResources, ...resources.filter((resource) => !orderedIds.has(resource.id))]
  }

  if (category === 'dashboards') {
    const orderedResources = FEATURED_DASHBOARD_RESOURCE_ORDER.map((id) => resources.find((resource) => resource.id === id)).filter(
      (resource): resource is PortalResource => Boolean(resource),
    )
    const orderedIds = new Set(orderedResources.map((resource) => resource.id))
    return [...orderedResources, ...resources.filter((resource) => !orderedIds.has(resource.id))]
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
  if (type === 'Document') return <FileText size={18} aria-hidden="true" />
  if (type === 'Map') return <MapPinned size={18} aria-hidden="true" />
  if (type === 'Report') return <BarChart3 size={18} aria-hidden="true" />
  if (type === 'Table') return <Rows3 size={18} aria-hidden="true" />
  return <BarChart3 size={18} aria-hidden="true" />
}

function resourceLaunchContext(
  user: PortalUser | null,
  resource: PortalResource,
  testAccess: PortalTestAccess | null,
): PortalResourceLaunchContext | null {
  if (!user) return null

  const permission = resource.effectivePermission

  return {
    portal_email: user.email,
    portal_employeeid: user.employee_id,
    portal_first_name: user.first_name,
    portal_last_name: user.last_name,
    portal_team_name: user.team_name ?? '',
    portal_is_manager: user.manager_user_id === user.id ? '1' : '0',
    portal_user_role: roleText(user.selected_role),
    portal_permission: permission?.permission ?? '',
    portal_permission_level: String(permission?.permission_level ?? 0),
    portal_permission_types: permission?.permission_types.join(',') ?? '',
    portal_permission_source: permission?.source ?? '',
    portal_test_access: testAccess ? '1' : '0',
  }
}

function appendPortalUserContext(url: URL, user: PortalUser | null, resource: PortalResource, testAccess: PortalTestAccess | null) {
  const context = resourceLaunchContext(user, resource, testAccess)
  if (!context) return

  Object.entries(context).forEach(([key, value]) => {
    url.searchParams.set(key, value)
  })
}

function resourcePopupUrl(resource: PortalResource, user: PortalUser | null, testAccess: PortalTestAccess | null) {
  try {
    const url = new URL(resource.href, window.location.origin)
    if (resource.resourceId) {
      url.searchParams.set('portal_resource_id', resource.resourceId)
    }
    appendPortalUserContext(url, user, resource, testAccess)

    if (url.origin === window.location.origin) {
      url.searchParams.set('embed', '1')
      const popupPath = `${url.pathname}${url.search}`
      const token = storedManagementToken()
      return token && user
        ? managementSessionTransferUrl(popupPath, token, user.selected_role)
        : `${popupPath}${url.hash}`
    }
    return url.toString()
  } catch {
    return resource.href
  }
}

function resourceHelpUrl(resource: PortalResource, user: PortalUser | null, testAccess: PortalTestAccess | null) {
  if (!resource.helpUrl) return null

  try {
    const url = new URL(resource.helpUrl, window.location.origin)
    if (resource.resourceId) {
      url.searchParams.set('portal_resource_id', resource.resourceId)
    }
    appendPortalUserContext(url, user, resource, testAccess)

    if (url.origin === window.location.origin) {
      return `${url.pathname}${url.search}${url.hash}`
    }
    return url.toString()
  } catch {
    return resource.helpUrl
  }
}

function ResourceCard({
  resource,
  theme,
  onOpen,
  favorite,
  favoriteBusy,
  onToggleFavorite,
}: {
  resource: PortalResource
  theme: AppTheme
  onOpen: (resource: PortalResource) => void
  favorite?: boolean
  favoriteBusy?: boolean
  onToggleFavorite?: (resource: PortalResource) => void
}) {
  const thumbnail = theme === 'dark' && resource.darkThumbnail ? resource.darkThumbnail : resource.thumbnail

  return (
    <article className="home-resource-card">
      <button className={`home-resource-preview image-preview ${resource.preview}`} type="button" onClick={() => onOpen(resource)} aria-label={`Open ${resource.title}`}>
        <img src={thumbnail} alt="" loading="lazy" />
      </button>
      <div className="home-resource-body">
        <button className="home-resource-title" type="button" onClick={() => onOpen(resource)}>
          <ResourceTypeIcon type={resource.type} />
          <span>{resource.title}</span>
        </button>
        <div className="home-resource-footer">
          {onToggleFavorite ? (
            <button
              className={`home-favorite-button ${favorite ? 'active' : ''}`}
              type="button"
              disabled={favoriteBusy}
              onClick={() => onToggleFavorite(resource)}
              aria-label={`${favorite ? 'Remove' : 'Add'} ${resource.title} ${favorite ? 'from' : 'to'} My Favorites`}
              title={favorite ? 'Remove from My Favorites' : 'Add to My Favorites'}
            >
              <Star size={18} fill={favorite ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          <button type="button" onClick={() => onOpen(resource)} aria-label={`${resource.title} details`}>
            <Info size={17} />
          </button>
        </div>
      </div>
    </article>
  )
}

function ResourcePopup({
  resource,
  user,
  testAccess,
  onClose,
}: {
  resource: PortalResource
  user: PortalUser | null
  testAccess: PortalTestAccess | null
  onClose: () => void
}) {
  const helpUrl = resourceHelpUrl(resource, user, testAccess)

  return (
    <div
      className="home-resource-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="home-resource-modal" role="dialog" aria-modal="true" aria-label={resource.title}>
        <div className="home-resource-modal-tools" aria-label="Resource window controls">
          <button className="home-resource-modal-close" type="button" onClick={onClose} aria-label="Close resource popup" title="Close">
            <X size={21} />
          </button>
          {helpUrl ? (
            <a className="home-resource-modal-help" href={helpUrl} target="_blank" rel="noreferrer" aria-label={`Open help for ${resource.title}`} title="Help">
              <CircleHelp size={21} />
            </a>
          ) : null}
        </div>
        <iframe src={resourcePopupUrl(resource, user, testAccess)} title={resource.title} />
      </section>
    </div>
  )
}

function DesktopResourceTabs({
  tabs,
  activeResourceId,
  onActivateHome,
  onActivateResource,
  onCloseResource,
}: {
  tabs: PortalResource[]
  activeResourceId: string | null
  onActivateHome: () => void
  onActivateResource: (resourceId: string) => void
  onCloseResource: (resourceId: string) => void
}) {
  if (!tabs.length) return null

  return (
    <nav className="desktop-resource-tabs" aria-label="Open portal resources">
      <button className={`desktop-resource-tab desktop-resource-home-tab ${activeResourceId === null ? 'active' : ''}`} type="button" onClick={onActivateHome}>
        <Grid3X3 size={16} aria-hidden="true" />
        <span>Home</span>
      </button>
      {tabs.map((resource) => (
        <div className={`desktop-resource-tab ${activeResourceId === resource.id ? 'active' : ''}`} key={resource.id}>
          <button className="desktop-resource-tab-open" type="button" onClick={() => onActivateResource(resource.id)} aria-current={activeResourceId === resource.id ? 'page' : undefined}>
            <ResourceTypeIcon type={resource.type} />
            <span>{resource.title}</span>
          </button>
          <button className="desktop-resource-tab-close" type="button" onClick={() => onCloseResource(resource.id)} aria-label={`Close ${resource.title}`} title={`Close ${resource.title}`}>
            <X size={16} />
          </button>
        </div>
      ))}
    </nav>
  )
}

function DesktopResourceWorkspace({
  tabs,
  activeResourceId,
  user,
  testAccess,
}: {
  tabs: PortalResource[]
  activeResourceId: string | null
  user: PortalUser | null
  testAccess: PortalTestAccess | null
}) {
  if (!tabs.length) return null

  return (
    <section className={`desktop-resource-workspace ${activeResourceId ? 'is-active' : ''}`} aria-label="Portal resource workspace">
      {tabs.map((resource) => {
        const isActive = resource.id === activeResourceId

        return (
          <section className={`desktop-resource-pane ${isActive ? 'is-active' : ''}`} key={resource.id} aria-hidden={!isActive}>
            <iframe src={resourcePopupUrl(resource, user, testAccess)} title={resource.title} tabIndex={isActive ? 0 : -1} />
          </section>
        )
      })}
    </section>
  )
}

const ACCOUNT_PROFILE_ROUTE = `${ACCOUNT_ROUTE}?tab=profile`

function accountDisplayName(user: PortalUser) {
  return user.first_name || user.display_name || 'Account'
}

function roleText(role: PortalRole) {
  if (role === 'system_admin') return 'System Admin'
  if (role === 'admin') return 'Admin'
  return 'User'
}

function isManagementRole(role: PortalRole) {
  return role === 'admin' || role === 'system_admin'
}

function AccountMenu({
  user,
  showAdmin,
  showSignOut,
  testAccess,
  onSignOut,
  onSwitchRole,
  onStartTestAccess,
  onStopTestAccess,
}: {
  user: PortalUser
  showAdmin: boolean
  showSignOut: boolean
  testAccess: PortalTestAccess | null
  onSignOut: () => void
  onSwitchRole: (role: PortalRole) => Promise<void>
  onStartTestAccess: () => void
  onStopTestAccess: () => void
}) {
  const [open, setOpen] = useState(false)
  const [switchingRole, setSwitchingRole] = useState<PortalRole | null>(null)
  const [roleError, setRoleError] = useState('')
  const hasMultipleRoles = user.roles.length > 1

  async function handleSwitchRole(role: PortalRole) {
    if (switchingRole || role === user.selected_role) return
    setSwitchingRole(role)
    setRoleError('')
    try {
      await onSwitchRole(role)
      setOpen(false)
    } catch (error) {
      setRoleError(error instanceof Error ? error.message : 'Could not switch role.')
    } finally {
      setSwitchingRole(null)
    }
  }

  return (
    <div className="home-account-menu" onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="home-account-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <UserRound size={17} />
        <span>{accountDisplayName(user)}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="home-account-menu-panel" onMouseDown={(event) => event.preventDefault()} role="menu">
          {hasMultipleRoles ? (
            <div className="home-account-role-section" role="group" aria-label="Switch role">
              <span className="home-account-role-label">Role</span>
              {user.roles.map((role) => (
                <button
                  aria-checked={role === user.selected_role}
                  className={role === user.selected_role ? 'home-account-role-button active' : 'home-account-role-button'}
                  disabled={Boolean(switchingRole)}
                  key={role}
                  onClick={() => void handleSwitchRole(role)}
                  role="menuitemradio"
                  type="button"
                >
                  <span>{roleText(role)}</span>
                  {role === user.selected_role ? <Check size={15} /> : null}
                </button>
              ))}
              {roleError ? <div className="home-account-role-error">{roleError}</div> : null}
            </div>
          ) : null}
          {showAdmin && isManagementRole(user.selected_role) ? (
            <a href={ADMIN_MANAGEMENT_ROUTE} role="menuitem">
              <Settings size={16} />
              Portal Admin
            </a>
          ) : null}
          {isManagementRole(user.selected_role) ? (
            testAccess ? (
              <button type="button" role="menuitem" onClick={() => { onStopTestAccess(); setOpen(false) }}>
                <ShieldCheck size={16} />
                Stop viewing as user
              </button>
            ) : (
              <button type="button" role="menuitem" onClick={() => { onStartTestAccess(); setOpen(false) }}>
                <ShieldCheck size={16} />
                View as user
              </button>
            )
          ) : null}
          <a href={ACCOUNT_PROFILE_ROUTE} role="menuitem">
            <UserRound size={16} />
            Profile
          </a>
          {showSignOut ? (
            <button type="button" role="menuitem" onClick={onSignOut}>
              <LogOut size={16} />
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function TestAccessDialog({
  users,
  current,
  loading,
  error,
  onClose,
  onStart,
}: {
  users: PortalUser[]
  current: PortalTestAccess | null
  loading: boolean
  error: string
  onClose: () => void
  onStart: (value: PortalTestAccess) => void
}) {
  const [userId, setUserId] = useState<number | null>(current?.userId ?? null)
  const [role, setRole] = useState<PortalRole>(current?.role ?? 'user')
  const selectedUser = users.find((user) => user.id === userId) ?? null
  const availableRoles = selectedUser?.roles ?? []

  useEffect(() => {
    if (selectedUser && !availableRoles.includes(role)) setRole(availableRoles[0] ?? 'user')
  }, [availableRoles, role, selectedUser])

  return (
    <div className="home-test-access-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="home-test-access-dialog" role="dialog" aria-modal="true" aria-labelledby="test-access-title">
        <div className="home-test-access-title-row">
          <div>
            <span>Access preview</span>
            <h2 id="test-access-title">View as user</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close test access" title="Close">
            <X size={21} />
          </button>
        </div>
        <p>Preview the portal as a real active user. Their team, manager access, direct permissions, and featured resources are used. Changes are disabled.</p>
        <label>
          User
          <select value={userId ?? ''} disabled={loading} onChange={(event) => setUserId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">Select user</option>
            {users.filter((user) => user.is_active).map((user) => (
              <option key={user.id} value={user.id}>
                {user.display_name} - {user.email}{user.team_name ? ` - ${user.team_name}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          User role
          <select value={role} disabled={loading} onChange={(event) => setRole(event.target.value as PortalRole)}>
            {availableRoles.map((availableRole) => <option key={availableRole} value={availableRole}>{roleText(availableRole)}</option>)}
          </select>
        </label>
        {error ? <div className="home-test-access-error">{error}</div> : null}
        <div className="home-test-access-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            disabled={!selectedUser || loading || !availableRoles.includes(role)}
            onClick={() => selectedUser && onStart({ userId: selectedUser.id, displayName: selectedUser.display_name, email: selectedUser.email, role })}
          >
            Start preview
          </button>
        </div>
      </section>
    </div>
  )
}

export default function HomePage({ theme, onThemeChange }: HomePageProps) {
  const desktopRuntime = isDesktopRuntime()
  const [activeCategory, setActiveCategory] = useState<ResourceCategory>('all')
  const activeFeaturedCategory = featuredCategoryForPortalCategory(activeCategory)
  const activeFeaturedCategoryRef = useRef(activeFeaturedCategory)
  activeFeaturedCategoryRef.current = activeFeaturedCategory
  const [searchTerm, setSearchTerm] = useState('')
  const [defaultFeaturedResourcesByCategory, setDefaultFeaturedResourcesByCategory] = useState<PortalFeaturedResourcesByCategory>({})
  const [defaultConfiguredFeaturedCategories, setDefaultConfiguredFeaturedCategories] = useState<PortalFeaturedCategory[]>([])
  const [favoriteResourceIds, setFavoriteResourceIds] = useState<string[]>([])
  const [favoriteBusyResourceId, setFavoriteBusyResourceId] = useState<string | null>(null)
  const [favoritesLoadingTeam, setFavoritesLoadingTeam] = useState(false)
  const [favoritesError, setFavoritesError] = useState('')
  const [accessibleManagedResources, setAccessibleManagedResources] = useState<ManagedPortalResource[]>([])
  const [portalUser, setPortalUser] = useState<PortalUser | null>(() => storedManagementUser())
  const [previewUser, setPreviewUser] = useState<PortalUser | null>(null)
  const [popupResource, setPopupResource] = useState<PortalResource | null>(null)
  const [desktopResourceTabs, setDesktopResourceTabs] = useState<PortalResource[]>([])
  const [activeDesktopResourceId, setActiveDesktopResourceId] = useState<string | null>(null)
  const [testAccess, setTestAccess] = useState<PortalTestAccess | null>(() => storedPortalTestAccess())
  const [testAccessDialogOpen, setTestAccessDialogOpen] = useState(false)
  const [testUsers, setTestUsers] = useState<PortalUser[]>([])
  const [testUsersLoading, setTestUsersLoading] = useState(false)
  const [testUsersError, setTestUsersError] = useState('')

  useEffect(() => {
    // Desktop authentication comes from the current Windows account, so it has
    // no browser token. Keep the web token requirement only for browser runs.
    if (!desktopRuntime && !storedManagementToken()) return
    let cancelled = false

    if (!desktopRuntime && !testAccess) {
      fetchMe()
        .then((meResponse) => {
          if (cancelled) return
          saveManagementUser(meResponse.user)
          setPortalUser(meResponse.user)
        })
        .catch(() => {
          if (cancelled) return
          clearManagementToken()
          setPortalUser(null)
          window.location.replace(PORTAL_LOGIN_ROUTE)
        })
    }

    if (testAccess) {
      fetchMe()
        .then((meResponse) => {
          if (!cancelled) setPreviewUser(meResponse.user)
        })
        .catch(() => {
          if (!cancelled) setPreviewUser(null)
        })
    } else {
      setPreviewUser(null)
    }

    Promise.all([fetchMyResources(), fetchMyFeaturedResources()])
      .then(([resourcesResponse, featuredResponse]) => {
        if (!cancelled) {
          setAccessibleManagedResources(portalCardResourcesFromResponse(resourcesResponse.resources))
          setDefaultFeaturedResourcesByCategory(featuredResponse.default_featured ?? { all: featuredResponse.default_resources ?? [] })
          setDefaultConfiguredFeaturedCategories(
            featuredResponse.default_configured_categories ?? (featuredResponse.default_resources?.length ? ['all'] : []),
          )
        }
      })
      .catch(() => {
        if (cancelled) return
        setAccessibleManagedResources([])
        setDefaultFeaturedResourcesByCategory({})
        setDefaultConfiguredFeaturedCategories([])
      })

    return () => {
      cancelled = true
    }
  }, [desktopRuntime, testAccess?.role, testAccess?.userId])

  useEffect(() => {
    if (!desktopRuntime || testAccess) {
      setFavoriteResourceIds([])
      setFavoritesError('')
      return
    }

    let cancelled = false
    setFavoriteResourceIds([])
    setFavoritesError('')
    fetchMyFavorites(activeFeaturedCategory)
      .then(async (response) => {
        const resolvedResponse = response.total === 0
          ? await loadMyTeamFavoriteSettings(activeFeaturedCategory)
          : response
        if (cancelled) return
        setFavoriteResourceIds(resolvedResponse.favorites.map((favorite) => favorite.resource_id))
        if (resolvedResponse.loaded === false && resolvedResponse.message) setFavoritesError(resolvedResponse.message)
      })
      .catch((favoritesLoadError) => {
        if (cancelled) return
        setFavoriteResourceIds([])
        setFavoritesError(favoritesLoadError instanceof Error ? favoritesLoadError.message : 'Could not load My Favorites.')
      })

    return () => {
      cancelled = true
    }
  }, [activeFeaturedCategory, desktopRuntime, testAccess])

  useEffect(() => {
    if (!popupResource) return

    const previousBodyOverflow = document.body.style.overflow
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPopupResource(null)
    }

    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [popupResource])

  function handlePortalSignOut() {
    clearPortalTestAccess()
    setTestAccess(null)
    setPreviewUser(null)
    clearManagementToken()
    setPortalUser(null)
    setAccessibleManagedResources([])
    setDefaultFeaturedResourcesByCategory({})
    setDefaultConfiguredFeaturedCategories([])
    setFavoriteResourceIds([])
    setFavoritesError('')
    setDesktopResourceTabs([])
    setActiveDesktopResourceId(null)
    window.location.replace(PORTAL_LOGIN_ROUTE)
  }

  function handleOpenResource(resource: PortalResource) {
    if (!storedManagementToken() || !portalUser) {
      clearManagementToken()
      setPopupResource(null)
      window.location.replace(PORTAL_LOGIN_ROUTE)
      return
    }

    if (desktopRuntime) {
      setDesktopResourceTabs((currentTabs) => (currentTabs.some((tab) => tab.id === resource.id) ? currentTabs : [...currentTabs, resource]))
      setActiveDesktopResourceId(resource.id)
      return
    }

    setPopupResource(resource)
  }

  function handleCloseDesktopResource(resourceId: string) {
    const closedIndex = desktopResourceTabs.findIndex((tab) => tab.id === resourceId)
    const nextTabs = desktopResourceTabs.filter((tab) => tab.id !== resourceId)

    setDesktopResourceTabs(nextTabs)
    if (activeDesktopResourceId === resourceId) {
      setActiveDesktopResourceId(nextTabs[Math.max(0, closedIndex - 1)]?.id ?? nextTabs[0]?.id ?? null)
    }
  }

  async function handleToggleFavorite(resource: PortalResource) {
    if (!desktopRuntime || testAccess || !resource.resourceId || favoriteBusyResourceId || favoritesLoadingTeam) return
    const resourceId = resource.resourceId
    const favorite = favoriteResourceIds.includes(resourceId)
    setFavoriteBusyResourceId(resourceId)
    setFavoritesError('')
    const category = activeFeaturedCategory
    try {
      const response = favorite
        ? await removeMyFavorite(resourceId, category)
        : await addMyFavorite(resourceId, category)
      const resolvedResponse = response.total === 0
        ? await loadMyTeamFavoriteSettings(category)
        : response
      if (activeFeaturedCategoryRef.current !== category) return
      setFavoriteResourceIds(resolvedResponse.favorites.map((item) => item.resource_id))
      if (resolvedResponse.loaded === false && resolvedResponse.message) setFavoritesError(resolvedResponse.message)
    } catch (favoriteError) {
      setFavoritesError(favoriteError instanceof Error ? favoriteError.message : 'Could not update My Favorites.')
    } finally {
      setFavoriteBusyResourceId(null)
    }
  }

  async function handleLoadTeamFavoriteSettings() {
    if (!desktopRuntime || testAccess || favoritesLoadingTeam || favoriteBusyResourceId) return
    if (
      favoriteResourceIds.length > 0 &&
      !window.confirm(`Replace My Favorites for ${CATEGORY_OPTIONS.find((option) => option.key === activeCategory)?.label ?? 'this category'} with the current team settings?`)
    ) {
      return
    }
    setFavoritesLoadingTeam(true)
    setFavoritesError('')
    const category = activeFeaturedCategory
    try {
      const response = await loadMyTeamFavoriteSettings(category)
      if (activeFeaturedCategoryRef.current !== category) return
      setFavoriteResourceIds(response.favorites.map((item) => item.resource_id))
      if (!response.loaded && response.message) setFavoritesError(response.message)
    } catch (favoriteError) {
      setFavoritesError(favoriteError instanceof Error ? favoriteError.message : 'Could not load team settings.')
    } finally {
      setFavoritesLoadingTeam(false)
    }
  }

  async function handlePortalRoleSwitch(role: PortalRole) {
    clearPortalTestAccess()
    setTestAccess(null)
    setPreviewUser(null)
    setDesktopResourceTabs([])
    setActiveDesktopResourceId(null)
    const response = await switchRole(role)
    saveManagementToken(response.token, role)
    const switchedUser = { ...response.user, selected_role: role }
    saveManagementUser(switchedUser)
    setPortalUser(switchedUser)

    try {
      const [resourcesResponse, featuredResponse] = await Promise.all([
        fetchMyResources(response.token),
        fetchMyFeaturedResources(response.token),
      ])
      const refreshedUser = switchedUser
      saveManagementUser(refreshedUser)
      setPortalUser(refreshedUser)
      setAccessibleManagedResources(portalCardResourcesFromResponse(resourcesResponse.resources))
      setDefaultFeaturedResourcesByCategory(featuredResponse.default_featured ?? { all: featuredResponse.default_resources ?? [] })
      setDefaultConfiguredFeaturedCategories(
        featuredResponse.default_configured_categories ?? (featuredResponse.default_resources?.length ? ['all'] : []),
      )
    } catch {
      saveManagementUser(switchedUser)
      setPortalUser(switchedUser)
      setAccessibleManagedResources([])
      setDefaultFeaturedResourcesByCategory({})
      setDefaultConfiguredFeaturedCategories([])
    }
  }

  function handleOpenTestAccess() {
    if (!portalUser || !isManagementRole(portalUser.selected_role)) return
    setTestAccessDialogOpen(true)
    setTestUsersError('')
    if (testUsers.length || testUsersLoading) return
    setTestUsersLoading(true)
    fetchUsers()
      .then((response) => setTestUsers(response.users.filter((user) => user.is_active)))
      .catch((error) => setTestUsersError(error instanceof Error ? error.message : 'Could not load portal users.'))
      .finally(() => setTestUsersLoading(false))
  }

  function handleStartTestAccess(value: PortalTestAccess) {
    savePortalTestAccess(value)
    setTestAccess(value)
    setPreviewUser(null)
    setDesktopResourceTabs([])
    setActiveDesktopResourceId(null)
    setTestAccessDialogOpen(false)
  }

  function handleStopTestAccess() {
    clearPortalTestAccess()
    setTestAccess(null)
    setPreviewUser(null)
    setDesktopResourceTabs([])
    setActiveDesktopResourceId(null)
  }

  const catalogResources = useMemo(() => DASHBOARD_CATALOG.map(catalogResource), [])
  const dashboardResources = useMemo(() => [...CRITICAL_ASSET_RESOURCES, ...CRITICAL_TEAM_RESOURCES], [])
  const baseResources = useMemo(
    () => mergeResources([...dashboardResources, ...catalogResources]),
    [catalogResources, dashboardResources],
  )
  const managedCardResources = useMemo(
    () => accessibleManagedResources.filter(isPortalCardResource).map((resource) => managedResourceCard(resource, baseResources)),
    [accessibleManagedResources, baseResources],
  )
  const allResources = useMemo(
    () => mergeResources(managedCardResources),
    [managedCardResources],
  )
  const availableResourceKeys = useMemo(() => new Set(allResources.map((resource) => resource.id)), [allResources])
  const favoriteResourceIdSet = useMemo(() => new Set(favoriteResourceIds), [favoriteResourceIds])
  const visibleCategoryOptions = useMemo(
    () =>
      CATEGORY_OPTIONS.filter((option) =>
        option.key === 'all'
          ? allResources.length > 0
          : allResources.some((resource) => resource.category === option.key),
      ),
    [allResources],
  )

  useEffect(() => {
    if (!visibleCategoryOptions.length) {
      if (activeCategory !== 'all') setActiveCategory('all')
      return
    }
    if (!visibleCategoryOptions.some((option) => option.key === activeCategory)) {
      setActiveCategory(visibleCategoryOptions[0].key)
    }
  }, [activeCategory, visibleCategoryOptions])

  const filteredResources = useMemo(
    () => orderAllResources(allResources.filter((resource) => resourceMatches(resource, activeCategory, searchTerm)), activeCategory),
    [activeCategory, allResources, searchTerm],
  )
  const favoriteResources = useMemo(() => {
    const resourcesById = new Map(
      allResources
        .filter((resource) => resource.resourceId)
        .map((resource) => [resource.resourceId as string, resource]),
    )
    return favoriteResourceIds
      .map((resourceId) => resourcesById.get(resourceId))
      .filter((resource): resource is PortalResource => Boolean(resource))
      .filter((resource) => resourceMatches(resource, activeCategory, searchTerm))
  }, [activeCategory, allResources, favoriteResourceIds, searchTerm])
  const hasExplicitTeamDefaultFeaturedCategory = defaultConfiguredFeaturedCategories.includes(activeFeaturedCategory)
  const hasComposedTeamDefaultForAll =
    activeFeaturedCategory === 'all' &&
    !hasExplicitTeamDefaultFeaturedCategory &&
    FEATURED_CATEGORY_COMPOSE_ORDER.some((category) => defaultConfiguredFeaturedCategories.includes(category))
  const hasTeamDefaultFeaturedCategory = hasExplicitTeamDefaultFeaturedCategory || hasComposedTeamDefaultForAll
  const teamDefaultFeaturedResources = useMemo(() => {
    if (!hasTeamDefaultFeaturedCategory) return []
    const defaultResources =
      activeFeaturedCategory === 'all' && !hasExplicitTeamDefaultFeaturedCategory
        ? composeAllFeaturedResources(defaultFeaturedResourcesByCategory)
        : defaultFeaturedResourcesByCategory[activeFeaturedCategory]
    return featuredResourcesForDisplay(defaultResources, allResources, availableResourceKeys, activeCategory, searchTerm)
  }, [
    activeCategory,
    activeFeaturedCategory,
    allResources,
    availableResourceKeys,
    defaultFeaturedResourcesByCategory,
    hasExplicitTeamDefaultFeaturedCategory,
    hasTeamDefaultFeaturedCategory,
    searchTerm,
  ])
  const featuredResourceMatches = useMemo(
    () => {
      if (hasTeamDefaultFeaturedCategory) return teamDefaultFeaturedResources
      return orderFeaturedResources(
        allResources.filter((resource) => resourceMatches(resource, activeCategory, searchTerm)),
        activeCategory,
      )
    },
    [
      activeCategory,
      allResources,
      hasTeamDefaultFeaturedCategory,
      searchTerm,
      teamDefaultFeaturedResources,
    ],
  )
  const featuredResources = useMemo(() => featuredResourceMatches.slice(0, 4), [featuredResourceMatches])

  return (
    <main className="home-page">
      <header className="home-header">
        <div className="home-nav-row">
          <a
            className="home-brand"
            href="/"
            aria-label="Storm Water Asset Intelligence Portal"
            onClick={(event) => {
              if (!desktopRuntime) return
              event.preventDefault()
              setActiveDesktopResourceId(null)
            }}
          >
            <span className="home-logo-mark">
              <img src={stormwaterLogo} alt="" />
            </span>
          </a>

          <strong className="home-desktop-app-title">Storm Water Asset Intelligence Portal</strong>

          <div className="home-utility-nav" aria-label="Portal utilities">
            {portalUser ? (
              <AccountMenu
                user={portalUser}
                showAdmin={!desktopRuntime}
                showSignOut={!desktopRuntime}
                testAccess={testAccess}
                onSignOut={handlePortalSignOut}
                onSwitchRole={handlePortalRoleSwitch}
                onStartTestAccess={handleOpenTestAccess}
                onStopTestAccess={handleStopTestAccess}
              />
            ) : desktopRuntime ? null : (
              <a href={PORTAL_LOGIN_ROUTE}>
                <LogIn size={17} />
                Sign in
              </a>
            )}
            {!desktopRuntime ? (
              <ThemeToggle placement="inline" theme={theme} onThemeChange={onThemeChange} />
            ) : null}
          </div>
        </div>
      </header>

      {desktopRuntime ? (
        <DesktopResourceTabs
          tabs={desktopResourceTabs}
          activeResourceId={activeDesktopResourceId}
          onActivateHome={() => setActiveDesktopResourceId(null)}
          onActivateResource={setActiveDesktopResourceId}
          onCloseResource={handleCloseDesktopResource}
        />
      ) : null}

      {testAccess ? (
        <section className="home-test-access-banner" aria-label="Test access is active">
          <ShieldCheck size={18} />
          <span>Viewing as <strong>{previewUser?.display_name ?? testAccess.displayName}</strong> ({roleText(testAccess.role)}). Changes are disabled.</span>
          <button type="button" onClick={handleStopTestAccess}>Stop preview</button>
        </section>
      ) : null}

      <div className={`desktop-home-content ${desktopRuntime && activeDesktopResourceId ? 'is-hidden' : ''}`}>
      <section className="home-catalog-controls" aria-label="Portal resources">
        <nav className="home-category-nav" aria-label="Resource categories">
          {visibleCategoryOptions.map((option) => (
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
            placeholder="Search resources"
            type="search"
          />
        </label>
      </section>

      <section className="home-featured">
        {desktopRuntime && !testAccess ? (
          <section className="home-favorites-section" aria-labelledby="my-favorites-heading">
            <div className="home-featured-heading compact">
              <div className="home-favorites-title-row">
                <h2 id="my-favorites-heading">My Favorites</h2>
                <button
                  className="home-load-team-favorites"
                  type="button"
                  disabled={favoritesLoadingTeam || Boolean(favoriteBusyResourceId)}
                  onClick={handleLoadTeamFavoriteSettings}
                >
                  {favoritesLoadingTeam ? 'Loading team settings…' : 'Load team settings'}
                </button>
              </div>
              <p>{favoriteResources.length.toLocaleString()} {favoriteResources.length === 1 ? 'Resource' : 'Resources'} found</p>
            </div>

            {favoritesError ? <p className="home-favorites-error" role="alert">{favoritesError}</p> : null}

            {favoriteResources.length ? (
              <div className="home-resource-grid">
                {favoriteResources.map((resource) => (
                  <ResourceCard
                    key={`favorite-${resource.id}`}
                    resource={resource}
                    theme={theme}
                    onOpen={handleOpenResource}
                    favorite
                    favoriteBusy={favoriteBusyResourceId === resource.resourceId}
                    onToggleFavorite={handleToggleFavorite}
                  />
                ))}
              </div>
            ) : (
              <div className="home-favorites-empty">
                <Star size={22} />
                <span>Select the star on any resource to add it here.</span>
              </div>
            )}
          </section>
        ) : null}

        <section className="home-team-featured" aria-labelledby="team-featured-heading">
        <div className="home-featured-heading">
          <h2 id="team-featured-heading">Team Featured</h2>
          <p>
            {featuredResources.length.toLocaleString()} {featuredResources.length === 1 ? 'Resource' : 'Resources'} found
          </p>
        </div>

        {featuredResources.length ? (
          <div className="home-resource-grid">
            {featuredResources.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                theme={theme}
                onOpen={handleOpenResource}
                favorite={Boolean(resource.resourceId && favoriteResourceIdSet.has(resource.resourceId))}
                favoriteBusy={favoriteBusyResourceId === resource.resourceId}
                onToggleFavorite={desktopRuntime && !testAccess ? handleToggleFavorite : undefined}
              />
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
        </section>

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
              <ResourceCard
                key={`all-${resource.id}`}
                resource={resource}
                theme={theme}
                onOpen={handleOpenResource}
                favorite={Boolean(resource.resourceId && favoriteResourceIdSet.has(resource.resourceId))}
                favoriteBusy={favoriteBusyResourceId === resource.resourceId}
                onToggleFavorite={desktopRuntime && !testAccess ? handleToggleFavorite : undefined}
              />
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
      </div>
      {desktopRuntime ? (
        <DesktopResourceWorkspace
          tabs={desktopResourceTabs}
          activeResourceId={activeDesktopResourceId}
          user={previewUser ?? portalUser}
          testAccess={testAccess}
        />
      ) : popupResource ? (
        <ResourcePopup resource={popupResource} user={previewUser ?? portalUser} testAccess={testAccess} onClose={() => setPopupResource(null)} />
      ) : null}
      {testAccessDialogOpen ? (
        <TestAccessDialog
          users={testUsers}
          current={testAccess}
          loading={testUsersLoading}
          error={testUsersError}
          onClose={() => setTestAccessDialogOpen(false)}
          onStart={handleStartTestAccess}
        />
      ) : null}
    </main>
  )
}
