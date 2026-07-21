import { invoke } from '@tauri-apps/api/core'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export type DesktopContext = {
  applicationName: string
  applicationVersion: string
  runtime: 'tauri'
  userName: string
  userDomain: string
  deviceName: string
  dataRoot: string
  cacheRoot: string
  logRoot: string
  pythonWorkerAvailable: boolean
}

export type PythonHealth = {
  ok: boolean
  worker: string
  pythonVersion: string
  executable: string
}

export type BusinessSyncStatus = {
  configured: boolean
  networkAvailable: boolean
  manifestAvailable: boolean
  localDatabaseExists: boolean
  localDatabase: string
  networkRoot: string
  masterManifest: string
  masterVersion: string | null
  masterDatabase: string | null
  message: string
}

export type DesktopStartupSession<TUser = unknown> = {
  sharedDataRoot: string
  windowsEmail: string
  session: {
    token?: string
    token_type?: string
    user: TUser
  }
}

export function isDesktopRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

export async function getDesktopContext() {
  if (!isDesktopRuntime()) throw new Error('Desktop context is available only inside Tauri.')
  return invoke<DesktopContext>('desktop_context')
}

export async function startDesktopSession<TUser>() {
  if (!isDesktopRuntime()) throw new Error('Desktop startup is available only inside Tauri.')
  return invoke<DesktopStartupSession<TUser>>('desktop_startup_session')
}

export async function exitDesktopApplication() {
  if (!isDesktopRuntime()) return
  await invoke('exit_application')
}

export async function checkPythonWorker() {
  if (!isDesktopRuntime()) throw new Error('Python worker is available only inside Tauri.')
  return invoke<PythonHealth>('python_health_check')
}

export async function getBusinessSyncStatus() {
  if (!isDesktopRuntime()) throw new Error('Business synchronization is available only inside Tauri.')
  return invoke<BusinessSyncStatus>('business_sync_status')
}

export async function openExternalUrl(url: string) {
  if (isDesktopRuntime()) {
    await invoke('open_external_url', { url })
    return
  }

  const opened = window.open(url, '_blank')
  if (!opened) throw new Error('The browser blocked the new window.')
  opened.opener = null
}
