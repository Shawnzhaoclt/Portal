export type DashboardCatalogItem = {
  resource_id: string
  id: string
  title: string
  description: string
  path: string
  helpUrl?: string
  category: 'Operations' | 'Planning' | 'Risk' | 'Maps'
  kind: 'dashboard' | 'map' | 'tab' | 'doc' | 'report' | 'form'
}

export type ResourcePresentation = {
  thumbnail_light?: string
  thumbnail_dark?: string
}

type ResourceMetadataItem = {
  resource_id: string
  resource_slug: string
  type: DashboardCatalogItem['kind'] | 'dataset' | 'service' | 'admin' | 'api'
  name: string
  url: string
  help_url?: string
  category: DashboardCatalogItem['category']
  description?: string
  show_in_catalog?: boolean
  presentation?: ResourcePresentation
}

type ResourceMetadataModule = {
  default: ResourceMetadataItem
}

const resourceMetadataModules = import.meta.glob('./resources/**/resource.json', { eager: true }) as Record<string, ResourceMetadataModule>
const RESOURCE_METADATA = Object.values(resourceMetadataModules)
  .map((module) => module.default)
  .sort((left, right) => left.resource_slug.localeCompare(right.resource_slug))

export const RESOURCE_PRESENTATION_BY_KEY = Object.fromEntries(
  RESOURCE_METADATA.map((resource) => [resource.resource_slug, resource.presentation]),
) as Record<string, ResourcePresentation | undefined>

export const DASHBOARD_LINKS_ROUTE = '/dashboard_links'
export const PROACTIVE_TEAM_CCTV_REVIEW_ROUTE = '/report_proactive_team_cctv_review'
export const PROACTIVE_TEAM_CCTV_REVIEW_HELP_ROUTE = '/help_proactive_team_cctv_review'
export const CREATE_AIF_FROM_ITPIPES_ROUTE = '/form_create_aif_from_itpipes'
export const WEEKLY_TIME_REPORTING_ROUTE = '/report_weekly_time_reporting'
export const AIF_OVERVIEW_ROUTE = '/dashboard_aif_overview'
export const CRITICAL_ASSET_TRACKING_ROUTE = '/dashboard_critical_asset_tracking'
export const GIS_FACILITY_ROUTE = '/map_critical_asset_facility'
export const GIS_HISTORY_ROUTE = '/map_critical_asset_history'
export const STM_RISK_MAP_ROUTE = '/map_stm_risk'
export const STORM_WATER_ASSET_HISTORY_ROUTE = '/asset-history'
export const PLANNING_PENDING_AIF_QA_ROUTE = '/tab_planning_pending_aif_qa'
export const ADMIN_MANAGEMENT_ROUTE = '/admin_management'
export const ACCOUNT_ROUTE = '/account'
export const PORTAL_LOGIN_ROUTE = '/login'
export const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'
export const CRITICAL_TEAM_TABLES_ROUTE = '/tab_critical_team'

export const CRITICAL_TEAM_SHEET_ROUTES = {
  overview: CRITICAL_TEAM_ROUTE,
  'insp-proj-start-date': CRITICAL_TEAM_ROUTE,
  'insp-comp-date-bar-chart': CRITICAL_TEAM_ROUTE,
  'report-comp-date-chart': CRITICAL_TEAM_ROUTE,
  'insp-comp-date-reviews': CRITICAL_TEAM_ROUTE,
  'insp-comp-date-table': CRITICAL_TEAM_TABLES_ROUTE,
  'report-comp-date-table': CRITICAL_TEAM_TABLES_ROUTE,
  'insp-comp-date-reviews-table': CRITICAL_TEAM_TABLES_ROUTE,
  workorders: CRITICAL_TEAM_TABLES_ROUTE,
} as const

export const CRITICAL_ASSET_SHEET_ROUTES = {
  'condition-facility-aggregate-both': '/dashboard_critical_asset_condition_facility_aggregate_both',
  'clog-facility-aggregate-pipes': '/dashboard_critical_asset_clog_facility_aggregate_pipes',
  'history-table-both': '/tab_critical_asset_history_both',
} as const

export type CriticalTeamSheetId = keyof typeof CRITICAL_TEAM_SHEET_ROUTES
export type CriticalAssetSheetId = keyof typeof CRITICAL_ASSET_SHEET_ROUTES

const CRITICAL_TEAM_LEGACY_PATH_TO_SHEET_ID: Record<string, CriticalTeamSheetId> = {
  '/dashboard_critical_team_overview': 'overview',
  '/dashboard_critical_team_inspection_project_start_date': 'insp-proj-start-date',
  '/dashboard_critical_team_inspection_completion_date_chart': 'insp-comp-date-bar-chart',
  '/dashboard_critical_team_report_completion_date_chart': 'report-comp-date-chart',
  '/dashboard_critical_team_inspection_completion_date_reviews': 'insp-comp-date-reviews',
  '/tab_critical_team_inspection_completion_date': 'insp-comp-date-table',
  '/tab_critical_team_report_completion_date': 'report-comp-date-table',
  '/tab_critical_team_review_completion_date': 'insp-comp-date-reviews-table',
  '/tab_critical_team_work_order_detail': 'workorders',
}

const CRITICAL_ASSET_PATH_TO_SHEET_ID = Object.fromEntries(
  Object.entries(CRITICAL_ASSET_SHEET_ROUTES).map(([sheetId, path]) => [path, sheetId]),
) as Record<string, CriticalAssetSheetId>

export function criticalTeamSheetPath(sheetId: string) {
  return CRITICAL_TEAM_SHEET_ROUTES[sheetId as CriticalTeamSheetId] ?? CRITICAL_TEAM_SHEET_ROUTES.overview
}

export function criticalTeamSheetIdFromPath(path: string) {
  if (path === CRITICAL_TEAM_ROUTE) return 'overview'
  if (path === CRITICAL_TEAM_TABLES_ROUTE) return 'workorders'
  return CRITICAL_TEAM_LEGACY_PATH_TO_SHEET_ID[path] ?? null
}

export function criticalAssetSheetPath(sheetId: string) {
  return CRITICAL_ASSET_SHEET_ROUTES[sheetId as CriticalAssetSheetId] ?? CRITICAL_ASSET_TRACKING_ROUTE
}

export function criticalAssetSheetIdFromPath(path: string) {
  return CRITICAL_ASSET_PATH_TO_SHEET_ID[path] ?? null
}

export const DASHBOARD_CATALOG: DashboardCatalogItem[] = RESOURCE_METADATA
  .filter((resource) => resource.show_in_catalog !== false)
  .filter((resource): resource is ResourceMetadataItem & { type: DashboardCatalogItem['kind'] } =>
    ['dashboard', 'map', 'tab', 'doc', 'report', 'form'].includes(resource.type),
  )
  .map((resource) => ({
    resource_id: resource.resource_id,
    id: resource.resource_slug,
    title: resource.name,
    description: resource.description ?? '',
    path: resource.url,
    helpUrl: resource.help_url,
    category: resource.category,
    kind: resource.type,
  }))

export function dashboardUrl(path: string) {
  if (typeof window === 'undefined') {
    return path
  }
  return `${window.location.origin}${path}`
}

export function dashboardEmbedUrl(path: string) {
  return `${dashboardUrl(path)}?embed=1`
}
