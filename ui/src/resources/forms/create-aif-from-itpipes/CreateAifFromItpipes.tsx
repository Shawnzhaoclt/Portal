import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  FilePlus2,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { formatDateOnly, formatDateTime } from '../../../lib/dateTime'
import { appConfirm } from '../../../components/messageDialogService'
import { fetchPortalDictionaryItems } from '../../../dashboards/amteam/api'
import { openExternalUrl } from '../../../desktop/runtime'
import {
  inspectionDateKey,
  inspectionDateKeysFromOption,
  inspectionDateOptions,
} from '../../../dashboards/amteam/inspectionDates'
import {
  createAif,
  deleteAif,
  exportAifRegister,
  fetchAif,
  fetchAifAssetCandidates,
  fetchAifEnrichment,
  fetchAifEvents,
  fetchAifObservations,
  fetchAifReviewers,
  fetchAifs,
  saveAif,
  searchAifAsset,
  submitAif,
  transitionAif,
  type AifEditableFields,
  type AifEvent,
  type AifRecord,
  type AifStatus,
  type AssetSearchResponse,
  type RegisterFilters,
  type Reviewer,
  type SourceObservation,
} from './api'
import './CreateAifFromItpipes.css'

const EMPTY_FILTERS: RegisterFilters = {
  saved_view: 'all',
  search: '',
  status: '',
  source_date_from: '',
  source_date_to: '',
  initiated_from: '',
  initiated_to: '',
  submitted_from: '',
  submitted_to: '',
  closed_from: '',
  closed_to: '',
  initiator_employee_id: '',
  reviewer_employee_id: '',
  defect_severity: '',
}

const ITPIPES_INSPECTION_URL = 'https://charlottenc.itpipes.com/Asset/SearchByInspId'
const LOW_CONDITION_RISK_THRESHOLD = 15
type InspectionDirectionOption = { value: 0 | 1; label: string }

function itpipesInspectionUrl(mliId: string) {
  const url = new URL(ITPIPES_INSPECTION_URL)
  url.searchParams.set('assetType', 'ML')
  url.searchParams.set('inspID', mliId)
  return url.toString()
}

function formatConditionRisk(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) return '-'
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  })
}

function formatStationDistance(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) return '-'
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  })
}

function inspectionDirectionLabel(value: number | null | undefined, options: InspectionDirectionOption[] = []) {
  const configured = options.find((option) => option.value === value)
  return configured?.label ?? 'Not available'
}

function canonicalDictionaryLabel(value: string | null, options: string[]) {
  if (!value) return null
  const normalized = value.trim().toLocaleLowerCase()
  return options.find((option) => option.trim().toLocaleLowerCase() === normalized) ?? null
}

function configuredDictionaryLabel(value: string | null, options: string[]) {
  if (!value) return null
  const normalized = value.trim().toLocaleLowerCase()
  return options.find((option) => option.trim().toLocaleLowerCase() === normalized) ?? null
}

const EMPTY_FIELDS: AifEditableFields = {
  inspection_direction: null,
  flooding_impact: null,
  flooding_service_eligibility: null,
  flooding_design_standards: null,
  defect_severity: null,
  defect_callout: null,
  consequence_location: null,
  consequence_location_zol: null,
  service_eligibility: null,
  defect_stationing: null,
  limited_extensive: null,
}

type Workspace = {
  mode: 'new' | 'view' | 'edit' | 'review'
  record: AifRecord | null
  initialDialog?: 'events' | 'submit' | 'reopen'
}
type Message = { kind: 'error' | 'warning' | 'success' | 'info'; text: string }

function errorText(error: unknown) {
  if (!(error instanceof Error)) return 'The operation could not be completed.'
  try {
    const parsed = JSON.parse(error.message) as { message?: string; fields?: string[] }
    return [parsed.message, ...(parsed.fields ?? [])].filter(Boolean).join(' ')
  } catch {
    return error.message
  }
}

function statusLabel(status: AifStatus) {
  if (status === 'ready_to_review') return 'Ready to review'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function eventLabel(value: string) {
  return value.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function editableFromRecord(record: AifRecord): AifEditableFields {
  return Object.fromEntries(Object.keys(EMPTY_FIELDS).map((key) => [key, record[key as keyof AifRecord] ?? null])) as AifEditableFields
}

function normalizeFields(fields: AifEditableFields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === '' ? null : value])) as AifEditableFields
}

function recordDate(value: string | null | undefined, dateOnly = false) {
  if (!value) return '-'
  return dateOnly ? formatDateOnly(value, value) : formatDateTime(value, value)
}

