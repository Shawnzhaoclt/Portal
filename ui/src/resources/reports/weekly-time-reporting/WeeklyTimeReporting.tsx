import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { portalRequestJson } from '../../../desktop/request'
import { formatDateOnly, formatDateTime } from '../../../lib/dateTime'
import { appConfirm, appPrompt } from '../../../components/messageDialogService'
import './WeeklyTimeReporting.css'

type EntryType = string
type SubmissionStatus = 'draft' | 'submitted' | 'returned' | 'approved'

type WeeklyTimeEntryType = {
  id: number
  type_key: string
  label: string
  sort_order: number
  is_active: boolean
}

type TimeEntry = {
  entry_id: string
  entry_type: EntryType
  work_date: string
  hours: number
  start_time: string | null
  end_time: string | null
  notes: string | null
}

type ScheduleDay = {
  date: string
  scheduled_hours: number
  target_hours: number
  holiday: { name: string; hours: number } | null
}

type ScheduleRequest = {
  request_id: string
  user_id: number
  employee_name: string
  team_name: string | null
  week_start: string
  week_end: string
  reason: string
  daily_hours: number[]
  status: string
  created_at: string
  review_comments: string | null
}

type WorkflowEvent = {
  event_id: string
  event_type: string
  actor_name: string
  event_at: string
  from_status: string | null
  to_status: string | null
  memo: string | null
}

type WeeklyContext = {
  resource_id: string
  user: {
    id: number
    employee_id: string
    display_name: string
    team_id: number | null
    team_name: string | null
  }
  viewer: {
    id: number
    display_name: string
    role: string
    can_review: boolean
  }
  week_start: string
  week_end: string
  submission: {
    submission_id: string
    status: SubmissionStatus
    submitted_at: string | null
    reviewed_at: string | null
    reviewed_by_name: string | null
    review_comments: string | null
  }
  entries: TimeEntry[]
  entry_types: WeeklyTimeEntryType[]
  schedule_days: ScheduleDay[]
  schedule_requests: ScheduleRequest[]
  events: WorkflowEvent[]
  summary: {
    target_hours: number
    reported_hours: number
    field_hours: number
    remaining_hours: number
  }
  permissions: {
    can_edit: boolean
    can_create: boolean
    can_delete: boolean
    can_submit: boolean
    can_review: boolean
    can_request_schedule_change: boolean
  }
}

type ReviewQueue = {
  submissions: Array<{
    submission_id: string
    user_id: number
    employee_name: string
    team_name: string | null
    week_start: string
    week_end: string
    submitted_at: string
    status: string
  }>
  schedule_requests: ScheduleRequest[]
}

type CopyPreviousWeekResponse = {
  context: WeeklyContext
  copied: number
  skipped_holidays: number
  skipped_duplicates: number
}

const DEFAULT_ENTRY_TYPES: WeeklyTimeEntryType[] = [
  { id: 0, type_key: 'field_work', label: 'Field work', sort_order: 1, is_active: true },
  { id: 0, type_key: 'office_work', label: 'Office work', sort_order: 2, is_active: true },
  { id: 0, type_key: 'leave', label: 'Leave', sort_order: 3, is_active: true },
  { id: 0, type_key: 'meeting', label: 'Meeting', sort_order: 4, is_active: true },
  { id: 0, type_key: 'training', label: 'Training', sort_order: 5, is_active: true },
  { id: 0, type_key: 'conference', label: 'Conference attendance', sort_order: 6, is_active: true },
  { id: 0, type_key: 'emergency_response', label: 'Emergency response', sort_order: 7, is_active: true },
  { id: 0, type_key: 'special_assignment', label: 'Special assignment', sort_order: 8, is_active: true },
  { id: 0, type_key: 'other', label: 'Other', sort_order: 9, is_active: true },
]

