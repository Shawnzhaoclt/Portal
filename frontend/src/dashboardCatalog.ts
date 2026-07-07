export type DashboardCatalogItem = {
  id: string
  title: string
  description: string
  path: string
  category: 'Operations' | 'Planning' | 'Risk' | 'Maps'
  kind: 'dashboard' | 'map' | 'tab' | 'doc' | 'report'
}

export const DASHBOARD_LINKS_ROUTE = '/dashboard_links'
export const PROACTIVE_TEAM_CCTV_REVIEW_ROUTE = '/dashboard_proactive_team_cctv_review'
export const AMTEAM_INSPECTION_VIEWER_ROUTE = '/dashboard_amteam_inspection_viewer'
export const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'
export const CRITICAL_ASSET_TRACKING_ROUTE = '/dashboard_critical_asset_tracking'
export const GIS_FACILITY_ROUTE = '/map_critical_asset_facility'
export const GIS_HISTORY_ROUTE = '/map_critical_asset_history'
export const STM_RISK_MAP_ROUTE = '/map_stm_risk'
export const PLANNING_PENDING_AIF_QA_ROUTE = '/tab_planning_pending_aif_qa'
export const ADMIN_MANAGEMENT_ROUTE = '/admin_management'
export const PORTAL_LOGIN_ROUTE = '/login'

export const CRITICAL_TEAM_SHEET_ROUTES = {
  overview: '/dashboard_critical_team_overview',
  'insp-proj-start-date': '/dashboard_critical_team_inspection_project_start_date',
  'insp-comp-date-bar-chart': '/dashboard_critical_team_inspection_completion_date_chart',
  'report-comp-date-chart': '/dashboard_critical_team_report_completion_date_chart',
  'insp-comp-date-reviews': '/dashboard_critical_team_inspection_completion_date_reviews',
  'insp-comp-date-table': '/tab_critical_team_inspection_completion_date',
  'report-comp-date-table': '/tab_critical_team_report_completion_date',
  'insp-comp-date-reviews-table': '/tab_critical_team_review_completion_date',
  workorders: '/tab_critical_team_work_order_detail',
} as const

export const CRITICAL_ASSET_SHEET_ROUTES = {
  'condition-facility-aggregate-both': '/dashboard_critical_asset_condition_facility_aggregate_both',
  'clog-facility-aggregate-pipes': '/dashboard_critical_asset_clog_facility_aggregate_pipes',
  'history-table-both': '/tab_critical_asset_history_both',
} as const

export type CriticalTeamSheetId = keyof typeof CRITICAL_TEAM_SHEET_ROUTES
export type CriticalAssetSheetId = keyof typeof CRITICAL_ASSET_SHEET_ROUTES

const CRITICAL_TEAM_PATH_TO_SHEET_ID = Object.fromEntries(
  Object.entries(CRITICAL_TEAM_SHEET_ROUTES).map(([sheetId, path]) => [path, sheetId]),
) as Record<string, CriticalTeamSheetId>

const CRITICAL_ASSET_PATH_TO_SHEET_ID = Object.fromEntries(
  Object.entries(CRITICAL_ASSET_SHEET_ROUTES).map(([sheetId, path]) => [path, sheetId]),
) as Record<string, CriticalAssetSheetId>

export function criticalTeamSheetPath(sheetId: string) {
  return CRITICAL_TEAM_SHEET_ROUTES[sheetId as CriticalTeamSheetId] ?? CRITICAL_TEAM_ROUTE
}

export function criticalTeamSheetIdFromPath(path: string) {
  return CRITICAL_TEAM_PATH_TO_SHEET_ID[path] ?? null
}

export function criticalAssetSheetPath(sheetId: string) {
  return CRITICAL_ASSET_SHEET_ROUTES[sheetId as CriticalAssetSheetId] ?? CRITICAL_ASSET_TRACKING_ROUTE
}

export function criticalAssetSheetIdFromPath(path: string) {
  return CRITICAL_ASSET_PATH_TO_SHEET_ID[path] ?? null
}

