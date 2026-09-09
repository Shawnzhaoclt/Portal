import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { listen } from '@tauri-apps/api/event'
import { Toaster } from 'sonner'
import './index.css'
import { AppMessageDialogProvider } from './components/AppMessageDialog'
import { appConfirm } from './components/messageDialogService'
import DesktopStartupSplash from './desktop/DesktopStartupSplash'
import {
  isScheduledMaintenance,
  MAINTENANCE_SPLASH_DURATION_MS,
} from './desktop/maintenance'
import {
  checkPortalUpdate,
  DESKTOP_RESOURCE_COUNT_EVENT,
  exitDesktopApplication,
  installPortalUpdate,
  isDesktopRuntime,
  prepareNetworkAccess,
  restartDesktopApplication,
  startDataCache,
  startDesktopSession,
  type DataCacheProgress,
  type DataCacheUpdateCompleted,
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
import { configureErrorToastDuration } from './lib/errorToast'
import { applyAppTheme, getInitialTheme } from './theme'

configureErrorToastDuration()

const root = createRoot(document.getElementById('root')!)
const MAINTENANCE_MONITOR_INTERVAL_MS = 5_000
const UPDATE_SHUTDOWN_COUNTDOWN_SECONDS = 10
let dataRestartPromptPending = false
let openDesktopResourceCount = 0

window.addEventListener(DESKTOP_RESOURCE_COUNT_EVENT, (event) => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'number') return
  openDesktopResourceCount = Math.max(0, Math.trunc(event.detail))
})

async function promptForDataRestart(update: DataCacheUpdateCompleted) {
  if (dataRestartPromptPending || openDesktopResourceCount === 0) return
  dataRestartPromptPending = true
  try {
    const sourceLabel = update.updatedSourceCount === 1 ? 'data source has' : 'data sources have'
    const restart = await appConfirm(
      `${update.updatedSourceCount} ${sourceLabel} finished synchronizing and the new local data is ready.\n\nOne or more open resources may still be using an earlier data version. Restart Portal now to reload them with the newly activated data. If you choose Later, newly opened resources will automatically use the latest data.`,
      {
        title: 'New Portal data is ready',
        confirmLabel: 'Restart now',
        cancelLabel: 'Later',
        kind: 'warning',
      },
    )
    if (restart) await restartDesktopApplication()
  } finally {
    dataRestartPromptPending = false
  }
}

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

async function showUpdateCountdownThenInstall(releaseVersion: string | null) {
  for (let secondsRemaining = UPDATE_SHUTDOWN_COUNTDOWN_SECONDS; secondsRemaining > 0; secondsRemaining -= 1) {
    root.render(
      <StrictMode>
        <DesktopStartupSplash
          updateCountdownSeconds={secondsRemaining}
          updateReleaseVersion={releaseVersion}
        />
      </StrictMode>,
    )
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000))
  }

  root.render(
    <StrictMode>
      <DesktopStartupSplash
        updateReleaseVersion={releaseVersion}
        updateStarting
      />
    </StrictMode>,
  )
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  await installPortalUpdate()
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
      await prepareNetworkAccess()
      await listen<DataCacheUpdateCompleted>('portal-data-cache-updated', (event) => {
        void promptForDataRestart(event.payload)
      })
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
        await showUpdateCountdownThenInstall(update.releaseVersion)
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
