import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { portalRequestBinary, portalRequestJson } from '../../../desktop/request'
import { saveExportAs } from '../../../desktop/runtime'

type InsightsWindow = '12w' | '6m' | 'ytd' | 'year' | 'all' | 'custom'

type WeeklyInsights = {
  scope: 'self' | 'all'
  window: InsightsWindow
  bucket: 'week' | 'month' | 'year'
  year: number
  start: string
  end: string
  available_years: number[]
  can_view_all: boolean
  entry_types: { key: string; label: string }[]
  buckets: { key: string; label: string; totals: Record<string, number>; total: number }[]
  people: { name: string; team: string | null; totals: Record<string, number>; total: number }[]
}

const INSIGHTS_WINDOW_LABELS: Record<InsightsWindow, string> = {
  '12w': 'Last 12 weeks',
  '6m': 'Last 6 months',
  ytd: 'Year to date',
  year: 'Specific year',
  all: 'All years',
  custom: 'Custom range',
}
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
  time_off: boolean
}

type TimeOffRequestRecord = {
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

const EMPTY_TIME_OFF = { start_date: '', end_date: '', reason: '' }

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
  time_off_requests: TimeOffRequestRecord[]
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

type MatrixCell = {
  submission_id: string
  status: SubmissionStatus
  hours: number | null
  target_hours: number | null
  submitted_at: string | null
}

type ReviewMatrix = {
  weeks: { week_start: string; week_end: string }[]
  rows: {
    user_id: number
    name: string
    employee_id: string
    team_id: number | null
    team_name: string | null
    cells: Record<string, MatrixCell>
  }[]
  counts: Record<string, number>
  teams: { team_id: number; name: string }[]
  people: { user_id: number; name: string; team_id: number | null }[]
  end_week: string
  weeks_shown: number
  max_weeks: number
  can_reopen: boolean
}

const MATRIX_SPANS = [8, 12, 16, 26]

// Glyph plus label, never colour alone: the cell has to read for someone who cannot
// tell the green from the amber.
const MATRIX_LEGEND: { status: string; mark: string; label: string }[] = [
  { status: 'approved', mark: '\u2713', label: 'Approved' },
  { status: 'submitted', mark: '\u25cf', label: 'Waiting on review' },
  { status: 'returned', mark: '\u26a0', label: 'Returned' },
  { status: 'draft', mark: '\u25cb', label: 'Draft' },
  { status: 'missing', mark: '\u2014', label: 'Not submitted' },
]

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

function weekdayName(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' })
}

function isWeekendDate(value: string) {
  const day = new Date(`${value}T00:00:00`).getDay()
  return day === 0 || day === 6
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
  const [tab, setTab] = useState<'week' | 'review' | 'insights'>('week')
  const [insights, setInsights] = useState<WeeklyInsights | null>(null)
  const [insightsScope, setInsightsScope] = useState<'self' | 'all'>('self')
  const [insightsWindow, setInsightsWindow] = useState<InsightsWindow>('12w')
  const [insightsYear, setInsightsYear] = useState<number | null>(null)
  const [weekView, setWeekView] = useState<'cards' | 'grid'>('cards')
  const [gridDraft, setGridDraft] = useState<Record<string, number> | null>(null)
  const [gridBusy, setGridBusy] = useState(false)
  const [insightsStart, setInsightsStart] = useState('')
  const [insightsEnd, setInsightsEnd] = useState('')
  const [insightsLoading, setInsightsLoading] = useState(false)

  useEffect(() => {
    if (tab !== 'insights' || !context) return
    if (insightsWindow === 'custom' && !(insightsStart && insightsEnd)) return
    let cancelled = false
    setInsightsLoading(true)
    portalRequestJson<WeeklyInsights>(
      `/api/reports/weekly-time/insights?week_start=${context.week_start}&scope=${insightsScope}`
      + `&window=${insightsWindow}${insightsYear ? `&year=${insightsYear}` : ''}`
      + (insightsWindow === 'custom' ? `&start=${insightsStart}&end=${insightsEnd}` : ''),
    )
      .then((response) => {
        if (!cancelled) setInsights(response)
      })
      .catch((requestError) => {
        if (!cancelled) toast.error(requestError instanceof Error ? requestError.message : 'The insights could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setInsightsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, insightsScope, insightsWindow, insightsYear, insightsStart, insightsEnd, context?.week_start])

  const [busy, setBusy] = useState(false)
  const [entryModal, setEntryModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY)
  const linkedTimeDrivers = useRef<LinkedTimeField[]>(['hours'])
  const [matrix, setMatrix] = useState<ReviewMatrix | null>(null)
  const [matrixSpan, setMatrixSpan] = useState(12)
  const [matrixEndWeek, setMatrixEndWeek] = useState<string | null>(null)
  const [matrixPerson, setMatrixPerson] = useState<number | null>(null)
  const [matrixTeam, setMatrixTeam] = useState<number | null>(null)
  const [matrixStatus, setMatrixStatus] = useState<string>('')
  const [matrixBusy, setMatrixBusy] = useState(false)
  const [selected, setSelected] = useState<Record<string, true>>({})
  const [bulkModal, setBulkModal] = useState<'approve' | 'return' | 'reopen' | null>(null)
  const [bulkComments, setBulkComments] = useState('')
  const [timeOffModal, setTimeOffModal] = useState(false)
  const [timeOffForm, setTimeOffForm] = useState(EMPTY_TIME_OFF)
  const [timeOffQueue, setTimeOffQueue] = useState<TimeOffRequestRecord[]>([])
  const [timeOffReview, setTimeOffReview] = useState<{ id: string; action: 'approve' | 'return' } | null>(null)
  const selectedIds = useMemo(() => Object.keys(selected), [selected])
  const [reviewModal, setReviewModal] = useState<{
    id: string
    action: 'approve' | 'return' | 'reopen'
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
  // The grid lists the work types someone can actually pick. A retired type still
  // appears if this week already has hours against it, so those hours stay visible
  // and the day totals below them stay honest.
  const gridRowTypes = useMemo(
    () => entryTypeOptions.filter(
      (entryType) => entryType.is_active
        || (context?.entries ?? []).some((entry) => entry.entry_type === entryType.type_key),
    ),
    [entryTypeOptions, context?.entries],
  )
  const gridCells = useMemo(() => {
    const totals = new Map<string, { hours: number; count: number }>()
    for (const entry of context?.entries ?? []) {
      const key = `${entry.work_date}|${entry.entry_type}`
      const current = totals.get(key) ?? { hours: 0, count: 0 }
      totals.set(key, { hours: current.hours + Number(entry.hours), count: current.count + 1 })
    }
    return totals
  }, [context?.entries])
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
    const parameters = new URLSearchParams({ weeks: String(matrixSpan) })
    if (matrixEndWeek) parameters.set('end_week', matrixEndWeek)
    if (matrixPerson) parameters.set('people', String(matrixPerson))
    if (matrixTeam) parameters.set('team_id', String(matrixTeam))
    if (matrixStatus) parameters.set('status', matrixStatus)
    setMatrixBusy(true)
    try {
      const response = await portalRequestJson<ReviewMatrix>(
        `/api/reports/weekly-time/review-matrix?${parameters.toString()}`,
      )
      setMatrix(response)
      const pending = await portalRequestJson<{ time_off_requests: TimeOffRequestRecord[] }>(
        '/api/reports/weekly-time/review-queue?status=submitted',
      )
      setTimeOffQueue(pending.time_off_requests)
      // Anything no longer on screen must leave the selection, or a bulk action
      // would act on weeks the manager can no longer see.
      const visible = new Set(response.rows.flatMap((row) => Object.values(row.cells).map((cell) => cell.submission_id)))
      setSelected((current) => Object.fromEntries(
        Object.keys(current).filter((id) => visible.has(id)).map((id) => [id, true as const]),
      ))
    } finally {
      setMatrixBusy(false)
    }
  }

  async function submitTimeOff(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const response = await portalRequestJson<{ weeks: number; working_days: number; context: WeeklyContext }>(
        '/api/reports/weekly-time/time-off',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(timeOffForm),
        },
      )
      setContext(response.context)
      setTimeOffModal(false)
      setTimeOffForm(EMPTY_TIME_OFF)
      toast.success(
        `${response.working_days} business day${response.working_days === 1 ? '' : 's'} requested`
        + (response.weeks > 1 ? ` across ${response.weeks} weeks.` : '.'),
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function withdrawTimeOff(requestId: string) {
    if (!(await appConfirm('Withdraw this time-off request?', {
      title: 'Withdraw request', kind: 'warning', confirmLabel: 'Withdraw',
    }))) return
    setBusy(true)
    try {
      const response = await portalRequestJson<WeeklyContext>(
        `/api/reports/weekly-time/time-off/${requestId}/withdraw`, { method: 'POST' },
      )
      setContext(response)
      toast.success('Time-off request withdrawn.')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function decideTimeOff(event: FormEvent) {
    event.preventDefault()
    if (!timeOffReview) return
    setBusy(true)
    try {
      const response = await portalRequestJson<{ status: string; leave_entries: number }>(
        `/api/reports/weekly-time/time-off/${timeOffReview.id}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: timeOffReview.action, comments: reviewComments }),
        },
      )
      setTimeOffReview(null)
      setReviewComments('')
      await loadQueue()
      toast.success(
        response.status === 'approved'
          ? `Approved - ${response.leave_entries} leave entr${response.leave_entries === 1 ? 'y' : 'ies'} added.`
          : 'Returned to the employee.',
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function runBulkReview() {
    if (!bulkModal) return
    const ids = Object.keys(selected)
    setBusy(true)
    try {
      const response = await portalRequestJson<{ changed: number; skipped: string[] }>(
        '/api/reports/weekly-time/submissions/bulk-review',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submission_ids: ids, action: bulkModal, comments: bulkComments }),
        },
      )
      setBulkModal(null)
      setBulkComments('')
      setSelected({})
      await loadQueue()
      if (response.skipped.length) {
        toast.warning(`${response.changed} updated, ${response.skipped.length} skipped: ${response.skipped.join('; ')}`)
      } else {
        toast.success(`${response.changed} week${response.changed === 1 ? '' : 's'} updated.`)
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
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

  useEffect(() => {
    if (tab !== 'review' || !context?.viewer.can_review) return
    void loadQueue().catch((error) => toast.error(errorText(error)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, matrixSpan, matrixEndWeek, matrixPerson, matrixTeam, matrixStatus, context?.viewer.can_review])

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

  async function openSubmittedWeek(item: { week_start: string; user_id: number }) {
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
      const response = await portalRequestJson<WeeklyContext>(
        `/api/reports/weekly-time/submissions/${reviewModal.id}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: reviewModal.action, comments: reviewComments }),
        },
      )
      setContext(response)
      await loadQueue()
      setReviewModal(null)
      setReviewComments('')
      toast.success(
        reviewModal.action === 'approve'
          ? 'Approved.'
          : reviewModal.action === 'reopen'
            ? 'Week reopened for edits.'
            : 'Returned for changes.',
      )
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
        <button type="button" className={tab === 'insights' ? 'is-active' : ''} onClick={() => setTab('insights')}>
          <CalendarClock size={17} /> Insights
        </button>
        {context.viewer.can_review && (
          <button type="button" className={tab === 'review' ? 'is-active' : ''} onClick={() => { setTab('review'); void loadQueue() }}>
            <ClipboardCheck size={17} /> Manager review
            {(matrix?.counts.submitted ?? 0) > 0 && <span>{matrix?.counts.submitted}</span>}
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
          <div className="weekly-time__week-summary">
            <div>
              <span>Recorded</span>
              <b>{context.summary.reported_hours}h</b>
            </div>
            <div>
              <span>Scheduled target</span>
              <b>{context.summary.target_hours}h</b>
            </div>
            <div>
              <span>Remaining</span>
              <b className={context.summary.remaining_hours < 0 ? 'is-over' : undefined}>
                {context.summary.remaining_hours}h
              </b>
            </div>
          </div>
          <div className="weekly-time__view-bar">
            <div className="weekly-time__view-toggle" role="group" aria-label="Week view">
              <button type="button" className={weekView === 'cards' ? 'is-active' : ''} onClick={() => setWeekView('cards')}>
                Day cards
              </button>
              <button type="button" className={weekView === 'grid' ? 'is-active' : ''} onClick={() => { setWeekView('grid'); setGridDraft(null) }}>
                Grid edit
              </button>
            </div>
            {context.permissions.can_request_schedule_change && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  setTimeOffForm({ ...EMPTY_TIME_OFF, start_date: context.week_start, end_date: context.week_start })
                  setTimeOffModal(true)
                }}
              >
                <CalendarClock size={16} /> Request time off
              </button>
            )}
          </div>
          {context.time_off_requests.length > 0 && (
            <div className="weekly-time__timeoff-strip">
              {context.time_off_requests.map((request) => (
                <div key={request.request_id}>
                  <span className={`weekly-time__status weekly-time__status--${request.status}`}>
                    {statusLabel(request.status)}
                  </span>
                  <strong>{request.daily_hours.reduce((sum, value) => sum + Number(value || 0), 0)}h time off</strong>
                  <span>{request.reason}</span>
                  {request.review_comments && <em>{request.review_comments}</em>}
                  {request.status === 'pending' && (
                    <button type="button" className="table-link" onClick={() => void withdrawTimeOff(request.request_id)}>
                      Withdraw
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {weekView === 'grid' ? (
            <div className="weekly-time__grid-wrap">
              <table className="weekly-time__grid">
                <thead>
                  <tr>
                    <th>Work type</th>
                    {context.schedule_days.filter((day) => !isWeekendDate(day.date)).map((day) => (
                      <th key={day.date}>
                        {weekdayName(day.date).slice(0, 3)}
                        <span>{shortDate(day.date)}</span>
                      </th>
                    ))}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {gridRowTypes.map((entryType) => {
                    const weekdays = context.schedule_days.filter((day) => !isWeekendDate(day.date))
                    const rowTotal = weekdays.reduce((sum, day) => {
                      const key = `${day.date}|${entryType.type_key}`
                      const draft = gridDraft?.[key]
                      return sum + (draft ?? gridCells.get(key)?.hours ?? 0)
                    }, 0)
                    return (
                      <tr key={entryType.type_key}>
                        <th>{entryType.label}</th>
                        {weekdays.map((day) => {
                          const key = `${day.date}|${entryType.type_key}`
                          const cell = gridCells.get(key)
                          const locked = (cell?.count ?? 0) > 1
                          const value = gridDraft?.[key] ?? cell?.hours ?? 0
                          return (
                            <td key={key}>
                              <input
                                type="number"
                                min="0"
                                max="8"
                                step="0.5"
                                disabled={gridBusy || locked || day.target_hours <= 0
                                  || (day.time_off && entryType.type_key !== 'leave')
                                  || !context.permissions.can_edit}
                                title={locked
                                  ? 'Several entries share this day and work type - edit them on the day cards.'
                                  : day.time_off
                                    ? 'Approved time off - only leave can be recorded'
                                    : day.holiday
                                      ? `${day.holiday.name} - ${day.target_hours}h can still be recorded`
                                      : undefined}
                                value={value || ''}
                                placeholder="0"
                                onChange={(event) => {
                                  const next = { ...(gridDraft ?? {}) }
                                  next[key] = Number(event.currentTarget.value || 0)
                                  setGridDraft(next)
                                }}
                              />
                            </td>
                          )
                        })}
                        <td className="weekly-time__grid-total">{rowTotal ? rowTotal.toFixed(1) : '\u2014'}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Day total</th>
                    {context.schedule_days.filter((day) => !isWeekendDate(day.date)).map((day) => {
                      const dayTotal = gridRowTypes.reduce((sum, entryType) => {
                        const key = `${day.date}|${entryType.type_key}`
                        return sum + (gridDraft?.[key] ?? gridCells.get(key)?.hours ?? 0)
                      }, 0)
                      return (
                        <td key={day.date} className={dayTotal > 8 ? 'is-over' : undefined}>
                          {dayTotal ? dayTotal.toFixed(1) : '\u2014'}
                        </td>
                      )
                    })}
                    <td className="weekly-time__grid-total">
                      {context.schedule_days
                        .filter((day) => !isWeekendDate(day.date))
                        .reduce((sum, day) => sum + gridRowTypes.reduce((rowSum, entryType) => {
                          const key = `${day.date}|${entryType.type_key}`
                          return rowSum + (gridDraft?.[key] ?? gridCells.get(key)?.hours ?? 0)
                        }, 0), 0)
                        .toFixed(1)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <div className="weekly-time__grid-actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={gridBusy || !gridDraft || !context.permissions.can_edit}
                  onClick={async () => {
                    if (!gridDraft) return
                    setGridBusy(true)
                    try {
                      const cells = Object.entries(gridDraft).map(([key, hours]) => {
                        const [work_date, entry_type] = key.split('|')
                        return { work_date, entry_type, hours }
                      })
                      const response = await portalRequestJson<{ context: WeeklyContext; created: number; updated: number; removed: number }>(
                        '/api/reports/weekly-time/entries/grid',
                        { method: 'PUT', body: JSON.stringify({ week_start: context.week_start, cells }) },
                      )
                      setContext(response.context)
                      setGridDraft(null)
                      toast.success(`Saved: ${response.created} added, ${response.updated} changed, ${response.removed} removed.`)
                    } catch (saveError) {
                      toast.error(saveError instanceof Error ? saveError.message : 'The week could not be saved.')
                    } finally {
                      setGridBusy(false)
                    }
                  }}
                >
                  Save week
                </button>
                {gridDraft && (
                  <button type="button" className="button" disabled={gridBusy} onClick={() => setGridDraft(null)}>
                    Discard changes
                  </button>
                )}
                <span className="weekly-time__grid-hint">
                  Type hours per work type and day, then save. Weekends are closed, and a holiday
                  only leaves whatever hours it did not take.
                </span>
              </div>
            </div>
          ) : (
          <section className="weekly-time__calendar">
            {context.schedule_days.map((day) => {
              const entries = groupedEntries.get(day.date) ?? []
              const total = entries.reduce((sum, entry) => sum + Number(entry.hours), 0)
              const weekend = isWeekendDate(day.date)
              return (
                <article key={day.date} className={`weekly-time__day ${day.holiday ? 'is-holiday' : ''} ${weekend ? 'is-weekend' : ''}`}>
                  <header>
                    <div>
                      <strong>{weekdayName(day.date)}</strong>
                      <span className="weekly-time__day-date">{fullDate(day.date)}</span>
                    </div>
                    <b className={total > day.target_hours ? 'is-over' : undefined}>
                      {total}h
                      {day.target_hours > 0 && <span className="weekly-time__day-target"> / {day.target_hours}h</span>}
                    </b>
                  </header>
                  {day.holiday && (
                    <div className="weekly-time__holiday">
                      {day.holiday.name} - {day.holiday.hours}h
                      {day.target_hours > 0 && ` (${day.target_hours}h still enterable)`}
                    </div>
                  )}
                  {weekend && <div className="weekly-time__holiday">Weekend - no time entry</div>}
                  {day.time_off && <div className="weekly-time__holiday">Approved time off</div>}
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
                  {context.permissions.can_create && day.target_hours > 0 && !weekend && !day.time_off && (
                    <button type="button" className="weekly-time__add" onClick={() => openEntry(day.date)}>
                      <Plus size={16} /> Add entry
                    </button>
                  )}
                </article>
              )
            })}
          </section>
          )}

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
                  <button type="button" className="button button--secondary" onClick={() => setReviewModal({ id: context.submission.submission_id, action: 'return' })}>
                    <RotateCcw size={17} /> Return
                  </button>
                  <button type="button" className="button button--primary" onClick={() => setReviewModal({ id: context.submission.submission_id, action: 'approve' })}>
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
        </>
      )}

      {tab === 'insights' && (
        <section className="weekly-time__insights">
          <header className="weekly-time__insights-header">
            <div>
              <h2>Hours by work type</h2>
              <p>
                Submitted and approved weeks only
                {insights ? ` · ${INSIGHTS_WINDOW_LABELS[insights.window]} · by ${insights.bucket}` : ''}.
              </p>
            </div>
            <div className="weekly-time__insights-controls">
              <label className="weekly-time__insights-range">
                <span>Range</span>
                <select
                  value={insightsWindow}
                  onChange={(event) => {
                    const next = event.currentTarget.value as InsightsWindow
                    setInsightsWindow(next)
                    if (next !== 'year') setInsightsYear(null)
                    else if (!insightsYear) setInsightsYear(insights?.year ?? new Date().getFullYear())
                  }}
                >
                  {(Object.keys(INSIGHTS_WINDOW_LABELS) as InsightsWindow[]).map((value) => (
                    <option key={value} value={value}>{INSIGHTS_WINDOW_LABELS[value]}</option>
                  ))}
                </select>
              </label>
              {insightsWindow === 'custom' && (
                <>
                  <label className="weekly-time__insights-range">
                    <span>From</span>
                    <input type="date" value={insightsStart} onChange={(event) => setInsightsStart(event.currentTarget.value)} />
                  </label>
                  <label className="weekly-time__insights-range">
                    <span>To</span>
                    <input type="date" value={insightsEnd} onChange={(event) => setInsightsEnd(event.currentTarget.value)} />
                  </label>
                </>
              )}
              <button
                type="button"
                className="weekly-time__insights-export"
                disabled={!insights || insightsLoading}
                onClick={async () => {
                  if (!context) return
                  try {
                    const query = `week_start=${context.week_start}&scope=${insightsScope}&window=${insightsWindow}`
                      + (insightsYear ? `&year=${insightsYear}` : '')
                      + (insightsWindow === 'custom' ? `&start=${insightsStart}&end=${insightsEnd}` : '')
                    const file = await portalRequestBinary(`/api/reports/weekly-time/insights/export?${query}`)
                    await saveExportAs(`Weekly-Time-Insights-${insights?.start ?? ''}-to-${insights?.end ?? ''}.xlsx`, file.bytes, 'excel')
                    toast.success('Insights exported.')
                  } catch (exportError) {
                    if (exportError instanceof Error && /cancel/i.test(exportError.message)) return
                    toast.error(exportError instanceof Error ? exportError.message : 'The export failed.')
                  }
                }}
              >
                Export to Excel
              </button>
              {insightsWindow === 'year' && (
                <label className="weekly-time__insights-range">
                  <span>Year</span>
                  <select
                    value={insightsYear ?? ''}
                    onChange={(event) => setInsightsYear(Number(event.currentTarget.value))}
                  >
                    {(insights?.available_years.length ? insights.available_years : [new Date().getFullYear()]).map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {insights?.can_view_all && (
              <div className="weekly-time__insights-scope" role="group" aria-label="Whose hours">
                <button
                  type="button"
                  className={insightsScope === 'self' ? 'is-active' : ''}
                  onClick={() => setInsightsScope('self')}
                >
                  My hours
                </button>
                <button
                  type="button"
                  className={insightsScope === 'all' ? 'is-active' : ''}
                  onClick={() => setInsightsScope('all')}
                >
                  Everyone
                </button>
              </div>
            )}
          </header>
          {insightsLoading && <p className="weekly-time__empty">Loading insights…</p>}
          {!insightsLoading && insights && (
            <>
              <div className="weekly-time__matrix-wrap">
                <table className="weekly-time__matrix">
                  <thead>
                    <tr>
                      <th className="weekly-time__matrix-type">Work type</th>
                      {insights.buckets.map((bucket) => (
                        <th key={bucket.key} title={bucket.key}>{bucket.label}</th>
                      ))}
                      <th className="weekly-time__matrix-total">Total</th>
                      <th className="weekly-time__matrix-total">Avg/wk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.entry_types.map((entryType) => {
                      const rowValues = insights.buckets.map((bucket) => bucket.totals[entryType.key] ?? 0)
                      const rowTotal = rowValues.reduce((sum, value) => sum + value, 0)
                      const activeWeeks = insights.buckets.filter((bucket) => bucket.total > 0).length
                      const peak = Math.max(1, ...insights.buckets.flatMap((bucket) =>
                        insights.entry_types.map((item) => bucket.totals[item.key] ?? 0)))
                      return (
                        <tr key={entryType.key}>
                          <th className="weekly-time__matrix-type">{entryType.label}</th>
                          {rowValues.map((value, index) => (
                            <td
                              key={insights.buckets[index].key}
                              className="weekly-time__matrix-cell"
                              title={`${entryType.label} · ${insights.buckets[index].label}: ${value ? `${value}h` : 'no hours'}`}
                              style={value ? { background: `rgba(37, 90, 143, ${(0.06 + 0.3 * (value / peak)).toFixed(3)})` } : undefined}
                            >
                              {value ? value.toFixed(value % 1 ? 1 : 0) : '\u2014'}
                            </td>
                          ))}
                          <td className="weekly-time__matrix-total">{rowTotal ? rowTotal.toFixed(1) : '\u2014'}</td>
                          <td className="weekly-time__matrix-total">
                            {rowTotal && activeWeeks ? (rowTotal / activeWeeks).toFixed(1) : '\u2014'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th className="weekly-time__matrix-type">Period total</th>
                      {insights.buckets.map((bucket) => (
                        <td key={bucket.key} className="weekly-time__matrix-total">
                          {bucket.total ? bucket.total.toFixed(1) : '\u2014'}
                        </td>
                      ))}
                      <td className="weekly-time__matrix-total">
                        {insights.buckets.reduce((sum, week) => sum + week.total, 0).toFixed(1)}
                      </td>
                      <td className="weekly-time__matrix-total" />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="weekly-time__insights-summary">
                <div>
                  <span>Total</span>
                  <b>{insights.buckets.reduce((sum, bucket) => sum + bucket.total, 0).toFixed(1)}h</b>
                </div>
                <div>
                  <span>Average / period</span>
                  <b>{(insights.buckets.reduce((sum, bucket) => sum + bucket.total, 0) / Math.max(1, insights.buckets.filter((bucket) => bucket.total > 0).length)).toFixed(1)}h</b>
                </div>
                <div>
                  <span>Periods counted</span>
                  <b>{insights.buckets.filter((bucket) => bucket.total > 0).length}</b>
                </div>
              </div>
              {insights.scope === 'all' && insights.people.length > 0 && (
                <div className="weekly-time__insights-table-wrap">
                  <table className="weekly-time__insights-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Team</th>
                        {insights.entry_types.map((entryType) => <th key={entryType.key}>{entryType.label}</th>)}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.people.map((person) => (
                        <tr key={person.name}>
                          <td>{person.name}</td>
                          <td>{person.team ?? '—'}</td>
                          {insights.entry_types.map((entryType) => (
                            <td key={entryType.key}>{person.totals[entryType.key]?.toFixed(1) ?? ''}</td>
                          ))}
                          <td><b>{person.total.toFixed(1)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!insights.buckets.some((bucket) => bucket.total > 0) && (
                <p className="weekly-time__empty">No submitted or approved weeks in this range yet.</p>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'review' && context.viewer.can_review && (
        <section className="weekly-time__panel">
          <header>
            <div>
              <h2>Manager review</h2>
              <p>Weekly reports awaiting your decision.</p>
            </div>
            <button type="button" className="button button--secondary" onClick={() => void loadQueue()}>
              <RefreshCw size={17} /> Refresh queue
            </button>
          </header>
          <div className="weekly-time__filters">
            <label>
              <span>Person</span>
              <select
                value={matrixPerson ?? ''}
                onChange={(event) => { setMatrixPerson(Number(event.currentTarget.value) || null); setSelected({}) }}
              >
                <option value="">Everyone</option>
                {matrix?.people.map((person) => (
                  <option key={person.user_id} value={person.user_id}>{person.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Team</span>
              <select
                value={matrixTeam ?? ''}
                onChange={(event) => { setMatrixTeam(Number(event.currentTarget.value) || null); setSelected({}) }}
              >
                <option value="">All teams</option>
                {matrix?.teams.map((team) => (
                  <option key={team.team_id} value={team.team_id}>{team.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={matrixStatus} onChange={(event) => setMatrixStatus(event.currentTarget.value)}>
                <option value="">Any status</option>
                <option value="submitted">Waiting on review</option>
                <option value="approved">Approved</option>
                <option value="returned">Returned</option>
                <option value="draft">Draft</option>
              </select>
            </label>
            <label>
              <span>Window</span>
              <select value={matrixSpan} onChange={(event) => setMatrixSpan(Number(event.currentTarget.value))}>
                {MATRIX_SPANS.map((value) => (
                  <option key={value} value={value}>Last {value} weeks</option>
                ))}
              </select>
            </label>
            <div className="weekly-time__filter-nav">
              <button
                type="button"
                title="Earlier weeks"
                onClick={() => setMatrixEndWeek(shiftWeek(matrix?.end_week ?? weekStart, -matrixSpan))}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                type="button"
                title="Later weeks"
                onClick={() => setMatrixEndWeek(shiftWeek(matrix?.end_week ?? weekStart, matrixSpan))}
              >
                <ArrowRight size={16} />
              </button>
              {matrixEndWeek && (
                <button type="button" className="table-link" onClick={() => setMatrixEndWeek(null)}>Today</button>
              )}
            </div>
          </div>

          {selectedIds.length > 0 && (
            <div className="weekly-time__bulk-bar">
              <strong>{selectedIds.length} week{selectedIds.length === 1 ? '' : 's'} selected</strong>
              <button type="button" className="button button--primary" onClick={() => setBulkModal('approve')}>
                <Check size={16} /> Approve selected
              </button>
              <button type="button" className="button button--secondary" onClick={() => setBulkModal('return')}>
                <RotateCcw size={16} /> Return selected
              </button>
              {matrix?.can_reopen && (
                <button type="button" className="button button--secondary" onClick={() => setBulkModal('reopen')}>
                  Reopen selected
                </button>
              )}
              <button type="button" className="table-link" onClick={() => setSelected({})}>Clear</button>
            </div>
          )}

          <div className="weekly-time__matrix-wrap">
            <table className="weekly-time__review-matrix">
              <thead>
                <tr>
                  <th className="weekly-time__matrix-person">Employee</th>
                  {matrix?.weeks.map((week) => {
                    const columnIds = (matrix?.rows ?? [])
                      .map((row) => row.cells[week.week_start])
                      .filter((cell): cell is MatrixCell => Boolean(cell) && cell.status === 'submitted')
                      .map((cell) => cell.submission_id)
                    const allPicked = columnIds.length > 0 && columnIds.every((id) => selected[id])
                    return (
                      <th key={week.week_start}>
                        <button
                          type="button"
                          className="table-link"
                          disabled={columnIds.length === 0}
                          title={columnIds.length ? `Select the ${columnIds.length} week(s) waiting on review` : 'Nothing waiting this week'}
                          onClick={() => setSelected((current) => {
                            const next = { ...current }
                            for (const id of columnIds) {
                              if (allPicked) delete next[id]
                              else next[id] = true
                            }
                            return next
                          })}
                        >
                          {shortDate(week.week_start)}
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {(matrix?.rows.length ?? 0) === 0 && (
                  <tr>
                    <td className="empty-cell" colSpan={(matrix?.weeks.length ?? 0) + 1}>
                      {matrixBusy ? 'Loading...' : 'Nobody in your review scope matches these filters.'}
                    </td>
                  </tr>
                )}
                {matrix?.rows.map((row) => (
                  <tr key={row.user_id}>
                    <th className="weekly-time__matrix-person">
                      {row.name}
                      <span>{row.team_name || 'No team'}</span>
                    </th>
                    {matrix.weeks.map((week) => {
                      const cell = row.cells[week.week_start]
                      if (!cell) {
                        return (
                          <td key={week.week_start} className="weekly-time__cell weekly-time__cell--missing" title="Not submitted">
                            &#8212;
                          </td>
                        )
                      }
                      const mark = MATRIX_LEGEND.find((item) => item.status === cell.status)?.mark ?? ''
                      const pickable = cell.status === 'submitted' || (cell.status === 'approved' && matrix.can_reopen)
                      return (
                        <td key={week.week_start} className={`weekly-time__cell weekly-time__cell--${cell.status}`}>
                          <button
                            type="button"
                            className={selected[cell.submission_id] ? 'is-picked' : undefined}
                            title={`${row.name} - ${statusLabel(cell.status)}${cell.hours ? ` - ${cell.hours}h` : ''}`}
                            onClick={(event) => {
                              if (pickable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
                                setSelected((current) => {
                                  const next = { ...current }
                                  if (next[cell.submission_id]) delete next[cell.submission_id]
                                  else next[cell.submission_id] = true
                                  return next
                                })
                                return
                              }
                              void openSubmittedWeek({ week_start: week.week_start, user_id: row.user_id })
                            }}
                          >
                            <b>{mark}</b>
                            <span>{cell.hours ? `${cell.hours}h` : ''}</span>
                          </button>
                          {pickable && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.name} week of ${week.week_start}`}
                              checked={Boolean(selected[cell.submission_id])}
                              onChange={() => setSelected((current) => {
                                const next = { ...current }
                                if (next[cell.submission_id]) delete next[cell.submission_id]
                                else next[cell.submission_id] = true
                                return next
                              })}
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {timeOffQueue.length > 0 && (
            <>
              <h3 className="weekly-time__section-heading">Time off waiting on you</h3>
              <table className="weekly-time__table">
                <thead><tr><th>Employee</th><th>Week</th><th>Hours</th><th>Reason</th><th>Actions</th></tr></thead>
                <tbody>
                  {timeOffQueue.map((request) => (
                    <tr key={request.request_id}>
                      <td>{request.employee_name}</td>
                      <td>{shortDate(request.week_start)} - {shortDate(request.week_end)}</td>
                      <td>{request.daily_hours.reduce((sum, value) => sum + Number(value || 0), 0)}h</td>
                      <td>{request.reason}</td>
                      <td className="weekly-time__table-actions">
                        <button type="button" className="table-link" onClick={() => setTimeOffReview({ id: request.request_id, action: 'approve' })}>
                          Approve
                        </button>
                        <button type="button" className="table-link" onClick={() => setTimeOffReview({ id: request.request_id, action: 'return' })}>
                          Return
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="weekly-time__matrix-legend">
            {MATRIX_LEGEND.map((item) => (
              <span key={item.status} className={`weekly-time__cell--${item.status}`}>
                <b>{item.mark}</b> {item.label}
                {matrix?.counts[item.status === 'missing' ? 'not_submitted' : item.status]
                  ? ` (${matrix.counts[item.status === 'missing' ? 'not_submitted' : item.status]})`
                  : ''}
              </span>
            ))}
            <span className="weekly-time__grid-hint">Click a cell to open the week; Ctrl-click or the checkbox to select it.</span>
          </div>
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

      {timeOffModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal" onSubmit={submitTimeOff}>
            <header><h2>Request time off</h2><button type="button" onClick={() => setTimeOffModal(false)}><X /></button></header>
            <p className="weekly-time__grid-hint">
              Each business day off is a full day. Weekends and holidays are skipped automatically,
              and once approved the leave hours are recorded on your week for you.
            </p>
            <div className="weekly-time__form-grid">
              <label>
                <span>First day</span>
                <input type="date" required value={timeOffForm.start_date}
                  onChange={(event) => setTimeOffForm({ ...timeOffForm, start_date: event.target.value })} />
              </label>
              <label>
                <span>Last day</span>
                <input type="date" required value={timeOffForm.end_date}
                  onChange={(event) => setTimeOffForm({ ...timeOffForm, end_date: event.target.value })} />
              </label>
            </div>
            <label className="weekly-time__reason">
              <span>Reason</span>
              <textarea rows={3} required value={timeOffForm.reason}
                onChange={(event) => setTimeOffForm({ ...timeOffForm, reason: event.target.value })} />
            </label>
            <footer>
              <button type="button" className="button button--secondary" onClick={() => setTimeOffModal(false)}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy}>Send request</button>
            </footer>
          </form>
        </div>
      )}

      {timeOffReview && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal weekly-time__modal--review" onSubmit={decideTimeOff}>
            <header>
              <h2>{timeOffReview.action === 'approve' ? 'Approve time off' : 'Return request'}</h2>
              <button type="button" onClick={() => setTimeOffReview(null)}><X /></button>
            </header>
            {timeOffReview.action === 'approve' && (
              <p className="weekly-time__grid-hint">
                Approving records the leave hours on that person's week. Their week must still be
                open - reopen it first if it has already been submitted.
              </p>
            )}
            <label className="weekly-time__reason">
              <span>{timeOffReview.action === 'approve' ? 'Comments (optional)' : 'Comments (required)'}</span>
              <textarea rows={4} value={reviewComments} required={timeOffReview.action === 'return'}
                onChange={(event) => setReviewComments(event.target.value)} />
            </label>
            <footer>
              <button type="button" className="button button--secondary" onClick={() => setTimeOffReview(null)}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy}>
                {timeOffReview.action === 'approve' ? 'Approve' : 'Return'}
              </button>
            </footer>
          </form>
        </div>
      )}

      {bulkModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal weekly-time__modal--review" onSubmit={(event) => { event.preventDefault(); void runBulkReview() }}>
            <header>
              <h2>
                {bulkModal === 'approve' && `Approve ${selectedIds.length} week${selectedIds.length === 1 ? '' : 's'}`}
                {bulkModal === 'return' && `Return ${selectedIds.length} week${selectedIds.length === 1 ? '' : 's'}`}
                {bulkModal === 'reopen' && `Reopen ${selectedIds.length} week${selectedIds.length === 1 ? '' : 's'}`}
              </h2>
              <button type="button" onClick={() => setBulkModal(null)}><X /></button>
            </header>
            <p className="weekly-time__grid-hint">
              The same comment goes on every week. A week that has moved since the page loaded is
              skipped and reported back, not silently changed.
            </p>
            <label className="weekly-time__reason">
              <span>{bulkModal === 'approve' ? 'Comments (optional)' : 'Comments (required)'}</span>
              <textarea rows={4} value={bulkComments} onChange={(event) => setBulkComments(event.target.value)} required={bulkModal !== 'approve'} />
            </label>
            <footer>
              <button type="button" className="button button--secondary" onClick={() => setBulkModal(null)}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy}>Confirm</button>
            </footer>
          </form>
        </div>
      )}

      {reviewModal && (
        <div className="weekly-time__modal-backdrop" role="presentation">
          <form className="weekly-time__modal weekly-time__modal--review" onSubmit={completeReview}>
            <header>
              <h2>
                {reviewModal.action === 'approve' && 'Approve'}
                {reviewModal.action === 'return' && 'Return for changes'}
                {reviewModal.action === 'reopen' && 'Reopen approved week'}
              </h2>
              <button type="button" onClick={() => setReviewModal(null)}><X /></button>
            </header>
            {reviewModal.action === 'reopen' && (
              <p className="weekly-time__grid-hint">
                The week goes back to the employee as returned, so they can correct it and submit again.
              </p>
            )}
            <label className="weekly-time__reason">
              <span>{reviewModal.action === 'approve' ? 'Comments (optional)' : 'Comments (required)'}</span>
              <textarea rows={4} value={reviewComments} onChange={(event) => setReviewComments(event.target.value)} required={reviewModal.action !== 'approve'} />
            </label>
            <footer>
              <button type="button" className="button button--secondary" onClick={() => setReviewModal(null)}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy}>
                {reviewModal.action === 'approve' && 'Approve'}
                {reviewModal.action === 'return' && 'Return'}
                {reviewModal.action === 'reopen' && 'Reopen'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  )
}