export const DASHBOARD_CATALOG: DashboardCatalogItem[] = [
  {
    id: 'proactive_team_cctv_review',
    title: 'Proactive Team CCTV Review',
    description: 'Search CCTV pipe records, choose inspections, and compile proactive team review reports with defects and media.',
    path: PROACTIVE_TEAM_CCTV_REVIEW_ROUTE,
    category: 'Operations',
    kind: 'report',
  },
  {
    id: 'amteam_inspection_viewer',
    title: 'Proactive Team CCTV Review Report',
    description: 'Search CCTV pipe records, choose inspections, and compile review reports with defects and media.',
    path: AMTEAM_INSPECTION_VIEWER_ROUTE,
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team',
    title: 'Critical Team Dashboard',
    description: 'Work order status, milestone trends, and critical team inspection details.',
    path: CRITICAL_TEAM_ROUTE,
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_overview',
    title: 'Critical Team Overview',
    description: 'Cityworks Critical Asset Inspection work-order source and completion summary.',
    path: CRITICAL_TEAM_SHEET_ROUTES.overview,
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_inspection_project_start_date',
    title: 'Inspection Project Start Date',
    description: 'Count of inspection work orders by project start month and assigned submitter.',
    path: CRITICAL_TEAM_SHEET_ROUTES['insp-proj-start-date'],
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_inspection_completion_date_chart',
    title: 'Inspection Completion Date Chart',
    description: 'Inspection completion date counts grouped by submitter.',
    path: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-bar-chart'],
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_report_completion_date_chart',
    title: 'Report Completion Date Chart',
    description: 'Report completion date counts grouped by submitter.',
    path: CRITICAL_TEAM_SHEET_ROUTES['report-comp-date-chart'],
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_inspection_completion_date_reviews',
    title: 'Inspection Completion Date Reviews',
    description: 'Ready-for-review and review-complete work orders by closed date and reviewer.',
    path: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-reviews'],
    category: 'Operations',
    kind: 'dashboard',
  },
  {
    id: 'critical_team_inspection_completion_date',
    title: 'Inspection Completion Date',
    description: 'Inspection completion date cross-tab by submitter.',
    path: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-table'],
    category: 'Operations',
    kind: 'tab',
  },
  {
    id: 'critical_team_report_completion_date',
    title: 'Report Completion Date',
    description: 'Report completion date cross-tab by submitter.',
    path: CRITICAL_TEAM_SHEET_ROUTES['report-comp-date-table'],
    category: 'Operations',
    kind: 'tab',
  },
  {
    id: 'critical_team_review_completion_date',
    title: 'Review Completion Date',
    description: 'Review-complete cross-tab by reviewer and closed month.',
    path: CRITICAL_TEAM_SHEET_ROUTES['insp-comp-date-reviews-table'],
    category: 'Operations',
    kind: 'tab',
  },
  {
    id: 'critical_team_work_order_detail',
    title: 'Work Order Detail',
    description: 'Operational detail rows from the Cityworks Critical Asset Inspection source.',
    path: CRITICAL_TEAM_SHEET_ROUTES.workorders,
    category: 'Operations',
    kind: 'tab',
  },
  {
    id: 'planning_pending_aif_qa',
    title: 'Planning Pending AIF QA/QC',
    description: 'Pending Asset Inspection Form records for planning team QA/QC review.',
    path: PLANNING_PENDING_AIF_QA_ROUTE,
    category: 'Planning',
    kind: 'tab',
  },
  {
    id: 'critical_asset_tracking',
    title: 'Critical Asset Tracking',
    description: 'Risk assessment tables and facility aggregate views for tracked critical assets.',
    path: CRITICAL_ASSET_TRACKING_ROUTE,
    category: 'Risk',
    kind: 'dashboard',
  },
  {
    id: 'critical_asset_condition_facility_aggregate_both',
    title: 'Condition Risk Facility Aggregate - Both',
    description: 'Condition risk summarized by facility across pipes and structures.',
    path: CRITICAL_ASSET_SHEET_ROUTES['condition-facility-aggregate-both'],
    category: 'Risk',
    kind: 'dashboard',
  },
  {
    id: 'critical_asset_clog_facility_aggregate_pipes',
    title: 'Clog Risk Facility Aggregate - Pipes',
    description: 'Clog risk summarized by facility for pipe assets.',
    path: CRITICAL_ASSET_SHEET_ROUTES['clog-facility-aggregate-pipes'],
    category: 'Risk',
    kind: 'dashboard',
  },
  {
    id: 'critical_asset_history_both',
    title: 'History - Both',
    description: 'Paged, sortable inspection history across pipes and structures.',
    path: CRITICAL_ASSET_SHEET_ROUTES['history-table-both'],
    category: 'Risk',
    kind: 'tab',
  },
  {
    id: 'gis_critical_asset_facility',
    title: 'Critical Asset Facility',
    description: 'Spatial view of culvert facilities, pipes, structures, and current risk values.',
    path: GIS_FACILITY_ROUTE,
    category: 'Maps',
    kind: 'map',
  },
  {
    id: 'gis_critical_asset_history',
    title: 'Critical Asset History',
    description: 'Spatial view focused on assets with multiple inspections and risk changes over time.',
    path: GIS_HISTORY_ROUTE,
    category: 'Maps',
    kind: 'map',
  },
  {
    id: 'stm_risk_map',
    title: 'Storm Water Asset Risk Map',
    description: 'MapLibre PMTiles viewer for planning-team risk layers, asset search, inventory metrics, and risk summaries.',
    path: STM_RISK_MAP_ROUTE,
    category: 'Maps',
    kind: 'map',
  },
]

export function dashboardUrl(path: string) {
  if (typeof window === 'undefined') {
    return path
  }
  return `${window.location.origin}${path}`
}

export function dashboardEmbedUrl(path: string) {
  return `${dashboardUrl(path)}?embed=1`
}
