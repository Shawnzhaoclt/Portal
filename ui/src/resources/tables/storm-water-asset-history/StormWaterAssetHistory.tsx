import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDotDashed,
  Clipboard,
  Download,
  ExternalLink,
  FileSearch,
  LayoutList,
  LoaderCircle,
  LocateFixed,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Split,
  Table2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { openExternalUrl } from '../../../desktop/runtime'
import { activatePortalHome, openPortalResource } from '../../../lib/portalNavigation'
import {
  exportAssetHistory,
  loadExportFields,
  loadAssetRecords,
  loadAssetSummary,
  loadRecordDetail,
  searchAssetCandidates,
  type AssetCandidate,
  type AssetHistoryRecord,
  type AssetSummaryResponse,
  type AssetType,
  type AssignmentState,
  type HistoryKind,
  type HistoryRecord,
  type ITPipesDefectRecord,
  type PipeRiskRecord,
  type RecordDetail,
  type ExportFieldCatalog,
  type ExportFieldSelection,
} from './api'
import './StormWaterAssetHistory.css'

const TABS: Array<{ id: HistoryKind; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'service_requests', label: 'Service requests' },
  { id: 'investigations', label: 'Investigations' },
  { id: 'inspections', label: 'Inspections' },
  { id: 'work_orders', label: 'Work orders' },
  { id: 'itpipes_defects', label: 'ITPipes defects' },
  { id: 'pipe_risk', label: 'Risk information' },
]

const ITPIPES_INSPECTION_URL = 'https://charlottenc.itpipes.com/Asset/SearchByInspId'
const EASTERN_TIME_ZONE = 'America/New_York'
const EXPORT_STORAGE_KEY = 'portal.asset-history.export-fields.v1'
const EXPORT_TABS: Array<{ id: Exclude<HistoryKind, 'timeline'>; label: string; required: string[] }> = [
  { id: 'service_requests', label: 'Service Requests', required: ['Date', 'Type', 'ID', 'Status', 'Title / summary', 'Relationship'] },
  { id: 'investigations', label: 'Investigations', required: ['Date', 'Type', 'ID', 'Status', 'Title / summary', 'Relationship'] },
  { id: 'inspections', label: 'Inspections', required: ['Date', 'Type', 'ID', 'Status', 'Condition risk', 'Flood risk', 'Clogging risk', 'Risk', 'Title / summary', 'Relationship'] },
  { id: 'work_orders', label: 'Work Orders', required: ['Date', 'Type', 'ID', 'Status', 'Title / summary', 'Relationship'] },
  { id: 'itpipes_defects', label: 'ITPipes Defects', required: ['Inspection date', 'MLI ID', 'MLO ID', 'ML ID', 'Direction', 'Continuous', 'Observation text', 'Distance', 'Relative depth', 'Condition risk', 'Flood risk', 'Clogging risk', 'Risk'] },
  { id: 'pipe_risk', label: 'Risk Information', required: ['Basin name', 'Work zone ID', 'CL score', 'LOF score', 'COF score', 'Risk'] },
]

type AssetSummaryField = { label: string; keys: string[]; format?: 'date' | 'number'; compact?: boolean; wide?: boolean }

const ASSET_SUMMARY_FIELDS: Record<AssetType, AssetSummaryField[]> = {
  pipe: [
    { label: 'Active', keys: ['Active', 'STATUS'] },
    { label: 'Diameter', keys: ['DIAMETER'], format: 'number' },
    { label: 'Material', keys: ['MATERIAL'] },
    { label: 'Pipe shape', keys: ['PI_SHAPE', 'PACP_Shape'] },
    { label: 'Construction date', keys: ['CONST_DATE'], format: 'date' },
    { label: 'Construction date source', keys: ['ConstDateSource'], wide: true },
    { label: 'Upstream asset', keys: ['US_ID'] },
    { label: 'Upstream invert', keys: ['US_INVERT'], format: 'number' },
    { label: 'Downstream asset', keys: ['DS_ID'] },
    { label: 'Downstream invert', keys: ['DS_INVERT'], format: 'number' },
  ],
  structure: [
    { label: 'Active', keys: ['Active', 'STATUS'] },
    { label: 'Structure type', keys: ['STRUCT_TYPE', 'TYPE'] },
    { label: 'Structure size', keys: ['STRUCTURE_SIZE'] },
    { label: 'Material', keys: ['MATERIAL'] },
    { label: 'Depth', keys: ['DEPTH'], format: 'number' },
    { label: 'Invert', keys: ['INVERT'], format: 'number', compact: true },
    { label: 'Construction date', keys: ['CONST_DATE'], format: 'date' },
    { label: 'Construction date source', keys: ['ConstDateSource'], wide: true },
  ],
  channel: [
    { label: 'Active', keys: ['Active', 'STATUS'] },
    { label: 'Channel shape', keys: ['CH_SHAPE', 'TYPE'] },
    { label: 'Material', keys: ['MATERIAL'] },
    { label: 'Width', keys: ['WIDTH', 'WIDTH_TOP'], format: 'number', compact: true },
    { label: 'Depth', keys: ['DEPTH'], format: 'number', compact: true },
    { label: 'Construction date', keys: ['CONST_DATE'], format: 'date' },
    { label: 'Construction date source', keys: ['ConstDateSource'], wide: true },
    { label: 'Upstream asset', keys: ['US_ID'] },
    { label: 'Downstream asset', keys: ['DS_ID'] },
  ],
}

