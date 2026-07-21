import { useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle, LogOut, RotateCw } from 'lucide-react'
import stormwaterLogo from '../assets/stormwater-logo.png'
import './DesktopStartupSplash.css'

const STARTUP_MESSAGES = [
  'Checking shared data',
  'Identifying your Windows account',
  'Loading your profile and permissions',
]

type DesktopStartupSplashProps = {
  error?: string
  onExit?: () => void
  onRetry?: () => void
}

export default function DesktopStartupSplash({ error, onExit, onRetry }: DesktopStartupSplashProps) {
  const [messageIndex, setMessageIndex] = useState(0)

  useEffect(() => {
    if (error) return
    const timer = window.setInterval(() => {
      setMessageIndex((current) => Math.min(current + 1, STARTUP_MESSAGES.length - 1))
    }, 1800)
    return () => window.clearInterval(timer)
  }, [error])

  return (
    <main className="desktop-startup-screen">
      <section className="desktop-startup-content" aria-live="polite">
        <img className="desktop-startup-logo" src={stormwaterLogo} alt="Charlotte-Mecklenburg Storm Water Services" />
        <div className="desktop-startup-rule" />
        <h1>Storm Water Asset Intelligence Portal</h1>
        {error ? (
          <>
            <AlertTriangle className="desktop-startup-error-icon" aria-hidden="true" />
            <h2>Portal could not start</h2>
            <p className="desktop-startup-error">{error}</p>
            <div className="desktop-startup-actions">
              <button onClick={onRetry} type="button">
                <RotateCw size={18} /> Retry
              </button>
              <button onClick={onExit} type="button">
                <LogOut size={18} /> Exit
              </button>
            </div>
          </>
        ) : (
          <>
            <LoaderCircle className="desktop-startup-spinner" aria-hidden="true" />
            <h2>Starting Portal</h2>
            <p>{STARTUP_MESSAGES[messageIndex]}...</p>
            <div className="desktop-startup-progress" aria-hidden="true">
              <span />
            </div>
          </>
        )}
      </section>
    </main>
  )
}
