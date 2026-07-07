import { useEffect, useState } from 'react'
import DashboardLinksPage from './DashboardLinksPage'
import HomePage from './HomePage'
import AMTeamInspectionViewer from './dashboards/amteam/AMTeamInspectionViewer'
import ProactiveTeamCCTVReview from './dashboards/amteam/ProactiveTeamCCTVReview'
import CriticalAssetTrackingDashboard from './dashboards/critical-assets/CriticalAssetTrackingDashboard'
import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'
import GISCriticalAssetHistoryDashboard from './dashboards/gis/GISCriticalAssetHistoryDashboard'
import GISDashboard from './dashboards/gis/GISDashboard'
import ManagementPage from './management/ManagementPage'
import PlanningPendingAifQaTable from './dashboards/planning/PlanningPendingAifQaTable'
import MapTilesDashboard from './resources/maps/stm-risk-map/MapTilesDashboard'
import { storedManagementToken } from './management/api'
import {
  ADMIN_MANAGEMENT_ROUTE,
  CRITICAL_ASSET_TRACKING_ROUTE,
  AMTEAM_INSPECTION_VIEWER_ROUTE,
  CRITICAL_TEAM_ROUTE,
  DASHBOARD_LINKS_ROUTE,
  GIS_FACILITY_ROUTE,
  GIS_HISTORY_ROUTE,
  PORTAL_LOGIN_ROUTE,
  PLANNING_PENDING_AIF_QA_ROUTE,
  PROACTIVE_TEAM_CCTV_REVIEW_ROUTE,
  STM_RISK_MAP_ROUTE,
  criticalAssetSheetIdFromPath,
  criticalTeamSheetIdFromPath,
} from './dashboardCatalog'
import { applyAppTheme, getInitialTheme, type AppTheme } from './theme'

function setPageMeta(title: string, faviconHref = '/favicon.svg') {
  document.title = title
  const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (iconLink && iconLink.href !== faviconHref) {
    iconLink.href = faviconHref
  }
}

function getRouteTheme(): AppTheme | null {
  const requestedTheme = new URLSearchParams(window.location.search).get('theme')
  if (requestedTheme === 'dark' || requestedTheme === 'light') return requestedTheme
  return null
}

export default function AppRoutes() {
  const [theme, setTheme] = useState<AppTheme>(() => getRouteTheme() ?? getInitialTheme())
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  const embedMode = params.get('embed') === '1' || params.get('embedded') === '1'
  const isLoginRoute = path === PORTAL_LOGIN_ROUTE || path === '/management_login'

  useEffect(() => {
    applyAppTheme(theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('dashboard-embed-mode', embedMode)
    return () => document.documentElement.classList.remove('dashboard-embed-mode')
  }, [embedMode])

  if (!isLoginRoute && !storedManagementToken()) {
    setPageMeta('Portal Sign In')
    window.location.replace(PORTAL_LOGIN_ROUTE)
    return null
  }

  if (path === '/') {
    setPageMeta('Storm Water Asset Intelligence Portal')
    return <HomePage theme={theme} onThemeChange={setTheme} />
  }

  const criticalAssetSheetId = criticalAssetSheetIdFromPath(path)
  if (path === CRITICAL_ASSET_TRACKING_ROUTE || criticalAssetSheetId) {
    setPageMeta('Critical Asset Tracking')
    return <CriticalAssetTrackingDashboard initialSheetId={criticalAssetSheetId ?? undefined} />
  }

  if (path === PROACTIVE_TEAM_CCTV_REVIEW_ROUTE) {
    setPageMeta('Proactive Team CCTV Review')
    return <ProactiveTeamCCTVReview />
  }

  if (path === AMTEAM_INSPECTION_VIEWER_ROUTE) {
    setPageMeta('Proactive Team CCTV Review Report')
    return <AMTeamInspectionViewer />
  }

  if (path === PLANNING_PENDING_AIF_QA_ROUTE) {
    setPageMeta('Planning Pending AIF QA/QC')
    return <PlanningPendingAifQaTable />
  }

  if (path === GIS_FACILITY_ROUTE) {
    setPageMeta('Critical Asset Facility', '/map-favicon.svg')
    return <GISDashboard />
  }

  if (path === GIS_HISTORY_ROUTE) {
    setPageMeta('Critical Asset History', '/map-favicon.svg')
    return <GISCriticalAssetHistoryDashboard />
  }

  if (path === STM_RISK_MAP_ROUTE) {
    setPageMeta('STM Risk Map', '/map-favicon.svg')
    return <MapTilesDashboard />
  }

  if (path === DASHBOARD_LINKS_ROUTE) {
    setPageMeta('Portal Dashboard Links')
    return <DashboardLinksPage />
  }

  if (path === ADMIN_MANAGEMENT_ROUTE) {
    setPageMeta('Portal Management')
    return <ManagementPage />
  }

  if (path === PORTAL_LOGIN_ROUTE) {
    setPageMeta('Portal Sign In')
    return <ManagementPage loginOnly />
  }

  if (path === '/management_login') {
    window.location.replace(PORTAL_LOGIN_ROUTE)
    return null
  }

  const criticalTeamSheetId = criticalTeamSheetIdFromPath(path)
  if (path === CRITICAL_TEAM_ROUTE || criticalTeamSheetId) {
    setPageMeta('Critical Team Dashboard')
    return <CriticalTeamDashboard initialSheetId={criticalTeamSheetId ?? undefined} />
  }

  setPageMeta('Storm Water Asset Intelligence Portal')
  return <HomePage theme={theme} onThemeChange={setTheme} />
}
