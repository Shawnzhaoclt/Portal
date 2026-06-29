import { useEffect, useState } from 'react'
import DashboardLinksPage from './DashboardLinksPage'
import HomePage from './HomePage'
import CriticalAssetTrackingDashboard from './dashboards/critical-assets/CriticalAssetTrackingDashboard'
import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'
import GISCriticalAssetHistoryDashboard from './dashboards/gis/GISCriticalAssetHistoryDashboard'
import GISDashboard from './dashboards/gis/GISDashboard'
import {
  CRITICAL_ASSET_TRACKING_ROUTE,
  DASHBOARD_LINKS_ROUTE,
  GIS_FACILITY_ROUTE,
  GIS_HISTORY_ROUTE,
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

  useEffect(() => {
    applyAppTheme(theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('dashboard-embed-mode', embedMode)
    return () => document.documentElement.classList.remove('dashboard-embed-mode')
  }, [embedMode])

  if (path === '/') {
    setPageMeta('Storm Water Asset Intelligence Portal')
    return <HomePage theme={theme} onThemeChange={setTheme} />
  }

  if (path === CRITICAL_ASSET_TRACKING_ROUTE) {
    setPageMeta('Critical Asset Tracking')
    return <CriticalAssetTrackingDashboard />
  }

  if (path === GIS_FACILITY_ROUTE) {
    setPageMeta('Critical Asset Facility', '/map-favicon.svg')
    return <GISDashboard />
  }

  if (path === GIS_HISTORY_ROUTE) {
    setPageMeta('Critical Asset History', '/map-favicon.svg')
    return <GISCriticalAssetHistoryDashboard />
  }

  if (path === DASHBOARD_LINKS_ROUTE) {
    setPageMeta('Portal Dashboard Links')
    return <DashboardLinksPage />
  }

  setPageMeta('Critical Team Dashboard')
  return <CriticalTeamDashboard />
}
