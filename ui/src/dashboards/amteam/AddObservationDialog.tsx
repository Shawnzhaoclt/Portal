import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Crosshair, X } from 'lucide-react'

import { fuzzyMatchScore } from './fuzzyMatch'
import type { PortalDictionaryItem, UserObservationRequest } from './api'

/**
 * Records an observation a reviewer spotted that ITPipes did not capture.
 *
 * Only the fields the STM Risk ETL reads are collected. Which of them apply depends on
 * the chosen code: roughly a third of real ITPipes observations legitimately carry no
 * grade, and only clogging codes carry a percentage, so each code's dictionary metadata
 * decides what the form asks for. The observation text is derived from the code rather
 * than typed, because the ETL branches on its wording.
 */

export type AddObservationDialogProps = {
  open: boolean
  codes: PortalDictionaryItem[]
  /** Current position of the inspection video, used as the media position. */
  currentTimeSeconds: number | null
  /** Inspected length of the pipe in feet; null when the source records no length. */
  maxDistance?: number | null
  /** Length of the inspection video, which bounds the position sliders. */
  videoDurationSeconds?: number | null
  /** Seeks the inspection video so a position can be picked while the dialog is open. */
  onSeek?: (seconds: number) => void
  busy?: boolean
  errorMessage?: string
  onCancel: () => void
  onSubmit: (payload: UserObservationRequest) => void
}

function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60)
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Most reviewer-recorded defects land on a 3, so the required grade starts there. */
const DEFAULT_GRADE = '3'

function codeOptionLabel(item: PortalDictionaryItem): string {
  return `${item.item_code} — ${item.label}`
}

/**
 * Picks one ITPipes observation code out of the ~170 the dictionary carries.
 *
 * A plain select forces the reviewer to scroll the whole list, so this filters as
 * they type against both the code and its wording ("cl" and "longitudinal" both
 * reach Crack Longitudinal). Free text is never accepted: the value has to be a
 * dictionary item, because the code drives the risk ETL and the fields the form
 * goes on to ask for. The menu is portalled since the dialog body scrolls.
 */
