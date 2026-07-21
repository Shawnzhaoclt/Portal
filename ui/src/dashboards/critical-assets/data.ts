import { useEffect, useState } from 'react'
import type { CriticalAssetDataset } from './types'

type LoadState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: CriticalAssetDataset; error: null }
  | { status: 'error'; data: null; error: string }

export function useCriticalAssetData(): LoadState {
  const [state, setState] = useState<LoadState>({
    status: 'loading',
    data: null,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    fetch('/data/critical-assets.json')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Data request failed with ${response.status}`)
        }
        return response.json() as Promise<CriticalAssetDataset>
      })
      .then((data) => {
        if (!cancelled) {
          setState({ status: 'ready', data, error: null })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            data: null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}
