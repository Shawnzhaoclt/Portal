import { useEffect, useState } from 'react'
import DashboardLinksPage from './DashboardLinksPage'
import HomePage from './HomePage'
import ProactiveTeamCCTVReview from './dashboards/amteam/ProactiveTeamCCTVReview'
import ProactiveCCTVReviewHelp from './resources/reports/proactive-team-cctv-review/ProactiveCCTVReviewHelp'
import CreateAifFromItpipes from './resources/forms/create-aif-from-itpipes/CreateAifFromItpipes'
import WeeklyTimeReporting from './resources/reports/weekly-time-reporting/WeeklyTimeReporting'
import CriticalAssetTrackingDashboard from './dashboards/critical-assets/CriticalAssetTrackingDashboard'
import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'
import GISCriticalAssetHistoryDashboard from './dashboards/gis/GISCriticalAssetHistoryDashboard'
import GISDashboard from './dashboards/gis/GISDashboard'
import ManagementPage from './management/ManagementPage'
import AifOverviewDashboard from './dashboards/planning/AifOverviewDashboard'
import PlanningPendingAifQaTable from './dashboards/planning/PlanningPendingAifQaTable'
import MapTilesDashboard from './resources/maps/stm-risk-map/MapTilesDashboard'
import StormWaterAssetHistory from './resources/tables/storm-water-asset-history/StormWaterAssetHistory'
import { clearManagementToken, fetchMe, storedManagementToken, storedManagementUser } from './management/api'
import {
  ADMIN_MANAGEMENT_ROUTE,
  ACCOUNT_ROUTE,
  AIF_OVERVIEW_ROUTE,
  CRITICAL_ASSET_TRACKING_ROUTE,
  CREATE_AIF_FROM_ITPIPES_ROUTE,
  DASHBOARD_LINKS_ROUTE,
  GIS_FACILITY_ROUTE,
  GIS_HISTORY_ROUTE,
  PORTAL_LOGIN_ROUTE,
  PROACTIVE_TEAM_CCTV_REVIEW_HELP_ROUTE,
  PLANNING_PENDING_AIF_QA_ROUTE,
  PROACTIVE_TEAM_CCTV_REVIEW_ROUTE,
  STM_RISK_MAP_ROUTE,
  STORM_WATER_ASSET_HISTORY_ROUTE,
  WEEKLY_TIME_REPORTING_ROUTE,
  criticalAssetSheetIdFromPath,
  criticalTeamSheetIdFromPath,
} from './dashboardCatalog'
import { applyAppTheme, getInitialTheme, type AppTheme } from './theme'
import { isDesktopRuntime } from './desktop/runtime'

function setPageMeta(title: string) {
  document.title = title
  const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (iconLink && !iconLink.href.endsWith('/portal-desktop-icon.png')) {
    iconLink.href = '/portal-desktop-icon.png'
  }
}

function getRouteTheme(): AppTheme | null {
  const requestedTheme = new URLSearchParams(window.location.search).get('theme')
  if (requestedTheme === 'dark' || requestedTheme === 'light') return requestedTheme
  return null
}

export default function AppRoutes() {
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  const embedMode = params.get('embed') === '1' || params.get('embedded') === '1'
  const isLoginRoute = path === PORTAL_LOGIN_ROUTE || path === '/management_login'
  const desktopRuntime = isDesktopRuntime()
  const requiresAuth = !isLoginRoute
  const [theme, setTheme] = useState<AppTheme>(() => getRouteTheme() ?? getInitialTheme())
  const [authReady, setAuthReady] = useState(!requiresAuth)

  useEffect(() => {
    applyAppTheme(theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('dashboard-embed-mode', embedMode)
    return () => document.documentElement.classList.remove('dashboard-embed-mode')
  }, [embedMode])

  useEffect(() => {
    let cancelled = false

    if (!requiresAuth) {
      setAuthReady(true)
      return
    }

    const token = storedManagementToken()
    if (!token) {
      setAuthReady(false)
      setPageMeta('Portal Sign In')
      window.location.replace(PORTAL_LOGIN_ROUTE)
      return
    }

    if (desktopRuntime && storedManagementUser()) {
      setAuthReady(true)
      return
    }

    setAuthReady(false)
    fetchMe(token)
      .then(() => {
        if (!cancelled) setAuthReady(true)
      })
      .catch(() => {
        if (cancelled) return
        clearManagementToken()
        setAuthReady(false)
        setPageMeta('Portal Sign In')
        window.location.replace(PORTAL_LOGIN_ROUTE)
      })

    return () => {
      cancelled = true
    }
  }, [desktopRuntime, path, requiresAuth])

  if (requiresAuth && !storedManagementToken()) {
    setPageMeta('Portal Sign In')
    window.location.replace(PORTAL_LOGIN_ROUTE)
    return null
  }

  if (requiresAuth && !authReady) return null

  if (desktopRuntime && isLoginRoute) {
    window.location.replace('/')
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

  if (path === PROACTIVE_TEAM_CCTV_REVIEW_HELP_ROUTE) {
    setPageMeta('Proactive CCTV Review Help')
    return <ProactiveCCTVReviewHelp />
  }

  if (path === CREATE_AIF_FROM_ITPIPES_ROUTE) {
    setPageMeta('Create AIF from ITPipes')
    return <CreateAifFromItpipes />
  }

  if (path === WEEKLY_TIME_REPORTING_ROUTE) {
    setPageMeta('Weekly Time Reporting')
    return <WeeklyTimeReporting />
  }

  if (path === PLANNING_PENDING_AIF_QA_ROUTE) {
    setPageMeta('Planning Pending AIF QA/QC')
    return <PlanningPendingAifQaTable />
  }

  if (path === AIF_OVERVIEW_ROUTE) {
    setPageMeta('AIF Overview')
    return <AifOverviewDashboard />
  }

  if (path === GIS_FACILITY_ROUTE) {
    setPageMeta('Critical Asset Facility')
    return <GISDashboard />
  }

  if (path === GIS_HISTORY_ROUTE) {
    setPageMeta('Critical Asset History')
    return <GISCriticalAssetHistoryDashboard />
  }

  if (path === STM_RISK_MAP_ROUTE) {
    setPageMeta('STM Risk Map')
    return <MapTilesDashboard />
  }

  if (path === STORM_WATER_ASSET_HISTORY_ROUTE) {
    setPageMeta('Storm Water Asset History')
    return <StormWaterAssetHistory />
  }

  if (path === DASHBOARD_LINKS_ROUTE) {
    setPageMeta('Portal Dashboard Links')
    return <DashboardLinksPage />
  }

  if (path === ACCOUNT_ROUTE) {
    setPageMeta('Portal Account')
    return <ManagementPage accountOnly={desktopRuntime} />
  }

  if (path === ADMIN_MANAGEMENT_ROUTE && desktopRuntime) {
    window.location.replace(ACCOUNT_ROUTE)
    return null
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
  if (criticalTeamSheetId) {
    setPageMeta('Critical Team Dashboard')
    return <CriticalTeamDashboard initialSheetId={criticalTeamSheetId ?? undefined} />
  }

  setPageMeta('Storm Water Asset Intelligence Portal')
  return <HomePage theme={theme} onThemeChange={setTheme} />
}
