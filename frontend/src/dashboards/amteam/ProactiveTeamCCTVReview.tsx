import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Edit3,
  Eye,
  FileText,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  deleteCctvReviewReport,
  fetchMe,
  fetchCctvReviewReportEvents,
  fetchCctvReviewReports,
  updateCctvReviewReportStatus,
  type CctvReviewReportEvent,
  type CctvReviewReport,
  type CctvReviewReportStatus,
  type PortalUser,
} from '../../management/api'
import {
  fetchAmTeamPipeGroups,
  fetchAmTeamPipes,
} from './api'
import AMTeamInspectionViewer, { downloadSavedCctvReviewReport } from './AMTeamInspectionViewer'
import type {
  AmTeamCellValue,
  AmTeamPipe,
  AmTeamPipeInspectionGroup,
} from './types'
import './ProactiveTeamCCTVReview.css'

type ReportField =
  | 'report_name'
  | 'binding_type'
  | 'binding_text'
  | 'inspection_date_text'
  | 'status'
  | 'created_by_name'
  | 'created_at'
  | 'updated_by_name'
  | 'updated_at'
  | 'submitted_by_name'
  | 'submitted_at'
  | 'reviewed_by_name'
  | 'reviewed_at'

type SortState = {
  field: ReportField
  direction: 'asc' | 'desc'
}

type ReportTableColumnKey = ReportField | 'operations'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

type SearchCandidate = {
  key: string
  kind: 'ProjectTitle' | 'Address'
  value: string
  detail: string
}

type InspectionDateOption = {
  key: string
  label: string
  dateKeys: string[]
}

type NewReportDraft = {
  reportKey: string
  reportName: string
  bindingType: CctvReviewReport['binding_type']
  bindingText: string
  searchKind: SearchCandidate['kind']
  inspectionDateKey: string
  inspectionDateText: string
}

type WorkspaceState =
  | { mode: 'new'; draft: NewReportDraft }
  | { mode: 'edit'; report: CctvReviewReport }
  | { mode: 'view'; report: CctvReviewReport }
  | { mode: 'review'; report: CctvReviewReport }

type EventModalState = {
  report: CctvReviewReport
  events: CctvReviewReportEvent[]
  loading: boolean
  error: string
}

const REPORT_COLUMNS: Array<{ field: ReportField; label: string; type?: 'status' | 'binding' | 'date' }> = [
  { field: 'binding_type', label: 'Binding', type: 'binding' },
  { field: 'binding_text', label: 'Search Text' },
  { field: 'inspection_date_text', label: 'Inspection Date' },
  { field: 'status', label: 'Status', type: 'status' },
  { field: 'created_by_name', label: 'Created By' },
  { field: 'created_at', label: 'Created At', type: 'date' },
  { field: 'updated_by_name', label: 'Updated By' },
  { field: 'submitted_by_name', label: 'Submitted By' },
  { field: 'reviewed_by_name', label: 'Reviewed By' },
]

const DEFAULT_REPORT_COLUMN_WIDTHS: Record<ReportTableColumnKey, number> = {
  report_name: 100,
  binding_type: 100,
  binding_text: 100,
  inspection_date_text: 100,
  status: 100,
  created_by_name: 100,
  created_at: 100,
  updated_by_name: 100,
  updated_at: 100,
  submitted_by_name: 100,
  submitted_at: 100,
  reviewed_by_name: 100,
  reviewed_at: 100,
  operations: 180,
}

const MIN_REPORT_COLUMN_WIDTHS: Record<ReportTableColumnKey, number> = {
  report_name: 100,
  binding_type: 100,
  binding_text: 100,
  inspection_date_text: 100,
  status: 100,
  created_by_name: 100,
  created_at: 100,
  updated_by_name: 100,
  updated_at: 100,
  submitted_by_name: 100,
  submitted_at: 100,
  reviewed_by_name: 100,
  reviewed_at: 100,
  operations: 180,
}

