import { ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import ConsequenceInspector from '../../resources/maps/stm-risk-map/ConsequenceInspector'
import FailureConsequenceExtentControl from '../../resources/maps/stm-risk-map/FailureConsequenceExtentControl'
import FailureConsequenceScene3D from '../../resources/maps/stm-risk-map/FailureConsequenceScene3D'
import {
  DEFAULT_FAILURE_CONSEQUENCE_EXTENT_MILES,
  fetchFailureConsequence,
  type FailureConsequenceResult,
  type FailureDefect,
  type FailureScenario,
  type ReviewedObservation,
} from '../../resources/maps/stm-risk-map/failureConsequence'
import type { AmTeamCellValue, AmTeamObservation } from './types'
// The scene and panel ship their styles with the risk-map viewer stylesheet. Every
// selector in it is class-scoped, so importing it here cannot restyle the review page.
import '../../resources/maps/stm-risk-map/MapTilesViewer.css'

/**
 * The risk map's failure-consequence analysis, embedded for the pipe under CCTV review.
 *
 * Full parity with the risk map resource except for what needs a 2D map: the scene is
 * always 3D, and simulated-defect placement is unavailable because placing one means
 * clicking a map. Scenario selection, the summary KPIs, affected features with their
 * highlight, and the method notes are the same shared inspector the risk map renders.
 */

export type PipeConsequence3DProps = {
  open: boolean
  /** Inventory asset identifier of the reviewed pipe, e.g. "P_202319". */
  assetId: string
  /** The observation rows of the inspection under review, marked along the pipe. */
  observations: AmTeamObservation[]
  inspectionDirection: AmTeamCellValue
  onClose: () => void
}

function numberOrNull(value: AmTeamCellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function reviewedObservations(rows: AmTeamObservation[]): ReviewedObservation[] {
  return rows.map((row) => {
    const grade = numberOrNull(row.grade)
    const code = String(row.code ?? '').trim() || String(row.observation_text ?? '').trim() || 'Observation'
    return {
      mlo_id: String(row.mlo_id ?? ''),
      label: grade === null ? code : `${code} (Grade ${grade})`,
      distance_feet: numberOrNull(row.distance),
      origin: row.origin,
    }
  }).filter((row) => row.mlo_id !== '')
}

export function PipeConsequence3D({
  open,
  assetId,
  observations,
  inspectionDirection,
  onClose,
}: PipeConsequence3DProps) {
  const [result, setResult] = useState<FailureConsequenceResult | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [scenario, setScenario] = useState<FailureScenario | undefined>(undefined)
  const [extentMiles, setExtentMiles] = useState(DEFAULT_FAILURE_CONSEQUENCE_EXTENT_MILES)
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null)
  const [locateToken, setLocateToken] = useState(0)

  useEffect(() => {
    setScenario(undefined)
  }, [assetId])

  useEffect(() => {
    if (!open || !assetId) return undefined
    const controller = new AbortController()
    setErrorMessage('')
    setLoading(true)
    fetchFailureConsequence(assetId, 'pipe', {
      scenario,
      signal: controller.signal,
      extentMiles,
      reviewed: {
        observations: reviewedObservations(observations),
        inspection_direction: inspectionDirection === null ? null : String(inspectionDirection),
      },
    })
      .then((response) => setResult(response))
      .catch((error) => {
        if (controller.signal.aborted) return
        setErrorMessage(error instanceof Error ? error.message : 'Consequence analysis failed.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [assetId, extentMiles, inspectionDirection, observations, open, scenario])

  useEffect(() => {
    if (!open) return undefined
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  // A re-analysis can drop the selected feature, so the highlight follows what the
  // current result still contains rather than a remembered id.
  const activeFeatureId = (result?.analysis?.impacted_features ?? []).some((feature) => feature.id === selectedFeatureId)
    ? selectedFeatureId
    : null

  function selectDefect(defect: FailureDefect) {
    if (defect.source === 'simulated') return
    setScenario({ source: defect.source, id: defect.id })
  }

  function selectAffectedFeature(featureId: string) {
    setSelectedFeatureId((current) => (current === featureId ? null : featureId))
    setLocateToken((value) => value + 1)
  }

  return (
    <div className="failure-consequence-backdrop" role="dialog" aria-modal="true" aria-label="Pipe failure consequence analysis">
      <section className="failure-consequence-panel">
        <header className="failure-consequence-header">
          <div className="failure-consequence-title-icon"><ShieldAlert size={21} /></div>
          <div className="failure-consequence-title">
            <strong>Failure Consequence</strong>
            <span>Local DEM, selected asset, defects, zone of influence, and affected features</span>
          </div>
          <div className="failure-consequence-selected-asset">
            <span>Selected asset</span>
            <strong>{String(result?.asset.asset_id ?? assetId ?? 'Loading…')}</strong>
          </div>
          <span className="failure-consequence-type">{String(result?.asset.asset_type ?? 'pipe')}</span>
          <FailureConsequenceExtentControl
            disabled={loading}
            value={extentMiles}
            onChange={setExtentMiles}
          />
          <div className="failure-consequence-mode-toggle" role="group" aria-label="Map dimension">
            <button type="button" className="active" disabled>3D</button>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close consequence analysis"><X size={21} /></button>
        </header>

        <div className="failure-consequence-workspace">
          <div className="failure-consequence-map-shell">
            <FailureConsequenceScene3D
              result={result}
              basemapTextureUrl={null}
              selectedFeatureId={activeFeatureId}
              locateToken={locateToken}
            />
          </div>

          <ConsequenceInspector
            error={errorMessage}
            loading={loading}
            result={result}
            selectedFeatureId={activeFeatureId}
            mapLabel="3D map"
            onSelectFeature={selectAffectedFeature}
            onSelectDefect={selectDefect}
          />
        </div>
      </section>
    </div>
  )
}