function fallbackEntryTypeLabel(typeKey: string) {
  return typeKey
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const MIN_ENTRY_HOURS = 0.5
const MAX_ENTRY_HOURS = 12
type LinkedTimeField = 'hours' | 'start_time' | 'end_time'

const EMPTY_ENTRY = {
  entry_type: 'field_work' as EntryType,
  work_date: '',
  hours: 7,
  start_time: '',
  end_time: '',
  notes: '',
}

function timeToMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function calculateTimeSpan(startTime: string, endTime: string) {
  const start = timeToMinutes(startTime)
  const end = timeToMinutes(endTime)
  if (start === null || end === null || end <= start) return null
  return Math.round(((end - start) / 60) * 100) / 100
}

function minutesToTime(value: number) {
  if (value < 0 || value >= 24 * 60) return null
  const rounded = Math.round(value)
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`
}

function deriveLinkedTimeValue(
  values: typeof EMPTY_ENTRY,
  drivers: LinkedTimeField[],
) {
  if (drivers.length !== 2) return values

  const next = { ...values }
  const hasHours = drivers.includes('hours')
  const hasStart = drivers.includes('start_time')
  const hasEnd = drivers.includes('end_time')
  const hours = Number(next.hours)
  const validHours = Number.isFinite(hours) && hours >= MIN_ENTRY_HOURS && hours <= MAX_ENTRY_HOURS

  if (hasHours && hasStart) {
    const start = timeToMinutes(next.start_time)
    if (validHours && start !== null) {
      next.end_time = minutesToTime(start + hours * 60) ?? ''
    }
  } else if (hasHours && hasEnd) {
    const end = timeToMinutes(next.end_time)
    if (validHours && end !== null) {
      next.start_time = minutesToTime(end - hours * 60) ?? ''
    }
  } else if (hasStart && hasEnd) {
    const duration = calculateTimeSpan(next.start_time, next.end_time)
    if (duration !== null) next.hours = duration
  }

  return next
}

function isoDate(value: Date) {
  const year = value.getFullYear()
  return `${year}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function currentMonday() {
  const value = new Date()
  const day = value.getDay()
  value.setDate(value.getDate() - (day === 0 ? 6 : day - 1))
  value.setHours(12, 0, 0, 0)
  return isoDate(value)
}

function shiftWeek(value: string, amount: number) {
  const date = new Date(`${value}T12:00:00`)
  date.setDate(date.getDate() + amount * 7)
  return isoDate(date)
}

function shortDate(value: string) {
  return formatDateOnly(value, value)
}

function fullDate(value: string) {
  return formatDateOnly(value, value)
}

function formatTime(value: string | null | undefined) {
  return formatDateTime(value)
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function eventLabel(value: string) {
  return statusLabel(value.replace('week_', '').replace('schedule_change_', 'Schedule '))
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

export default function WeeklyTimeReporting() {
  const [weekStart, setWeekStart] = useState(currentMonday)
  const [context, setContext] = useState<WeeklyContext | null>(null)
  const [queue, setQueue] = useState<ReviewQueue | null>(null)
  const [tab, setTab] = useState<'week' | 'schedule' | 'review'>('week')
  const [busy, setBusy] = useState(false)
  const [entryModal, setEntryModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY)
  const linkedTimeDrivers = useRef<LinkedTimeField[]>(['hours'])
  const [scheduleModal, setScheduleModal] = useState(false)
  const [scheduleHours, setScheduleHours] = useState<number[]>([])
  const [scheduleReason, setScheduleReason] = useState('')
  const [reviewModal, setReviewModal] = useState<{
    kind: 'submission' | 'schedule'
    id: string
    action: 'approve' | 'return'
  } | null>(null)
  const [reviewComments, setReviewComments] = useState('')

  const isViewingAnotherUser = Boolean(context && context.user.id !== context.viewer.id)
  const groupedEntries = useMemo(() => {
    const map = new Map<string, TimeEntry[]>()
    for (const entry of context?.entries ?? []) {
      map.set(entry.work_date, [...(map.get(entry.work_date) ?? []), entry])
    }
    return map
  }, [context?.entries])
  const entryTypeOptions = useMemo(() => {
    const configuredTypes = context?.entry_types?.length ? context.entry_types : DEFAULT_ENTRY_TYPES
    const typesByKey = new Map(configuredTypes.map((entryType) => [entryType.type_key, entryType]))
    for (const entry of context?.entries ?? []) {
      if (!typesByKey.has(entry.entry_type)) {
        typesByKey.set(entry.entry_type, {
          id: 0,
          type_key: entry.entry_type,
          label: fallbackEntryTypeLabel(entry.entry_type),
          sort_order: 999,
          is_active: false,
        })
      }
    }
    return [...typesByKey.values()].sort(
      (left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label),
    )
  }, [context?.entries, context?.entry_types])
  const entryTypeLabels = useMemo(
    () => new Map(entryTypeOptions.map((entryType) => [entryType.type_key, entryType.label])),
    [entryTypeOptions],
  )
  const categoryTotals = useMemo(() => {
    const totals = new Map<EntryType, number>()
    for (const entry of context?.entries ?? []) {
      totals.set(entry.entry_type, (totals.get(entry.entry_type) ?? 0) + Number(entry.hours))
    }
    return entryTypeOptions
      .filter((entryType) => totals.has(entryType.type_key))
      .map((entryType) => ({
        entryType: entryType.type_key,
        label: entryType.label,
        hours: Math.round((totals.get(entryType.type_key) ?? 0) * 100) / 100,
      }))
  }, [context?.entries, entryTypeOptions])
  const entryValidation = useMemo(() => {
    const hours = Number(entryForm.hours)
    if (!Number.isFinite(hours) || hours < MIN_ENTRY_HOURS || hours > MAX_ENTRY_HOURS) {
      return {
        valid: false,
        message: `Enter between ${MIN_ENTRY_HOURS} and ${MAX_ENTRY_HOURS} hours.`,
      }
    }

    const hasStart = Boolean(entryForm.start_time)
    const hasEnd = Boolean(entryForm.end_time)
    if (hasStart !== hasEnd) {
      return {
        valid: false,
        message: 'Provide both start and end time, or leave both blank.',
      }
    }
    if (!hasStart) {
      return {
        valid: true,
        message: `Hours must be between ${MIN_ENTRY_HOURS} and ${MAX_ENTRY_HOURS}. Add both times to calculate automatically.`,
      }
    }

    const duration = calculateTimeSpan(entryForm.start_time, entryForm.end_time)
    if (duration === null) {
      return {
        valid: false,
        message: 'End time must be later than start time.',
      }
    }
    if (duration < MIN_ENTRY_HOURS || duration > MAX_ENTRY_HOURS) {
      return {
        valid: false,
        message: `The time span must be between ${MIN_ENTRY_HOURS} and ${MAX_ENTRY_HOURS} hours.`,
      }
    }
    if (Math.abs(hours - duration) > 0.01) {
      return {
        valid: false,
        message: `Hours must equal the ${duration}-hour time span.`,
      }
    }
    return {
      valid: true,
      message: `${duration} hours calculated from the selected start and end time.`,
    }
  }, [entryForm.end_time, entryForm.hours, entryForm.start_time])

  async function loadContext(targetWeek = weekStart, userId?: number) {
    const query = new URLSearchParams({ week_start: targetWeek })
    if (userId) query.set('user_id', String(userId))
    const response = await portalRequestJson<WeeklyContext>(`/api/reports/weekly-time/context?${query}`)
    setContext(response)
    setWeekStart(response.week_start)
    return response
  }

  async function loadQueue() {
    const response = await portalRequestJson<ReviewQueue>('/api/reports/weekly-time/review-queue')
    setQueue(response)
  }

  async function refresh() {
    setBusy(true)
    try {
      const response = await loadContext(weekStart, isViewingAnotherUser ? context?.user.id : undefined)
      if (response.viewer.can_review) await loadQueue()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function changeWeek(nextWeek: string) {
    setBusy(true)
    try {
      await loadContext(nextWeek, isViewingAnotherUser ? context?.user.id : undefined)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function copyPreviousWeek() {
    if (!(await appConfirm(
      'Copy entries from the previous week? Existing entries will be kept.',
      { title: 'Copy previous week', confirmLabel: 'Copy entries' },
    ))) return
    setBusy(true)
    try {
      const response = await portalRequestJson<CopyPreviousWeekResponse>(
        '/api/reports/weekly-time/copy-previous-week',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ week_start: weekStart }),
        },
      )
      setContext(response.context)
      const skipped = response.skipped_holidays + response.skipped_duplicates
      toast.success(
        response.copied
          ? `${response.copied} ${response.copied === 1 ? 'entry' : 'entries'} copied${skipped ? `; ${skipped} skipped` : ''}.`
          : 'No new entries were copied.',
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function openEntry(day: string, entry?: TimeEntry) {
    setEditingEntry(entry ?? null)
    linkedTimeDrivers.current = entry?.start_time && entry?.end_time
      ? ['start_time', 'end_time']
      : ['hours']
    setEntryForm(
      entry
        ? {
            entry_type: entry.entry_type,
            work_date: entry.work_date,
            hours: entry.hours,
            start_time: entry.start_time ?? '',
            end_time: entry.end_time ?? '',
            notes: entry.notes ?? '',
          }
        : { ...EMPTY_ENTRY, work_date: day },
    )
    setEntryModal(true)
  }

  function updateLinkedTimeField(field: LinkedTimeField, value: string) {
    setEntryForm((current) => {
      if ((field === 'start_time' || field === 'end_time') && !value) {
        linkedTimeDrivers.current = ['hours']
        return { ...current, start_time: '', end_time: '' }
      }

      const next = {
        ...current,
        [field]: field === 'hours' ? Number(value) : value,
      }
      linkedTimeDrivers.current = [
        ...linkedTimeDrivers.current.filter((item) => item !== field),
        field,
      ].slice(-2)
      return deriveLinkedTimeValue(next, linkedTimeDrivers.current)
    })
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault()
    if (!entryValidation.valid) {
      toast.error(entryValidation.message)
      return
    }
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>(
        editingEntry
          ? `/api/reports/weekly-time/entries/${editingEntry.entry_id}`
          : '/api/reports/weekly-time/entries',
        {
          method: editingEntry ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...entryForm, week_start: weekStart, hours: Number(entryForm.hours) }),
        },
      )
      setContext(response)
      setEntryModal(false)
      toast.success(editingEntry ? 'Time entry updated.' : 'Time entry added.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function deleteEntry(entry: TimeEntry) {
    if (!(await appConfirm('Delete this time entry?', { title: 'Delete time entry', kind: 'danger', confirmLabel: 'Delete' }))) return
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>(
        `/api/reports/weekly-time/entries/${entry.entry_id}`,
        { method: 'DELETE' },
      )
      setContext(response)
      toast.success('Time entry deleted.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function submitWeek() {
    const memo = await appPrompt('Optional note for your manager:', { title: 'Submit week', confirmLabel: 'Continue' })
    if (memo === null) return
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>('/api/reports/weekly-time/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week_start: weekStart, memo }),
      })
      setContext(response)
      if (response.viewer.can_review) await loadQueue()
      toast.success('Week submitted for review.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function openScheduleRequest(request?: ScheduleRequest) {
    if (!context) return
    setScheduleHours(request?.daily_hours ?? context.schedule_days.map((day) => day.scheduled_hours))
    setScheduleReason(request?.reason ?? '')
    setScheduleModal(true)
  }

  async function withdrawScheduleRequest(request: ScheduleRequest) {
    if (!(await appConfirm(
      'Withdraw this pending schedule request?',
      { title: 'Withdraw schedule request', kind: 'warning', confirmLabel: 'Withdraw' },
    ))) return
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>(
        `/api/reports/weekly-time/schedule-changes/${request.request_id}/withdraw`,
        { method: 'POST' },
      )
      setContext(response)
      toast.success('Schedule request withdrawn.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveScheduleRequest(event: FormEvent) {
    event.preventDefault()
    if (!context) return
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>('/api/reports/weekly-time/schedule-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          week_start: weekStart,
          reason: scheduleReason,
          days: context.schedule_days.map((day, index) => ({
            work_date: day.date,
            hours: Number(scheduleHours[index] ?? 0),
          })),
        }),
      })
      setContext(response)
      setScheduleModal(false)
      toast.success('Schedule change sent to your manager.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openSubmittedWeek(item: ReviewQueue['submissions'][number]) {
    setBusy(true)
    try {
      await loadContext(item.week_start, item.user_id)
      setTab('week')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function completeReview(event: FormEvent) {
    event.preventDefault()
    if (!reviewModal) return
    setBusy(true)
    try {
      if (reviewModal.kind === 'submission') {
        const response = await portalRequestJson<WeeklyContext>(
          `/api/reports/weekly-time/submissions/${reviewModal.id}/review`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: reviewModal.action, comments: reviewComments }),
          },
        )
        setContext(response)
      } else {
        await portalRequestJson<WeeklyContext>(
          `/api/reports/weekly-time/schedule-changes/${reviewModal.id}/review`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: reviewModal.action, comments: reviewComments }),
          },
        )
      }
      await loadQueue()
      setReviewModal(null)
      setReviewComments('')
      toast.success(reviewModal.action === 'approve' ? 'Approved.' : 'Returned for changes.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  if (!context) {
    return (
      <main className="weekly-time weekly-time--loading">
        <RefreshCw className={busy ? 'is-spinning' : ''} />
        <strong>Loading weekly time reporting...</strong>
      </main>
    )
  }

  const status = context.submission.status

  return (
    <main className="weekly-time">
      <header className="weekly-time__header">
        <div>
          <span className="weekly-time__eyebrow">Operations</span>
          <h1>Weekly Time Reporting</h1>
          <p>
            {isViewingAnotherUser
              ? `${context.user.display_name} - ${context.user.team_name ?? 'No team'}`
              : 'Record work, manage your weekly schedule, and submit for review.'}
          </p>
        </div>
        <div className="weekly-time__header-actions">
          {isViewingAnotherUser && (
            <button type="button" className="button button--secondary" onClick={() => void loadContext(weekStart)}>
              <RotateCcw size={17} />
              My week
            </button>
          )}
          <button type="button" className="icon-button" title="Refresh" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={19} className={busy ? 'is-spinning' : ''} />
          </button>
        </div>
      </header>

      <section className="weekly-time__controlbar">
        <div className="weekly-time__week-picker">
          <button type="button" className="icon-button" title="Previous week" onClick={() => void changeWeek(shiftWeek(weekStart, -1))}>
            <ArrowLeft size={18} />
          </button>
          <button type="button" className="button button--secondary" onClick={() => void changeWeek(currentMonday())}>
            Current week
          </button>
          <label>
            <span>Week of</span>
            <input type="date" value={weekStart} onChange={(event) => void changeWeek(event.target.value)} />
          </label>
          <strong>{shortDate(context.week_start)} - {shortDate(context.week_end)}</strong>
          <button type="button" className="icon-button" title="Next week" onClick={() => void changeWeek(shiftWeek(weekStart, 1))}>
            <ArrowRight size={18} />
          </button>
          {context.permissions.can_create && !isViewingAnotherUser && (
            <button type="button" className="button button--secondary" onClick={() => void copyPreviousWeek()} disabled={busy}>
              <Copy size={17} />
              Copy previous week
            </button>
          )}
        </div>
        <span className={`weekly-time__status weekly-time__status--${status}`}>{statusLabel(status)}</span>
      </section>

      {categoryTotals.length > 0 && (
        <section className="weekly-time__metrics" aria-label="Hours by category">
          {categoryTotals.map((category) => (
            <div key={category.entryType}>
              <span>{category.label}</span>
              <strong>{category.hours}</strong>
              <small>hours</small>
            </div>
          ))}
        </section>
      )}

      <nav className="weekly-time__tabs" aria-label="Weekly time views">
        <button type="button" className={tab === 'week' ? 'is-active' : ''} onClick={() => setTab('week')}>
          <CalendarClock size={17} /> My week
        </button>
        <button type="button" className={tab === 'schedule' ? 'is-active' : ''} onClick={() => setTab('schedule')}>
          <History size={17} /> Schedule changes
        </button>
        {context.viewer.can_review && (
          <button type="button" className={tab === 'review' ? 'is-active' : ''} onClick={() => { setTab('review'); void loadQueue() }}>
            <ClipboardCheck size={17} /> Manager review
            {(queue?.submissions.length ?? 0) + (queue?.schedule_requests.length ?? 0) > 0 && (
              <span>{(queue?.submissions.length ?? 0) + (queue?.schedule_requests.length ?? 0)}</span>
            )}
          </button>
        )}
      </nav>

      {tab === 'week' && (
        <>
          {status === 'returned' && context.submission.review_comments && (
            <div className="weekly-time__notice weekly-time__notice--warning">
              <strong>Returned by {context.submission.reviewed_by_name}</strong>
              <span>{context.submission.review_comments}</span>
            </div>
          )}
          <section className="weekly-time__calendar">
            {context.schedule_days.map((day) => {
              const entries = groupedEntries.get(day.date) ?? []
              const total = entries.reduce((sum, entry) => sum + Number(entry.hours), 0)
              return (
                <article key={day.date} className={`weekly-time__day ${day.holiday ? 'is-holiday' : ''}`}>
                  <header>
                    <div>
                      <strong>{fullDate(day.date)}</strong>
                    </div>
                    <b>{total}h</b>
                  </header>
                  {day.holiday && <div className="weekly-time__holiday">{day.holiday.name} - {day.holiday.hours}h</div>}
                  <div className="weekly-time__entries">
                    {entries.length === 0 && <span className="weekly-time__empty">No time recorded</span>}
                    {entries.map((entry) => (
                      <div className="weekly-time__entry" key={entry.entry_id}>
                        <div>
                          <strong>{entryTypeLabels.get(entry.entry_type) ?? fallbackEntryTypeLabel(entry.entry_type)}</strong>
                          <span>{entry.notes || 'No notes'}</span>
                        </div>
                        <b>{entry.hours}h</b>
                        {(context.permissions.can_edit || context.permissions.can_delete) && (
                          <div className="weekly-time__entry-actions">
                            {context.permissions.can_edit && <button type="button" title="Edit entry" onClick={() => openEntry(day.date, entry)}><Pencil size={15} /></button>}
                            {context.permissions.can_delete && <button type="button" title="Delete entry" onClick={() => void deleteEntry(entry)}><Trash2 size={15} /></button>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {context.permissions.can_create && !day.holiday && (
                    <button type="button" className="weekly-time__add" onClick={() => openEntry(day.date)}>
                      <Plus size={16} /> Add entry
                    </button>
                  )}
                </article>
              )
            })}
          </section>

          <footer className="weekly-time__workflow">
            <div>
              <strong>{statusLabel(status)}</strong>
              <span>
                {status === 'draft' && 'Complete the week, then send it to your manager.'}
                {status === 'submitted' && `Submitted ${formatTime(context.submission.submitted_at)}.`}
                {status === 'returned' && 'Update the returned week and submit it again.'}
                {status === 'approved' && `Approved by ${context.submission.reviewed_by_name} ${formatTime(context.submission.reviewed_at)}.`}
              </span>
            </div>
            <div>
              {context.permissions.can_review && (
                <>
                  <button type="button" className="button button--secondary" onClick={() => setReviewModal({ kind: 'submission', id: context.submission.submission_id, action: 'return' })}>
                    <RotateCcw size={17} /> Return
                  </button>
                  <button type="button" className="button button--primary" onClick={() => setReviewModal({ kind: 'submission', id: context.submission.submission_id, action: 'approve' })}>
                    <Check size={17} /> Approve
                  </button>
                </>
              )}
              {context.permissions.can_submit && (
                <button type="button" className="button button--primary" onClick={() => void submitWeek()} disabled={busy}>
                  <Send size={17} /> Submit for review
                </button>
              )}
            </div>
          </footer>
        </>
      )}

      {tab === 'schedule' && (
        <section className="weekly-time__panel">
          <header>
            <div>
              <h2>Schedule changes</h2>
              <p>Propose a different work schedule for any selected week. Your manager must approve it.</p>
            </div>
            {context.permissions.can_request_schedule_change && (
              <button type="button" className="button button--primary" onClick={() => openScheduleRequest()}>
                <Plus size={17} /> Request change
              </button>
            )}
          </header>
          <table className="weekly-time__table">
            <thead><tr><th>Week</th><th>Requested hours</th><th>Reason</th><th>Status</th><th>Review note</th><th>Actions</th></tr></thead>
            <tbody>
              {context.schedule_requests.length === 0 && <tr><td colSpan={6} className="empty-cell">No schedule change requests for this week.</td></tr>}
              {context.schedule_requests.map((request) => (
                <tr key={request.request_id}>
                  <td>{shortDate(request.week_start)} - {shortDate(request.week_end)}</td>
                  <td>{request.daily_hours.reduce((sum, value) => sum + Number(value), 0)} hours</td>
                  <td>{request.reason}</td>
                  <td><span className={`weekly-time__status weekly-time__status--${request.status}`}>{statusLabel(request.status)}</span></td>
                  <td>{request.review_comments || '-'}</td>
                  <td className="weekly-time__table-actions">
                    {request.status === 'pending' && <button type="button" title="Withdraw request" onClick={() => void withdrawScheduleRequest(request)}><X size={16} /></button>}
                    {request.status === 'returned' && <button type="button" title="Revise request" onClick={() => openScheduleRequest(request)}><Pencil size={16} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="weekly-time__history">
            <h3>Workflow history</h3>
            {context.events.length === 0 && <p>No workflow activity has been recorded.</p>}
            {context.events.map((item) => (
              <div key={item.event_id}>
                <strong>{eventLabel(item.event_type)}</strong>
                <span>{item.actor_name} - {formatTime(item.event_at)}</span>
                {item.memo && <p>{item.memo}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'review' && context.viewer.can_review && (
        <section className="weekly-time__panel">
          <header>
            <div>
              <h2>Manager review</h2>
              <p>Weekly reports and schedule changes awaiting your decision.</p>
            </div>
            <button type="button" className="button button--secondary" onClick={() => void loadQueue()}>
              <RefreshCw size={17} /> Refresh queue
            </button>
          </header>
          <h3>Weekly submissions</h3>
          <table className="weekly-time__table">
            <thead><tr><th>Employee</th><th>Team</th><th>Week</th><th>Submitted</th><th>Action</th></tr></thead>
            <tbody>
              {(queue?.submissions.length ?? 0) === 0 && <tr><td colSpan={5} className="empty-cell">No weekly reports are waiting.</td></tr>}
              {queue?.submissions.map((item) => (
                <tr key={item.submission_id}>
                  <td>{item.employee_name}</td><td>{item.team_name || '-'}</td>
                  <td>{shortDate(item.week_start)} - {shortDate(item.week_end)}</td>
                  <td>{formatTime(item.submitted_at)}</td>
                  <td><button type="button" className="table-link" onClick={() => void openSubmittedWeek(item)}>Review week</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Schedule requests</h3>
          <table className="weekly-time__table">
            <thead><tr><th>Employee</th><th>Team</th><th>Week</th><th>Hours</th><th>Reason</th><th>Actions</th></tr></thead>
            <tbody>
              {(queue?.schedule_requests.length ?? 0) === 0 && <tr><td colSpan={6} className="empty-cell">No schedule requests are waiting.</td></tr>}
              {queue?.schedule_requests.map((request) => (
                <tr key={request.request_id}>
                  <td>{request.employee_name}</td><td>{request.team_name || '-'}</td>
                  <td>{shortDate(request.week_start)} - {shortDate(request.week_end)}</td>
                  <td>{request.daily_hours.reduce((sum, value) => sum + Number(value), 0)}</td>
                  <td>{request.reason}</td>
                  <td className="weekly-time__table-actions">
                    <button type="button" title="Approve" onClick={() => setReviewModal({ kind: 'schedule', id: request.request_id, action: 'approve' })}><Check size={16} /></button>
                    <button type="button" title="Return" onClick={() => setReviewModal({ kind: 'schedule', id: request.request_id, action: 'return' })}><RotateCcw size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {entryModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal" onSubmit={saveEntry}>
            <header><h2>{editingEntry ? 'Edit time entry' : 'Add time entry'}</h2><button type="button" onClick={() => setEntryModal(false)}><X /></button></header>
            <div className="weekly-time__form-grid">
              <label><span>Date</span><input type="date" value={entryForm.work_date} min={context.week_start} max={context.week_end} onChange={(event) => setEntryForm({ ...entryForm, work_date: event.target.value })} required /></label>
              <label>
                <span>Type</span>
                <select value={entryForm.entry_type} onChange={(event) => setEntryForm({ ...entryForm, entry_type: event.target.value })}>
                  {entryTypeOptions
                    .filter((entryType) => entryType.is_active || entryType.type_key === entryForm.entry_type)
                    .map((entryType) => <option key={entryType.type_key} value={entryType.type_key}>{entryType.label}</option>)}
                </select>
              </label>
              <label><span>Hours</span><input type="number" min={MIN_ENTRY_HOURS} max={MAX_ENTRY_HOURS} step="0.01" value={entryForm.hours} onChange={(event) => updateLinkedTimeField('hours', event.target.value)} aria-invalid={!entryValidation.valid} required /></label>
              <label><span>Start time</span><input type="time" value={entryForm.start_time} onChange={(event) => updateLinkedTimeField('start_time', event.target.value)} /></label>
              <label><span>End time</span><input type="time" value={entryForm.end_time} onChange={(event) => updateLinkedTimeField('end_time', event.target.value)} /></label>
              <p className={`weekly-time__duration-help span-2${entryValidation.valid ? '' : ' is-error'}`} aria-live="polite">
                {entryValidation.message}
              </p>
              <label className="span-2"><span>Notes</span><textarea rows={3} value={entryForm.notes} onChange={(event) => setEntryForm({ ...entryForm, notes: event.target.value })} /></label>
            </div>
            <footer><button type="button" className="button button--secondary" onClick={() => setEntryModal(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={busy || !entryValidation.valid}>Save entry</button></footer>
          </form>
        </div>
      )}

      {scheduleModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal weekly-time__modal--wide" onSubmit={saveScheduleRequest}>
            <header><h2>Request schedule change</h2><button type="button" onClick={() => setScheduleModal(false)}><X /></button></header>
            <div className="weekly-time__schedule-form">
              {context.schedule_days.map((day, index) => (
                <label key={day.date}><span>{fullDate(day.date)}</span><input type="number" min="0" max="24" step="0.5" value={scheduleHours[index] ?? 0} onChange={(event) => setScheduleHours(scheduleHours.map((value, itemIndex) => itemIndex === index ? Number(event.target.value) : value))} /></label>
              ))}
            </div>
            <label className="weekly-time__reason"><span>Reason</span><textarea rows={3} value={scheduleReason} onChange={(event) => setScheduleReason(event.target.value)} required /></label>
            <footer><strong>{scheduleHours.reduce((sum, value) => sum + Number(value || 0), 0)} hours</strong><button type="button" className="button button--secondary" onClick={() => setScheduleModal(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={busy}>Send request</button></footer>
          </form>
        </div>
      )}

      {reviewModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal weekly-time__modal--review" onSubmit={completeReview}>
            <header><h2>{reviewModal.action === 'approve' ? 'Approve' : 'Return for changes'}</h2><button type="button" onClick={() => setReviewModal(null)}><X /></button></header>
            <label className="weekly-time__reason">
              <span>{reviewModal.action === 'return' ? 'Comments (required)' : 'Comments (optional)'}</span>
              <textarea rows={4} value={reviewComments} onChange={(event) => setReviewComments(event.target.value)} required={reviewModal.action === 'return'} />
            </label>
            <footer><button type="button" className="button button--secondary" onClick={() => setReviewModal(null)}>Cancel</button><button type="submit" className="button button--primary" disabled={busy}>{reviewModal.action === 'approve' ? 'Approve' : 'Return'}</button></footer>
          </form>
        </div>
      )}
    </main>
  )
}