const REPORT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function formatStatus(status: CctvReviewReportStatus) {
  if (status === 'ready_to_review') return 'Ready to Review'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatNullableStatus(status: CctvReviewReportStatus | null) {
  return status ? formatStatus(status) : '-'
}

function formatEventType(value: string) {
  return value
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function formatBindingType(value: CctvReviewReport['binding_type']) {
  return value === 'project_title' ? 'Project Title' : 'Address'
}

function formatDate(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function cellText(report: CctvReviewReport, field: ReportField) {
  const value = report[field]
  if (field === 'status') return formatStatus(value as CctvReviewReportStatus)
  if (field === 'binding_type') return formatBindingType(value as CctvReviewReport['binding_type'])
  if (field.endsWith('_at')) return formatDate(value as string | null)
  return value == null || value === '' ? '-' : String(value)
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

const DAY_IN_MS = 24 * 60 * 60 * 1000
const INSPECTION_GROUP_DAY_WINDOW = 1

function recordText(value: AmTeamCellValue | undefined) {
  if (value == null) return ''
  return String(value).trim()
}

function inspectionDateKey(value: AmTeamCellValue | undefined) {
  const text = recordText(value)
  if (!text) return ''
  const isoDate = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (isoDate) {
    const [, year, month, day] = isoDate
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function inspectionDateTimeFromKey(key: string) {
  const date = new Date(`${key}T00:00:00`)
  return Number.isNaN(date.getTime()) ? Number.NaN : date.getTime()
}

function inspectionDateLabelFromKey(key: string) {
  const date = new Date(`${key}T00:00:00`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

function inspectionPeriodLabel(dateKeys: string[]) {
  if (dateKeys.length === 0) return '-'
  const ascendingKeys = [...dateKeys].sort((left, right) => left.localeCompare(right))
  const firstKey = ascendingKeys[0]
  const lastKey = ascendingKeys[ascendingKeys.length - 1]
  if (firstKey === lastKey) return inspectionDateLabelFromKey(firstKey)
  return `${inspectionDateLabelFromKey(firstKey)} - ${inspectionDateLabelFromKey(lastKey)}`
}

function inspectionDateOptionsFromGroups(groups: AmTeamPipeInspectionGroup[]) {
  const uniqueDateKeys = new Set<string>()
  for (const group of groups) {
    for (const inspection of group.inspections) {
      const key = inspectionDateKey(inspection.inspection_date)
      if (key) uniqueDateKeys.add(key)
    }
  }

  const descendingKeys = [...uniqueDateKeys].sort((left, right) => right.localeCompare(left))
  const options: InspectionDateOption[] = []
  let groupKeys: string[] = []
  let newestKey = ''

  for (const dateKey of descendingKeys) {
    if (groupKeys.length === 0) {
      groupKeys = [dateKey]
      newestKey = dateKey
      continue
    }

    const newestTime = inspectionDateTimeFromKey(newestKey)
    const nextTime = inspectionDateTimeFromKey(dateKey)
    const dayDifference = Math.abs(newestTime - nextTime) / DAY_IN_MS
    if (Number.isFinite(dayDifference) && dayDifference <= INSPECTION_GROUP_DAY_WINDOW) {
      groupKeys.push(dateKey)
      continue
    }

    options.push({
      key: groupKeys.join('|'),
      label: inspectionPeriodLabel(groupKeys),
      dateKeys: groupKeys,
    })
    groupKeys = [dateKey]
    newestKey = dateKey
  }

  if (groupKeys.length > 0) {
    options.push({
      key: groupKeys.join('|'),
      label: inspectionPeriodLabel(groupKeys),
      dateKeys: groupKeys,
    })
  }

  return options
}

function pipeSearchCandidates(pipes: AmTeamPipe[]) {
  const candidates: SearchCandidate[] = []
  const seenKeys = new Set<string>()
  for (const pipe of pipes) {
    const pairs: Array<[SearchCandidate['kind'], string, string]> = [
      ['ProjectTitle', recordText(pipe.project_title), recordText(pipe.street)],
      ['Address', recordText(pipe.street), recordText(pipe.project_title)],
    ]
    for (const [kind, value, detail] of pairs) {
      if (!value) continue
      const key = `${kind}:${value.toLowerCase()}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      candidates.push({ key, kind, value, detail })
    }
  }
  return candidates.slice(0, 10)
}

function compactDateToken(dateKey: string) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return dateKey.replace(/[^A-Za-z0-9]+/g, '')
  const [, year, month, day] = match
  return `${month}${day}${year}`
}

function reportInspectionDateText(option: InspectionDateOption) {
  const ordered = [...option.dateKeys].sort((left, right) => left.localeCompare(right))
  const first = compactDateToken(ordered[0] ?? '')
  const last = compactDateToken(ordered[ordered.length - 1] ?? '')
  if (!first) return ''
  return first === last ? first : `${first} - ${last}`
}

function reportInspectionDateKeyText(option: InspectionDateOption) {
  return reportInspectionDateText(option).replace(/\s+-\s+/g, '-')
}

function normalizeReportKey(value: string) {
  return value.trim().replace(/\s*@\s*/g, '@').replace(/\s*-\s*/g, '-').replace(/\s+/g, '')
}

function reportDisplayKey(report: Pick<CctvReviewReport, 'report_key' | 'report_name'>) {
  return normalizeReportKey(report.report_key || report.report_name)
}

function dateTokenToInspectionKey(token: string) {
  const match = token.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!match) return ''
  const [, month, day, year] = match
  return `${year}-${month}-${day}`
}

function inspectionOptionKeyFromReportDateText(value: string) {
  return (value.match(/\d{8}/g) ?? [])
    .map(dateTokenToInspectionKey)
    .filter(Boolean)
    .join('|')
}

function normalizeReportBindingText(value: string) {
  return value.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildReportDraft(candidate: SearchCandidate, dateOption: InspectionDateOption): NewReportDraft {
  const normalizedBinding = normalizeReportBindingText(candidate.value)
  const inspectionDateText = reportInspectionDateText(dateOption)
  const reportKey = normalizeReportKey(`${normalizedBinding}@${reportInspectionDateKeyText(dateOption)}`)
  return {
    reportKey,
    reportName: reportKey,
    bindingType: candidate.kind === 'ProjectTitle' ? 'project_title' : 'address',
    bindingText: candidate.value,
    searchKind: candidate.kind,
    inspectionDateKey: dateOption.key,
    inspectionDateText,
  }
}

function NewReportCreator({
  reports,
  onReportsLoaded,
  onStartDraft,
}: {
  reports: CctvReviewReport[]
  onReportsLoaded: (reports: CctvReviewReport[]) => void
  onStartDraft: (draft: NewReportDraft) => void
}) {
  const [searchTerm, setSearchTerm] = useState('')
  const [candidatePipes, setCandidatePipes] = useState<AmTeamPipe[]>([])
  const [candidateStatus, setCandidateStatus] = useState<LoadStatus>('idle')
  const [candidateMessage, setCandidateMessage] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState<SearchCandidate | null>(null)
  const [pipeStatus, setPipeStatus] = useState<LoadStatus>('idle')
  const [dateOptions, setDateOptions] = useState<InspectionDateOption[]>([])
  const [selectedDateKey, setSelectedDateKey] = useState('')

  const candidates = useMemo(() => pipeSearchCandidates(candidatePipes), [candidatePipes])
  const selectedDateOption = dateOptions.find((option) => option.key === selectedDateKey) ?? null

  useEffect(() => {
    const query = searchTerm.trim()

    if (selectedCandidate && query === selectedCandidate.value) {
      return
    }

    setDateOptions([])
    setSelectedDateKey('')

    if (query.length < 2) {
      setCandidatePipes([])
      setCandidateStatus('idle')
      setPipeStatus('idle')
      setCandidateMessage('')
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setCandidateStatus('loading')
      setPipeStatus('idle')
      setCandidateMessage('')
      fetchAmTeamPipes(query)
        .then((response) => {
          if (cancelled) return
          setCandidatePipes(response.rows)
          setCandidateStatus('ready')
        })
        .catch((error) => {
          if (cancelled) return
          setCandidatePipes([])
          setCandidateStatus('error')
          setCandidateMessage(error instanceof Error ? error.message : 'Candidate lookup failed.')
          toast.error(error instanceof Error ? error.message : 'Candidate lookup failed.')
        })
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchTerm, selectedCandidate])

  async function chooseCandidate(candidate: SearchCandidate) {
    setSelectedCandidate(candidate)
    setSearchTerm(candidate.value)
    setCandidatePipes([])
    setCandidateStatus('idle')
    setPipeStatus('loading')
    try {
      const response = await fetchAmTeamPipeGroups(candidate.value, candidate.kind)
      const nextOptions = inspectionDateOptionsFromGroups(response.rows)
      setDateOptions(nextOptions)
      setSelectedDateKey(nextOptions[0]?.key ?? '')
      setPipeStatus(nextOptions.length ? 'ready' : 'error')
      if (!nextOptions.length) toast.warning('No inspections were found for this project or address.')
    } catch (error) {
      setDateOptions([])
      setSelectedDateKey('')
      setPipeStatus('error')
      toast.error(error instanceof Error ? error.message : 'Inspection date lookup failed.')
    }
  }

  async function startDraft() {
    if (!selectedCandidate || !selectedDateOption) return
    const draft = buildReportDraft(selectedCandidate, selectedDateOption)
    setPipeStatus('loading')
    try {
      const response = await fetchCctvReviewReports()
      onReportsLoaded(response.reports)
      const duplicate = response.reports.find((report) => report.report_key === draft.reportKey)
        ?? reports.find((report) => report.report_key === draft.reportKey)
      if (duplicate) {
        setPipeStatus('ready')
        toast.warning(`Report has already been created: ${duplicate.report_name}.`)
        return
      }
      setPipeStatus('ready')
      onStartDraft(draft)
    } catch (error) {
      setPipeStatus('error')
      toast.error(error instanceof Error ? error.message : 'Unable to check existing reports.')
    }
  }

  return (
    <section className="cctv-new-report-panel" aria-label="Create report">
      <header>
        <strong>Review navigation</strong>
      </header>
      <div className="cctv-new-report-section">
        <label htmlFor="cctv-new-report-search">Search</label>
        <div className="cctv-new-report-search-row">
          <Search size={18} />
          <input
            id="cctv-new-report-search"
            type="search"
            value={searchTerm}
            placeholder="Address or project title"
            onChange={(event) => {
              setSelectedCandidate(null)
              setSearchTerm(event.currentTarget.value)
            }}
          />
        </div>
      </div>

      <div className="cctv-new-report-scroll">
        {candidateStatus === 'idle' && !selectedCandidate ? (
          <div className="cctv-new-report-note">
            <AlertCircle size={20} />
            <span>Enter a project title or address.</span>
          </div>
        ) : null}
        {candidateStatus === 'loading' ? (
          <div className="cctv-new-report-note">
            <Loader2 className="spin" size={20} />
            <span>Finding candidates.</span>
          </div>
        ) : null}
        {candidateStatus === 'error' ? (
          <div className="cctv-new-report-note error">
            <AlertCircle size={20} />
            <span>{candidateMessage}</span>
          </div>
        ) : null}
        {candidateStatus === 'ready' && candidates.length === 0 ? (
          <div className="cctv-new-report-note">
            <AlertCircle size={20} />
            <span>No matching project or address.</span>
          </div>
        ) : null}
        {candidates.length ? (
          <div className="cctv-new-report-candidates">
            {candidates.map((candidate) => (
              <button key={candidate.key} type="button" onClick={() => chooseCandidate(candidate)}>
                <span>{candidate.kind === 'ProjectTitle' ? 'Project' : 'Address'}</span>
                <strong>{candidate.value}</strong>
                {candidate.detail ? <small>{candidate.detail}</small> : null}
              </button>
            ))}
          </div>
        ) : null}

        {selectedCandidate ? (
          <div className="cctv-new-report-selected">
            <span>{selectedCandidate.kind === 'ProjectTitle' ? 'Project' : 'Address'}</span>
            <strong>{selectedCandidate.value}</strong>
            {selectedCandidate.detail ? <small>{selectedCandidate.detail}</small> : null}
          </div>
        ) : null}
      </div>

      <div className="cctv-new-report-date">
        <label htmlFor="cctv-new-report-date">Inspection date</label>
        <select
          id="cctv-new-report-date"
          value={selectedDateKey}
          disabled={!dateOptions.length || pipeStatus === 'loading'}
          onChange={(event) => setSelectedDateKey(event.currentTarget.value)}
        >
          {!dateOptions.length ? <option value="">Select a project or address</option> : null}
          {dateOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <button
        className="cctv-new-report-start"
        disabled={!selectedCandidate || !selectedDateOption || pipeStatus === 'loading'}
        onClick={startDraft}
        type="button"
      >
        {pipeStatus === 'loading' ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
        Start report
      </button>
    </section>
  )
}

function ReportDownloadProgress({ reportName }: { reportName: string }) {
  return (
    <div className="cctv-report-download-progress" role="status" aria-live="polite">
      <div className="cctv-report-download-progress-panel">
        <Loader2 className="spin" size={30} aria-hidden="true" />
        <strong>Generating report</strong>
        <span>{reportName ? `Preparing ${reportName}.` : 'Preparing report download.'}</span>
        <div className="cctv-report-download-progress-bar" aria-hidden="true">
          <i />
        </div>
      </div>
    </div>
  )
}

export default function ProactiveTeamCCTVReview() {
  const [reports, setReports] = useState<CctvReviewReport[]>([])
  const [currentUser, setCurrentUser] = useState<PortalUser | null>(null)
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<SortState>({ field: 'updated_at', direction: 'desc' })
  const [columnWidths, setColumnWidths] = useState<Record<ReportTableColumnKey, number>>(DEFAULT_REPORT_COLUMN_WIDTHS)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [isCreateModalOpen, setCreateModalOpen] = useState(false)
  const [workspaceModal, setWorkspaceModal] = useState<WorkspaceState | null>(null)
  const [eventModal, setEventModal] = useState<EventModalState | null>(null)
  const [downloadingReportId, setDownloadingReportId] = useState<number | null>(null)

  async function loadReports() {
    setLoading(true)
    try {
      const [meResponse, reportsResponse] = await Promise.all([fetchMe(), fetchCctvReviewReports()])
      setCurrentUser(meResponse.user)
      setReports(reportsResponse.reports)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load reports.'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadReports()
  }, [])

  function handleReportSaved(report: CctvReviewReport) {
    toast.success('Report saved.')
    setReports((currentReports) => {
      const existingIndex = currentReports.findIndex((currentReport) => currentReport.id === report.id)
      if (existingIndex < 0) return [report, ...currentReports]
      const nextReports = [...currentReports]
      nextReports[existingIndex] = report
      return nextReports
    })
  }

  function reportSaveContextFromDraft(draft: NewReportDraft) {
    return {
      reportKey: draft.reportKey,
      reportName: draft.reportName,
      bindingType: draft.bindingType,
      bindingText: draft.bindingText,
      inspectionDateText: draft.inspectionDateText,
    }
  }

  function reportSaveContextFromReport(report: CctvReviewReport) {
    return {
      reportKey: report.report_key,
      reportName: reportDisplayKey(report),
      bindingType: report.binding_type,
      bindingText: report.binding_text,
      inspectionDateText: report.inspection_date_text,
    }
  }

  const filteredReports = useMemo(() => {
    const activeFilters = Object.entries(filters).filter(([, value]) => value.trim())
    const visible = reports.filter((report) =>
      activeFilters.every(([field, value]) => {
        const search = value.trim().toLowerCase()
        return cellText(report, field as ReportField).toLowerCase().includes(search)
      }),
    )
    return [...visible].sort((left, right) => {
      const direction = sort.direction === 'asc' ? 1 : -1
      return compareText(cellText(left, sort.field), cellText(right, sort.field)) * direction
    })
  }, [filters, reports, sort])

  const pageCount = Math.max(1, Math.ceil(filteredReports.length / pageSize))
  const currentPageIndex = Math.min(pageIndex, pageCount - 1)
  const firstRecord = filteredReports.length === 0 ? 0 : currentPageIndex * pageSize + 1
  const lastRecord = filteredReports.length === 0 ? 0 : Math.min((currentPageIndex + 1) * pageSize, filteredReports.length)
  const pagedReports = filteredReports.slice(currentPageIndex * pageSize, currentPageIndex * pageSize + pageSize)
  const reportTableWidth = REPORT_COLUMNS.reduce((total, column) => total + columnWidths[column.field], columnWidths.operations)
  const reportTableStyle = { '--cctv-report-table-width': `${reportTableWidth}px` } as CSSProperties
  const downloadingReport = downloadingReportId === null
    ? null
    : reports.find((report) => report.id === downloadingReportId) ?? null

  useEffect(() => {
    setPageIndex(0)
  }, [filters, pageSize, sort])

  useEffect(() => {
    if (pageIndex >= pageCount) setPageIndex(pageCount - 1)
  }, [pageCount, pageIndex])

  function setFilter(field: ReportField, value: string) {
    setFilters((current) => ({ ...current, [field]: value }))
  }

  function toggleSort(field: ReportField) {
    setSort((current) => ({
      field,
      direction: current.field === field && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  function startColumnResize(event: ReactPointerEvent<HTMLButtonElement>, column: ReportTableColumnKey) {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = columnWidths[column]

    const resizeColumn = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(MIN_REPORT_COLUMN_WIDTHS[column], startWidth + moveEvent.clientX - startX)
      setColumnWidths((currentWidths) => ({ ...currentWidths, [column]: Math.round(nextWidth) }))
    }
    const stopResize = () => {
      window.removeEventListener('pointermove', resizeColumn)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', resizeColumn)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  function columnResizeHandle(column: ReportTableColumnKey, label: string) {
    return (
      <button
        type="button"
        className="cctv-report-column-resizer"
        aria-label={`Resize ${label} column`}
        title={`Resize ${label} column`}
        onPointerDown={(event) => startColumnResize(event, column)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const direction = event.key === 'ArrowLeft' ? -12 : 12
          setColumnWidths((currentWidths) => ({
            ...currentWidths,
            [column]: Math.max(MIN_REPORT_COLUMN_WIDTHS[column], currentWidths[column] + direction),
          }))
        }}
      >
        <span aria-hidden="true" />
      </button>
    )
  }

  async function runStatusAction(report: CctvReviewReport, action: 'submit_to_review' | 'return_to_edit' | 'complete') {
    try {
      await updateCctvReviewReportStatus(report.id, { action })
      toast.success('Report status updated.')
      await loadReports()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update report status.'
      toast.error(message)
    }
  }

  async function deleteReport(report: CctvReviewReport) {
    const confirmed = window.confirm(`Delete ${formatStatus(report.status).toLowerCase()} report "${report.report_name}"? This action cannot be undone.`)
    if (!confirmed) return

    try {
      await deleteCctvReviewReport(report.id)
      toast.success('Report deleted.')
      setReports((currentReports) => currentReports.filter((currentReport) => currentReport.id !== report.id))
      setWorkspaceModal((currentWorkspace) =>
        currentWorkspace && 'report' in currentWorkspace && currentWorkspace.report.id === report.id ? null : currentWorkspace,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to delete report.'
      toast.error(message)
    }
  }

  async function openReportEvents(report: CctvReviewReport) {
    setEventModal({ report, events: [], loading: true, error: '' })
    try {
      const response = await fetchCctvReviewReportEvents(report.id)
      setEventModal({ report, events: response.events, loading: false, error: '' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load report events.'
      toast.error(message)
      setEventModal({
        report,
        events: [],
        loading: false,
        error: message,
      })
    }
  }

  async function downloadReport(report: CctvReviewReport) {
    setDownloadingReportId(report.id)
    try {
      await downloadSavedCctvReviewReport(report)
      toast.success('Report download started.')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.error(err instanceof Error ? err.message : 'Unable to download report.')
    } finally {
      setDownloadingReportId(null)
    }
  }

  function canDeleteReport(report: CctvReviewReport) {
    if (report.can_delete) return true
    if (!currentUser) return false
    if (currentUser.selected_role === 'admin' || currentUser.selected_role === 'system_admin') return true
    return report.status === 'pending' && report.created_by_user_id === currentUser.id
  }

  function renderFilter(column: (typeof REPORT_COLUMNS)[number]) {
    const value = filters[column.field] ?? ''
    if (column.type === 'status') {
      return (
        <select value={value} onChange={(event) => setFilter(column.field, event.target.value)}>
          <option value="">All</option>
          <option value="Pending">Pending</option>
          <option value="Ready to Review">Ready</option>
          <option value="Completed">Completed</option>
        </select>
      )
    }
    if (column.type === 'binding') {
      return (
        <select value={value} onChange={(event) => setFilter(column.field, event.target.value)}>
          <option value="">All</option>
          <option value="Address">Address</option>
          <option value="Project Title">Project</option>
        </select>
      )
    }
    return (
      <input
        value={value}
        onChange={(event) => setFilter(column.field, event.target.value)}
        placeholder="Filter"
        type="text"
      />
    )
  }

  function renderActions(report: CctvReviewReport) {
    const isPending = report.status === 'pending'
    const isReady = report.status === 'ready_to_review'

    return (
      <div className="cctv-report-actions">
        <button aria-label="View report" onClick={() => setWorkspaceModal({ mode: 'view', report })} title="View report" type="button">
          <Eye size={15} />
        </button>
        {isPending ? (
          <>
            <button aria-label="Edit report" onClick={() => setWorkspaceModal({ mode: 'edit', report })} title="Edit report" type="button">
              <Edit3 size={15} />
            </button>
            <button aria-label="Submit to review" onClick={() => runStatusAction(report, 'submit_to_review')} title="Submit to review" type="button">
              <Send size={15} />
            </button>
          </>
        ) : null}
        {isReady ? (
          <>
            <button aria-label="Return to edit" onClick={() => runStatusAction(report, 'return_to_edit')} title="Return to edit" type="button">
              <RotateCcw size={15} />
            </button>
            <button aria-label="Complete review" onClick={() => runStatusAction(report, 'complete')} title="Complete review" type="button">
              <CheckCircle2 size={15} />
            </button>
          </>
        ) : null}
        <button
          aria-label="Download report"
          disabled={downloadingReportId === report.id}
          onClick={() => void downloadReport(report)}
          title="Download report"
          type="button"
        >
          {downloadingReportId === report.id ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
        </button>
        <button aria-label="Report events" onClick={() => void openReportEvents(report)} title="Report events" type="button">
          <History size={15} />
        </button>
        {canDeleteReport(report) ? (
          <button className="danger" aria-label="Delete report" onClick={() => void deleteReport(report)} title="Delete report" type="button">
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
    )
  }

  function renderWorkspace() {
    const workspace = workspaceModal
    if (!workspace) {
      return (
        <div className="cctv-report-workspace-empty">
          <FileText size={34} />
          <strong>Create a report from the left panel.</strong>
          <span>Select a project or address and an inspection date to open the review workspace.</span>
        </div>
      )
    }

    if (workspace.mode === 'new') {
      return (
        <AMTeamInspectionViewer
          key={`new-${workspace.draft.reportKey}`}
          initialSearchTerm={workspace.draft.bindingText}
          initialSearchKind={workspace.draft.searchKind}
          initialInspectionDateKey={workspace.draft.inspectionDateKey}
          hideReviewNavigation
          reportSaveContext={reportSaveContextFromDraft(workspace.draft)}
          onReportSaved={handleReportSaved}
        />
      )
    }

    return (
      <AMTeamInspectionViewer
        key={`${workspace.mode}-${workspace.report.id}`}
        initialSearchTerm={workspace.report.binding_text}
        initialSearchKind={workspace.report.binding_type === 'project_title' ? 'ProjectTitle' : 'Address'}
        initialInspectionDateKey={inspectionOptionKeyFromReportDateText(workspace.report.inspection_date_text)}
        hideReviewNavigation
        savedReport={workspace.report}
        readOnly={workspace.mode !== 'edit'}
        reportSaveContext={workspace.mode === 'edit' ? reportSaveContextFromReport(workspace.report) : undefined}
        onReportSaved={handleReportSaved}
      />
    )
  }

  function workspaceTitle() {
    const workspace = workspaceModal
    if (!workspace) return 'Report Edit / View'
    if (workspace.mode === 'new') return `New: ${workspace.draft.reportName}`
    if (workspace.mode === 'edit') return `Edit: ${reportDisplayKey(workspace.report)}`
    return `View: ${reportDisplayKey(workspace.report)}`
  }

  return (
    <div className="cctv-report-page">
      <section className="cctv-report-shell">
        <div className="cctv-report-toolbar">
          <div>
            <h1>Proactive Team CCTV Review</h1>
          </div>
          <div className="cctv-report-toolbar-actions">
            <button onClick={loadReports} type="button">
              <RefreshCw size={16} /> Refresh
            </button>
            <button className="primary" onClick={() => setCreateModalOpen(true)} type="button">
              <Plus size={17} /> New Report
            </button>
          </div>
        </div>

        <div className="cctv-report-table-summary">
          <span>{firstRecord}-{lastRecord} shown</span>
          <span>{filteredReports.length} filtered</span>
          <span>{reports.length} total</span>
          {loading ? <span>Loading...</span> : null}
        </div>

        <div className="cctv-report-table-wrap">
          <table className={`cctv-report-table${filteredReports.length ? '' : ' is-empty'}`} style={reportTableStyle}>
            <colgroup>
              {REPORT_COLUMNS.map((column) => (
                <col key={column.field} style={{ width: `${columnWidths[column.field]}px` }} />
              ))}
              <col style={{ width: `${columnWidths.operations}px` }} />
            </colgroup>
            <thead>
              <tr>
                {REPORT_COLUMNS.map((column) => (
                  <th className="cctv-report-resizable-header" key={column.field}>
                    <button className="cctv-report-sort" onClick={() => toggleSort(column.field)} type="button">
                      {column.label}
                      <span className={sort.field === column.field ? 'active' : ''} aria-hidden="true">
                        {sort.field === column.field ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                    {columnResizeHandle(column.field, column.label)}
                  </th>
                ))}
                <th className="cctv-report-operations-col cctv-report-resizable-header">
                  <span className="cctv-report-operations-heading">Operations</span>
                  {columnResizeHandle('operations', 'Operations')}
                </th>
              </tr>
              <tr className="cctv-report-filter-row">
                {REPORT_COLUMNS.map((column) => (
                  <th key={column.field}>{renderFilter(column)}</th>
                ))}
                <th className="cctv-report-operations-col">
                  <button onClick={() => setFilters({})} type="button">
                    <X size={14} /> Clear
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedReports.map((report) => (
                <tr key={report.id}>
                  {REPORT_COLUMNS.map((column) => (
                    <td key={column.field}>{cellText(report, column.field)}</td>
                  ))}
                  <td className="cctv-report-operations-col">{renderActions(report)}</td>
                </tr>
              ))}
              {!filteredReports.length ? (
                <tr>
                  <td className="cctv-report-empty" colSpan={REPORT_COLUMNS.length + 1}>
                    <Search size={24} />
                    <span>No CCTV review reports found.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="cctv-report-pagination" aria-label="Report table pagination">
          <div className="cctv-report-page-size">
            <span>Rows</span>
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
            >
              {REPORT_PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          <span>
            Page {filteredReports.length === 0 ? 1 : currentPageIndex + 1} of {pageCount}
          </span>
          <div className="cctv-report-pagination-actions">
            <button type="button" title="First page" aria-label="First page" disabled={currentPageIndex === 0} onClick={() => setPageIndex(0)}>
              <ChevronsLeft size={16} />
            </button>
            <button type="button" title="Previous page" aria-label="Previous page" disabled={currentPageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" title="Next page" aria-label="Next page" disabled={currentPageIndex >= pageCount - 1 || filteredReports.length === 0} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}>
              <ChevronRight size={16} />
            </button>
            <button type="button" title="Last page" aria-label="Last page" disabled={currentPageIndex >= pageCount - 1 || filteredReports.length === 0} onClick={() => setPageIndex(pageCount - 1)}>
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {isCreateModalOpen ? (
        <div className="cctv-report-modal cctv-report-create-modal" role="dialog" aria-modal="true" aria-label="Create report">
          <div className="cctv-report-modal-backdrop" onClick={() => setCreateModalOpen(false)} />
          <aside className="cctv-report-popup-window cctv-report-create-window" aria-label="Create report">
            <button className="cctv-report-modal-close" onClick={() => setCreateModalOpen(false)} title="Close" type="button">
              <X size={24} />
            </button>
            <NewReportCreator
              reports={reports}
              onReportsLoaded={setReports}
              onStartDraft={(draft) => {
                setCreateModalOpen(false)
                setWorkspaceModal({ mode: 'new', draft })
              }}
            />
          </aside>
        </div>
      ) : null}

      {workspaceModal ? (
        <div className="cctv-report-modal cctv-report-workspace-modal" role="dialog" aria-modal="true" aria-label="Report edit and view">
          <div className="cctv-report-modal-backdrop" onClick={() => setWorkspaceModal(null)} />
          <section className="cctv-report-popup-window cctv-report-review-window" aria-label="Report edit and view">
            <button className="cctv-report-modal-close" onClick={() => setWorkspaceModal(null)} title="Close" type="button">
              <X size={24} />
            </button>
            <header className="cctv-report-review-pane-header">
              <strong>{workspaceTitle()}</strong>
            </header>
            <div className="cctv-report-review-pane-body">
              {renderWorkspace()}
            </div>
          </section>
        </div>
      ) : null}

      {eventModal ? (
        <div className="cctv-report-modal cctv-report-events-modal" role="dialog" aria-modal="true" aria-label="Report events">
          <div className="cctv-report-modal-backdrop" onClick={() => setEventModal(null)} />
          <section className="cctv-report-popup-window cctv-report-events-window" aria-label="Report events">
            <button className="cctv-report-modal-close" onClick={() => setEventModal(null)} title="Close" type="button">
              <X size={24} />
            </button>
            <header className="cctv-report-events-header">
              <strong>Report Events</strong>
              <span>{reportDisplayKey(eventModal.report)}</span>
            </header>
            <div className="cctv-report-events-body">
              {eventModal.loading ? (
                <div className="cctv-report-events-status">
                  <Loader2 size={18} /> Loading events...
                </div>
              ) : null}
              {eventModal.error ? <div className="cctv-report-message error">{eventModal.error}</div> : null}
              {!eventModal.loading && !eventModal.error ? (
                <table className="cctv-report-events-table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>User</th>
                      <th>Event Time</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Memo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventModal.events.map((event) => (
                      <tr key={event.id}>
                        <td>{formatEventType(event.event_type)}</td>
                        <td>{event.event_by_name || '-'}</td>
                        <td>{formatDate(event.event_at)}</td>
                        <td>{formatNullableStatus(event.from_status)}</td>
                        <td>{formatNullableStatus(event.to_status)}</td>
                        <td>{event.memo || '-'}</td>
                      </tr>
                    ))}
                    {!eventModal.events.length ? (
                      <tr>
                        <td colSpan={6}>No report events found.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {downloadingReportId !== null ? (
        <ReportDownloadProgress reportName={downloadingReport ? reportDisplayKey(downloadingReport) : ''} />
      ) : null}
    </div>
  )
}
