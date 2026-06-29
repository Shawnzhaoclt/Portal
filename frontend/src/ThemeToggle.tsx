import { Moon, Sun } from 'lucide-react'
import type { AppTheme } from './theme'
import './ThemeToggle.css'

type ThemeToggleProps = {
  placement?: 'floating' | 'inline'
  theme: AppTheme
  onThemeChange: (theme: AppTheme) => void
}

export default function ThemeToggle({ placement = 'floating', theme, onThemeChange }: ThemeToggleProps) {
  const nextTheme: AppTheme = theme === 'dark' ? 'light' : 'dark'
  const label = theme === 'dark' ? 'Use light color scheme' : 'Use dark color scheme'
  const Icon = theme === 'dark' ? Sun : Moon

  return (
    <button
      className={`theme-toggle theme-toggle-${placement}`}
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onThemeChange(nextTheme)}
    >
      <Icon size={19} aria-hidden="true" />
    </button>
  )
}
