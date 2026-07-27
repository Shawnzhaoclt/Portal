import { invoke } from '@tauri-apps/api/core'

import { isDesktopRuntime } from './runtime'

const DESKTOP_DATA_ORIGIN = 'http://portal-data.localhost'

export type PortalTestAccess = {
  teamId: number
  teamName: string
  role: 'user' | 'admin' | 'system_admin'
}

const PORTAL_TEST_ACCESS_KEY = 'portal_test_access'

export function storedPortalTestAccess(): PortalTestAccess | null {
  const raw = window.sessionStorage.getItem(PORTAL_TEST_ACCESS_KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PortalTestAccess>
    if (
      typeof value.teamId === 'number' &&
      typeof value.teamName === 'string' &&
      (value.role === 'user' || value.role === 'admin' || value.role === 'system_admin')
    ) {
      return value as PortalTestAccess
    }
  } catch {
    // Ignore stale or malformed session data.
  }
  window.sessionStorage.removeItem(PORTAL_TEST_ACCESS_KEY)
  return null
}

export function savePortalTestAccess(value: PortalTestAccess) {
  window.sessionStorage.setItem(PORTAL_TEST_ACCESS_KEY, JSON.stringify(value))
}

export function clearPortalTestAccess() {
  window.sessionStorage.removeItem(PORTAL_TEST_ACCESS_KEY)
}

type LocalResponse<T> = {
  status: number
  kind: 'json' | 'file' | 'binary' | 'error'
  data?: T
  error?: unknown
  path?: string
  filename?: string | null
  mediaType?: string | null
  bytes?: number[]
  headers?: Record<string, string>
}

function queryObject(searchParams: URLSearchParams) {
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0] ?? ''
  }
  return query
}

function requestBody(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) return null
  if (typeof body !== 'string') {
    throw new Error('Desktop Python commands accept JSON request bodies only.')
  }
  if (!body.trim()) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

function errorMessage(error: unknown, status: number) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return JSON.stringify(error ?? `Local command failed with status ${status}.`)
}

export async function portalRequest<T>(path: string, options: RequestInit = {}): Promise<LocalResponse<T>> {
  if (!isDesktopRuntime()) {
    throw new Error('Portal data commands are available only inside the desktop application.')
  }

  const url = new URL(path, 'https://portal.local')
  const headers = Object.fromEntries(new Headers(options.headers).entries())
  const testAccess = storedPortalTestAccess()
  if (testAccess) {
    headers['X-Portal-Test-Access'] = '1'
    headers['X-Portal-Test-Team-Id'] = String(testAccess.teamId)
    headers['X-Portal-Test-Role'] = testAccess.role
  }
  const response = await invoke<LocalResponse<T>>('python_request', {
    request: {
      method: String(options.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: queryObject(url.searchParams),
      headers,
      body: requestBody(options.body),
    },
  })

  if (response.kind === 'error' || response.status >= 400) {
    throw new Error(errorMessage(response.error, response.status))
  }
  return response
}

export async function portalRequestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await portalRequest<T>(path, options)
  if (response.kind !== 'json') {
    throw new Error(`Expected JSON from ${path}, but the local command returned ${response.kind}.`)
  }
  return response.data as T
}

export async function portalRequestFile(path: string, options: RequestInit = {}) {
  const response = await portalRequest<never>(path, options)
  if (response.kind !== 'file' || !response.path) {
    throw new Error(`Expected a file from ${path}, but the local command returned ${response.kind}.`)
  }
  return response
}

export function portalDataUrl(path: string) {
  if (!isDesktopRuntime() || /^(?:https?:|data:|blob:)/i.test(path)) return path
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${DESKTOP_DATA_ORIGIN}${normalizedPath}`
}

export function portalDataOrigin() {
  return isDesktopRuntime() ? DESKTOP_DATA_ORIGIN : window.location.origin
}