function ObservationCodeCombobox({
  codes,
  selected,
  onSelect,
}: {
  codes: PortalDictionaryItem[]
  selected: PortalDictionaryItem | null
  onSelect: (item: PortalDictionaryItem) => void
}) {
  const listboxId = useId()
  const [isOpen, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [inputValue, setInputValue] = useState('')
  const [query, setQuery] = useState('')
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const matches = useMemo(() => (
    codes
      .map((item, index) => ({ item, index, score: fuzzyMatchScore(codeOptionLabel(item), query) }))
      .filter((entry): entry is { item: PortalDictionaryItem; index: number; score: number } => (
        entry.score !== null
      ))
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((entry) => entry.item)
  ), [codes, query])

  useEffect(() => {
    setInputValue(selected ? codeOptionLabel(selected) : '')
    setQuery('')
  }, [selected])

  useEffect(() => {
    if (!isOpen) {
      setMenuStyle(null)
      return undefined
    }

    function positionMenu() {
      const input = inputRef.current
      if (!input) return
      const rect = input.getBoundingClientRect()
      const viewportPadding = 8
      const menuWidth = Math.min(Math.max(rect.width, 260), window.innerWidth - viewportPadding * 2)
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - menuWidth - viewportPadding,
      )
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding)
      const spaceAbove = Math.max(0, rect.top - viewportPadding)
      const placeAbove = spaceBelow < 180 && spaceAbove > spaceBelow
      const availableHeight = Math.max(96, placeAbove ? spaceAbove : spaceBelow)

      setMenuStyle({
        left,
        width: menuWidth,
        maxHeight: Math.min(300, availableHeight),
        top: placeAbove ? undefined : rect.bottom + 3,
        bottom: placeAbove ? window.innerHeight - rect.top + 3 : undefined,
      })
    }

    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [isOpen])

  function commit(item: PortalDictionaryItem) {
    onSelect(item)
    setInputValue(codeOptionLabel(item))
    setQuery('')
    setOpen(false)
    setActiveIndex(-1)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  function close() {
    setOpen(false)
    setActiveIndex(-1)
    // Never leave a half-typed query behind that does not name a real code.
    setInputValue(selected ? codeOptionLabel(selected) : '')
    setQuery('')
  }

  return (
    <div
      className={`amteam-callout-combobox amteam-observation-code-combobox ${isOpen ? 'open' : ''}`.trim()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
      }}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-label="Observation code"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        placeholder="Type a code or description"
        value={inputValue}
        onFocus={(event) => {
          setQuery('')
          setOpen(true)
          event.currentTarget.select()
        }}
        onChange={(event) => {
          setInputValue(event.currentTarget.value)
          setQuery(event.currentTarget.value)
          setOpen(true)
          setActiveIndex(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActiveIndex((current) => Math.min(current + 1, matches.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            setActiveIndex((current) => Math.max(current - 1, 0))
          } else if (event.key === 'Enter' && isOpen && matches.length) {
            event.preventDefault()
            commit(matches[activeIndex >= 0 ? activeIndex : 0])
          } else if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      />
      <button
        type="button"
        className="amteam-callout-toggle"
        aria-label="Show observation codes"
        aria-expanded={isOpen}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (isOpen) {
            close()
          } else {
            setQuery('')
            setOpen(true)
          }
          inputRef.current?.focus()
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {isOpen && menuStyle && typeof document !== 'undefined' ? createPortal(
        <div
          className="amteam-callout-menu amteam-observation-code-menu"
          id={listboxId}
          role="listbox"
          style={menuStyle}
        >
          {matches.length === 0 ? (
            <p className="amteam-callout-empty">No code matches “{query}”.</p>
          ) : matches.map((item, index) => (
            <button
              type="button"
              className={`amteam-callout-option ${index === activeIndex ? 'active' : ''} ${
                selected && selected.id === item.id ? 'selected' : ''
              }`.trim()}
              id={`${listboxId}-${index}`}
              key={item.id}
              role="option"
              aria-selected={Boolean(selected && selected.id === item.id)}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(item)}
            >
              <strong>{item.item_code}</strong>
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export function AddObservationDialog({
  open,
  codes,
  currentTimeSeconds,
  maxDistance = null,
  videoDurationSeconds = null,
  onSeek,
  busy = false,
  errorMessage = '',
  onCancel,
  onSubmit,
}: AddObservationDialogProps) {
  const [codeId, setCodeId] = useState('')
  const [distance, setDistance] = useState('')
  const [grade, setGrade] = useState('')
  const [valuePercent, setValuePercent] = useState('')
  const [clockFrom, setClockFrom] = useState('')
  const [clockTo, setClockTo] = useState('')
  const [joint, setJoint] = useState(false)
  const [remarks, setRemarks] = useState('')
  const [continuous, setContinuous] = useState(false)
  const [finishDistance, setFinishDistance] = useState('')
  const [startSeconds, setStartSeconds] = useState('')
  const [finishSeconds, setFinishSeconds] = useState('')
  const [validationMessage, setValidationMessage] = useState('')
  // While set, the dialog steps aside so the reviewer can drive the real video
  // transport and pick a frame at full brightness instead of through the backdrop.
  const [picking, setPicking] = useState<'start' | 'finish' | null>(null)
  const [pickBarStyle, setPickBarStyle] = useState<CSSProperties | null>(null)

  const selected = useMemo(
    () => codes.find((item) => String(item.id) === codeId) ?? null,
    [codeId, codes],
  )
  const applies = selected?.metadata ?? {}
  const distanceLimit = maxDistance !== null && maxDistance > 0 ? maxDistance : null
  const videoDuration = videoDurationSeconds !== null && videoDurationSeconds > 0
    ? Math.round(videoDurationSeconds)
    : null
  const canPickFromVideo = currentTimeSeconds !== null

  // Read through a ref so the video advancing behind the dialog cannot retrigger the
  // reset below and wipe what the reviewer has already filled in.
  const openingTimeRef = useRef(currentTimeSeconds)
  openingTimeRef.current = currentTimeSeconds

  useEffect(() => {
    if (!open) return
    setCodeId('')
    setDistance('')
    setGrade('')
    setValuePercent('')
    setClockFrom('')
    setClockTo('')
    setJoint(false)
    setRemarks('')
    setContinuous(false)
    setFinishDistance('')
    setValidationMessage('')
    setPicking(null)
    const opened = openingTimeRef.current
    setStartSeconds(opened === null ? '' : String(Math.round(opened)))
    setFinishSeconds('')
  }, [open])

  // Sit the picker against the video transport it is asking the reviewer to drive,
  // rather than floating at the top of the window away from the controls in use.
  useEffect(() => {
    if (!picking) {
      setPickBarStyle(null)
      return undefined
    }

    function positionBar() {
      const controls = document.querySelector('.amteam-video-controls')
      if (!controls) {
        setPickBarStyle({ top: 16, left: '50%', transform: 'translateX(-50%)' })
        return
      }
      const rect = controls.getBoundingClientRect()
      const gap = 8
      const estimatedHeight = 62
      const fitsBelow = window.innerHeight - rect.bottom - gap >= estimatedHeight
      setPickBarStyle({
        left: rect.left,
        width: rect.width,
        top: fitsBelow ? rect.bottom + gap : undefined,
        bottom: fitsBelow ? undefined : window.innerHeight - rect.top + gap,
      })
    }

    positionBar()
    window.addEventListener('resize', positionBar)
    window.addEventListener('scroll', positionBar, true)
    return () => {
      window.removeEventListener('resize', positionBar)
      window.removeEventListener('scroll', positionBar, true)
    }
  }, [picking])

  // Grades are required wherever a code uses them, and reviewers record a 3 far more
  // often than anything else, so it is the starting point rather than an empty field.
  useEffect(() => {
    if (!open) return
    setGrade((current) => (selected?.metadata?.grade ? current || DEFAULT_GRADE : ''))
  }, [open, selected])

  if (!open) return null

  function submit() {
    if (!selected) {
      setValidationMessage('Select an observation code.')
      return
    }
    const startDistance = numberOrNull(distance)
    if (startDistance === null || startDistance < 0) {
      setValidationMessage('Enter the distance in feet.')
      return
    }
    const finish = continuous ? numberOrNull(finishDistance) : null
    if (continuous && (finish === null || finish <= startDistance)) {
      setValidationMessage('A continuous defect needs a finish distance beyond its start.')
      return
    }
    // Mirrors the check the API enforces, so the reviewer sees it before posting.
    if (maxDistance !== null && maxDistance > 0) {
      const furthest = Math.max(startDistance, finish ?? startDistance)
      if (furthest > maxDistance) {
        setValidationMessage(
          `${furthest} ft is beyond the inspected length of this pipe (${maxDistance} ft).`,
        )
        return
      }
    }
    const startTime = numberOrNull(startSeconds)
    if (startTime === null || startTime < 0) {
      setValidationMessage(
        continuous ? 'Enter the start video time.' : 'Enter the video time of the defect.',
      )
      return
    }
    const finishTime = continuous ? numberOrNull(finishSeconds) : null
    if (continuous && (finishTime === null || finishTime < 0)) {
      setValidationMessage('Enter the finish video time.')
      return
    }
    // The camera only travels forward, so the finish cannot come earlier in the video.
    if (finishTime !== null && finishTime < startTime) {
      setValidationMessage(
        `The finish video time (${formatSeconds(finishTime)}) is before the start (${formatSeconds(startTime)}).`,
      )
      return
    }
    if (applies.grade && !grade) {
      setValidationMessage('Select a grade.')
      return
    }
    setValidationMessage('')
    onSubmit({
      code: selected.item_code,
      observation_text: selected.label,
      distance: startDistance,
      digital_time_seconds: startTime,
      grade: applies.grade ? numberOrNull(grade) : null,
      value_percent: applies.value_percent ? numberOrNull(valuePercent) : null,
      clock_from: applies.clock ? numberOrNull(clockFrom) : null,
      clock_to: applies.clock ? numberOrNull(clockTo) : null,
      joint: applies.joint ? joint : null,
      remarks: remarks.trim() || null,
      continuous,
      finish_distance: finish,
      finish_time_seconds: finishTime,
    })
  }

  const message = validationMessage || errorMessage

  // No backdrop while picking: the video keeps its own controls, at full brightness,
  // and the entered form values stay mounted behind this bar.
  if (picking) {
    const live = currentTimeSeconds === null ? null : Math.round(currentTimeSeconds)
    return (
      <div
        className="amteam-observation-pick-bar"
        role="dialog"
        aria-label="Pick a video position"
        style={pickBarStyle ?? undefined}
      >
        <div className="amteam-observation-pick-copy">
          <strong>
            {picking === 'finish' ? 'Pick the finish frame' : 'Pick the frame of the defect'}
          </strong>
          <span>Play or drag the video below, then keep the position.</span>
        </div>
        <span className="amteam-observation-pick-time">
          {live === null ? '--:--' : formatSeconds(live)}
        </span>
        <button type="button" onClick={() => setPicking(null)}>Cancel</button>
        <button
          type="button"
          className="primary"
          disabled={live === null}
          onClick={() => {
            if (live === null) return
            if (picking === 'finish') setFinishSeconds(String(live))
            else setStartSeconds(String(live))
            setPicking(null)
          }}
        >
          Use this frame
        </button>
      </div>
    )
  }

  return (
    <div className="amteam-observation-detail-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="amteam-observation-detail-dialog amteam-add-observation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add observation"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Add observation</span>
            <strong>Recorded in Portal, not ITPipes</strong>
          </div>
          <button type="button" aria-label="Close add observation" onClick={onCancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="amteam-observation-detail-dialog-body amteam-add-observation-body">
          <div className="amteam-add-observation-field">
            <span>Observation code</span>
            <ObservationCodeCombobox
              codes={codes}
              selected={selected}
              onSelect={(item) => setCodeId(String(item.id))}
            />
          </div>

          <div className="amteam-add-observation-row">
            <label>
              <span>
                {continuous ? 'Start distance (ft)' : 'Distance (ft)'}
                {distanceLimit !== null ? (
                  <em className="amteam-add-observation-hint"> max {distanceLimit}</em>
                ) : null}
              </span>
              <input
                type="number"
                min="0"
                max={distanceLimit ?? undefined}
                step="0.1"
                inputMode="decimal"
                value={distance}
                onChange={(event) => setDistance(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>{continuous ? 'Start video time (s)' : 'Video time (s)'}</span>
              <div className="amteam-add-observation-time">
                <input
                  type="number"
                  min="0"
                  max={videoDuration ?? undefined}
                  step="1"
                  inputMode="numeric"
                  value={startSeconds}
                  onChange={(event) => setStartSeconds(event.currentTarget.value)}
                />
                {videoDuration !== null || canPickFromVideo ? (
                  <div className="amteam-add-observation-time-controls">
                    {videoDuration !== null ? (
                      <input
                        type="range"
                        aria-label="Scrub the video to the start of the defect"
                        min="0"
                        max={videoDuration}
                        step="1"
                        value={numberOrNull(startSeconds) ?? 0}
                        onChange={(event) => {
                          setStartSeconds(event.currentTarget.value)
                          onSeek?.(Number(event.currentTarget.value))
                        }}
                      />
                    ) : null}
                    {canPickFromVideo ? (
                      <button
                        type="button"
                        className="amteam-add-observation-pick"
                        onClick={() => setPicking('start')}
                      >
                        <Crosshair size={13} aria-hidden="true" />
                        Pick
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </label>
          </div>

          {applies.continuous ? (
            <label className="amteam-add-observation-check">
              <input
                type="checkbox"
                checked={continuous}
                onChange={(event) => setContinuous(event.currentTarget.checked)}
              />
              <span>Continuous defect (records a start and a finish)</span>
            </label>
          ) : null}

          {continuous ? (
            <div className="amteam-add-observation-row">
              <label>
                <span>
                  Finish distance (ft)
                  {distanceLimit !== null ? (
                    <em className="amteam-add-observation-hint"> max {distanceLimit}</em>
                  ) : null}
                </span>
                <input
                  type="number"
                  min="0"
                  max={distanceLimit ?? undefined}
                  step="0.1"
                  inputMode="decimal"
                  value={finishDistance}
                  onChange={(event) => setFinishDistance(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>Finish video time (s)</span>
                <div className="amteam-add-observation-time">
                  <input
                    type="number"
                    min={numberOrNull(startSeconds) ?? 0}
                    max={videoDuration ?? undefined}
                    step="1"
                    inputMode="numeric"
                    value={finishSeconds}
                    onChange={(event) => setFinishSeconds(event.currentTarget.value)}
                  />
                  {videoDuration !== null || canPickFromVideo ? (
                    <div className="amteam-add-observation-time-controls">
                      {videoDuration !== null ? (
                        <input
                          type="range"
                          aria-label="Scrub the video to the finish of the defect"
                          min={numberOrNull(startSeconds) ?? 0}
                          max={videoDuration}
                          step="1"
                          value={numberOrNull(finishSeconds) ?? 0}
                          onChange={(event) => {
                            setFinishSeconds(event.currentTarget.value)
                            onSeek?.(Number(event.currentTarget.value))
                          }}
                        />
                      ) : null}
                      {canPickFromVideo ? (
                        <button
                          type="button"
                          className="amteam-add-observation-pick"
                          onClick={() => setPicking('finish')}
                        >
                          <Crosshair size={13} aria-hidden="true" />
                          Pick
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </label>
            </div>
          ) : null}

          {applies.grade || applies.value_percent ? (
            <div className="amteam-add-observation-row">
              {applies.grade ? (
                <label>
                  <span>Grade</span>
                  <select value={grade} onChange={(event) => setGrade(event.currentTarget.value)}>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={String(value)}>{value}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {applies.value_percent ? (
                <label>
                  <span>Value percent</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    inputMode="numeric"
                    value={valuePercent}
                    onChange={(event) => setValuePercent(event.currentTarget.value)}
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {applies.clock ? (
            <div className="amteam-add-observation-row">
              <label>
                <span>Clock from</span>
                <input
                  type="number"
                  min="0"
                  max="12"
                  step="1"
                  inputMode="numeric"
                  value={clockFrom}
                  onChange={(event) => setClockFrom(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>Clock to</span>
                <input
                  type="number"
                  min="0"
                  max="12"
                  step="1"
                  inputMode="numeric"
                  value={clockTo}
                  onChange={(event) => setClockTo(event.currentTarget.value)}
                />
              </label>
            </div>
          ) : null}

          {applies.joint ? (
            <label className="amteam-add-observation-check">
              <input
                type="checkbox"
                checked={joint}
                onChange={(event) => setJoint(event.currentTarget.checked)}
              />
              <span>At a joint</span>
            </label>
          ) : null}

          <label>
            <span>Remarks</span>
            <textarea
              rows={2}
              maxLength={500}
              value={remarks}
              onChange={(event) => setRemarks(event.currentTarget.value)}
            />
          </label>

          {message ? <p className="amteam-add-observation-error">{message}</p> : null}

          <div className="amteam-add-observation-actions">
            <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" className="primary" onClick={submit} disabled={busy}>
              {busy ? 'Adding' : 'Add observation'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
