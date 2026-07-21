import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import './index.css'
import DesktopStartupSplash from './desktop/DesktopStartupSplash'
import { exitDesktopApplication, isDesktopRuntime, startDesktopSession } from './desktop/runtime'
import { initializeClientSettings } from './desktop/settings'
import {
  clearManagementToken,
  consumeManagementSessionTransfer,
  saveManagementToken,
  saveManagementUser,
  type PortalUser,
} from './management/api'
import { applyAppTheme, getInitialTheme } from './theme'

const root = createRoot(document.getElementById('root')!)

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

    try {
      clearManagementToken()
      await initializeClientSettings()
      const startup = await startDesktopSession<PortalUser>()
      const session = startup.session
      if (!session.token) throw new Error('Desktop sign-in did not return a Portal session token.')
      saveManagementToken(session.token, session.user.selected_role)
      saveManagementUser(session.user)
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
    </StrictMode>,
  )
}

void bootstrap()
