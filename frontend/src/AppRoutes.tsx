import CriticalAssetTrackingDashboard from './dashboards/critical-assets/CriticalAssetTrackingDashboard'
import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'
import GISCriticalAssetHistoryDashboard from './dashboards/gis/GISCriticalAssetHistoryDashboard'
import GISDashboard from './dashboards/gis/GISDashboard'

const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'
const CRITICAL_ASSET_TRACKING_ROUTE = '/dashboard_critical_asset_tracking'
const GIS_ROUTE = '/dashboard_gis_critical_asset_facility'
const GIS_HISTORY_ROUTE = '/dashboard_gis_critical_asset_history'

function setPageMeta(title: string, faviconHref = '/favicon.svg') {
  document.title = title
  const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (iconLink && iconLink.href !== faviconHref) {
    iconLink.href = faviconHref
  }
}

export default function AppRoutes() {
  const path = window.location.pathname

  if (path === '/') {
    window.history.replaceState(null, '', CRITICAL_TEAM_ROUTE)
    setPageMeta('Critical Team Dashboard')
    return <CriticalTeamDashboard />
  }

  if (path === CRITICAL_ASSET_TRACKING_ROUTE) {
    setPageMeta('Critical Asset Tracking')
    return <CriticalAssetTrackingDashboard />
  }

  if (path === GIS_ROUTE) {
    setPageMeta('Critical Asset Facility', '/map-favicon.svg')
    return <GISDashboard />
  }

  if (path === GIS_HISTORY_ROUTE) {
    setPageMeta('Critical Asset History', '/map-favicon.svg')
    return <GISCriticalAssetHistoryDashboard />
  }

  setPageMeta('Critical Team Dashboard')
  return <CriticalTeamDashboard />
}
