import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { appConfirm } from '../../components/messageDialogService'
import { closeItpipesLogin, isDesktopRuntime, openItpipesLogin } from '../../desktop/runtime'
import { checkItpipesSession } from './api'
import './AMTeamInspectionViewer.css'

/** Shown once per app run, before the ITpipes window opens. Plain language on
 * purpose: people are being asked to type a password, and they are owed a clear
 * reason and a clear promise about what happens to it. */
const ITPIPES_SIGN_IN_REASON = [
  'The inspection videos and photos for this resource are stored in ITpipes, not in Portal.',
  '',
  'To show them to you, Portal needs you to sign in to ITpipes once. An ITpipes window will open - sign in there the same way you normally would.',
  '',
  'Portal does not see, save, or store your ITpipes password. It does not keep any key or login file on this computer. It simply uses the session you started, the same way a second browser tab would, and that session ends when ITpipes signs you out.',
].join('\n')

/** Set once per app run so a reviewer opening the resource repeatedly is told once. */
let itpipesReasonShown = false

/** Blocks a resource until the user has an ITpipes session.
 *
 * Sits at the resource entry so the explanation and sign-in happen before any
 * page renders, rather than after twenty media requests have already failed.
 */
export function ItpipesGate({ children }: { children: ReactNode }) {
  // 'checking' until the first probe answers, so the gate never flashes for
  // someone whose session is already good.
  const [gate, setGate] = useState<'checking' | 'signed_out' | 'ready'>(
    isDesktopRuntime() ? 'checking' : 'ready',
  )

  useEffect(() => {
    if (!isDesktopRuntime()) return
    let cancelled = false
    let timer = 0

    const keepWatching = (delay: number) => {
      timer = window.setTimeout(() => {
        void checkItpipesSession()
          .then((result) => {
            if (cancelled) return
            if (result.connected) {
              setGate('ready')
              // Signed in - the window has done its job; the session lives in the
              // shared profile, not in the window.
              void closeItpipesLogin()
              return
            }
            keepWatching(2500)
          })
          .catch(() => {
            if (!cancelled) keepWatching(5000)
          })
      }, delay)
    }

    void checkItpipesSession()
      .then(async (result) => {
        if (cancelled) return
        if (result.connected) {
          setGate('ready')
          return
        }
        setGate('signed_out')
        if (!itpipesReasonShown) {
          itpipesReasonShown = true
          const proceed = await appConfirm(ITPIPES_SIGN_IN_REASON, {
            title: 'Sign in to ITpipes',
            confirmLabel: 'Sign in to ITpipes',
            cancelLabel: 'Not now',
          })
          if (cancelled) return
          if (proceed) await openItpipesLogin().catch(() => undefined)
        }
        // Watch for the sign-in to land, whether it came through the prompt or
        // the button on the gate card.
        keepWatching(2500)
      })
      .catch(() => {
        if (cancelled) return
        setGate('signed_out')
        keepWatching(5000)
      })

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  if (gate === 'ready') return <>{children}</>

  return (
    <main className="amteam-page amteam-itpipes-gate">
      <div className="amteam-itpipes-gate-card">
        <h1>Sign in to ITpipes</h1>
        {gate === 'checking' ? (
          <p>Checking your ITpipes session…</p>
        ) : (
          <>
            <p>
              The videos and photos for this resource are stored in ITpipes. Sign in once and
              Portal will show them to you.
            </p>
            <p className="amteam-itpipes-gate-hint">
              Portal never sees or saves your ITpipes password, and keeps no login file on
              this computer.
            </p>
            <button
              type="button"
              className="amteam-itpipes-gate-button"
              onClick={() => {
                void openItpipesLogin().catch(() => undefined)
              }}
            >
              Open ITpipes sign-in
            </button>
            <p className="amteam-itpipes-gate-hint">
              This page continues automatically once you are signed in.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
