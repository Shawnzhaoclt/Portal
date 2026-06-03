import CriticalTeamDashboard from './dashboards/critical-team/CriticalTeamDashboard'

const CRITICAL_TEAM_ROUTE = '/dashboard_critical_team'

export default function AppRoutes() {
  const path = window.location.pathname

  if (path === '/') {
    window.history.replaceState(null, '', CRITICAL_TEAM_ROUTE)
  }

  return <CriticalTeamDashboard />
}
