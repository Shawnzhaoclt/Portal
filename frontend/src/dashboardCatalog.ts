export type DashboardCatalogItem = {
  id: string
  title: string
  description: string
  path: string
  category: 'Operations' | 'Risk' | 'Maps'
}

export const DASHBOARD_LINKS_ROUTE = '/dashboard_links'
export const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'
export const CRITICAL_ASSET_TRACKING_ROUTE = '/dashboard_critical_asset_tracking'
export const GIS_FACILITY_ROUTE = '/dashboard_gis_critical_asset_facility'
export const GIS_HISTORY_ROUTE = '/dashboard_gis_critical_asset_history'

export const DASHBOARD_CATALOG: DashboardCatalogItem[] = [
  {
    id: 'critical_team',
    title: 'Critical Team Dashboard',
    description: 'Work order status, milestone trends, and critical team inspection details.',
    path: CRITICAL_TEAM_ROUTE,
    category: 'Operations',
  },
  {
    id: 'critical_asset_tracking',
    title: 'Critical Asset Tracking',
    description: 'Risk assessment tables and facility aggregate views for tracked critical assets.',
    path: CRITICAL_ASSET_TRACKING_ROUTE,
    category: 'Risk',
  },
  {
    id: 'gis_critical_asset_facility',
    title: 'Critical Asset Facility',
    description: 'Spatial view of culvert facilities, pipes, structures, and current risk values.',
    path: GIS_FACILITY_ROUTE,
    category: 'Maps',
  },
  {
    id: 'gis_critical_asset_history',
    title: 'Critical Asset History',
    description: 'Spatial view focused on assets with multiple inspections and risk changes over time.',
    path: GIS_HISTORY_ROUTE,
    category: 'Maps',
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