function exportKindForRecord(kind: AssetHistoryRecord['kind']): Exclude<HistoryKind, 'timeline'> | null {
  if (kind === 'asset') return null
  return `${kind}s` === 'pipe_risks' ? 'pipe_risk' : `${kind}s` as Exclude<HistoryKind, 'timeline'>
}

function storedExportFields(): ExportFieldSelection {
  try { return JSON.parse(window.localStorage.getItem(EXPORT_STORAGE_KEY) || '{}') as ExportFieldSelection } catch { return {} }
}

function parseResourceDate(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim().replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatEasternDateTime(value: string | null | undefined, fallback = '—') {
  const date = parseResourceDate(value)
  return date ? new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date) : value || fallback
}

function formatEasternDateOnly(value: string | null | undefined, fallback = '—') {
  if (!value) return fallback
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (dateOnly) return `${Number(dateOnly[2])}/${Number(dateOnly[3])}/${dateOnly[1]}`
  const date = parseResourceDate(value)
  return date ? new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date) : value
}

function detailValueText(field: string, value: unknown) {
  if (typeof value === 'string' && /(date|time)/i.test(field) && parseResourceDate(value)) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? formatEasternDateOnly(value) : formatEasternDateTime(value)
  }
  return valueText(value)
}

function itpipesInspectionUrl(mliId: string) {
  const url = new URL(ITPIPES_INSPECTION_URL)
  url.searchParams.set('assetType', 'ML')
  url.searchParams.set('inspID', mliId)
  return url.toString()
}

const STATE_LABELS: Record<AssignmentState, string> = {
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  mixed: 'Mixed',
  not_evaluated: 'Not evaluated',
  data_issue: 'Data issue',
  data_unavailable: 'Data unavailable',
}

function assignmentIcon(state: AssignmentState) {
  if (state === 'assigned') return <CheckCircle2 size={16} />
  if (state === 'mixed') return <Split size={16} />
  if (state === 'data_issue' || state === 'data_unavailable') return <TriangleAlert size={16} />
  return <CircleDotDashed size={16} />
}

function valueText(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function assetSummaryEntries(asset: AssetSummaryResponse['asset'], assetType: AssetType) {
  const values = { ...asset.all_fields, ...asset.summary }
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))
  return ASSET_SUMMARY_FIELDS[assetType].map((field) => {
    const value = field.keys.map((key) => normalized.get(key.toLowerCase())).find((candidate) => candidate !== null && candidate !== undefined && candidate !== '')
    let text = valueText(value)
    if (field.format === 'date' && value !== null && value !== undefined && value !== '') {
      text = formatEasternDateOnly(String(value))
    } else if (field.format === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      text = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value)
    }
    return { label: field.label, text, compact: Boolean(field.compact), wide: Boolean(field.wide) }
  })
}

function recordKindLabel(kind: AssetHistoryRecord['kind']) {
  return ({
    asset: 'Asset',
    service_request: 'Service request',
    investigation: 'Investigation',
    inspection: 'Inspection',
    work_order: 'Work order',
    itpipes_defect: 'ITPipes defect',
    pipe_risk: 'Risk information',
  } as const)[kind]
}

function riskText(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—'
}

function openRecordUrl(event: MouseEvent<HTMLAnchorElement>, url: string, recordLabel: string) {
  event.preventDefault()
  event.stopPropagation()
  void openExternalUrl(url).catch((reason) => toast.error(reason instanceof Error ? reason.message : `Could not open ${recordLabel}.`))
}

function backToPortal() {
  if (new URLSearchParams(window.location.search).get('returnTo') === 'map') {
    openPortalResource('/map_stm_risk', { preserveExisting: true })
    return
  }
  activatePortalHome()
}

function isCityworksRecord(record: AssetHistoryRecord): record is HistoryRecord {
  return record.kind !== 'itpipes_defect' && record.kind !== 'pipe_risk'
}

function isSameRecord(left: AssetHistoryRecord, right: AssetHistoryRecord) {
  if (left.kind !== right.kind || left.record_id !== right.record_id) return false
  if (isCityworksRecord(left) && isCityworksRecord(right) && (left.event_key || right.event_key)) return left.event_key === right.event_key
  if (left.kind === 'pipe_risk' && right.kind === 'pipe_risk') return left.work_zone_id === right.work_zone_id
  return true
}

