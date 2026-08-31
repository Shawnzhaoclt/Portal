import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Download,
  ArrowRight,
  CalendarClock,
  Check,
  ClipboardCheck,
  Copy,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { portalRequestBinary, portalRequestJson } from '../../../desktop/request'
import { saveExportAs } from '../../../desktop/runtime'

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
  week_status?: string
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

type SubmissionQueueRecord = {
  submission_id: string
  user_id: number
  employee_name: string
  team_name: string | null
  week_start: string
  week_end: string
  status: string
  submitted_at: string | null
  reviewed_at: string | null
  reviewed_by_name: string | null
  review_comments: string | null
}

type ReviewQueue = {
  submissions: SubmissionQueueRecord[]
  time_off_requests: TimeOffRequestRecord[]
  recent: SubmissionQueueRecord[]
  can_reopen: boolean
}

type StatisticsCard = {
  user_id: number
  name: string
  team_name: string | null
  own: boolean
  total_hours: number
  logged_days: number
  missing_days: number
  leave_hours: number
  types: Record<string, number>
  bucket_hours: Record<string, number>
}

type StatisticsReport = {
  start: string
  end: string
  counted_through: string
  working_days: number
  bucket: string
  buckets: { key: string; label: string }[]
  team: string | null
  teams: string[]
  cards: StatisticsCard[]
}

/** Buckets per-week time-off rows back into the requests that created them.
 * One request spanning weeks is stored week by week; rows of the same request
 * share the owner, the reason and the creation instant. */
