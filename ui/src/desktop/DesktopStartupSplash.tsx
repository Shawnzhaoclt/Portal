import { useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle, LogOut, RotateCw } from 'lucide-react'
import stormwaterLogo from '../assets/stormwater-logo.png'
import { formatLocalClock } from '../lib/dateTime'
import {
  MAINTENANCE_END_HOUR,
  MAINTENANCE_SPLASH_DURATION_SECONDS,
  MAINTENANCE_START_HOUR,
} from './maintenance'
import './DesktopStartupSplash.css'

const STARTUP_MESSAGES = [
  'Checking shared data',
  'Identifying your Windows account',
  'Loading your profile and permissions',
  'Synchronizing local business data',
]

type DesktopStartupSplashProps = {
  error?: string
  message?: string
  maintenance?: boolean
  onExit?: () => void
  onRetry?: () => void
}

export default function DesktopStartupSplash({ error, message, maintenance = false, onExit, onRetry }: DesktopStartupSplashProps) {
  const [messageIndex, setMessageIndex] = useState(0)
  const [maintenanceSecondsRemaining, setMaintenanceSecondsRemaining] = useState(MAINTENANCE_SPLASH_DURATION_SECONDS)
  const maintenanceStart = formatLocalClock(MAINTENANCE_START_HOUR * 60)
  const maintenanceEnd = formatLocalClock(MAINTENANCE_END_HOUR * 60)

  useEffect(() => {
    if (error || maintenance) return
    const timer = window.setInterval(() => {
      setMessageIndex((current) => Math.min(current + 1, STARTUP_MESSAGES.length - 1))
    }, 1800)
    return () => window.clearInterval(timer)
  }, [error, maintenance])

  useEffect(() => {
    if (!maintenance) return
    const timer = window.setInterval(() => {
      setMaintenanceSecondsRemaining((current) => Math.max(0, current - 1))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [maintenance])

  return (
    <main className="desktop-startup-screen">
      <section className={`desktop-startup-content${maintenance ? ' maintenance' : ''}`} aria-live="polite">
        <img className="desktop-startup-logo" src={stormwaterLogo} alt="Charlotte-Mecklenburg Storm Water Services" />
        <div className="desktop-startup-rule" />
        <h1>Storm Water Asset Intelligence Portal</h1>
        {maintenance ? (
          <>
            <AlertTriangle className="desktop-startup-maintenance-icon" aria-hidden="true" />
            <h2>System under maintenance</h2>
            <p className="desktop-startup-maintenance-message">
              {message ?? `The Portal is under maintenance daily from ${maintenanceStart} through ${maintenanceEnd}. Please try again after ${maintenanceEnd}.`}
            </p>
            <div className="desktop-startup-countdown" role="timer" aria-label={`Portal will close automatically in ${maintenanceSecondsRemaining} seconds`}>
              <strong>{maintenanceSecondsRemaining}</strong>
              <span>seconds until Portal closes</span>
            </div>
            <div className="desktop-startup-actions">
              <button onClick={onExit} type="button">
                <LogOut size={18} /> Exit
              </button>
            </div>
          </>
        ) : error ? (
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
            <p>{message ?? `${STARTUP_MESSAGES[messageIndex]}...`}</p>
            <div className="desktop-startup-progress" aria-hidden="true">
              <span />
            </div>
          </>
        )}
      </section>
    </main>
  )
}
