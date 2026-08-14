import { invoke } from '@tauri-apps/api/core'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export const DESKTOP_RESOURCE_COUNT_EVENT = 'portal:desktop-resource-count'

export function reportDesktopOpenResourceCount(count: number) {
  window.dispatchEvent(new CustomEvent<number>(DESKTOP_RESOURCE_COUNT_EVENT, {
    detail: Math.max(0, Math.trunc(count)),
  }))
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

export type PortalUpdateCheck = {
  available: boolean
  currentVersion: string
  releaseVersion: string | null
  message: string
}

export type DataCacheProgress = {
  phase: string
  message: string
  sourceId: string
  displayName: string
  currentFileBytes: number
  currentFileSize: number
  completedBytes: number
  totalBytes: number
  completedSources: number
  totalSources: number
  bytesPerSecond: number
  etaSeconds: number | null
  background: boolean
}

export type DataCacheStartupResult = {
  enabled: boolean
  offline: boolean
  blockingDownloads: number
  backgroundDownloads: number
  activeSources: number
  publicationId: string
  localManifest: string
  message: string
}

export type DataCacheUpdateCompleted = {
  publicationId: string
  updatedSourceCount: number
  updatedSourceIds: string[]
}

export type DataCacheStatus = {
  enabled: boolean
  offline: boolean
  activeSources: number
  publicationId: string
  lastCheckedAtEpoch: number
  localManifest: string
  updating: boolean
  totalCacheBytes: number
  sources: DataCacheSourceStatus[]
  lastError: string
}

export type DataCacheSourceStatus = {
  id: string
  displayName: string
  activeVersion: string
  remoteVersion: string
  publishedAtUtc: string
  updateClass: string
  validationState: string
  validatedAtEpoch: number
  sizeBytes: number
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

export async function startDataCache() {
  if (!isDesktopRuntime()) throw new Error('Desktop data cache is available only inside Tauri.')
  return invoke<DataCacheStartupResult>('data_cache_startup')
}

export async function getDataCacheStatus() {
  if (!isDesktopRuntime()) throw new Error('Desktop data cache is available only inside Tauri.')
  return invoke<DataCacheStatus>('data_cache_status')
}

export async function exitDesktopApplication() {
  if (!isDesktopRuntime()) return
  await invoke('exit_application')
}

export async function restartDesktopApplication() {
  if (!isDesktopRuntime()) return
  await invoke('restart_application')
}

export async function checkPortalUpdate() {
  if (!isDesktopRuntime()) throw new Error('Portal updates are available only inside Tauri.')
  return invoke<PortalUpdateCheck>('check_portal_update')
}

export async function installPortalUpdate() {
  if (!isDesktopRuntime()) throw new Error('Portal updates are available only inside Tauri.')
  await invoke('install_portal_update')
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

export async function saveAndOpenExcelExport(fileName: string, bytes: Uint8Array) {
  if (!isDesktopRuntime()) throw new Error('Native Excel exports are available only inside Tauri.')
  return invoke<string>('save_and_open_excel_export', {
    request: {
      fileName,
      bytes: Array.from(bytes),
    },
  })
}

export async function saveExportAs(
  fileName: string,
  bytes: Uint8Array,
  format: 'excel' | 'geopackage' | 'jpg',
  openAfterSave = false,
) {
  if (!isDesktopRuntime()) throw new Error('Native Save As exports are available only inside Tauri.')
  return invoke<string | null>('save_export_as', {
    request: {
      fileName,
      bytes: Array.from(bytes),
      format,
      openAfterSave,
    },
  })
}

export async function openFileLocation(path: string) {
  if (!isDesktopRuntime()) return
  await invoke('open_file_location', { path })
}