function timelineDateParts(value: string | null | undefined) {
  if (!value) return { year: 'Unknown date', day: 'Unknown date', time: '' }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { year: 'Unknown date', day: value, time: '' }
  return {
    year: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIME_ZONE, year: 'numeric' }).format(date),
    day: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIME_ZONE, weekday: 'short', month: 'long', day: 'numeric' }).format(date),
    time: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN_TIME_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date),
  }
}

function groupedTimeline(records: AssetHistoryRecord[]) {
  const groups: Array<{ year: string; dates: Array<{ day: string; events: HistoryRecord[] }> }> = []
  for (const record of records.filter(isCityworksRecord)) {
    const parts = timelineDateParts(record.event_date)
    let year = groups.at(-1)
    if (!year || year.year !== parts.year) {
      year = { year: parts.year, dates: [] }
      groups.push(year)
    }
    let date = year.dates.at(-1)
    if (!date || date.day !== parts.day) {
      date = { day: parts.day, events: [] }
      year.dates.push(date)
    }
    date.events.push(record)
  }
  return groups
}

export default function StormWaterAssetHistory() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialType = initial.get('assetType') as AssetType | null
  const [assetType, setAssetType] = useState<AssetType | null>(initialType && ['structure', 'pipe', 'channel'].includes(initialType) ? initialType : null)
  const [assetId, setAssetId] = useState(initial.get('assetId') ?? '')
  const [search, setSearch] = useState(initial.get('assetId') ?? '')
  const [candidates, setCandidates] = useState<AssetCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [summary, setSummary] = useState<AssetSummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [tab, setTab] = useState<HistoryKind>('timeline')
  const [records, setRecords] = useState<AssetHistoryRecord[]>([])
  const [total, setTotal] = useState(0)
  const [recordTotal, setRecordTotal] = useState(0)
  const [timelineView, setTimelineView] = useState<'activity' | 'table'>('activity')
  const [timelineDensity, setTimelineDensity] = useState<'comfortable' | 'compact'>('comfortable')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [recordSearch, setRecordSearch] = useState('')
  const [status, setStatus] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [selected, setSelected] = useState<AssetHistoryRecord | null>(null)
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)
  const [exportCatalog, setExportCatalog] = useState<ExportFieldCatalog>({ worksheets: {} })
  const [exportSelection, setExportSelection] = useState<ExportFieldSelection>(storedExportFields)
  const [exportTab, setExportTab] = useState<Exclude<HistoryKind, 'timeline'>>('service_requests')
  const [exportSearch, setExportSearch] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (assetId || search.trim().length < 2) {
      setCandidates([])
      return
    }
    const handle = window.setTimeout(() => {
      setSearching(true)
      searchAssetCandidates(search)
        .then((result) => setCandidates(result.results))
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setSearching(false))
    }, 220)
    return () => window.clearTimeout(handle)
  }, [assetId, search])

  const refreshSummary = useCallback(() => {
    if (!assetId || !assetType) return
    setSummaryLoading(true)
    setError('')
    loadAssetSummary(assetType, assetId)
      .then(setSummary)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setSummaryLoading(false))
  }, [assetId, assetType])

  useEffect(refreshSummary, [refreshSummary])

  const refreshRecords = useCallback(() => {
    if (!assetId || !assetType) return
    setRecordsLoading(true)
    loadAssetRecords(assetType, assetId, {
      kind: tab,
      page,
      page_size: pageSize,
      search: recordSearch,
      status,
      from_date: fromDate,
      to_date: toDate,
    })
      .then((result) => {
        setRecords(result.items)
        setTotal(result.total)
        setRecordTotal(result.record_total ?? result.total)
        setSelected((current) => {
          if (!current || result.items.some((item) => isSameRecord(item, current))) return current
          setDetail(null)
          return null
        })
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setRecordsLoading(false))
  }, [assetId, assetType, fromDate, page, pageSize, recordSearch, status, tab, toDate])

  useEffect(refreshRecords, [refreshRecords])

  useEffect(() => {
    if (!summary) return
    const unavailableITPipes = tab === 'itpipes_defects' && (summary.counts.itpipes_defects ?? 0) === 0
    const unavailablePipeRisk = tab === 'pipe_risk' && (assetType !== 'pipe' || (summary.counts.pipe_risk ?? 0) === 0)
    if (unavailableITPipes || unavailablePipeRisk) {
      setTab('timeline')
      setPage(1)
    }
  }, [assetType, summary, tab])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    setDetail(null)
    loadRecordDetail(selected.kind, selected.record_id, selected.kind === 'pipe_risk' ? selected.work_zone_id ?? '' : '', assetType)
      .then(setDetail)
      .catch((reason: Error) => toast.error(reason.message))
      .finally(() => setDetailLoading(false))
  }, [assetType, selected])

  useEffect(() => {
    if (!selected || !assetType || !assetId || Object.keys(exportCatalog.worksheets).length) return
    loadExportFields(assetType, assetId).then(setExportCatalog).catch(() => undefined)
  }, [assetId, assetType, exportCatalog.worksheets, selected])

  function selectAsset(candidate: AssetCandidate) {
    setAssetId(candidate.asset_id)
    setAssetType(candidate.asset_type)
    setSearch(candidate.asset_id)
    setCandidates([])
    setPage(1)
    const next = new URL(window.location.href)
    next.searchParams.set('assetId', candidate.asset_id)
    next.searchParams.set('assetType', candidate.asset_type)
    window.history.replaceState({}, '', next)
  }

  function clearAsset() {
    setAssetId('')
    setAssetType(null)
    setSummary(null)
    setRecords([])
    setSelected(null)
    setDetail(null)
    setSearch('')
    const next = new URL(window.location.href)
    next.searchParams.delete('assetId')
    next.searchParams.delete('assetType')
    window.history.replaceState({}, '', next)
  }

  async function copyAssetId() {
    await navigator.clipboard.writeText(assetId)
    toast.success('Asset ID copied.')
  }

  async function openExportDialog() {
    if (!assetType || !assetId) return
    setExportOpen(true)
    if (Object.keys(exportCatalog.worksheets).length) return
    setExportLoading(true)
    try {
      setExportCatalog(await loadExportFields(assetType, assetId))
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load export fields.')
    } finally {
      setExportLoading(false)
    }
  }

  function setExportField(kind: Exclude<HistoryKind, 'timeline'>, field: string, selected: boolean) {
    setExportSelection((current) => {
      const values = new Set(current[kind] ?? [])
      if (selected) values.add(field); else values.delete(field)
      const next = { ...current, [kind]: [...values] }
      window.localStorage.setItem(EXPORT_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  async function exportWorkbook() {
    if (!assetType || !assetId) return
    try {
      setExportLoading(true)
      await exportAssetHistory(assetType, assetId, { search: recordSearch, status, from_date: fromDate, to_date: toDate }, exportSelection)
      setExportOpen(false)
      toast.success('Asset history workbook created and opened.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not export asset history.')
    } finally {
      setExportLoading(false)
    }
  }

  if (!assetId || !assetType) {
    return (
      <main className="asset-history search-state">
        <section className="asset-history-search-card">
          <span className="eyebrow">STORM WATER OPERATIONS</span>
          <FileSearch size={34} />
          <h1>Storm Water Asset History</h1>
          <p>Find a storm structure, pipe, or channel to review assignment and Cityworks activity.</p>
          <label className="asset-search-control">
            <Search size={20} />
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Asset ID, for example P_12345" />
            {searching ? <LoaderCircle className="spin" size={19} /> : null}
          </label>
          {candidates.length ? (
            <div className="asset-candidates" role="listbox">
              {candidates.map((candidate) => (
                <button key={`${candidate.asset_type}:${candidate.asset_id}`} type="button" onClick={() => selectAsset(candidate)}>
                  <strong>{candidate.asset_id}</strong><span>{candidate.asset_type}</span><small>{candidate.subtitle}</small>
                </button>
              ))}
            </div>
          ) : search.length >= 2 && !searching ? <div className="empty-search">No matching core asset.</div> : null}
          {error ? <div className="asset-history-error">{error}</div> : null}
          <button className="text-button" type="button" onClick={backToPortal}><ArrowLeft size={16} /> Back to Portal</button>
        </section>
      </main>
    )
  }

  const assignment = summary?.assignment.combined ?? 'not_evaluated'
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const sourceTime = summary?.assignment.published_at || summary?.sources.step401?.published_at
  const summaryEntries = summary ? assetSummaryEntries(summary.asset, assetType) : []
  const availableTabs = TABS.filter((item) => {
    if (item.id === 'itpipes_defects') return (summary?.counts.itpipes_defects ?? 0) > 0
    if (item.id === 'pipe_risk') return assetType === 'pipe' && (summary?.counts.pipe_risk ?? 0) > 0
    return true
  })
  const exportTabDefinition = EXPORT_TABS.find((item) => item.id === exportTab) ?? EXPORT_TABS[0]
  const exportFields = (exportCatalog.worksheets[exportTab] ?? []).filter((field) => {
    const needle = exportSearch.trim().toLowerCase()
    return !needle || field.label.toLowerCase().includes(needle) || field.key.toLowerCase().includes(needle)
  })
  const selectedExportCount = Object.values(exportSelection).reduce((count, fields) => count + (fields?.length ?? 0), 0)

  return (
    <main className="asset-history">
      <header className="asset-history-header">
        <div className="asset-title-row">
          <button className="icon-button" type="button" onClick={clearAsset} title="Find another asset"><ArrowLeft size={19} /></button>
          <div><span className="eyebrow">STORM WATER ASSET HISTORY</span><h1>{assetId}</h1></div>
          <span className="asset-type-chip">{assetType}</span>
          {summary ? (
            <details className={`assignment assignment-${assignment}`}>
              <summary>{assignmentIcon(assignment)} {STATE_LABELS[assignment]}</summary>
              <div className="assignment-popover">
                <h3>Assignment</h3>
                {Object.entries(summary.assignment.branches).map(([name, branch]) => (
                  <div className="branch-row" key={name}><span>{name === 'cityworks' ? 'Cityworks-only' : 'ITPipes-only'}</span><strong>{branch.state.replaceAll('_', ' ')}</strong></div>
                ))}
                <small>{summary.assignment.version || 'Active version'}{sourceTime ? ` · ${formatEasternDateTime(sourceTime)}` : ''}</small>
              </div>
            </details>
          ) : null}
          <div className="header-actions">
            <button type="button" onClick={() => openPortalResource(`/map_stm_risk?assetId=${encodeURIComponent(assetId)}&assetType=${assetType}`)}><LocateFixed size={17} /> Locate on map</button>
            <button type="button" onClick={copyAssetId}><Clipboard size={17} /> Copy ID</button>
            <button type="button" onClick={() => { refreshSummary(); refreshRecords() }}><RefreshCw size={17} /> Refresh</button>
          </div>
        </div>
        <div className="asset-summary-row">
          {summaryLoading ? <span><LoaderCircle className="spin" size={17} /> Loading asset...</span> : summaryEntries.map((item) => <span className={item.wide ? 'asset-summary-wide' : item.compact ? 'asset-summary-compact' : undefined} key={item.label}><small>{item.label}</small><strong title={item.text}>{item.text}</strong></span>)}
          {sourceTime ? <span className="source-age"><small>Step 401 published</small><strong>{formatEasternDateTime(sourceTime)}</strong></span> : null}
        </div>
      </header>

      {summary?.errors && Object.entries(summary.errors).map(([area, message]) => (
        <div className="asset-history-error page-error" key={area}><TriangleAlert size={18} /><strong>{area === 'assignment' ? 'Assignment unavailable:' : area === 'itpipes_defects' ? 'ITPipes defects unavailable:' : area === 'pipe_risk' ? 'Risk information unavailable:' : 'History unavailable:'}</strong> {message}</div>
      ))}

      {error ? <div className="asset-history-error page-error"><TriangleAlert size={18} />{error}<button onClick={() => setError('')}><X size={16} /></button></div> : null}

      <section className="asset-history-workspace">
        <nav className="history-tabs" aria-label="Asset history views">
          {availableTabs.map((item) => <button className={tab === item.id ? 'active' : ''} key={item.id} type="button" onClick={() => { setTab(item.id); setPage(1); setSelected(null); setDetail(null) }}>{item.label}<span>{summary?.counts[item.id] ?? 0}</span></button>)}
        </nav>
        <div className="history-toolbar">
          <label className="record-search"><Search size={17} /><input value={recordSearch} onChange={(event) => { setRecordSearch(event.target.value); setPage(1) }} placeholder={tab === 'itpipes_defects' ? 'Search MLI, MLO, direction, or observation' : tab === 'pipe_risk' ? 'Search basin, work zone, or score' : 'Search records'} /></label>
          {tab !== 'itpipes_defects' && tab !== 'pipe_risk' ? <input type="text" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} placeholder="Status" aria-label="Filter by exact status" /> : null}
          {tab !== 'pipe_risk' ? <label>From<input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1) }} /></label> : null}
          {tab !== 'pipe_risk' ? <label>To<input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1) }} /></label> : null}
          {(recordSearch || status || fromDate || toDate) ? <button type="button" onClick={() => { setRecordSearch(''); setStatus(''); setFromDate(''); setToDate(''); setPage(1) }}>Clear filters</button> : null}
          {tab === 'timeline' ? <>
            <div className="timeline-view-toggle" role="group" aria-label="Timeline view">
              <button type="button" className={timelineView === 'activity' ? 'active' : ''} onClick={() => setTimelineView('activity')}><LayoutList size={16} /> Timeline</button>
              <button type="button" className={timelineView === 'table' ? 'active' : ''} onClick={() => setTimelineView('table')}><Table2 size={16} /> Table</button>
            </div>
            {timelineView === 'activity' ? <div className="timeline-density-toggle" role="group" aria-label="Timeline density">
              <button type="button" className={timelineDensity === 'comfortable' ? 'active' : ''} onClick={() => setTimelineDensity('comfortable')}>Comfortable</button>
              <button type="button" className={timelineDensity === 'compact' ? 'active' : ''} onClick={() => setTimelineDensity('compact')}>Compact</button>
            </div> : null}
          </> : null}
          <button className="primary" type="button" onClick={openExportDialog}><Download size={17} /> Export</button>
        </div>

        <div className={`history-content ${selected ? 'with-details' : ''}`}>
          <div className="history-table-wrap">
            {tab === 'timeline' && timelineView === 'activity' ? (
              <div className={`activity-timeline density-${timelineDensity}`}>
                {recordsLoading ? <div className="timeline-state"><LoaderCircle className="spin" /> Loading timeline...</div> : records.length ? groupedTimeline(records).map((year) => (
                  <section className="timeline-year" key={year.year}>
                    <h2><span>{year.year}</span></h2>
                    {year.dates.map((date) => <section className="timeline-date-group" key={`${year.year}:${date.day}`}>
                      <h3>{date.day}</h3>
                      <div className="timeline-event-list">
                        {date.events.map((record) => {
                          const time = timelineDateParts(record.event_date).time
                          return <article key={record.event_key ?? `${record.kind}:${record.record_id}:${record.event_date}`} className={`timeline-card kind-border-${record.kind} ${selected && isSameRecord(selected, record) ? 'selected' : ''}`} onClick={() => setSelected(record)}>
                            <div className="timeline-marker" aria-hidden="true"><span /></div>
                            <time dateTime={record.event_date ?? undefined}>{time}</time>
                            <div className="timeline-card-main">
                              <div className="timeline-card-heading"><strong>{record.event_name || 'Activity'}</strong><span className={`record-kind kind-${record.kind}`}>{recordKindLabel(record.kind)}</span>{record.source_url ? <a className="timeline-record-link" href={record.source_url} target="_blank" rel="noreferrer" onClick={(event) => openRecordUrl(event, record.source_url!, `${recordKindLabel(record.kind)} ${record.record_id}`)}>{record.record_id}</a> : <span className="timeline-record-id">{record.record_id}</span>}</div>
                              <div className="timeline-card-details"><strong>{record.title || 'Untitled record'}</strong>{record.summary ? <span>{record.summary}</span> : null}<span className="relationship-chip">{record.relationship}</span>{record.related_id ? <span className="timeline-related">Related: {record.related_id}</span> : null}<small>{record.event_field?.replaceAll('_', ' ')}</small></div>
                            </div>
                            <span className={`timeline-status status-${String(record.status || 'unknown').toLowerCase().replaceAll(' ', '-')}`}>{record.status || 'No status'}</span>
                            {record.source_url ? <button type="button" className="row-action timeline-open" title="Open source record" onClick={(event) => { event.stopPropagation(); void openExternalUrl(record.source_url!) }}><ExternalLink size={16} /></button> : null}
                          </article>
                        })}
                      </div>
                    </section>)}
                  </section>
                )) : <div className="timeline-state">No timeline events match this view.</div>}
              </div>
            ) : tab === 'itpipes_defects' ? (
            <table className="history-table itpipes-defects-table">
              <thead><tr><th>Inspection date</th><th>MLI ID</th><th>MLO ID</th><th>ML ID</th><th>Direction</th><th>Continuous</th><th>Observation text</th><th>Distance</th><th>Relative depth</th><th>Condition risk</th><th>Flood risk</th><th>Clogging risk</th><th>Risk</th></tr></thead>
              <tbody>
                {recordsLoading ? <tr><td colSpan={13} className="table-state"><LoaderCircle className="spin" /> Loading ITPipes defects...</td></tr> : records.length ? records.filter((record): record is ITPipesDefectRecord => record.kind === 'itpipes_defect').map((record) => (
                  <tr key={`${record.mli_id}:${record.mlo_id}`} className={selected && isSameRecord(selected, record) ? 'selected' : ''} onClick={() => setSelected(record)}>
                    <td>{formatEasternDateOnly(record.inspection_date)}</td>
                    <td>{record.mli_id ? <a className="itpipes-inspection-link" href={itpipesInspectionUrl(record.mli_id)} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); event.stopPropagation(); const url = itpipesInspectionUrl(record.mli_id); void openExternalUrl(url).catch((reason) => toast.error(reason instanceof Error ? reason.message : `Could not open ITPipes inspection ${record.mli_id}.`)) }}>{record.mli_id}</a> : '—'}</td>
                    <td><strong>{record.mlo_id || '—'}</strong></td>
                    <td>{record.ml_id || '—'}</td>
                    <td>{record.inspection_direction || '—'}</td>
                    <td>{record.is_continuous === null || record.is_continuous === undefined ? '—' : record.is_continuous ? 'Yes' : 'No'}</td>
                    <td className="observation-cell">{record.observation_text || '—'}</td>
                    <td>{riskText(record.distance)}</td>
                    <td>{riskText(record.relative_depth)}</td>
                    <td>{riskText(record.condition_risk)}</td>
                    <td>{riskText(record.flood_risk)}</td>
                    <td>{riskText(record.clogging_risk)}</td>
                    <td><strong>{riskText(record.risk)}</strong></td>
                  </tr>
                )) : <tr><td colSpan={13} className="table-state">No ITPipes defects match this view.</td></tr>}
              </tbody>
            </table>
            ) : tab === 'pipe_risk' ? (
            <table className="history-table pipe-risk-table">
              <thead><tr><th>Basin name</th><th>Work zone ID</th><th>CL score</th><th>LOF score</th><th>COF score</th><th>Risk</th></tr></thead>
              <tbody>
                {recordsLoading ? <tr><td colSpan={6} className="table-state"><LoaderCircle className="spin" /> Loading risk information...</td></tr> : records.length ? records.filter((record): record is PipeRiskRecord => record.kind === 'pipe_risk').map((record) => (
                  <tr key={`${record.asset_id}:${record.work_zone_id ?? ''}`} className={selected && isSameRecord(selected, record) ? 'selected' : ''} onClick={() => setSelected(record)}>
                    <td><strong>{record.basin_name || 'â€”'}</strong></td>
                    <td>{record.work_zone_id || 'â€”'}</td>
                    <td>{riskText(record.cl_score)}</td>
                    <td>{riskText(record.lof_score)}</td>
                    <td>{riskText(record.cof_score)}</td>
                    <td><strong>{riskText(record.risk)}</strong></td>
                  </tr>
                )) : <tr><td colSpan={6} className="table-state">No priority-pipe risk information matches this view.</td></tr>}
              </tbody>
            </table>
            ) : (
            <table className={`history-table ${tab === 'inspections' ? 'inspection-history-table' : tab === 'timeline' ? 'timeline-history-table' : ''}`}>
              <thead><tr><th>Date</th>{tab === 'timeline' ? <th>Event</th> : null}<th>Type</th><th>ID</th><th>Status</th>{tab === 'inspections' ? <><th>Condition risk</th><th>Flood risk</th><th>Clogging risk</th><th>Risk</th></> : null}<th>Title / summary</th><th>Relationship</th><th aria-label="Open source" /></tr></thead>
              <tbody>
                {recordsLoading ? <tr><td colSpan={tab === 'inspections' ? 11 : tab === 'timeline' ? 8 : 7} className="table-state"><LoaderCircle className="spin" /> Loading history...</td></tr> : records.length ? records.filter(isCityworksRecord).map((record) => (
                  <tr key={record.event_key ?? `${record.kind}:${record.record_id}:${record.relationship}`} className={selected && isSameRecord(selected, record) ? 'selected' : ''} onClick={() => setSelected(record)}>
                    <td>{formatEasternDateTime(record.event_date)}</td>
                    {tab === 'timeline' ? <td><strong className="timeline-event-name">{record.event_name || 'Activity'}</strong><small>{record.event_field?.replaceAll('_', ' ')}</small></td> : null}
                    <td><span className={`record-kind kind-${record.kind}`}>{recordKindLabel(record.kind)}</span></td>
                    <td><strong>{record.source_url ? <a className="source-record-link" href={record.source_url} target="_blank" rel="noreferrer" onClick={(event) => openRecordUrl(event, record.source_url!, `${recordKindLabel(record.kind)} ${record.record_id}`)}>{record.record_id}</a> : record.record_id}</strong></td>
                    <td>{record.status || '—'}</td>
                    {tab === 'inspections' ? <><td>{riskText(record.condition_risk)}</td><td>{riskText(record.flood_risk)}</td><td>{riskText(record.clogging_risk)}</td><td><strong>{riskText(record.risk)}</strong></td></> : null}
                    <td><strong>{record.title || '—'}</strong><small>{record.summary || ''}</small></td>
                    <td><span className="relationship-chip">{record.relationship}</span>{record.related_id ? <small>{record.related_id}</small> : null}</td>
                    <td>{record.source_url ? <button type="button" className="row-action" onClick={(event) => { event.stopPropagation(); void openExternalUrl(record.source_url!) }}><ExternalLink size={16} /></button> : null}</td>
                  </tr>
                )) : <tr><td colSpan={tab === 'inspections' ? 11 : tab === 'timeline' ? 8 : 7} className="table-state">No records match this view.</td></tr>}
              </tbody>
            </table>
            )}
          </div>

          {selected ? (
            <aside className="record-details">
              <header><div><span className="eyebrow">{recordKindLabel(selected.kind)}</span><h2>{selected.record_id}</h2></div><button type="button" onClick={() => setSelected(null)}><X size={19} /></button></header>
              {detailLoading ? <div className="detail-state"><LoaderCircle className="spin" /> Loading details...</div> : detail ? (
                <div className="detail-body">
                  {isCityworksRecord(selected) && selected.event_name ? <section className="selected-event-context"><span>Selected timeline event</span><strong>{selected.event_name}</strong><small>{selected.event_date ? formatEasternDateTime(selected.event_date) : ''}{selected.event_field ? ` · ${selected.event_field.replaceAll('_', ' ')}` : ''}</small></section> : null}
                  {detail.source_url ? <button className="open-source" type="button" onClick={() => void openExternalUrl(detail.source_url!)}><ExternalLink size={17} /> Open in Cityworks</button> : null}
                  <h3>Source fields</h3>
                  <dl>{Object.entries(detail.fields).filter(([, value]) => !isCityworksRecord(selected) || (value !== null && value !== '')).map(([key, value]) => {
                    const exportKind = exportKindForRecord(selected.kind)
                    const included = exportKind ? (exportSelection[exportKind] ?? []).includes(key) : false
                    const exportable = exportKind ? (exportCatalog.worksheets[exportKind] ?? []).some((field) => field.key === key) : false
                    return <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{detailValueText(key, value)}</dd>{exportable && exportKind ? <label className="detail-export-field" title="Include this field in the exported worksheet"><input type="checkbox" checked={included} onChange={(event) => setExportField(exportKind, key, event.target.checked)} /><Download size={14} /></label> : <span />}</div>
                  })}</dl>
                  {detail.questions.length ? <><h3>Inspection questions</h3><div className="question-list">{detail.questions.map((question, index) => <article key={String(question.INSPQUESTIONID ?? index)}><strong>{valueText(question.QUESTION)}</strong><p>{valueText(question.ANSWER)}</p></article>)}</div></> : null}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>

        <footer className="history-pager">
          <label>Rows<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>{[10, 25, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
          <span>{total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}${tab === 'timeline' ? ` events · ${recordTotal} source records` : ''}` : tab === 'timeline' ? '0 events' : '0 records'}</span>
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /> Previous</button>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next <ChevronRight size={17} /></button>
        </footer>
      </section>
      {exportOpen ? <div className="asset-export-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExportOpen(false) }}>
        <section className="asset-export-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-export-title">
          <header><div><span className="eyebrow">EXCEL EXPORT</span><h2 id="asset-export-title">Export Asset History</h2><p>Visible table fields are always included. Select any additional source fields below.</p></div><button type="button" onClick={() => setExportOpen(false)} aria-label="Close export dialog"><X size={20} /></button></header>
          <div className="asset-export-layout">
            <nav aria-label="Export worksheets">{EXPORT_TABS.filter((item) => item.id !== 'pipe_risk' || assetType === 'pipe').map((item) => <button type="button" key={item.id} className={exportTab === item.id ? 'active' : ''} onClick={() => { setExportTab(item.id); setExportSearch('') }}><span>{item.label}</span><small>{(exportSelection[item.id] ?? []).length} additional</small></button>)}</nav>
            <div className="asset-export-fields">
              <div className="export-field-heading"><div><h3>{exportTabDefinition.label}</h3><span>{exportTabDefinition.required.length} visible fields always included</span></div><button type="button" onClick={() => setExportSelection((current) => { const next = { ...current, [exportTab]: [] }; window.localStorage.setItem(EXPORT_STORAGE_KEY, JSON.stringify(next)); return next })}>Reset additional fields</button></div>
              <div className="required-export-fields">{exportTabDefinition.required.map((field) => <span key={field}><CheckCircle2 size={14} /> {field}</span>)}</div>
              <label className="export-field-search"><Search size={17} /><input value={exportSearch} onChange={(event) => setExportSearch(event.target.value)} placeholder="Find a source field" /></label>
              <div className="optional-export-fields">
                {exportLoading && !exportFields.length ? <div className="export-fields-state"><LoaderCircle className="spin" /> Loading fields...</div> : exportFields.length ? exportFields.map((field) => <label key={field.key}><input type="checkbox" checked={(exportSelection[exportTab] ?? []).includes(field.key)} onChange={(event) => setExportField(exportTab, field.key, event.target.checked)} /><span><strong>{field.label}</strong><small>{field.key}</small></span></label>) : <div className="export-fields-state">No additional fields match this search.</div>}
              </div>
            </div>
          </div>
          <footer><span><SlidersHorizontal size={16} /> {selectedExportCount} additional fields selected</span><button type="button" onClick={() => setExportOpen(false)}>Cancel</button><button className="primary" type="button" disabled={exportLoading} onClick={exportWorkbook}>{exportLoading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />} Export workbook</button></footer>
        </section>
      </div> : null}
    </main>
  )
}
