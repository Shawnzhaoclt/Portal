import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { listen } from '@tauri-apps/api/event'
import { Toaster } from 'sonner'
import './index.css'
import { AppMessageDialogProvider } from './components/AppMessageDialog'
import DesktopStartupSplash from './desktop/DesktopStartupSplash'
import {
  isScheduledMaintenance,
  MAINTENANCE_SPLASH_DURATION_MS,
} from './desktop/maintenance'
import {
  checkPortalUpdate,
  exitDesktopApplication,
  installPortalUpdate,
  isDesktopRuntime,
  startDataCache,
  startDesktopSession,
  type DataCacheProgress,
} from './desktop/runtime'
import { initializeClientSettings } from './desktop/settings'
import {
  clearManagementToken,
  consumeManagementSessionTransfer,
  saveManagementToken,
  saveManagementUser,
  sessionManagementRole,
  switchRole,
  type PortalUser,
} from './management/api'
import { applyAppTheme, getInitialTheme } from './theme'

const root = createRoot(document.getElementById('root')!)
const MAINTENANCE_MONITOR_INTERVAL_MS = 5_000

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Portal could not complete its startup checks.'
}

function renderStartupError(error: unknown) {
  root.render(
    <StrictMode>
      <DesktopStartupSplash
        error={errorMessage(error)}
        onExit={() => void exitDesktopApplication()}
        onRetry={() => window.location.reload()}
      />
    </StrictMode>,
  )
}

function renderDataCacheProgress(progress: DataCacheProgress) {
  root.render(
    <StrictMode>
      <DesktopStartupSplash dataCacheProgress={progress} />
    </StrictMode>,
  )
}

async function showMaintenanceSplashThenExit() {
  root.render(
    <StrictMode>
      <DesktopStartupSplash
        maintenance
        onExit={() => void exitDesktopApplication()}
      />
    </StrictMode>,
  )
  await new Promise<void>((resolve) => window.setTimeout(resolve, MAINTENANCE_SPLASH_DURATION_MS))
  await exitDesktopApplication()
}

function monitorScheduledMaintenance() {
  let exitRequested = false
  const exitIfMaintenanceStarted = () => {
    if (exitRequested || !isScheduledMaintenance()) return
    exitRequested = true
    void showMaintenanceSplashThenExit().catch((error) => {
      exitRequested = false
      renderStartupError(error)
    })
  }

  window.setInterval(exitIfMaintenanceStarted, MAINTENANCE_MONITOR_INTERVAL_MS)
  window.addEventListener('focus', exitIfMaintenanceStarted)
  document.addEventListener('visibilitychange', exitIfMaintenanceStarted)
  exitIfMaintenanceStarted()
}

async function bootstrap() {
  const desktopRuntime = isDesktopRuntime()
  const embeddedResource =
    new URLSearchParams(window.location.search).get('embed') === '1' || window.self !== window.top
  applyAppTheme(getInitialTheme())

  if (desktopRuntime && !embeddedResource) {
    root.render(
      <StrictMode>
        <DesktopStartupSplash />
      </StrictMode>,
    )
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

    if (isScheduledMaintenance()) {
      try {
        await showMaintenanceSplashThenExit()
      } catch (error) {
        renderStartupError(error)
      }
      return
    }

    try {
      const activeSessionRole = sessionManagementRole()
      clearManagementToken()
      await initializeClientSettings()
      const unlisten = await listen<DataCacheProgress>('portal-data-cache-progress', (event) => {
        if (!event.payload.background) renderDataCacheProgress(event.payload)
      })
      try {
        await startDataCache()
      } finally {
        unlisten()
      }
      const startup = await startDesktopSession<PortalUser>()
      const session = startup.session
      if (!session.token) throw new Error('Desktop sign-in did not return a Portal session token.')
      saveManagementToken(session.token, session.user.selected_role)
      saveManagementUser(session.user)
      if (
        activeSessionRole &&
        activeSessionRole !== session.user.selected_role &&
        session.user.roles.includes(activeSessionRole)
      ) {
        const switched = await switchRole(activeSessionRole)
        saveManagementToken(switched.token, activeSessionRole)
        saveManagementUser({ ...switched.user, selected_role: activeSessionRole })
      }
      const update = await checkPortalUpdate()
      if (update.available) {
        root.render(
          <StrictMode>
            <DesktopStartupSplash message={`Updating Portal to ${update.releaseVersion}...`} />
          </StrictMode>,
        )
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        await installPortalUpdate()
        return
      }
    } catch (error) {
      renderStartupError(error)
      return
    }
  } else {
    await initializeClientSettings()
    if (desktopRuntime) consumeManagementSessionTransfer()
  }

  const { default: AppRoutes } = await import('./AppRoutes')
  root.render(
    <StrictMode>
      <AppMessageDialogProvider>
        <AppRoutes />
        <Toaster
          closeButton
          expand
          position="top-center"
          richColors
          toastOptions={{
            style: {
              borderRadius: 0,
              fontFamily: 'inherit',
            },
          }}
        />
      </AppMessageDialogProvider>
    </StrictMode>,
  )
  if (desktopRuntime && !embeddedResource) monitorScheduledMaintenance()
}

void bootstrap()
