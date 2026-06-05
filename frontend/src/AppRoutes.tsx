import CriticalAssetTrackingDashboard from './dashboards/critical-assets/CriticalAssetTrackingDashboard'
import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'
import GISCriticalAssetHistoryDashboard from './dashboards/gis/GISCriticalAssetHistoryDashboard'
import GISDashboard from './dashboards/gis/GISDashboard'

const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'
const CRITICAL_ASSET_TRACKING_ROUTE = '/dashboard_critical_asset_tracking'
const GIS_ROUTE = '/dashboard_gis_critical_asset_facility'
const GIS_HISTORY_ROUTE = '/dashboard_gis_critical_asset_history'

export default function AppRoutes() {
  const path = window.location.pathname

  if (path === '/') {
    window.history.replaceState(null, '', CRITICAL_TEAM_ROUTE)
  }

  if (path === CRITICAL_ASSET_TRACKING_ROUTE) {
    return <CriticalAssetTrackingDashboard />
  }

  if (path === GIS_ROUTE) {
    return <GISDashboard />
  }

  if (path === GIS_HISTORY_ROUTE) {
    return <GISCriticalAssetHistoryDashboard />
  }

  return <CriticalTeamDashboard />
}