function groupTimeOff<T extends TimeOffRequestRecord>(rows: T[]): T[][] {
  const groups: T[][] = []
  for (const row of rows) {
    const bucket = groups.find((candidate) => candidate[0].user_id === row.user_id
      && candidate[0].reason === row.reason
      && Math.abs(Date.parse(candidate[0].created_at) - Date.parse(row.created_at)) < 5000)
    if (bucket) bucket.push(row)
    else groups.push([row])
  }
  for (const bucket of groups) bucket.sort((a, b) => a.week_start.localeCompare(b.week_start))
  return groups
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

type HeatmapDay = { date: string; hours: number; status: string; types: Record<string, number> }
type WeeklyHeatmap = {
  year: number
  mode: string
  window_start: string
  window_end: string
  available_years: number[]
  owner: { user_id: number; name: string }
  own_calendar: boolean
  people: { user_id: number; name: string }[]
  days: HeatmapDay[]
  holidays: { date: string; name: string }[]
  max_daily: number
}

// Five intensity steps over the 8-hour day, in the resource's own blue rather
// than a borrowed green, so the calendar reads as part of this page.
function heatmapLevel(hours: number) {
  if (hours <= 0) return 0
  if (hours <= 2) return 1
  if (hours <= 4) return 2
  if (hours <= 6) return 3
  return 4
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Monday-start week columns covering the whole year. */
function heatmapWeeks(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  const end = new Date(`${endIso}T00:00:00Z`)
  const weeks: string[][] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const week: string[] = []
    for (let day = 0; day < 7; day += 1) {
      week.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}

/** Fiscal years start July 1 and are named by their starting year. */
function fiscalYearLabel(startYear: number) {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

// Glyph plus label, never colour alone: the cell has to read for someone who cannot
// tell the green from the amber.
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

/** Renders a modal at document.body, exactly like the app's own message dialog.
 *
 * Inline rendering left the dialog inside the resource's layout tree, where any
 * ancestor quirk (a transform, a scroll container, an embedding wrapper) can
 * defeat position: fixed and let the dialog overflow the window. A portal makes
 * the viewport the one and only containing block. */
function ModalBackdrop({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="weekly-time__modal-backdrop" role="presentation">{children}</div>,
    document.body,
  )
}

function shortDate(value: string) {
  return formatDateOnly(value, value)
}

/** Month/day only: inside one week's grid the year is redundant, and it costs
 * each day column roughly 40px it does not have to spare. */
function compactDate(value: string) {
  const [, month, day] = value.split('-')
  return `${Number(month)}/${Number(day)}`
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
  const [tab, setTab] = useState<'week' | 'stats' | 'review'>('week')
  const [gridDraft, setGridDraft] = useState<Record<string, number> | null>(null)
  const [gridBusy, setGridBusy] = useState(false)

  const [busy, setBusy] = useState(false)
  const [entryModal, setEntryModal] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY)
  const linkedTimeDrivers = useRef<LinkedTimeField[]>(['hours'])
  const [queueSubmissions, setQueueSubmissions] = useState<SubmissionQueueRecord[]>([])
  const [queueRecent, setQueueRecent] = useState<SubmissionQueueRecord[]>([])
  const [queueCanReopen, setQueueCanReopen] = useState(false)
  // The waiting list shows the current and previous week by default.
  const [queueFrom, setQueueFrom] = useState(() => {
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7)
    return isoDate(monday)
  })
  const [queueTo, setQueueTo] = useState(isoDate(new Date()))
  const [queuePage, setQueuePage] = useState(0)
  const [queueName, setQueueName] = useState('')
  const [queueTeam, setQueueTeam] = useState('')
  const [timeOffModal, setTimeOffModal] = useState(false)
  const [timeOffForm, setTimeOffForm] = useState(EMPTY_TIME_OFF)
  const [timeOffQueue, setTimeOffQueue] = useState<TimeOffRequestRecord[]>([])
  const [queueWaiting, setQueueWaiting] = useState(0)
  const [heatmap, setHeatmap] = useState<WeeklyHeatmap | null>(null)
  const [heatmapYear, setHeatmapYear] = useState<number | null>(null)
  const [heatmapPerson, setHeatmapPerson] = useState<number | null>(null)
  // Work-type filter for the calendar: '' colors cells by total hours, a type
  // key colors them by that type's hours alone. Purely client-side - the
  // heatmap payload already carries per-day hours by type.
  const [heatmapType, setHeatmapType] = useState('')
  // 'calendar' = January to December; 'fiscal' = July 1 to June 30.
  const [heatmapMode, setHeatmapMode] = useState<'calendar' | 'fiscal'>('calendar')
  // The statistics tab summarizes its own user-defined range, defaulting to
  // the current year to date, with data fetched separately from the calendar.
  const [statsStart, setStatsStart] = useState(`${new Date().getFullYear()}-01-01`)
  const [statsEnd, setStatsEnd] = useState(isoDate(new Date()))
  const [statsData, setStatsData] = useState<StatisticsReport | null>(null)
  // 'total' shows hours by work type; a period shows hours over time.
  const [statsBucket, setStatsBucket] = useState('total')
  // '' summarizes every work type; a key narrows the figures to that type.
  const [statsType, setStatsType] = useState('')
  const [statsTeam, setStatsTeam] = useState('')
  // The day highlighted in the week panel's day details; null falls back to
  // today when the current week is shown, otherwise Monday.
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [timeOffReview, setTimeOffReview] = useState<{ id: string; action: 'approve' | 'return' } | null>(null)
  const [reviewModal, setReviewModal] = useState<{
    id: string
    action: 'approve' | 'return' | 'reopen'
  } | null>(null)
  const [reviewComments, setReviewComments] = useState('')

  const isViewingAnotherUser = Boolean(context && context.user.id !== context.viewer.id)
  /** Days holding more than one entry of a single work type. The grid shows one
   * number per work type and day, so it cannot rewrite those without throwing a
   * note away - they stay editable entry by entry until one of them is gone. */
  const splitEntryDays = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of context?.entries ?? []) {
      const key = `${entry.work_date}|${entry.entry_type}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const days = new Set<string>()
    for (const [key, count] of counts) {
      if (count > 1) days.add(key.slice(0, key.indexOf('|')))
    }
    return [...days].sort()
  }, [context])
  /** The day whose entries show below the grid: the picked one when it still
   * needs untangling, else the first that does. */
  const activeDay = selectedDay && splitEntryDays.includes(selectedDay)
    ? selectedDay
    : splitEntryDays[0] ?? null

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
    const pending = await portalRequestJson<ReviewQueue>('/api/reports/weekly-time/review-queue?status=submitted')
    setQueueSubmissions(pending.submissions)
    setTimeOffQueue(pending.time_off_requests)
    setQueueRecent(pending.recent)
    setQueueCanReopen(pending.can_reopen)
    // The badge counts only items truly awaiting a decision; approved time off
    // rides in the payload merely so it can be returned.
    setQueueWaiting(
      pending.submissions.length
      + pending.time_off_requests.filter((row) => row.status === 'pending').length,
    )
  }

  async function submitTimeOff(event: FormEvent) {
    event.preventDefault()
    if (timeOffForm.end_date < timeOffForm.start_date) {
      toast.error('The last day cannot be earlier than the first day.')
      return
    }
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
    const approved = context?.time_off_requests.find((item) => item.request_id === requestId)?.status === 'approved'
    if (!(await appConfirm(
      approved
        ? 'Withdraw this approved time off? The leave hours it added to this week will be removed too.'
        : 'Withdraw this time-off request?',
      { title: 'Withdraw request', kind: 'warning', confirmLabel: 'Withdraw' },
    ))) return
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
      const response = await portalRequestJson<{ status: string; leave_entries: number; weeks: number; amended_weeks?: string[] }>(
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
          ? `Approved${response.weeks > 1 ? ` across ${response.weeks} weeks` : ''} - `
            + `${response.leave_entries} leave entr${response.leave_entries === 1 ? 'y' : 'ies'} added`
            + (response.amended_weeks?.length
              ? ` (written into ${response.amended_weeks.length} already-reviewed week${response.amended_weeks.length === 1 ? '' : 's'}).`
              : '.')
          : 'Returned to the employee.',
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const queueTeams = useMemo(() => (
    [...new Set([...queueSubmissions, ...queueRecent]
      .map((row) => row.team_name)
      .filter((value): value is string => Boolean(value)))].sort()
  ), [queueSubmissions, queueRecent])

  const queueFiltered = useMemo(() => {
    const name = queueName.trim().toLowerCase()
    const rows = queueSubmissions.filter((row) => (
      (!queueFrom || row.week_start >= queueFrom)
      && (!queueTo || row.week_start <= queueTo)
      && (!name || row.employee_name.toLowerCase().includes(name))
      && (!queueTeam || row.team_name === queueTeam)
    ))
    rows.sort((a, b) => String(b.submitted_at ?? '').localeCompare(String(a.submitted_at ?? '')))
    return rows
  }, [queueSubmissions, queueFrom, queueTo, queueName, queueTeam])

  const recentFiltered = useMemo(() => {
    const name = queueName.trim().toLowerCase()
    return queueRecent.filter((row) => (
      (!name || row.employee_name.toLowerCase().includes(name))
      && (!queueTeam || row.team_name === queueTeam)
    ))
  }, [queueRecent, queueName, queueTeam])

  type ReviewItem = {
    key: string
    kind: 'week' | 'timeoff'
    employee: string
    team: string | null
    periodStart: string
    periodEnd: string
    status: string
    when: string
    decidedBy: string | null
    hours: number | null
    reason: string | null
    weekCount: number
    lockedWeeks: number
    submissionId: string | null
    requestId: string | null
    userId: number
  }

  /** Every decision item as one list: weeks and time off together, items still
   * waiting first (newest submission on top), decided items after. */
  const reviewItems = useMemo(() => {
    const name = queueName.trim().toLowerCase()
    const items: ReviewItem[] = []
    for (const row of queueFiltered) {
      items.push({
        key: `week-${row.submission_id}`,
        kind: 'week',
        employee: row.employee_name,
        team: row.team_name,
        periodStart: row.week_start,
        periodEnd: row.week_end,
        status: row.status,
        when: row.submitted_at ?? '',
        decidedBy: null,
        hours: null,
        reason: null,
        weekCount: 1,
        lockedWeeks: 0,
        submissionId: row.submission_id,
        requestId: null,
        userId: row.user_id,
      })
    }
    for (const row of recentFiltered) {
      items.push({
        key: `decided-${row.submission_id}`,
        kind: 'week',
        employee: row.employee_name,
        team: row.team_name,
        periodStart: row.week_start,
        periodEnd: row.week_end,
        status: row.status,
        when: row.reviewed_at ?? '',
        decidedBy: row.reviewed_by_name,
        hours: null,
        reason: null,
        weekCount: 1,
        lockedWeeks: 0,
        submissionId: row.submission_id,
        requestId: null,
        userId: row.user_id,
      })
    }
    for (const request of groupTimeOff(timeOffQueue)) {
      const first = request[0]
      const last = request[request.length - 1]
      if (name && !first.employee_name.toLowerCase().includes(name)) continue
      if (queueTeam && first.team_name !== queueTeam) continue
      if (queueFrom && last.week_end < queueFrom) continue
      if (queueTo && first.week_start > queueTo) continue
      items.push({
        key: `timeoff-${first.request_id}`,
        kind: 'timeoff',
        employee: first.employee_name,
        team: first.team_name,
        periodStart: first.week_start,
        periodEnd: last.week_end,
        status: first.status,
        when: first.created_at,
        decidedBy: null,
        hours: request.reduce((sum, row) => sum + row.daily_hours.reduce((s, v) => s + Number(v || 0), 0), 0),
        reason: first.reason,
        weekCount: request.length,
        lockedWeeks: request.filter((row) => row.week_status && row.week_status !== 'draft' && row.week_status !== 'returned').length,
        submissionId: null,
        requestId: first.request_id,
        userId: first.user_id,
      })
    }
    const waiting = (item: ReviewItem) => item.status === 'submitted' || item.status === 'pending'
    items.sort((a, b) => {
      if (waiting(a) !== waiting(b)) return waiting(a) ? -1 : 1
      return b.when.localeCompare(a.when)
    })
    return items
  }, [queueFiltered, recentFiltered, timeOffQueue, queueName, queueTeam, queueFrom, queueTo])

  async function approveAllPending() {
    const ids = queueFiltered.map((row) => row.submission_id)
    if (ids.length === 0) return
    const ok = await appConfirm(
      `Approve all ${ids.length} waiting week${ids.length === 1 ? '' : 's'}?`,
      { title: 'Approve all', confirmLabel: 'Approve all' },
    )
    if (!ok) return
    setBusy(true)
    try {
      await portalRequestJson('/api/reports/weekly-time/submissions/bulk-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_ids: ids, action: 'approve', comments: '' }),
      })
      await loadQueue()
      toast.success(`${ids.length} week${ids.length === 1 ? '' : 's'} approved.`)
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
    const parameters = new URLSearchParams()
    if (heatmapYear) parameters.set('year', String(heatmapYear))
    if (heatmapPerson) parameters.set('user_id', String(heatmapPerson))
    parameters.set('mode', heatmapMode)
    portalRequestJson<WeeklyHeatmap>(`/api/reports/weekly-time/heatmap?${parameters}`)
      .then(setHeatmap)
      .catch(() => setHeatmap(null))
    // context.entries changes with every save, so the calendar repaints itself.
  }, [heatmapYear, heatmapPerson, heatmapMode, context?.entries])

  useEffect(() => {
    if (tab !== 'stats' || !statsStart || !statsEnd || statsEnd < statsStart) return
    const parameters = new URLSearchParams()
    parameters.set('start', statsStart)
    parameters.set('end', statsEnd)
    parameters.set('bucket', statsBucket)
    if (statsType) parameters.set('entry_type', statsType)
    if (statsTeam) parameters.set('team', statsTeam)
    portalRequestJson<StatisticsReport>(`/api/reports/weekly-time/statistics?${parameters}`)
      .then(setStatsData)
      .catch(() => setStatsData(null))
  }, [tab, statsStart, statsEnd, statsBucket, statsType, statsTeam, context?.entries])

  useEffect(() => {
    if (tab !== 'review' || !context?.viewer.can_review) return
    void loadQueue().catch((error) => toast.error(errorText(error)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, context?.viewer.can_review])

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

  /** True when this date sits inside the viewed week and is approved time off. */
  function isTimeOffDay(dateText: string) {
    return context?.schedule_days.some((d) => d.date === dateText && d.time_off) ?? false
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
        : { ...EMPTY_ENTRY, work_date: day, ...(isTimeOffDay(day) ? { entry_type: 'leave' } : {}) },
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

  /** Select the week containing this day, loading it into the week panel. */
  async function openWeekFromCalendar(dateText: string) {
    const parsed = new Date(`${dateText}T00:00:00`)
    parsed.setDate(parsed.getDate() - ((parsed.getDay() + 6) % 7))
    const monday = isoDate(parsed)
    if (context && context.week_start !== monday) {
      await changeWeek(monday)
    }
    setGridDraft(null)
    setTab('week')
    // A weekend day still opens its week; the details land on Monday.
    const weekday = (new Date(`${dateText}T00:00:00`).getDay() + 6) % 7
    setSelectedDay(weekday >= 5 ? monday : dateText)
    document.getElementById('wt-week-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function exportStatistics() {
    if (!statsStart || !statsEnd) return
    setBusy(true)
    try {
      const file = await portalRequestBinary(
        `/api/reports/weekly-time/statistics/export?start=${statsStart}&end=${statsEnd}&bucket=${statsBucket}`
          + (statsType ? `&entry_type=${encodeURIComponent(statsType)}` : '')
          + (statsTeam ? `&team=${encodeURIComponent(statsTeam)}` : ''),
      )
      const name = `Weekly-Time-Statistics-${statsStart}-to-${statsEnd}.xlsx`
      await saveExportAs(name, file.bytes, 'excel')
      toast.success(`Exported ${name}.`)
    } catch (error) {
      if (!(error instanceof Error && /cancel/i.test(error.message))) toast.error(errorText(error))
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

      {heatmap && (
        <div className="weekly-time__heatmap">
          <div className="weekly-time__heatmap-head">
            <h3>
              Year calendar
              {heatmap.own_calendar ? '' : ` - ${heatmap.owner.name}`}
            </h3>
            <div className="weekly-time__heatmap-controls">
              <select
                aria-label="Calendar mode"
                value={heatmapMode}
                onChange={(event) => {
                  setHeatmapMode(event.currentTarget.value as 'calendar' | 'fiscal')
                  // Year numbering changes meaning between modes; let the server
                  // pick the current period again.
                  setHeatmapYear(null)
                }}
              >
                <option value="calendar">Calendar year</option>
                <option value="fiscal">Fiscal year (Jul-Jun)</option>
              </select>
              <select
                aria-label="Work type filter"
                value={heatmapType}
                onChange={(event) => setHeatmapType(event.currentTarget.value)}
              >
                <option value="">All work types</option>
                {gridRowTypes.map((entryType) => (
                  <option key={entryType.type_key} value={entryType.type_key}>{entryType.label}</option>
                ))}
              </select>
              {heatmap.people.length > 1 && (
                <select
                  aria-label="Whose calendar"
                  value={heatmapPerson ?? ''}
                  onChange={(event) => setHeatmapPerson(Number(event.currentTarget.value) || null)}
                >
                  <option value="">My calendar</option>
                  {heatmap.people.map((person) => (
                    <option key={person.user_id} value={person.user_id}>{person.name}</option>
                  ))}
                </select>
              )}
              <select
                aria-label="Calendar year"
                value={heatmapYear ?? heatmap.year}
                onChange={(event) => setHeatmapYear(Number(event.currentTarget.value))}
              >
                {heatmap.available_years.map((value) => (
                  <option key={value} value={value}>
                    {heatmap.mode === 'fiscal' ? fiscalYearLabel(value) : value}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(() => {
            const byDate = new Map(heatmap.days.map((day) => [day.date, day]))
            const holidayByDate = new Map(heatmap.holidays.map((item) => [item.date, item.name]))
            const weeks = heatmapWeeks(heatmap.window_start, heatmap.window_end)
            const today = isoDate(new Date())
            return (
              <div className="weekly-time__heatmap-scroll">
                <div className="weekly-time__heatmap-months">
                  <span className="weekly-time__heatmap-gutter" />
                  {weeks.map((week, index) => {
                    // The first column may begin before the window (the week
                    // holding Jan 1 or Jul 1); anchor its label to the window.
                    const monthOf = (w: string[], i: number) => {
                      const anchor = i === 0 && w[0] < heatmap.window_start ? heatmap.window_start : w[0]
                      return Number(anchor.slice(5, 7)) - 1
                    }
                    const month = monthOf(week, index)
                    const previous = index > 0 ? monthOf(weeks[index - 1], index - 1) : -1
                    return (
                      <span key={week[0]}>
                        {month !== previous && week[0] <= heatmap.window_end ? MONTH_LABELS[month] : ''}
                      </span>
                    )
                  })}
                </div>
                <div className="weekly-time__heatmap-grid">
                  {/* Weekdays only: weekends cannot hold time, so two rows of
                      permanently empty cells would be noise. */}
                  {[0, 1, 2, 3, 4].map((row) => (
                    <div className="weekly-time__heatmap-row" key={row}>
                      <span className="weekly-time__heatmap-gutter">
                        {row === 0 ? 'Mon' : row === 2 ? 'Wed' : row === 4 ? 'Fri' : ''}
                      </span>
                      {weeks.map((week) => {
                        const dateText = week[row]
                        const inWindow = dateText >= heatmap.window_start && dateText <= heatmap.window_end
                        const day = byDate.get(dateText)
                        const holiday = holidayByDate.get(dateText)
                        const future = dateText > today
                        const shownHours = day ? (heatmapType ? day.types[heatmapType] ?? 0 : day.hours) : 0
                        const parts = day && !heatmapType
                          ? Object.entries(day.types)
                              .map(([key, value]) => `${entryTypeLabels.get(key) ?? fallbackEntryTypeLabel(key)} ${value}h`)
                              .join('; ')
                          : ''
                        const filterLabel = heatmapType
                          ? entryTypeLabels.get(heatmapType) ?? fallbackEntryTypeLabel(heatmapType)
                          : ''
                        const tooltip = [
                          `${weekdayName(dateText)} ${shortDate(dateText)}`,
                          day
                            ? heatmapType
                              ? `${filterLabel} ${shownHours}h (of ${day.hours}h)`
                              : `${day.hours}h${parts ? ` (${parts})` : ''}`
                            : 'No time recorded',
                          holiday ? `Holiday: ${holiday}` : '',
                          day && day.status !== 'approved' ? statusLabel(day.status) : '',
                        ].filter(Boolean).join(' - ')
                        const clickable = heatmap.own_calendar && inWindow
                        return (
                          <span
                            key={dateText}
                            role={clickable ? 'button' : undefined}
                            tabIndex={clickable ? 0 : undefined}
                            className={[
                              'weekly-time__heatmap-cell',
                              `level-${heatmapLevel(shownHours)}`,
                              inWindow ? '' : 'is-outside',
                              holiday ? 'is-holiday' : '',
                              future ? 'is-future' : '',
                              clickable ? 'is-clickable' : '',
                            ].filter(Boolean).join(' ')}
                            title={tooltip}
                            onClick={clickable ? () => void openWeekFromCalendar(dateText) : undefined}
                            onKeyDown={clickable ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') void openWeekFromCalendar(dateText)
                            } : undefined}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
                <div className="weekly-time__heatmap-legend">
                  <em>Amber outline marks a holiday.</em>
                  <span>Less</span>
                  {[0, 1, 2, 3, 4].map((level) => (
                    <span key={level} className={`weekly-time__heatmap-cell level-${level}`} />
                  ))}
                  <span>More</span>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <nav className="weekly-time__tabs" aria-label="Weekly time views">
        <button type="button" className={tab === 'week' ? 'is-active' : ''} onClick={() => setTab('week')}>
          <CalendarClock size={17} /> My week
        </button>
        <button type="button" className={tab === 'stats' ? 'is-active' : ''} onClick={() => setTab('stats')}>
          <CalendarClock size={17} /> Statistics
        </button>
        {context.viewer.can_review && (
          <button type="button" className={tab === 'review' ? 'is-active' : ''} onClick={() => { setTab('review'); void loadQueue() }}>
            <ClipboardCheck size={17} /> Manager review
            {queueWaiting > 0 && <span>{queueWaiting}</span>}
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
              {categoryTotals.map((category) => (
                <div key={category.entryType} className="weekly-time__week-summary-type">
                  <span>{category.label}</span>
                  <b>{category.hours}h</b>
                </div>
              ))}
            </div>
            <span className={`weekly-time__status weekly-time__status--${status}`}>{statusLabel(status)}</span>
          </section>
          <div className="weekly-time__view-bar">
            <span className="weekly-time__grid-hint">
              Click a day on the calendar to open that week for editing.
            </span>
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
              {groupTimeOff(context.time_off_requests).map((request) => {
                const first = request[0]
                const last = request[request.length - 1]
                const total = request.reduce((sum, row) => sum + row.daily_hours.reduce((s, v) => s + Number(v || 0), 0), 0)
                return (
                  <div key={first.request_id}>
                    <span className={`weekly-time__status weekly-time__status--${first.status}`}>
                      {statusLabel(first.status)}
                    </span>
                    <strong>
                      {total}h time off
                      {request.length > 1 ? ` · ${shortDate(first.week_start)} - ${shortDate(last.week_end)}` : ''}
                    </strong>
                    <span>{first.reason}</span>
                    {first.review_comments && <em>{first.review_comments}</em>}
                    {(first.status === 'pending' || first.status === 'returned') ? (
                      <button type="button" className="table-link" onClick={() => void withdrawTimeOff(first.request_id)}>
                        Withdraw{request.length > 1 ? ' all' : ''}
                      </button>
                    ) : first.status === 'approved' ? (
                      <em className="weekly-time__timeoff-locked">Ask a reviewer to return it before withdrawing.</em>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          <section id="wt-week-panel" className="weekly-time__week-card" aria-label="Selected week detail">
                <div className="weekly-time__grid-wrap">
                  <table className="weekly-time__grid">
                    <thead>
                      <tr>
                        <th>Work type</th>
                        {context.schedule_days.filter((day) => !isWeekendDate(day.date)).map((day) => (
                          <th
                            key={day.date}
                            className={day.holiday ? 'is-holiday' : undefined}
                            title={`${weekdayName(day.date)} ${shortDate(day.date)} · target ${day.target_hours}h${day.holiday ? ` · ${day.holiday.name}` : ''}`}
                          >
                            {weekdayName(day.date).slice(0, 3)} {compactDate(day.date)}
                            <span>{day.target_hours}h{day.holiday ? ` · ${day.holiday.name}` : ''}</span>
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
                            {weekdays.map((day, columnIndex) => {
                              const key = `${day.date}|${entryType.type_key}`
                              const cell = gridCells.get(key)
                              const locked = (cell?.count ?? 0) > 1
                              const value = gridDraft?.[key] ?? cell?.hours ?? 0
                              const rowIndex = gridRowTypes.indexOf(entryType)
                              return (
                                <td key={key}>
                                  <input
                                    id={`wt-cell-${rowIndex}-${columnIndex}`}
                                    type="number"
                                    min="0"
                                    max="8"
                                    step="0.5"
                                    disabled={gridBusy || locked
                                      || (day.time_off && entryType.type_key !== 'leave')
                                      || !context.permissions.can_edit}
                                    title={locked
                                      ? 'Several entries share this day and work type - edit them individually below.'
                                      : day.time_off
                                        ? 'Approved time off - only leave can be recorded'
                                        : day.holiday
                                          ? `${day.holiday.name} - the day still caps at 8 hours`
                                          : undefined}
                                    value={value || ''}
                                    placeholder="0"
                                    onFocus={(event) => event.currentTarget.select()}
                                    onKeyDown={(event) => {
                                      const moves: Record<string, [number, number]> = {
                                        Enter: [1, 0],
                                        ArrowDown: [1, 0],
                                        ArrowUp: [-1, 0],
                                        ArrowRight: [0, 1],
                                        ArrowLeft: [0, -1],
                                      }
                                      const move = moves[event.key]
                                      if (!move) return
                                      event.preventDefault()
                                      const target = document.getElementById(
                                        `wt-cell-${rowIndex + move[0]}-${columnIndex + move[1]}`,
                                      ) as HTMLInputElement | null
                                      if (target && !target.disabled) target.select()
                                      target?.focus()
                                    }}
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
                {activeDay && (
                <div className="weekly-time__dialog-day">
                  <p className="weekly-time__grid-hint">
                    These days hold several entries of one work type, so the grid cannot total
                    them for you. Delete or merge them here and the grid takes over.
                  </p>
                  <div className="weekly-time__dialog-daytabs" role="tablist" aria-label="Day details">
                    {splitEntryDays.map((day) => (
                      <button key={day} type="button" className={activeDay === day ? 'is-active' : ''} onClick={() => setSelectedDay(day)}>
                        {weekdayName(day).slice(0, 3)} {shortDate(day)}
                      </button>
                    ))}
                  </div>
                  {activeDay && (groupedEntries.get(activeDay) ?? []).map((entry) => (
                    <div key={entry.entry_id} className="weekly-time__dialog-entry">
                      <strong>{entryTypeLabels.get(entry.entry_type) ?? fallbackEntryTypeLabel(entry.entry_type)}</strong>
                      <span>{entry.hours}h{entry.start_time && entry.end_time ? ` \u00b7 ${entry.start_time}\u2013${entry.end_time}` : ''}</span>
                      <em>{entry.notes || 'No notes'}</em>
                      <span className="weekly-time__table-actions">
                        {context.permissions.can_edit && (
                          <button type="button" title="Edit entry" onClick={() => activeDay && openEntry(activeDay, entry)}><Pencil size={14} /></button>
                        )}
                        {context.permissions.can_delete && (
                          <button type="button" title="Delete entry" onClick={() => void deleteEntry(entry)}><Trash2 size={14} /></button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                )}
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

      {tab === 'stats' && (
        <section className="weekly-time__week-card" aria-label="Statistics">
          <div className="weekly-time__stats-controls">
            <label>
              <span>From</span>
              <input type="date" value={statsStart} max={statsEnd || undefined}
                onChange={(event) => setStatsStart(event.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={statsEnd} min={statsStart || undefined}
                onChange={(event) => setStatsEnd(event.target.value)} />
            </label>
            <label>
              <span>Group by</span>
              <select value={statsBucket} onChange={(event) => setStatsBucket(event.currentTarget.value)}>
                <option value="total">Work type (total)</option>
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </select>
            </label>
            <label>
              <span>Work type</span>
              <select value={statsType} onChange={(event) => setStatsType(event.currentTarget.value)}>
                <option value="">All work types</option>
                {gridRowTypes.map((entryType) => (
                  <option key={entryType.type_key} value={entryType.type_key}>{entryType.label}</option>
                ))}
              </select>
            </label>
            {(statsData?.teams.length ?? 0) > 1 && (
              <label className="weekly-time__stats-team">
                <span>Team</span>
                <select value={statsTeam} onChange={(event) => setStatsTeam(event.currentTarget.value)}>
                  <option value="">All teams</option>
                  {(statsData?.teams ?? []).map((team) => (
                    <option key={team} value={team}>{team}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="weekly-time__stats-presets">
              <button type="button" onClick={() => {
                const now = new Date()
                setStatsStart(`${now.getFullYear()}-01-01`)
                setStatsEnd(isoDate(now))
              }}>This year</button>
              <button type="button" onClick={() => {
                const now = new Date()
                const fiscalStart = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1
                setStatsStart(`${fiscalStart}-07-01`)
                setStatsEnd(isoDate(now))
              }}>Fiscal year</button>
              <button type="button" onClick={() => {
                const now = new Date()
                const past = new Date(now)
                past.setDate(now.getDate() - 29)
                setStatsStart(isoDate(past))
                setStatsEnd(isoDate(now))
              }}>Past 30 days</button>
            </div>
            <button type="button" className="button button--secondary weekly-time__stats-export"
              onClick={() => void exportStatistics()} disabled={busy || !statsData}>
              <Download size={16} /> Export Excel
            </button>
          </div>
          {statsData ? (
            <>
              <p className="weekly-time__grid-hint">
                {shortDate(statsData.start)} - {shortDate(statsData.end)}
                {statsData.counted_through < statsData.end ? ` \u00b7 counted through ${shortDate(statsData.counted_through)}` : ''}
                {' \u00b7 '}{statsData.working_days} working day{statsData.working_days === 1 ? '' : 's'}
                {statsData.cards.length > 1 ? ` \u00b7 ${statsData.cards.length} people` : ''}
              </p>
              <div className="weekly-time__stats-cards">
                {statsData.cards.map((card) => {
                  const grouped = statsData.buckets.length > 0
                  const columns: { key: string; label: string; value: number }[] = grouped
                    ? statsData.buckets.map((item) => ({
                        key: item.key,
                        label: item.label,
                        value: card.bucket_hours[item.key] ?? 0,
                      }))
                    : Object.entries(card.types)
                        .sort((a, b) => b[1] - a[1])
                        .map(([key, value]) => ({
                          key,
                          label: entryTypeLabels.get(key) ?? fallbackEntryTypeLabel(key),
                          value,
                        }))
                  const maxColumn = columns.reduce((max, item) => Math.max(max, item.value), 0)
                  const dense = columns.length > 16
                  return (
                    <article key={card.user_id} className="weekly-time__stats-card">
                      <header>
                        <strong>{card.name}</strong>
                        <span>{card.team_name ?? 'No team'}</span>
                        {card.own && <em>You</em>}
                      </header>
                      <div className="weekly-time__heatmap-stats weekly-time__heatmap-stats--card">
                        <div className="weekly-time__heatmap-stat-list">
                          <div className="weekly-time__heatmap-stat">
                            <span>Recorded</span>
                            <b>{round1(card.total_hours)}h</b>
                            <small>
                              {statsData.working_days > 0
                                ? `${round1(card.total_hours / (statsData.working_days / 5))}h avg/week`
                                : 'no working days'}
                            </small>
                          </div>
                          <div className="weekly-time__heatmap-stat">
                            <span>Days logged</span>
                            <b>{card.logged_days} of {statsData.working_days}</b>
                            {card.missing_days > 0
                              ? <small className="is-missing">{card.missing_days} day{card.missing_days === 1 ? '' : 's'} missing</small>
                              : <small>all days filled</small>}
                          </div>
                          <div className="weekly-time__heatmap-stat">
                            <span>Leave used</span>
                            <b>{round1(card.leave_hours)}h</b>
                            <small>{round1(card.leave_hours / 8)} day{card.leave_hours === 8 ? '' : 's'}</small>
                          </div>
                        </div>
                        {columns.length > 0 && maxColumn > 0 && (
                          <div
                            className={`weekly-time__heatmap-chart${dense ? ' is-dense' : ''}`}
                            role="img"
                            aria-label={`Hours for ${card.name}`}
                          >
                            {columns.map((column) => (
                              <div
                                key={column.key}
                                className="weekly-time__heatmap-chart-col"
                                title={`${column.label}: ${round1(column.value)}h`}
                              >
                                {!dense && <b>{column.value ? `${round1(column.value)}h` : ''}</b>}
                                <span style={{ height: `${Math.max(column.value ? 5 : 2, Math.round((column.value / maxColumn) * 70)) }px` }} />
                                {!dense && <em>{column.label}</em>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            </>
          ) : (
            <p className="weekly-time__empty">Loading statistics\u2026</p>
          )}
        </section>
      )}

      {tab === 'review' && context.viewer.can_review && (
        <section className="weekly-time__panel">
          <div className="weekly-time__stats-controls">
            <label>
              <span>Weeks from</span>
              <input type="date" value={queueFrom} max={queueTo || undefined}
                onChange={(event) => { setQueueFrom(event.target.value); setQueuePage(0) }} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={queueTo} min={queueFrom || undefined}
                onChange={(event) => { setQueueTo(event.target.value); setQueuePage(0) }} />
            </label>
            <label>
              <span>Employee</span>
              <input type="text" placeholder="Any name" value={queueName}
                onChange={(event) => { setQueueName(event.target.value); setQueuePage(0) }} />
            </label>
            <label>
              <span>Team</span>
              <select value={queueTeam} onChange={(event) => { setQueueTeam(event.currentTarget.value); setQueuePage(0) }}>
                <option value="">All teams</option>
                {queueTeams.map((team) => <option key={team} value={team}>{team}</option>)}
              </select>
            </label>
            {queueFiltered.length > 1 && (
              <button type="button" className="button button--secondary" onClick={() => void approveAllPending()} disabled={busy}>
                <Check size={16} /> Approve all {queueFiltered.length} weeks
              </button>
            )}
            <button type="button" className="button button--secondary weekly-time__stats-export" onClick={() => void loadQueue()}>
              <RefreshCw size={16} /> Refresh queue
            </button>
          </div>

          {(() => {
            const PAGE_SIZE = 10
            const pageCount = Math.max(1, Math.ceil(reviewItems.length / PAGE_SIZE))
            const page = Math.min(queuePage, pageCount - 1)
            const rows = reviewItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
            if (rows.length === 0) return null
            return (
              <>
                <table className="weekly-time__table">
                  <thead><tr><th>Employee</th><th>Item</th><th>Period</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {rows.map((item) => (
                      <tr key={item.key}>
                        <td>
                          {item.employee}
                          <span className="weekly-time__table-sub">{item.team ?? 'No team'}</span>
                        </td>
                        <td>
                          {item.kind === 'week' ? 'Week' : `Time off \u00b7 ${item.hours}h`}
                          {item.kind === 'timeoff' && item.reason ? (
                            <span className="weekly-time__table-sub">{item.reason}</span>
                          ) : null}
                        </td>
                        <td>
                          {shortDate(item.periodStart)} - {shortDate(item.periodEnd)}
                          {item.weekCount > 1 ? ` (${item.weekCount} weeks)` : ''}
                        </td>
                        <td>
                          <span className={`weekly-time__status weekly-time__status--${item.status}`}>{statusLabel(item.status)}</span>
                          <span className="weekly-time__table-sub">
                            {item.decidedBy ? `${item.decidedBy} \u00b7 ` : ''}
                            {item.when ? formatTime(item.when) : ''}
                          </span>
                        </td>
                        <td className="weekly-time__table-actions">
                          {item.kind === 'week' && (
                            <button type="button" className="table-link" onClick={() => void openSubmittedWeek({ week_start: item.periodStart, user_id: item.userId })}>
                              Open week
                            </button>
                          )}
                          {item.kind === 'week' && item.status === 'submitted' && item.submissionId && (
                            <>
                              <button type="button" className="table-link" onClick={() => setReviewModal({ id: item.submissionId as string, action: 'approve' })}>
                                Approve
                              </button>
                              <button type="button" className="table-link" onClick={() => setReviewModal({ id: item.submissionId as string, action: 'return' })}>
                                Return
                              </button>
                            </>
                          )}
                          {item.kind === 'week' && item.status === 'approved' && queueCanReopen && item.submissionId && (
                            <button type="button" className="table-link" onClick={() => setReviewModal({ id: item.submissionId as string, action: 'reopen' })}>
                              Reopen
                            </button>
                          )}
                          {item.kind === 'timeoff' && item.status === 'pending' && item.requestId && (
                            <button
                              type="button"
                              className="table-link"
                              title={item.lockedWeeks > 0
                                ? 'Some covered weeks are already submitted or approved - your approval writes the leave into them directly.'
                                : undefined}
                              onClick={() => setTimeOffReview({ id: item.requestId as string, action: 'approve' })}
                            >
                              Approve
                            </button>
                          )}
                          {item.kind === 'timeoff' && item.requestId && (
                            <button
                              type="button"
                              className="table-link"
                              title={item.status === 'approved'
                                ? 'Returning removes the approved leave from the week and lets the owner withdraw or re-request.'
                                : undefined}
                              onClick={() => setTimeOffReview({ id: item.requestId as string, action: 'return' })}
                            >
                              Return
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pageCount > 1 && (
                  <div className="weekly-time__pager">
                    <button type="button" className="table-link" disabled={page === 0} onClick={() => setQueuePage(page - 1)}>
                      <ArrowLeft size={14} /> Previous
                    </button>
                    <span>Page {page + 1} of {pageCount} \u00b7 {reviewItems.length} items</span>
                    <button type="button" className="table-link" disabled={page >= pageCount - 1} onClick={() => setQueuePage(page + 1)}>
                      Next <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </>
            )
          })()}
        </section>
      )}

      {entryModal && (
        <ModalBackdrop>
          <form className="weekly-time__modal" onSubmit={saveEntry}>
            <header><h2>{editingEntry ? 'Edit time entry' : 'Add time entry'}</h2><button type="button" onClick={() => setEntryModal(false)}><X /></button></header>
            <div className="weekly-time__form-grid">
              <label><span>Date</span><input type="date" value={entryForm.work_date} min={context.week_start} max={context.week_end} onChange={(event) => {
                const nextDate = event.target.value
                setEntryForm({ ...entryForm, work_date: nextDate, ...(isTimeOffDay(nextDate) && entryForm.entry_type !== 'leave' ? { entry_type: 'leave' } : {}) })
              }} required /></label>
              <label>
                <span>Type</span>
                <select value={entryForm.entry_type} onChange={(event) => setEntryForm({ ...entryForm, entry_type: event.target.value })}>
                  {entryTypeOptions
                    .filter((entryType) => entryType.is_active || entryType.type_key === entryForm.entry_type)
                    .filter((entryType) => !isTimeOffDay(entryForm.work_date) || entryType.type_key === 'leave')
                    .map((entryType) => <option key={entryType.type_key} value={entryType.type_key}>{entryType.label}</option>)}
                </select>
              </label>
              <label><span>Hours</span><input type="number" min={MIN_ENTRY_HOURS} max={MAX_ENTRY_HOURS} step="0.01" value={entryForm.hours} onChange={(event) => updateLinkedTimeField('hours', event.target.value)} aria-invalid={!entryValidation.valid} required /></label>
              <label><span>Start time</span><input type="time" value={entryForm.start_time} onChange={(event) => updateLinkedTimeField('start_time', event.target.value)} /></label>
              <label><span>End time</span><input type="time" value={entryForm.end_time} onChange={(event) => updateLinkedTimeField('end_time', event.target.value)} /></label>
              {isTimeOffDay(entryForm.work_date) && (
                <p className="weekly-time__grid-hint span-2">This day is approved time off - only leave hours can be recorded.</p>
              )}
              <p className={`weekly-time__duration-help span-2${entryValidation.valid ? '' : ' is-error'}`} aria-live="polite">
                {entryValidation.message}
              </p>
              <label className="span-2"><span>Notes</span><textarea rows={3} value={entryForm.notes} onChange={(event) => setEntryForm({ ...entryForm, notes: event.target.value })} /></label>
            </div>
            <footer><button type="button" className="button button--secondary" onClick={() => setEntryModal(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={busy || !entryValidation.valid}>Save entry</button></footer>
          </form>
        </ModalBackdrop>
      )}

      {timeOffModal && (
        <ModalBackdrop>
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
                  onChange={(event) => {
                    const start = event.target.value
                    // Moving the first day past the last drags the last day along.
                    setTimeOffForm((current) => ({
                      ...current,
                      start_date: start,
                      end_date: current.end_date && current.end_date < start ? start : current.end_date,
                    }))
                  }} />
              </label>
              <label>
                <span>Last day</span>
                <input type="date" required min={timeOffForm.start_date || undefined} value={timeOffForm.end_date}
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
        </ModalBackdrop>
      )}

      {timeOffReview && (
        <ModalBackdrop>
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
        </ModalBackdrop>
      )}

      {reviewModal && (
        <ModalBackdrop>
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
        </ModalBackdrop>
      )}
    </main>
  )
}
