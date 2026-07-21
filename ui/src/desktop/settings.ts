import { invoke } from '@tauri-apps/api/core'

import { isDesktopRuntime } from './runtime'

type SettingsValue = string | number | boolean | null | SettingsObject | SettingsValue[]
type SettingsObject = { [key: string]: SettingsValue }

let clientSettings: SettingsObject = {}

export async function initializeClientSettings() {
  if (!isDesktopRuntime()) return
  clientSettings = await invoke<SettingsObject>('client_settings')
}

export function clientSetting(...keys: string[]) {
  let current: SettingsValue = clientSettings
  for (const key of keys) {
    if (!current || Array.isArray(current) || typeof current !== 'object') return ''
    current = current[key]
  }
  return typeof current === 'string' ? current.trim() : ''
}
