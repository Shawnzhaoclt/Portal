import { useEffect, useState } from 'react'
import { AlertTriangle, Download, LoaderCircle, LogOut, RotateCw } from 'lucide-react'
import stormwaterLogo from '../assets/stormwater-logo.png'
import { formatLocalClock } from '../lib/dateTime'
import {
  MAINTENANCE_END_HOUR,
  MAINTENANCE_SPLASH_DURATION_SECONDS,
  MAINTENANCE_START_HOUR,
} from './maintenance'
import './DesktopStartupSplash.css'
import type { DataCacheProgress } from './runtime'

const STARTUP_MESSAGES = [
  'Checking shared data',
  'Identifying your Windows account',
  'Loading your profile and permissions',
  'Synchronizing local business data',
]

type DesktopStartupSplashProps = {
  dataCacheProgress?: DataCacheProgress
  error?: string
  message?: string
  maintenance?: boolean
  onExit?: () => void
  onRetry?: () => void
  updateCountdownSeconds?: number
  updateReleaseVersion?: string | null
  updateStarting?: boolean
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function formatEta(seconds: number | null) {
  if (seconds === null) return ''
  if (seconds < 60) return `${seconds}s remaining`
  return `${Math.ceil(seconds / 60)} min remaining`
}

export default function DesktopStartupSplash({
  dataCacheProgress,
  error,
  message,
  maintenance = false,
  onExit,
  onRetry,
  updateCountdownSeconds,
  updateReleaseVersion,
  updateStarting = false,
}: DesktopStartupSplashProps) {
  const [messageIndex, setMessageIndex] = useState(0)
  const [maintenanceSecondsRemaining, setMaintenanceSecondsRemaining] = useState(MAINTENANCE_SPLASH_DURATION_SECONDS)
  const maintenanceStart = formatLocalClock(MAINTENANCE_START_HOUR * 60)
  const maintenanceEnd = formatLocalClock(MAINTENANCE_END_HOUR * 60)
  const updating = updateCountdownSeconds !== undefined || updateStarting

  useEffect(() => {
    if (error || maintenance || updating) return
    const timer = window.setInterval(() => {
      setMessageIndex((current) => Math.min(current + 1, STARTUP_MESSAGES.length - 1))
    }, 1800)
    return () => window.clearInterval(timer)
  }, [error, maintenance, updating])

  useEffect(() => {
    if (!maintenance) return
    const timer = window.setInterval(() => {
      setMaintenanceSecondsRemaining((current) => Math.max(0, current - 1))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [maintenance])

  return (
    <main className="desktop-startup-screen">
      <section className={`desktop-startup-content${maintenance || updating ? ' maintenance' : ''}`} aria-live="polite">
        <img className="desktop-startup-logo" src={stormwaterLogo} alt="Charlotte-Mecklenburg Storm Water Services" />
        <div className="desktop-startup-rule" />
        <h1>Storm Water Asset Intelligence Portal</h1>
        {updating ? (
          <>
            {updateStarting ? (
              <LoaderCircle className="desktop-startup-spinner desktop-startup-update-icon" aria-hidden="true" />
            ) : (
              <Download className="desktop-startup-update-icon" aria-hidden="true" />
            )}
            <h2>{updateStarting ? 'Starting Portal update' : 'Portal update required'}</h2>
            <p className="desktop-startup-maintenance-message">
              {updateStarting
                ? `Portal is closing now. The newer version${updateReleaseVersion ? ` (${updateReleaseVersion})` : ''} will download and install automatically.`
                : `A newer Portal version${updateReleaseVersion ? ` (${updateReleaseVersion})` : ''} is ready. Portal must close before the update can be downloaded and installed.`}
            </p>
            {updateStarting ? (
              <div className="desktop-startup-progress" aria-hidden="true">
                <span />
              </div>
            ) : (
              <div
                className="desktop-startup-countdown"
                role="timer"
                aria-label={`Portal will close to update in ${updateCountdownSeconds} seconds`}
              >
                <strong>{updateCountdownSeconds}</strong>
                <span>seconds until Portal closes to update</span>
              </div>
            )}
          </>
        ) : maintenance ? (
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
            <p>{dataCacheProgress?.message ?? message ?? `${STARTUP_MESSAGES[messageIndex]}...`}</p>
            {dataCacheProgress ? (
              <div className="desktop-cache-progress" aria-label={`Downloaded ${dataCacheProgress.completedBytes} of ${dataCacheProgress.totalBytes} bytes`}>
                <div className="desktop-cache-progress-track">
                  <span style={{ width: `${dataCacheProgress.totalBytes > 0 ? Math.min(100, dataCacheProgress.completedBytes / dataCacheProgress.totalBytes * 100) : 0}%` }} />
                </div>
                <div className="desktop-cache-progress-detail">
                  <span>{dataCacheProgress.completedSources} of {dataCacheProgress.totalSources} files</span>
                  <span>{formatBytes(dataCacheProgress.completedBytes)} of {formatBytes(dataCacheProgress.totalBytes)}</span>
                  <span>{dataCacheProgress.bytesPerSecond > 0 ? `${formatBytes(dataCacheProgress.bytesPerSecond)}/s` : ''}</span>
                  <span>{formatEta(dataCacheProgress.etaSeconds)}</span>
                </div>
              </div>
            ) : (
              <div className="desktop-startup-progress" aria-hidden="true">
                <span />
              </div>
            )}
          </>
        )}
      </section>
    </main>
  )
}
