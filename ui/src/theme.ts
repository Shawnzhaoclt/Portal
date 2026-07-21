export type AppTheme = 'dark' | 'light'

const THEME_STORAGE_KEY = 'portal-color-scheme'
const LEGACY_THEME_STORAGE_KEY = 'arf-color-scheme'

function isAppTheme(value: string | null): value is AppTheme {
  return value === 'dark' || value === 'light'
}

export function getInitialTheme(): AppTheme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (isAppTheme(stored)) return stored
  return 'light'
}

export function applyAppTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('theme-dark', theme === 'dark')
  document.documentElement.classList.toggle('theme-light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
}