function MessageBar({ message, onClose }: { message: Message; onClose: () => void }) {
  return (
    <div className={`aif-message aif-message-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
      {message.kind === 'error' || message.kind === 'warning' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
      <span>{message.text}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss message"><X size={17} /></button>
    </div>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="aif-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="aif-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label={`Close ${title}`}><X size={20} /></button></header>
        {children}
      </section>
    </div>
  )
}

function AifRegister({
  onOpen,
  refreshToken,
  selectedGlobalId,
}: {
  onOpen: (workspace: Workspace) => void
  refreshToken: number
  selectedGlobalId: string | null
}) {
  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<RegisterFilters>(EMPTY_FILTERS)
  const [sort, setSort] = useState('updated_at')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize] = useState(25)
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([])
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAifs>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [deletingGlobalId, setDeletingGlobalId] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [severityOptions, setSeverityOptions] = useState<string[]>([])

  async function load() {
    setLoading(true)
    try {
      setData(await fetchAifs(appliedFilters, sort, direction, pageSize, cursor))
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [appliedFilters, sort, direction, pageSize, cursor, refreshToken])
  useEffect(() => {
    fetchPortalDictionaryItems('defect_severity').then((response) => setSeverityOptions(response.items.filter((item) => item.is_active).map((item) => item.label))).catch(() => undefined)
  }, [])

  function applyFilters(next = filters) {
    setCursor(null)
    setCursorStack([])
    setAppliedFilters({ ...next })
  }

  function updateSort(column: string) {
    if (sort === column) setDirection((value) => value === 'asc' ? 'desc' : 'asc')
    else { setSort(column); setDirection('asc') }
    setCursor(null)
    setCursorStack([])
  }

  async function exportRows() {
    setExporting(true)
    try {
      const fileName = await exportAifRegister(appliedFilters, sort, direction)
      setMessage({ kind: 'success', text: `Excel export created: ${fileName}` })
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) })
    } finally {
      setExporting(false)
    }
  }

  async function deleteDraft(row: AifRecord) {
    const confirmed = await appConfirm(
      `Delete draft ${row.inspection_id}? This action cannot be undone. Its audit events will be retained.`,
      { title: 'Delete AIF draft', kind: 'danger', confirmLabel: 'Delete draft' },
    )
    if (!confirmed) return
    setDeletingGlobalId(row.global_id)
    try {
      await deleteAif(row)
      setMessage({ kind: 'success', text: `${row.inspection_id} was deleted.` })
      await load()
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) })
    } finally {
      setDeletingGlobalId(null)
    }
  }

  const counts = data?.status_counts
  return (
    <main className="aif-resource aif-register-page">
      <header className="aif-page-header">
        <div><span>ASSET INSPECTION FORMS</span><h1 className="sr-only">AIF Register</h1></div>
        <div className="aif-header-actions">
          <span className="aif-total">{data?.total ?? 0} AIFs</span>
          <button className="secondary" type="button" disabled={!data?.can_export || exporting} onClick={() => void exportRows()}>
            {exporting ? <Loader2 className="spin" size={18} /> : <Download size={18} />} Export
          </button>
          <button className="primary" type="button" disabled={!data?.can_create} onClick={() => onOpen({ mode: 'new', record: null })}>
            <FilePlus2 size={18} /> Create AIF
          </button>
        </div>
      </header>
      {message ? <MessageBar message={message} onClose={() => setMessage(null)} /> : null}
      <section className="aif-register-toolbar" aria-label="AIF Register filters">
        <nav className="aif-view-tabs" aria-label="Saved views">
          {[
            ['all', 'All AIFs'], ['my_drafts', 'My drafts'], ['assigned_to_me', 'Assigned to me'],
            ['ready_to_review', 'Ready for review'], ['completed', 'Completed'],
          ].map(([key, label]) => (
            <button key={key} className={filters.saved_view === key ? 'active' : ''} type="button" onClick={() => {
              const next = { ...filters, saved_view: key }
              setFilters(next); applyFilters(next)
            }}>{label}</button>
          ))}
        </nav>
        <div className="aif-filter-row">
          <label className="aif-search"><Search size={18} /><input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && applyFilters()} placeholder="Search AIF, Asset, MLI, MLO, or person" /></label>
          <select aria-label="Status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">All statuses</option><option value="pending">Pending</option><option value="ready_to_review">Ready to review</option><option value="completed">Completed</option>
          </select>
          <select aria-label="Defect severity" value={filters.defect_severity} onChange={(event) => setFilters({ ...filters, defect_severity: event.target.value })}>
            <option value="">All severities</option>{severityOptions.map((value) => <option key={value}>{value}</option>)}
          </select>
          <button className="secondary" type="button" onClick={() => applyFilters()}><Search size={17} /> Apply</button>
          <button className="text" type="button" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'More'} filters <ChevronDown size={16} /></button>
          <button className="icon" type="button" onClick={() => void load()} aria-label="Refresh AIF Register"><RefreshCw size={18} /></button>
        </div>
        {advanced ? (
          <div className="aif-advanced-filters">
            <label>Source date from<input type="date" value={filters.source_date_from} onChange={(event) => setFilters({ ...filters, source_date_from: event.target.value })} /></label>
            <label>Source date to<input type="date" value={filters.source_date_to} onChange={(event) => setFilters({ ...filters, source_date_to: event.target.value })} /></label>
            <label>Initiated from<input type="date" value={filters.initiated_from} onChange={(event) => setFilters({ ...filters, initiated_from: event.target.value })} /></label>
            <label>Initiated to<input type="date" value={filters.initiated_to} onChange={(event) => setFilters({ ...filters, initiated_to: event.target.value })} /></label>
            <label>Submitted from<input type="date" value={filters.submitted_from} onChange={(event) => setFilters({ ...filters, submitted_from: event.target.value })} /></label>
            <label>Submitted to<input type="date" value={filters.submitted_to} onChange={(event) => setFilters({ ...filters, submitted_to: event.target.value })} /></label>
            <label>Closed from<input type="date" value={filters.closed_from} onChange={(event) => setFilters({ ...filters, closed_from: event.target.value })} /></label>
            <label>Closed to<input type="date" value={filters.closed_to} onChange={(event) => setFilters({ ...filters, closed_to: event.target.value })} /></label>
            <label>Initiator employee ID<input value={filters.initiator_employee_id} onChange={(event) => setFilters({ ...filters, initiator_employee_id: event.target.value })} /></label>
            <label>Reviewer employee ID<input value={filters.reviewer_employee_id} onChange={(event) => setFilters({ ...filters, reviewer_employee_id: event.target.value })} /></label>
            <button className="text" type="button" onClick={() => { setFilters(EMPTY_FILTERS); applyFilters(EMPTY_FILTERS) }}>Clear filters</button>
          </div>
        ) : null}
        <div className="aif-compact-counts">
          <span>{counts?.pending ?? 0} pending</span><span>{counts?.ready_to_review ?? 0} ready</span><span>{counts?.completed ?? 0} completed</span>
        </div>
      </section>
      <section className="aif-table-wrap" aria-live="polite">
        {loading ? <div className="aif-state"><Loader2 className="spin" /> Loading AIFs...</div> : null}
        {!loading && data?.rows.length === 0 ? (
          <div className="aif-state"><ClipboardList size={30} /><strong>No AIFs match the current filters.</strong><button className="secondary" type="button" onClick={() => { setFilters(EMPTY_FILTERS); applyFilters(EMPTY_FILTERS) }}>Clear filters</button></div>
        ) : null}
        {!loading && data?.rows.length ? (
          <table className="aif-table">
            <thead><tr>
              {[
                ['inspection_id', 'AIF ID'], ['entity_uid', 'Asset ID'], ['source_inspection_date', 'Source inspection'], ['defect_severity', 'Severity'],
                ['defect_callout', 'Defect callout'], ['status', 'Status'], ['initiated_by', 'Initiated by'], ['date_initiated', 'Initiated'],
                ['submitted_to', 'Submitted to'], ['date_submitted', 'Submitted'], ['date_closed', 'Closed'],
              ].map(([key, label]) => <th key={key}><button type="button" onClick={() => updateSort(key)}>{label}{sort === key ? direction === 'asc' ? ' ↑' : ' ↓' : ''}</button></th>)}
              <th>Operations</th>
            </tr></thead>
            <tbody>{data.rows.map((row) => (
              <tr key={row.global_id} className={row.global_id === selectedGlobalId ? 'selected' : undefined}>
                <td><button className="aif-link" type="button" onClick={() => onOpen({ mode: 'view', record: row })}>{row.inspection_id}</button></td>
                <td>{row.entity_uid}</td><td>{recordDate(row.source_inspection_date, true)}</td><td>{row.defect_severity || '-'}</td>
                <td className="truncate" title={row.defect_callout || ''}>{row.defect_callout || '-'}</td>
                <td><span className={`aif-status aif-status-${row.status}`}>{statusLabel(row.status)}</span></td>
                <td>{row.initiated_by || '-'}</td><td>{recordDate(row.date_initiated)}</td><td>{row.submitted_to || '-'}</td><td>{recordDate(row.date_submitted)}</td><td>{recordDate(row.date_closed)}</td>
                <td><div className="aif-row-actions">
                  <button type="button" onClick={() => onOpen({ mode: 'view', record: row })}><Eye size={15} /> View</button>
                  {row.actions.can_edit ? <button type="button" onClick={() => onOpen({ mode: 'edit', record: row })}><Pencil size={15} /> Edit</button> : null}
                  {row.actions.can_submit ? <button type="button" onClick={() => onOpen({ mode: 'edit', record: row, initialDialog: 'submit' })}><Send size={15} /> Submit</button> : null}
                  {row.actions.can_review ? <button type="button" onClick={() => onOpen({ mode: 'review', record: row })}><CheckCircle2 size={15} /> Review</button> : null}
                  {row.actions.can_reopen ? <button type="button" onClick={() => onOpen({ mode: 'review', record: row, initialDialog: 'reopen' })}><RotateCcw size={15} /> Reopen</button> : null}
                  <button type="button" onClick={() => onOpen({ mode: 'view', record: row, initialDialog: 'events' })}><History size={15} /> Events</button>
                  {row.actions.can_delete ? <button className="danger" type="button" disabled={deletingGlobalId === row.global_id} onClick={() => void deleteDraft(row)}>{deletingGlobalId === row.global_id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} Delete</button> : null}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
      </section>
      <footer className="aif-pagination">
        <label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCursor(null); setCursorStack([]) }}><option>25</option><option>50</option><option>100</option></select></label>
        <button type="button" disabled={!cursorStack.length} onClick={() => { const next = [...cursorStack]; setCursor(next.pop() ?? null); setCursorStack(next) }}><ChevronLeft size={17} /> Previous</button>
        <button type="button" disabled={!data?.next_cursor} onClick={() => { setCursorStack([...cursorStack, cursor]); setCursor(data?.next_cursor ?? null) }}>Next <ChevronRight size={17} /></button>
      </footer>
    </main>
  )
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return <label className="aif-field"><span>{label}{required ? ' *' : ''}</span>{children}</label>
}

function AifWorkspace({ workspace, onBack }: { workspace: Workspace; onBack: (record: AifRecord | null) => void }) {
  const [record, setRecord] = useState<AifRecord | null>(workspace.record)
  const [fields, setFields] = useState<AifEditableFields>(workspace.record ? editableFromRecord(workspace.record) : EMPTY_FIELDS)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [assetInput, setAssetInput] = useState(workspace.record?.entity_uid ?? '')
  const [assetCandidates, setAssetCandidates] = useState<string[]>([])
  const [candidateBusy, setCandidateBusy] = useState(false)
  const [candidateOpen, setCandidateOpen] = useState(false)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [assetResult, setAssetResult] = useState<AssetSearchResponse | null>(null)
  const [dateOption, setDateOption] = useState('')
  const [selectedMli, setSelectedMli] = useState(workspace.record?.source_mli_id ?? '')
  const [observations, setObservations] = useState<SourceObservation[]>([])
  const [selectedMlo, setSelectedMlo] = useState(workspace.record?.source_mlo_id ?? '')
  const [sourceValues, setSourceValues] = useState<Partial<AifEditableFields>>({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [pane, setPane] = useState<'source' | 'form'>('source')
  const [severityOptions, setSeverityOptions] = useState<string[]>([])
  const [calloutOptions, setCalloutOptions] = useState<string[]>([])
  const [directionOptions, setDirectionOptions] = useState<InspectionDirectionOption[]>([])
  const [floodingImpactOptions, setFloodingImpactOptions] = useState<string[]>([])
  const [floodingServiceOptions, setFloodingServiceOptions] = useState<string[]>([])
  const [floodingDesignOptions, setFloodingDesignOptions] = useState<string[]>([])
  const [consequenceLocationOptions, setConsequenceLocationOptions] = useState<string[]>([])
  const [consequenceLocationZoiOptions, setConsequenceLocationZoiOptions] = useState<string[]>([])
  const [serviceEligibilityOptions, setServiceEligibilityOptions] = useState<string[]>([])
  const [reviewers, setReviewers] = useState<Reviewer[]>([])
  const [submitOpen, setSubmitOpen] = useState(false)
  const [reviewerId, setReviewerId] = useState('')
  const [reviewerSearch, setReviewerSearch] = useState('')
  const [memo, setMemo] = useState('')
  const [severityUnavailable, setSeverityUnavailable] = useState(false)
  const [calloutUnavailable, setCalloutUnavailable] = useState(false)
  const [workflow, setWorkflow] = useState<'return_to_edit' | 'complete' | 'reopen' | null>(null)
  const [events, setEvents] = useState<AifEvent[] | null>(null)

  const editable = workspace.mode === 'new'
    ? !record || record.actions.can_edit
    : workspace.mode === 'edit' && Boolean(record?.actions.can_edit)
  const dates = useMemo(() => inspectionDateOptions(assetResult?.inspections.map((inspection) => inspection.inspection_date) ?? []), [assetResult])
  const filteredInspections = useMemo(() => {
    if (!assetResult) return []
    if (!dateOption) return assetResult.inspections
    const keys = new Set(inspectionDateKeysFromOption(dateOption))
    return assetResult.inspections.filter((inspection) => keys.has(inspectionDateKey(inspection.inspection_date)))
  }, [assetResult, dateOption])

  useEffect(() => {
    Promise.all([
      fetchPortalDictionaryItems('defect_severity'),
      fetchPortalDictionaryItems('pipe_defect_callout'),
      fetchPortalDictionaryItems('inspection_direction'),
      fetchPortalDictionaryItems('flooding_impact'),
      fetchPortalDictionaryItems('flooding_service_eligibility'),
      fetchPortalDictionaryItems('flooding_design_standards'),
      fetchPortalDictionaryItems('consequence_location'),
      fetchPortalDictionaryItems('consequence_location_zoi'),
      fetchPortalDictionaryItems('service_eligibility'),
    ]).then(([
      severity,
      callout,
      direction,
      floodingImpact,
      floodingService,
      floodingDesign,
      consequenceLocation,
      consequenceLocationZoi,
      serviceEligibility,
    ]) => {
      setSeverityOptions(severity.items.filter((item) => item.is_active).map((item) => item.label))
      setCalloutOptions(callout.items.filter((item) => item.is_active).map((item) => item.label))
      setDirectionOptions(direction.items
        .filter((item) => item.is_active && (item.item_code === '0' || item.item_code === '1'))
        .map((item) => ({ value: Number(item.item_code) as 0 | 1, label: item.label })))
      setFloodingImpactOptions(floodingImpact.items.filter((item) => item.is_active).map((item) => item.label))
      setFloodingServiceOptions(floodingService.items.filter((item) => item.is_active).map((item) => item.label))
      setFloodingDesignOptions(floodingDesign.items.filter((item) => item.is_active).map((item) => item.label))
      const consequenceLocationValues = consequenceLocation.items.filter((item) => item.is_active).map((item) => item.label)
      const consequenceLocationZoiValues = consequenceLocationZoi.items.filter((item) => item.is_active).map((item) => item.label)
      const serviceEligibilityValues = serviceEligibility.items.filter((item) => item.is_active).map((item) => item.label)
      setConsequenceLocationOptions(consequenceLocationValues)
      setConsequenceLocationZoiOptions(consequenceLocationZoiValues)
      setServiceEligibilityOptions(serviceEligibilityValues)
      setFields((current) => ({
        ...current,
        consequence_location: configuredDictionaryLabel(current.consequence_location, consequenceLocationValues),
        consequence_location_zol: configuredDictionaryLabel(current.consequence_location_zol, consequenceLocationZoiValues),
        service_eligibility: configuredDictionaryLabel(current.service_eligibility, serviceEligibilityValues),
      }))
    }).catch((error) => setMessage({ kind: 'warning', text: `System dictionaries could not be loaded: ${errorText(error)}` }))
    if (workspace.record) void loadAsset(workspace.record.entity_uid, false)
  }, [])

  useEffect(() => {
    if (!workspace.record || !workspace.initialDialog) return
    if (workspace.initialDialog === 'events') {
      fetchAifEvents(workspace.record.global_id)
        .then((response) => setEvents(response.events))
        .catch((error) => setMessage({ kind: 'error', text: errorText(error) }))
      return
    }
    if (workspace.initialDialog === 'reopen') {
      setWorkflow('reopen')
      return
    }
    fetchAifReviewers()
      .then((response) => {
        setReviewers(response.reviewers)
        setReviewerId('')
        setReviewerSearch('')
        setSubmitOpen(true)
      })
      .catch((error) => setMessage({ kind: 'error', text: errorText(error) }))
  }, [])

  useEffect(() => {
    const query = assetInput.trim()
    if (record || query.length < 2 || assetResult?.asset_id === query.toUpperCase()) {
      setAssetCandidates([])
      setCandidateBusy(false)
      return
    }
    let cancelled = false
    setCandidateBusy(true)
    const timer = window.setTimeout(() => {
      fetchAifAssetCandidates(query)
        .then((response) => {
          if (cancelled) return
          setAssetCandidates(response.candidates.slice(0, 10))
          setCandidateIndex(0)
          setCandidateOpen(Boolean(response.candidates.length))
        })
        .catch(() => {
          if (!cancelled) setAssetCandidates([])
        })
        .finally(() => {
          if (!cancelled) setCandidateBusy(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [assetInput, assetResult?.asset_id, record])

  function updateField<K extends keyof AifEditableFields>(key: K, value: AifEditableFields[K]) {
    setFields((current) => ({ ...current, [key]: value })); setDirty(true)
  }

  async function loadAsset(asset = assetInput, resetSelection = true) {
    if (!asset.trim()) { setMessage({ kind: 'error', text: 'Enter an Asset ID.' }); return }
    if (resetSelection && dirty && !(await appConfirm(
      'Searching another asset will replace the current unsaved source values. Continue?',
      { title: 'Replace unsaved source values', kind: 'warning', confirmLabel: 'Continue search' },
    ))) return
    setCandidateOpen(false)
    setAssetCandidates([])
    setBusy(true)
    try {
      const result = await searchAifAsset(asset)
      setAssetResult(result); setAssetInput(result.asset_id); setHistoryOpen(false)
      if (!result.inspections.length) {
        setMessage({ kind: 'warning', text: 'No ITPipes inspections are available for this asset. An AIF cannot be created.' }); return
      }
      const options = inspectionDateOptions(result.inspections.map((item) => item.inspection_date))
      const initialOption = workspace.record
        ? options.find((option) => option.dateKeys.includes(inspectionDateKey(workspace.record?.source_inspection_date)))?.key
        : options[0]?.key
      setDateOption(initialOption ?? '')
      const keys = new Set(inspectionDateKeysFromOption(initialOption ?? ''))
      const initialInspection = result.inspections.find((item) => item.mli_id === (workspace.record?.source_mli_id ?? ''))
        ?? result.inspections.find((item) => keys.has(inspectionDateKey(item.inspection_date)))
        ?? result.inspections[0]
      setSelectedMli(initialInspection.mli_id)
      await loadObservations(result.asset_id, initialInspection.mli_id, resetSelection)
      if (result.history_warning) setMessage({ kind: 'warning', text: result.history_warning })
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) })
    } finally { setBusy(false) }
  }

  function chooseAssetCandidate(assetId: string) {
    setAssetInput(assetId)
    setCandidateOpen(false)
    setAssetCandidates([])
    void loadAsset(assetId)
  }

  async function loadObservations(assetId: string, mliId: string, resetSelection = true) {
    try {
      const response = await fetchAifObservations(assetId, mliId)
      setObservations(response.observations)
      const mlo = resetSelection ? '' : (record?.source_mlo_id ?? selectedMlo)
      setSelectedMlo(mlo)
    } catch (error) {
      setObservations([]); setMessage({ kind: 'error', text: errorText(error) })
    }
  }

  function clearObservationSelection() {
    setSelectedMlo('')
    setFields(EMPTY_FIELDS)
    setSourceValues({})
    setDirty(false)
  }

  async function confirmInspectionChange() {
    if (!selectedMlo && !dirty) return true
    const selection = selectedMlo ? `selected MLO ${selectedMlo}` : 'current edited values'
    return appConfirm(
      `Changing the inspection will clear ${selection} and its source-populated form values. Continue?`,
      { title: 'Change inspection', kind: 'warning', confirmLabel: 'Change inspection' },
    )
  }

  async function confirmObservationSelection(observation: SourceObservation) {
    const warnings: string[] = []
    const conditionRisk = observation.condition_risk
    if (conditionRisk !== null && Number.isFinite(Number(conditionRisk)) && Number(conditionRisk) < LOW_CONDITION_RISK_THRESHOLD) {
      warnings.push(
        `Risk warning: MLO ${observation.mlo_id} has a condition risk score of ${formatConditionRisk(conditionRisk)}, which is below ${LOW_CONDITION_RISK_THRESHOLD}. Usually only observations with a condition risk score greater than ${LOW_CONDITION_RISK_THRESHOLD} are considered real risk.`,
      )
    }
    if (dirty) {
      const current = selectedMlo ? `MLO ${selectedMlo}` : 'the current edited values'
      warnings.push(`Selecting MLO ${observation.mlo_id} will replace source-populated fields from ${current}.`)
    }
    return warnings.length === 0 || appConfirm(
      `${warnings.join('\n\n')}\n\nContinue with this observation?`,
      { title: 'Confirm observation selection', kind: 'warning', confirmLabel: 'Select observation' },
    )
  }

  async function changeDateOption(option: string) {
    if (!assetResult || option === dateOption || !(await confirmInspectionChange())) return
    const keys = new Set(inspectionDateKeysFromOption(option))
    const next = assetResult.inspections.find((item) => keys.has(inspectionDateKey(item.inspection_date)))
    if (!next) return
    clearObservationSelection()
    setDateOption(option)
    setSelectedMli(next.mli_id)
    void loadObservations(assetResult.asset_id, next.mli_id)
  }

  async function changeInspection(mliId: string) {
    if (!assetResult || mliId === selectedMli || !(await confirmInspectionChange())) return
    clearObservationSelection()
    setSelectedMli(mliId)
    void loadObservations(assetResult.asset_id, mliId)
  }

  async function selectObservation(observation: SourceObservation) {
    if (selectedMlo === observation.mlo_id) return
    if (!(await confirmObservationSelection(observation))) return
    const observationMliId = String(observation.mli_id ?? '').trim()
    const observationMloId = String(observation.mlo_id ?? '').trim()
    if (!observationMliId || !observationMloId) {
      setMessage({ kind: 'error', text: 'The selected source observation is missing its MLI_ID or MLO_ID.' })
      return
    }
    const sourcePopulated: AifEditableFields = {
      inspection_direction: observation.inspection_direction,
      flooding_impact: canonicalDictionaryLabel(observation.flooding_impact, floodingImpactOptions),
      flooding_service_eligibility: canonicalDictionaryLabel(observation.flooding_service_eligibility, floodingServiceOptions),
      flooding_design_standards: canonicalDictionaryLabel(observation.flooding_design_standards, floodingDesignOptions),
      defect_severity: null,
      defect_callout: null,
      consequence_location: configuredDictionaryLabel(observation.consequence_location, consequenceLocationOptions),
      consequence_location_zol: configuredDictionaryLabel(observation.consequence_location_zol, consequenceLocationZoiOptions),
      service_eligibility: configuredDictionaryLabel(observation.service_eligibility, serviceEligibilityOptions),
      defect_stationing: observation.stationing,
      limited_extensive: null,
    }
    setSelectedMli(observationMliId)
    setSelectedMlo(observationMloId)
    setFields(sourcePopulated)
    setSourceValues(sourcePopulated)
    setDirty(true)
    setPane('form')
    setBusy(true)
    try {
      const response = await fetchAifEnrichment(assetInput, observationMliId, observationMloId)
      if (response.enrichment.ambiguous) {
        setMessage({ kind: 'warning', text: `${response.enrichment.message ?? 'CCTV Review enrichment is ambiguous.'} The ITPipes observation remains selected, but the ambiguity must be resolved before submission.` })
        return
      }
      const populated: AifEditableFields = {
        ...sourcePopulated,
        defect_severity: response.enrichment.defect_severity ?? null,
        defect_callout: response.enrichment.defect_callout ?? null,
        limited_extensive: response.enrichment.limited_extensive ?? null,
      }
      setFields(populated); setSourceValues(populated)
      if (!response.enrichment.available) setMessage({ kind: 'info', text: response.enrichment.message ?? 'No CCTV Review value available.' })
    } catch (error) {
      setMessage({ kind: 'warning', text: `MLO ${observationMloId} is selected, but CCTV Review enrichment could not be loaded: ${errorText(error)}` })
    } finally { setBusy(false) }
  }

  async function save() {
    const selectedObservation = observations.find((item) => String(item.mlo_id) === String(selectedMlo))
    const sourceMliId = String(selectedObservation?.mli_id ?? selectedMli).trim()
    if (!record && (!assetInput || !sourceMliId || !selectedMlo)) { setMessage({ kind: 'error', text: 'Select an Asset ID, inspection, and observation before saving.' }); return }
    setBusy(true)
    try {
      const response = record
        ? await saveAif(record, normalizeFields(fields))
        : await createAif({ asset_id: assetInput, source_mli_id: sourceMliId, source_mlo_id: selectedMlo, ...normalizeFields(fields) })
      setRecord(response.aif); setFields(editableFromRecord(response.aif)); setDirty(false)
      setMessage({ kind: 'success', text: record ? 'AIF draft saved.' : `${response.aif.inspection_id} created.` })
    } catch (error) { setMessage({ kind: 'error', text: errorText(error) }) } finally { setBusy(false) }
  }

  async function openSubmit() {
    if (dirty) { setMessage({ kind: 'warning', text: 'Save the current changes before submitting.' }); return }
    setBusy(true)
    try {
      const response = await fetchAifReviewers()
      setReviewers(response.reviewers)
      setReviewerId('')
      setReviewerSearch('')
      setSubmitOpen(true)
    }
    catch (error) { setMessage({ kind: 'error', text: errorText(error) }) }
    finally { setBusy(false) }
  }

  async function submit() {
    if (!record || !reviewerId) return
    setBusy(true)
    try {
      const response = await submitAif(record, reviewerId, memo, severityUnavailable, calloutUnavailable)
      setRecord(response.aif); setSubmitOpen(false); setMemo(''); setMessage({ kind: 'success', text: 'AIF submitted to review.' })
    } catch (error) { setMessage({ kind: 'error', text: errorText(error) }) } finally { setBusy(false) }
  }

  async function applyWorkflow() {
    if (!record || !workflow) return
    setBusy(true)
    try {
      const response = await transitionAif(record, workflow, memo)
      setRecord(response.aif); setFields(editableFromRecord(response.aif)); setWorkflow(null); setMemo('')
      setMessage({ kind: 'success', text: workflow === 'complete' ? 'AIF review completed.' : workflow === 'reopen' ? 'AIF reopened.' : 'AIF returned to edit.' })
    } catch (error) { setMessage({ kind: 'error', text: errorText(error) }) } finally { setBusy(false) }
  }

  async function openEvents() {
    if (!record) return
    setBusy(true)
    try { setEvents((await fetchAifEvents(record.global_id)).events) }
    catch (error) { setMessage({ kind: 'error', text: errorText(error) }) }
    finally { setBusy(false) }
  }

  async function copyPrevious(globalId: string) {
    if (dirty && !(await appConfirm(
      'Copying a previous AIF will replace the current editable values. Continue?',
      { title: 'Copy previous AIF', kind: 'warning', confirmLabel: 'Copy values' },
    ))) return
    try {
      const previous = (await fetchAif(globalId)).aif
      setFields(editableFromRecord(previous)); setDirty(true); setMessage({ kind: 'info', text: `Values copied from ${previous.inspection_id}. Source IDs and workflow identities were not copied.` })
    } catch (error) { setMessage({ kind: 'error', text: errorText(error) }) }
  }

  async function back() {
    if (!dirty || await appConfirm(
      'Discard unsaved changes and return to the AIF Register?',
      { title: 'Discard unsaved changes', kind: 'warning', confirmLabel: 'Discard changes' },
    )) onBack(record)
  }

  const sourceInspection = assetResult?.inspections.find((inspection) => inspection.mli_id === selectedMli)
  const currentStatus = record?.status ?? 'pending'
  const formReadOnly = !editable
  const canSaveDraft = record ? dirty : Boolean(selectedMlo && dirty)
  const reviewSummaryItems = [
    { label: 'Initiated by', value: record ? `${record.initiated_by} (${record.initiated_by_user_id})` : 'Current user when saved' },
    { label: 'Date initiated', value: recordDate(record?.date_initiated) },
    { label: 'Submitted to', value: record?.submitted_to ? `${record.submitted_to} (${record.submitted_to_user_id})` : '-' },
    { label: 'Date submitted', value: recordDate(record?.date_submitted) },
    { label: 'Closed by', value: record?.closed_by ? `${record.closed_by} (${record.closed_by_user_id})` : '-' },
    { label: 'Date closed', value: recordDate(record?.date_closed) },
  ]
  return (
    <main className="aif-resource aif-workspace">
      <header className="aif-command-bar">
        <div className="aif-command-left"><button type="button" onClick={() => void back()}><ArrowLeft size={18} /> Back</button><strong>Create AIF from ITPipes</strong>{record ? <span>{record.inspection_id}</span> : <span>New AIF</span>}<span className={`aif-status aif-status-${currentStatus}`}>{statusLabel(currentStatus)}</span></div>
        <div className="aif-command-actions">
          {editable ? <button className={canSaveDraft ? 'primary' : 'secondary'} type="button" disabled={busy || !canSaveDraft} title={!record && !selectedMlo ? 'Select one observation before saving the draft.' : undefined} onClick={() => void save()}><Save size={17} /> Save draft</button> : null}
          {editable && record?.actions.can_submit ? <button className={!dirty ? 'primary' : 'secondary'} type="button" disabled={busy || dirty} onClick={() => void openSubmit()}><Send size={17} /> Submit to review</button> : null}
          {workspace.mode === 'review' && record?.actions.can_review ? <><button className="primary" type="button" onClick={() => setWorkflow('complete')}><CheckCircle2 size={17} /> Complete review</button><button className="secondary" type="button" onClick={() => setWorkflow('return_to_edit')}><Undo2 size={17} /> Return to edit</button></> : null}
          {record?.actions.can_reopen ? <button className="secondary" type="button" onClick={() => setWorkflow('reopen')}><RotateCcw size={17} /> Reopen</button> : null}
          {record ? <button className="secondary" type="button" onClick={() => void openEvents()}><History size={17} /> Events</button> : null}
        </div>
      </header>
      {message ? <MessageBar message={message} onClose={() => setMessage(null)} /> : null}
      <nav className="aif-mobile-pane-tabs"><button className={pane === 'source' ? 'active' : ''} onClick={() => setPane('source')}>Source selection</button><button className={pane === 'form' ? 'active' : ''} onClick={() => setPane('form')}>AIF form</button></nav>
      <div className="aif-workspace-grid">
        <aside className={`aif-source-pane ${pane === 'source' ? 'mobile-active' : ''}`}>
          <section>
            <h2>Source and selection</h2>
            <div className="aif-asset-search">
              <label htmlFor="aif-asset-id">Asset ID</label>
              <div className="aif-asset-controls">
                <div className="aif-asset-combobox">
                  <input
                    id="aif-asset-id"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls="aif-asset-candidates"
                    aria-expanded={candidateOpen && Boolean(assetCandidates.length)}
                    aria-activedescendant={candidateOpen && assetCandidates.length ? `aif-asset-candidate-${candidateIndex}` : undefined}
                    autoComplete="off"
                    value={assetInput}
                    onChange={(event) => { setAssetInput(event.target.value); setCandidateOpen(true) }}
                    onFocus={() => assetCandidates.length && setCandidateOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' && assetCandidates.length) {
                        event.preventDefault(); setCandidateOpen(true); setCandidateIndex((index) => Math.min(index + 1, assetCandidates.length - 1))
                      } else if (event.key === 'ArrowUp' && assetCandidates.length) {
                        event.preventDefault(); setCandidateOpen(true); setCandidateIndex((index) => Math.max(index - 1, 0))
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        if (candidateOpen && assetCandidates[candidateIndex]) chooseAssetCandidate(assetCandidates[candidateIndex])
                        else void loadAsset()
                      } else if (event.key === 'Escape') {
                        setCandidateOpen(false)
                      }
                    }}
                    disabled={Boolean(record)}
                  />
                  {candidateOpen && assetCandidates.length ? <div id="aif-asset-candidates" className="aif-asset-candidates" role="listbox" aria-label="Matching Asset IDs">
                    {assetCandidates.map((assetId, index) => <button
                      id={`aif-asset-candidate-${index}`}
                      className={index === candidateIndex ? 'active' : ''}
                      type="button"
                      role="option"
                      aria-selected={index === candidateIndex}
                      key={assetId}
                      onMouseEnter={() => setCandidateIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseAssetCandidate(assetId)}
                    >{assetId}</button>)}
                  </div> : null}
                  {candidateBusy ? <Loader2 className="aif-candidate-spinner spin" size={16} aria-label="Finding matching Asset IDs" /> : null}
                </div>
                <button className="primary" type="button" disabled={busy || Boolean(record)} onClick={() => void loadAsset()}><Search size={17} /> Search</button>
              </div>
            </div>
          </section>
          {assetResult ? <>
            <section className="aif-history"><button className="aif-section-toggle" type="button" onClick={() => setHistoryOpen(!historyOpen)}><span><History size={17} /> Previous inspections ({assetResult.history.length}){assetResult.history[0]?.inspection_date ? ` · Latest ${recordDate(assetResult.history[0].inspection_date, true)}` : ''}</span><ChevronDown size={17} /></button>{historyOpen ? <div className="aif-history-list">{assetResult.history.length ? assetResult.history.map((item, index) => <article key={`${item.source}-${item.inspection_id}-${index}`}><div><strong>{item.inspection_id}</strong><span>{item.source} · {recordDate(item.inspection_date, true)}</span><span>{item.status || '-'} · {item.actor || '-'}</span></div>{item.source === 'Portal AIF' && item.global_id && editable ? <button type="button" onClick={() => void copyPrevious(item.global_id!)}>Copy values</button> : null}</article>) : <p>No previous inspections found.</p>}</div> : null}</section>
            <section><Field label="Inspection date period"><select value={dateOption} onChange={(event) => void changeDateOption(event.target.value)} disabled={Boolean(record)}>{dates.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></Field>
              <Field label="ITPipes inspection"><select value={selectedMli} onChange={(event) => void changeInspection(event.target.value)} disabled={Boolean(record)}>{filteredInspections.map((item) => <option key={item.mli_id} value={item.mli_id}>{recordDate(item.inspection_date, true)} · MLI {item.mli_id} · {inspectionDirectionLabel(item.inspection_direction, directionOptions)} · {item.observation_count} observations</option>)}</select></Field>
            </section>
            <section className="aif-observations">
              <div className="aif-observation-heading">
                <h3>Observations</h3>
                <span>{selectedMlo ? `MLO ${selectedMlo} selected` : 'Select one observation'}</span>
              </div>
              {busy ? <div className="aif-state compact"><Loader2 className="spin" /> Loading...</div> : observations.length ? <div className="aif-observation-table">
                <table aria-label="ITPipes observations">
                  <thead><tr><th scope="col"><span className="sr-only">Select</span></th><th scope="col">Inspection ID</th><th scope="col">MLO</th><th className="numeric" scope="col">Risk</th><th className="numeric" scope="col">Station</th><th scope="col">Pipe</th></tr></thead>
                  <tbody>{observations.map((item) => {
                    const selected = selectedMlo === item.mlo_id
                    const inspectionUrl = itpipesInspectionUrl(item.mli_id)
                    return <tr className={`${selected ? 'selected' : ''}${record ? ' read-only' : ''}`.trim()} key={item.mlo_id} onClick={() => !record && void selectObservation(item)}>
                      <td><input type="radio" name="aif-source-observation" value={item.mlo_id} checked={selected} disabled={Boolean(record)} aria-label={`Select MLO ${item.mlo_id}`} onClick={(event) => event.stopPropagation()} onChange={() => !record && void selectObservation(item)} /></td>
                      <td><a className="aif-observation-link" href={inspectionUrl} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openExternalUrl(inspectionUrl).catch((error) => setMessage({ kind: 'error', text: `Could not open ITPipes inspection ${item.mli_id}: ${errorText(error)}` })) }}>{item.mli_id}</a></td>
                      <td><strong>{item.mlo_id}</strong></td>
                      <td className="numeric">{formatConditionRisk(item.condition_risk)}</td>
                      <td className="numeric">{formatStationDistance(item.stationing)}</td>
                      <td title={`${item.us_asset_id || '-'} → ${item.ds_asset_id || '-'}`}>{item.us_asset_id || '-'} → {item.ds_asset_id || '-'}</td>
                    </tr>
                  })}</tbody>
                </table>
              </div> : <div className="aif-state compact">No observations are available for this inspection.</div>}
            </section>
          </> : <div className="aif-state compact"><Search size={25} /><span>Search an exact Asset ID to begin.</span></div>}
        </aside>
        <section className={`aif-form-pane ${pane === 'form' ? 'mobile-active' : ''}`}>
          <fieldset className="aif-record-summary"><legend>Record and source summary</legend><div className="aif-summary-grid"><div><span>AIF ID</span><strong>{record?.inspection_id ?? 'Generated when saved'}</strong></div><div><span>Asset ID</span><strong>{record?.entity_uid || assetResult?.asset_id || '-'}</strong></div><div><span>MLI ID</span><strong>{record?.source_mli_id || selectedMli || '-'}</strong></div><div><span>MLO ID</span><strong>{record?.source_mlo_id || selectedMlo || '-'}</strong></div><div><span>Source inspection date</span><strong>{recordDate(record?.source_inspection_date || sourceInspection?.inspection_date, true)}</strong></div><div><span>Status</span><strong>{statusLabel(currentStatus)}</strong></div></div></fieldset>
          <fieldset className="aif-compact-section" disabled={formReadOnly}>
            <legend>Inspection information</legend>
            <div className="aif-compact-fields aif-compact-fields-single">
              <Field label="Inspection direction">
                <select
                  value={fields.inspection_direction === null ? '' : String(fields.inspection_direction)}
                  onChange={(event) => updateField('inspection_direction', event.target.value === '' ? null : Number(event.target.value))}
                >
                  <option value="">Not available</option>
                  {directionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
            </div>
          </fieldset>
          <fieldset className="aif-compact-section" disabled={formReadOnly}>
            <legend>Flooding assessment</legend>
            <div className="aif-compact-fields">
              <Field label="Flooding impact">
                <select value={canonicalDictionaryLabel(fields.flooding_impact, floodingImpactOptions) ?? ''} onChange={(event) => updateField('flooding_impact', event.target.value || null)}>
                  <option value="">Not available</option>
                  {floodingImpactOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Flooding service eligibility">
                <select value={canonicalDictionaryLabel(fields.flooding_service_eligibility, floodingServiceOptions) ?? ''} onChange={(event) => updateField('flooding_service_eligibility', event.target.value || null)}>
                  <option value="">Not available</option>
                  {floodingServiceOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Flooding design standards">
                <select value={canonicalDictionaryLabel(fields.flooding_design_standards, floodingDesignOptions) ?? ''} onChange={(event) => updateField('flooding_design_standards', event.target.value || null)}>
                  <option value="">Not available</option>
                  {floodingDesignOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
            </div>
          </fieldset>
          <fieldset className="aif-compact-section aif-defect-section" disabled={formReadOnly}>
            <legend className="aif-defect-legend">
              <span>Defect assessment</span>
              {dirty && Object.keys(sourceValues).length ? <button className="text restore" type="button" disabled={formReadOnly} onClick={() => { setFields((current) => ({ ...current, ...sourceValues })); setDirty(true) }}>Restore source values</button> : null}
            </legend>
            <div className="aif-two-fields">
              <Field label="Defect severity">
                <select value={fields.defect_severity ?? ''} onChange={(event) => updateField('defect_severity', event.target.value || null)}>
                  <option value="">Not available</option>
                  {severityOptions.map((value) => <option key={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Defect callout">
                <input maxLength={100} list="aif-callouts" value={fields.defect_callout ?? ''} onChange={(event) => updateField('defect_callout', event.target.value)} />
                <datalist id="aif-callouts">{calloutOptions.map((value) => <option key={value}>{value}</option>)}</datalist>
              </Field>
              <Field label="Stationing">
                <input type="number" step="0.01" value={fields.defect_stationing ?? ''} onChange={(event) => updateField('defect_stationing', event.target.value ? Number(event.target.value) : null)} />
              </Field>
              <Field label="Classification">
                <select value={fields.limited_extensive ?? ''} onChange={(event) => updateField('limited_extensive', event.target.value as AifEditableFields['limited_extensive'])}>
                  <option value="">Not available</option>
                  <option>Limited</option>
                  <option>Extensive</option>
                </select>
              </Field>
            </div>
          </fieldset>
          <fieldset className="aif-compact-section" disabled={formReadOnly}>
            <legend>Consequence and eligibility</legend>
            <div className="aif-compact-fields">
              <Field label="Consequence location">
                <select
                  value={configuredDictionaryLabel(fields.consequence_location, consequenceLocationOptions) ?? ''}
                  onChange={(event) => updateField('consequence_location', event.target.value || null)}
                >
                  <option value="">Not available</option>
                  {consequenceLocationOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Consequence location zone of influence">
                <select
                  value={configuredDictionaryLabel(fields.consequence_location_zol, consequenceLocationZoiOptions) ?? ''}
                  onChange={(event) => updateField('consequence_location_zol', event.target.value || null)}
                >
                  <option value="">Not available</option>
                  {consequenceLocationZoiOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
              <Field label="Service eligibility">
                <select
                  value={configuredDictionaryLabel(fields.service_eligibility, serviceEligibilityOptions) ?? ''}
                  onChange={(event) => updateField('service_eligibility', event.target.value || null)}
                >
                  <option value="">Not available</option>
                  {serviceEligibilityOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </Field>
            </div>
          </fieldset>
          <fieldset className="aif-review-summary">
            <legend>Review and submission summary</legend>
            <div className="aif-summary-grid">
              {reviewSummaryItems.map((item) => <div key={item.label}><span>{item.label}</span><strong title={item.value}>{item.value}</strong></div>)}
            </div>
          </fieldset>
        </section>
      </div>
      {submitOpen ? <Modal title="Submit AIF to review" onClose={() => setSubmitOpen(false)}><div className="aif-modal-body"><Field label="Reviewer" required><input role="combobox" aria-autocomplete="list" list="aif-reviewer-options" value={reviewerSearch} placeholder="Search name, employee ID, or email" onChange={(event) => { const value = event.target.value; setReviewerSearch(value); const normalized = value.trim().toLocaleLowerCase(); const match = reviewers.find((reviewer) => reviewer.employee_id.toLocaleLowerCase() === normalized || reviewer.email.toLocaleLowerCase() === normalized || `${reviewer.display_name} - ${reviewer.employee_id}${reviewer.is_direct_manager ? ' (Direct manager)' : ''}`.toLocaleLowerCase() === normalized); setReviewerId(match?.employee_id ?? '') }} /><datalist id="aif-reviewer-options">{reviewers.map((reviewer) => <option key={reviewer.employee_id} value={`${reviewer.display_name} - ${reviewer.employee_id}${reviewer.is_direct_manager ? ' (Direct manager)' : ''}`}>{reviewer.email}</option>)}</datalist></Field><Field label="Submission memo"><textarea value={memo} onChange={(event) => setMemo(event.target.value)} /></Field>{!fields.defect_severity ? <label className="aif-check"><input type="checkbox" checked={severityUnavailable} onChange={(event) => setSeverityUnavailable(event.target.checked)} /> Confirm defect severity is unavailable</label> : null}{!fields.defect_callout ? <label className="aif-check"><input type="checkbox" checked={calloutUnavailable} onChange={(event) => setCalloutUnavailable(event.target.checked)} /> Confirm defect callout is unavailable</label> : null}</div><footer><button className="secondary" type="button" onClick={() => setSubmitOpen(false)}>Cancel</button><button className="primary" disabled={!reviewerId || busy} type="button" onClick={() => void submit()}><Send size={17} /> Submit to review</button></footer></Modal> : null}
      {workflow ? <Modal title={workflow === 'complete' ? 'Complete AIF review' : workflow === 'reopen' ? 'Reopen AIF' : 'Return AIF to edit'} onClose={() => setWorkflow(null)}><div className="aif-modal-body"><p>{workflow === 'complete' ? 'Completing the review makes this AIF read-only.' : workflow === 'reopen' ? 'A memo is required. Reopening restores the active MLO reservation.' : 'The submitter can edit and resubmit this AIF.'}</p><Field label="Memo" required={workflow === 'reopen'}><textarea value={memo} onChange={(event) => setMemo(event.target.value)} /></Field></div><footer><button className="secondary" type="button" onClick={() => setWorkflow(null)}>Cancel</button><button className="primary" disabled={busy || (workflow === 'reopen' && !memo.trim())} type="button" onClick={() => void applyWorkflow()}>Confirm</button></footer></Modal> : null}
      {events ? <Modal title="AIF events" onClose={() => setEvents(null)}><div className="aif-event-list">{events.length ? events.map((event) => <article key={event.global_id}><strong>{eventLabel(event.event_type)}</strong><span>{event.actor_name || '-'} · {event.actor_user_id || '-'}</span><time>{recordDate(event.event_at)}</time>{event.from_status || event.to_status ? <span>{event.from_status ? statusLabel(event.from_status as AifStatus) : '-'} → {event.to_status ? statusLabel(event.to_status as AifStatus) : '-'}</span> : null}{event.memo ? <p>{event.memo}</p> : null}</article>) : <p>No events are available.</p>}</div></Modal> : null}
    </main>
  )
}

export default function CreateAifFromItpipes() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [registerRefresh, setRegisterRefresh] = useState(0)
  const [selectedGlobalId, setSelectedGlobalId] = useState<string | null>(null)

  function openWorkspace(next: Workspace) {
    setSelectedGlobalId(next.record?.global_id ?? null)
    setWorkspace(next)
  }

  function closeWorkspace(record: AifRecord | null) {
    setSelectedGlobalId(record?.global_id ?? selectedGlobalId)
    setRegisterRefresh((value) => value + 1)
    setWorkspace(null)
  }

  return <>
    <div hidden={Boolean(workspace)}><AifRegister onOpen={openWorkspace} refreshToken={registerRefresh} selectedGlobalId={selectedGlobalId} /></div>
    {workspace ? <AifWorkspace workspace={workspace} onBack={closeWorkspace} /> : null}
  </>
}
