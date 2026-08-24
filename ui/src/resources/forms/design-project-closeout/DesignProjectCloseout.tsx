import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  CornerUpLeft,
  Download,
  FileSpreadsheet,
  FileUp,
  LayoutList,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'

import { appConfirm, appPrompt } from '../../../components/messageDialogService'
import { isDesktopRuntime, openExternalUrl, saveExportAs } from '../../../desktop/runtime'
import { fetchPortalDictionaryItems } from '../../../dashboards/amteam/api'
import { fuzzyMatchScore } from '../../../dashboards/amteam/fuzzyMatch'
import {
  type CityworksWorkorder,
  type CloseoutFlatRow,
  type CloseoutAsset,
  type CloseoutAssetInput,
  type CloseoutProject,
  type CloseoutProjectDetail,
  type CloseoutStatus,
  type CloseoutAttachmentResult,
  batchDeleteCloseoutProjects,
  batchReviewCloseoutProjects,
  createCloseoutProject,
  deleteCloseoutProject,
  exportCloseoutSelection,
  checkCloseoutWorkorder,
  fetchCloseoutAssetCandidates,
  type CloseoutAssetCandidate,
  type WorkorderCheck,
  fetchCityworksWorkorderAssets,
  fetchCloseoutProject,
  fetchCloseoutProjects,
  fetchCloseoutRows,
  importCloseoutExcel,
  importWorkorderAttachment,
  reviewCloseoutProject,
  searchCityworksWorkorders,
  updateCloseoutProject,
} from './api'
import './DesignProjectCloseout.css'

/**
 * Design Project Close-Out: post-project asset assessments with a review workflow.
 *
 * Data arrives three ways - typed by hand, imported from the Excel template, or pulled
 * from a Cityworks work order - and always lands as a pending project that a reviewer
 * approves or returns. The Approved view is the authoritative table and exports back to
 * the exact master-workbook shape the risk ETL reads.
 */

const PROJECT_PAGE_SIZE = 25

// The spreadsheet opens on this column, newest first.
const SHEET_DATE_COLUMN = 'Date of Analysis'
const SHEET_WORKORDER_COLUMN = 'Cityworks WO ID'
// Free-text prose: sorting it alphabetically means nothing, and it is already
// reachable through the other columns, so it takes neither control.
const SHEET_UNSORTED_COLUMNS = new Set(['Notes'])
const SHEET_PAGE_SIZES = [50, 100, 250, 1000]
// Below this many distinct values a column filters by dropdown; above it, by typing.
const SHEET_CHOICE_LIMIT = 25

const STATUS_LABELS: Record<CloseoutStatus, string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  returned: 'Returned',
}

const DICTIONARY_KEYS = {
  source_of_analysis: 'source_of_analysis',
  flooding_design_standards: 'flooding_design_standards',
  flooding_impact: 'flooding_impact',
  flooding_service_eligibility: 'flooding_service_eligibility',
  post_project_asset_condition: 'post_project_asset_condition',
} as const

type DictionaryField = keyof typeof DICTIONARY_KEYS

type AssetDraft = CloseoutAssetInput & { key: string }

type ProjectDraft = {
  globalId: string | null
  recordRevision: string | null
  projectName: string
  cityworksWoId: string
  sourceOfAnalysis: string
  dateOfAnalysis: string
  intakeMethod: 'manual' | 'excel' | 'cityworks'
  assets: AssetDraft[]
}

let draftKeySequence = 0
function nextKey() {
  draftKeySequence += 1
  return `draft-${draftKeySequence}`
}

// The most common value for each field across the 1,164 master rows, so the usual
// case is already selected: Meets CDS 60%, its two N/A partners 58% and 56%, and
// Not Inspected 74% (100% of Planning rows).
// An asset ID is at most ten characters (P_/S_/D_ plus a numeric id), and fewer than
// three characters matches too much of the inventory to be worth a lookup.
const WORKORDER_ID_MAX_DIGITS = 10
const ASSET_SEARCH_MIN = 3
const ASSET_ID_MAX = 10

const ASSET_DEFAULTS: Record<string, string> = {
  flooding_design_standards: 'Meets CDS',
  flooding_impact: 'Meets CDS - N/A',
  flooding_service_eligibility: 'Meets CDS - N/A',
  post_project_asset_condition: 'Not Inspected',
}

function emptyAsset(): AssetDraft {
  return {
    key: nextKey(),
    asset_id: '',
    construction_plan_id: null,
    critical_facility_id: null,
    flooding_design_standards: '',
    flooding_impact: '',
    flooding_service_eligibility: '',
    post_project_asset_condition: null,
    notes: null,
  }
}

function draftFromDetail(detail: CloseoutProjectDetail): ProjectDraft {
  return {
    globalId: detail.project.global_id,
    recordRevision: detail.project.record_revision,
    projectName: detail.project.project_name ?? '',
    cityworksWoId: detail.project.cityworks_wo_id ?? '',
    sourceOfAnalysis: detail.project.source_of_analysis ?? '',
    dateOfAnalysis: detail.project.date_of_analysis ?? '',
    intakeMethod: 'manual',
    assets: detail.assets.map((asset: CloseoutAsset) => ({
      key: nextKey(),
      asset_id: asset.asset_id,
      construction_plan_id: asset.construction_plan_id,
      critical_facility_id: asset.critical_facility_id,
      flooding_design_standards: asset.flooding_design_standards ?? '',
      flooding_impact: asset.flooding_impact ?? '',
      flooding_service_eligibility: asset.flooding_service_eligibility ?? '',
      post_project_asset_condition: asset.post_project_asset_condition,
      notes: asset.notes,
    })),
  }
}

function formatDate(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : '—'
}

export default function DesignProjectCloseout() {
  const [tab, setTab] = useState<CloseoutStatus>('pending_review')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [rows, setRows] = useState<CloseoutProject[]>([])
  const [statusCounts, setStatusCounts] = useState<Record<CloseoutStatus, number>>({
    pending_review: 0,
    approved: 0,
    returned: 0,
  })
  const [canCreate, setCanCreate] = useState(false)
  const [canDelete, setCanDelete] = useState(false)
  const [canReviewSelection, setCanReviewSelection] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')

  const [detail, setDetail] = useState<CloseoutProjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [draft, setDraft] = useState<ProjectDraft | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState('')

  const [importOpen, setImportOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importSummary, setImportSummary] = useState<string[]>([])

  const [cityworksOpen, setCityworksOpen] = useState(false)
  const [cityworksMode, setCityworksMode] = useState<'closed_date' | 'workorder'>('closed_date')
  const [cityworksDate, setCityworksDate] = useState('')
  const [cityworksQuery, setCityworksQuery] = useState('')
  const [cityworksRows, setCityworksRows] = useState<CityworksWorkorder[]>([])
  const [cityworksCutoff, setCityworksCutoff] = useState<string | null>(null)
  const [cityworksBusy, setCityworksBusy] = useState(false)
  const [attachmentWo, setAttachmentWo] = useState<string | null>(null)
  const [attachmentResult, setAttachmentResult] = useState<CloseoutAttachmentResult | null>(null)
  const [attachmentBusy, setAttachmentBusy] = useState(false)

  const [view, setView] = useState<'projects' | 'spreadsheet'>('projects')
  const [sheetStatus, setSheetStatus] = useState<CloseoutStatus | 'all'>('all')
  const [sheetHeadings, setSheetHeadings] = useState<string[]>([])
  const [workorderUrlTemplate, setWorkorderUrlTemplate] = useState<string | null>(null)
  // Keyed by asset row so two rows can be searched independently.
  const [assetQuery, setAssetQuery] = useState<Record<string, string>>({})
  const [assetChoices, setAssetChoices] = useState<Record<string, CloseoutAssetCandidate[]>>({})
  const [assetSearching, setAssetSearching] = useState<string | null>(null)
  const [assetAnchor, setAssetAnchor] = useState<{ top: number; left: number; width: number } | null>(null)
  const [workorderCheck, setWorkorderCheck] = useState<WorkorderCheck | null>(null)
  const [sheetFilters, setSheetFilters] = useState<Record<string, string>>({})
  const [sheetPage, setSheetPage] = useState(0)
  const [sheetPageSize, setSheetPageSize] = useState(SHEET_PAGE_SIZES[0])
  const [sheetSort, setSheetSort] = useState<{ column: string; direction: 'asc' | 'desc' }>({
    column: SHEET_DATE_COLUMN,
    direction: 'desc',
  })
  const [sheetRows, setSheetRows] = useState<CloseoutFlatRow[]>([])
  const [sheetLoading, setSheetLoading] = useState(false)

  const [dictionaries, setDictionaries] = useState<Record<DictionaryField, string[]>>({
    source_of_analysis: [],
    flooding_design_standards: [],
    flooding_impact: [],
    flooding_service_eligibility: [],
    post_project_asset_condition: [],
  })

  const reload = useCallback(async (status: CloseoutStatus, _query: string) => {
    setLoading(true)
    setErrorMessage('')
    try {
      const response = await fetchCloseoutProjects(status)
      setRows(response.rows)
      setStatusCounts(response.status_counts)
      setCanCreate(response.can_create)
      setCanDelete(response.can_delete)
      setCanReviewSelection(response.can_review)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The project list could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(tab, search)
  }, [reload, tab])

  useEffect(() => {
    setPage(0)
    setSelectedIds(new Set())
  }, [tab, search])

  useEffect(() => {
    if (!cityworksOpen) return
    const query = cityworksMode === 'workorder' ? cityworksQuery.trim() : ''
    const since = cityworksMode === 'closed_date' ? cityworksDate : ''
    // Opening or picking a date loads immediately; typing a number debounces.
    const timer = window.setTimeout(async () => {
      setCityworksBusy(true)
      try {
        const response = await searchCityworksWorkorders({
          search: query || undefined,
          closed_since: since || undefined,
        })
        setCityworksRows(response.rows)
        setWorkorderUrlTemplate(response.workorder_url_template)
        setCityworksCutoff(response.cutoff)
        // The backlog cutoff becomes the suggested starting date the first time.
        if (cityworksMode === 'closed_date' && !since && response.cutoff) {
          setCityworksDate(response.cutoff)
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'The work order search failed.')
      } finally {
        setCityworksBusy(false)
      }
    }, query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [cityworksOpen, cityworksMode, cityworksQuery, cityworksDate])

  useEffect(() => {
    if (view !== 'spreadsheet') return
    let cancelled = false
    setSheetLoading(true)
    fetchCloseoutRows(sheetStatus)
      .then((response) => {
        if (cancelled) return
        setSheetHeadings(response.headings)
        setSheetRows(response.rows)
        setWorkorderUrlTemplate(response.workorder_url_template)
      })
      .catch((error) => {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : 'The spreadsheet rows could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setSheetLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, sheetStatus, notice])

  useEffect(() => {
    let cancelled = false
    for (const field of Object.keys(DICTIONARY_KEYS) as DictionaryField[]) {
      fetchPortalDictionaryItems(DICTIONARY_KEYS[field])
        .then((response) => {
          if (cancelled) return
          setDictionaries((current) => ({
            ...current,
            [field]: response.items.map((item) => item.label),
          }))
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [])

  async function openDetail(globalId: string) {
    setDetailLoading(true)
    try {
      setDetail(await fetchCloseoutProject(globalId))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The project could not be loaded.')
    } finally {
      setDetailLoading(false)
    }
  }

  async function refreshAfterChange(globalId?: string) {
    await reload(tab, search)
    if (globalId) await openDetail(globalId)
  }

  function startManualProject() {
    setDraftError('')
    setDraft({
      globalId: null,
      recordRevision: null,
      projectName: '',
      cityworksWoId: '',
      // Manual entry is how the Planning bulk analyses arrive, so that is the default.
      sourceOfAnalysis: dictionaries.source_of_analysis.find((label) => label === 'Planning')
        ?? dictionaries.source_of_analysis[0]
        ?? '',
      dateOfAnalysis: new Date().toISOString().slice(0, 10),
      intakeMethod: 'manual',
      assets: [newAssetRow()],
    })
  }

  function startEdit(current: CloseoutProjectDetail) {
    setDraftError('')
    setDraft(draftFromDetail(current))
  }

  async function openWorkorderChooser(workorderId: string) {
    setAttachmentWo(workorderId)
    setAttachmentResult(null)
    setAttachmentBusy(true)
    try {
      setAttachmentResult(await importWorkorderAttachment(workorderId, true))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The attachment scan failed.')
      setAttachmentWo(null)
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function importAttachment() {
    if (!attachmentWo) return
    setAttachmentBusy(true)
    try {
      const result = await importWorkorderAttachment(attachmentWo, false)
      setAttachmentResult(result)
      if (result.summary?.imported) {
        setNotice(
          `Imported ${result.summary.project_count.toLocaleString()} project`
          + `${result.summary.project_count === 1 ? '' : 's'} from ${result.selected?.file_name ?? 'the attachment'}.`,
        )
        setAttachmentWo(null)
        setCityworksOpen(false)
        setTab('pending_review')
        await reload('pending_review', search)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The attachment import failed.')
    } finally {
      setAttachmentBusy(false)
    }
  }

  async function pullCityworksWorkorder(workorderId: string) {
    setCityworksBusy(true)
    try {
      const response = await fetchCityworksWorkorderAssets(workorderId)
      setCityworksOpen(false)
      setDraftError('')
      setDraft({
        globalId: null,
        recordRevision: null,
        projectName: response.workorder.project_name ?? '',
        cityworksWoId: response.workorder.workorder_id,
        sourceOfAnalysis: dictionaries.source_of_analysis[0] ?? '',
        dateOfAnalysis:
          (response.workorder.actual_finish ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        intakeMethod: 'cityworks',
        assets: response.assets.length
          ? response.assets.map((asset) => ({ ...newAssetRow(), asset_id: asset.asset_id }))
          : [newAssetRow()],
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The work order could not be loaded.')
    } finally {
      setCityworksBusy(false)
    }
  }

  const sheetColumns = useMemo(
    () => [...sheetHeadings, ...(sheetStatus === 'all' ? ['Status'] : [])],
    [sheetHeadings, sheetStatus],
  )

  // A column offers a dropdown when it holds few enough distinct values to be a
  // category, and a text box when it is an identifier or free text.
  const sheetChoices = useMemo(() => {
    const result: Record<string, string[]> = {}
    for (const column of sheetColumns) {
      if (SHEET_UNSORTED_COLUMNS.has(column)) continue
      const values = new Set<string>()
      for (const row of sheetRows) {
        const value = String(row[column] ?? '').trim()
        if (value) values.add(value)
        if (values.size > SHEET_CHOICE_LIMIT) break
      }
      if (values.size && values.size <= SHEET_CHOICE_LIMIT) {
        result[column] = [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      }
    }
    return result
  }, [sheetRows, sheetColumns])

  const filteredSheetRows = useMemo(() => {
    const active = Object.entries(sheetFilters).filter(([, value]) => value.trim())
    if (!active.length) return sheetRows
    return sheetRows.filter((row) => active.every(([column, needle]) => {
      const value = String(row[column] ?? '').trim()
      // A dropdown picks one exact value; a text box matches anywhere, case-insensitively.
      return sheetChoices[column]
        ? value === needle
        : value.toLowerCase().includes(needle.trim().toLowerCase())
    }))
  }, [sheetRows, sheetFilters, sheetChoices])

  const sortedSheetRows = useMemo(() => {
    const { column, direction } = sheetSort
    const sign = direction === 'asc' ? 1 : -1
    return [...filteredSheetRows].sort((left, right) => {
      const a = String(left[column] ?? '').trim()
      const b = String(right[column] ?? '').trim()
      // Blanks always sink, whichever way the column is pointing - 748 rows have no
      // project name, and floating them to the top would bury the real data.
      if (!a && !b) return 0
      if (!a) return 1
      if (!b) return -1
      const leftNumber = Number(a)
      const rightNumber = Number(b)
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && a !== '' && b !== '') {
        return (leftNumber - rightNumber) * sign
      }
      // numeric:true keeps S_9 before S_10 instead of after it.
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) * sign
    })
  }, [filteredSheetRows, sheetSort])

  const sheetPageCount = Math.max(1, Math.ceil(sortedSheetRows.length / sheetPageSize))
  const sheetCurrentPage = Math.min(sheetPage, sheetPageCount - 1)
  const pagedSheetRows = useMemo(
    () => sortedSheetRows.slice(sheetCurrentPage * sheetPageSize, (sheetCurrentPage + 1) * sheetPageSize),
    [sortedSheetRows, sheetCurrentPage, sheetPageSize],
  )

  function setSheetFilter(column: string, value: string) {
    // Any filter change invalidates the page number, so go back to the first page.
    setSheetPage(0)
    setSheetFilters((current) => {
      const next = { ...current }
      if (value.trim()) next[column] = value
      else delete next[column]
      return next
    })
  }

  function workorderUrl(value: string) {
    if (!workorderUrlTemplate || !value.trim()) return null
    const encoded = encodeURIComponent(value.trim())
    return workorderUrlTemplate.replace('{id}', encoded).replace('{record_id}', encoded)
  }

  function renderWorkorderLink(value: string) {
    const href = workorderUrl(value)
    if (!href) return value
    return (
      <a
        href={href}
        className="closeout-wo-link"
        title={`Open work order ${value} in Cityworks`}
        onClick={(event) => {
          // The webview cannot navigate away, so hand the URL to the system browser.
          event.preventDefault()
          void openExternalUrl(href).catch(() => setErrorMessage(
            'The work order could not be opened in Cityworks.',
          ))
        }}
      >
        {value}
      </a>
    )
  }

  function toggleSheetSort(column: string) {
    if (SHEET_UNSORTED_COLUMNS.has(column)) return
    setSheetSort((current) => current.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      // Dates read newest-first by default; everything else reads A to Z.
      : { column, direction: column === SHEET_DATE_COLUMN ? 'desc' : 'asc' })
  }

  // Debounced so a fast typist makes one lookup, not one per keystroke.
  useEffect(() => {
    const pending = Object.entries(assetQuery).filter(([, value]) => value.trim().length >= ASSET_SEARCH_MIN)
    if (!pending.length) return
    const timer = window.setTimeout(() => {
      for (const [key, value] of pending) {
        setAssetSearching(key)
        fetchCloseoutAssetCandidates(value.trim())
          .then((response) => setAssetChoices((current) => ({ ...current, [key]: response.candidates })))
          .catch(() => setAssetChoices((current) => ({ ...current, [key]: [] })))
          .finally(() => setAssetSearching((current) => (current === key ? null : current)))
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [assetQuery])

  // Verified as the number is typed, so the answer is on screen before Submit rather
  // than arriving as a rejection afterwards.
  useEffect(() => {
    const value = (draft?.cityworksWoId ?? '').trim()
    if (!value) {
      setWorkorderCheck(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      checkCloseoutWorkorder(value)
        .then((result) => { if (!cancelled) setWorkorderCheck(result) })
        .catch(() => { if (!cancelled) setWorkorderCheck(null) })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft?.cityworksWoId])

  function anchorFor(element: HTMLElement) {
    const box = element.getBoundingClientRect()
    return { top: box.bottom + 2, left: box.left, width: box.width }
  }

  function chooseAsset(rowKey: string, assetId: string) {
    updateAsset(rowKey, { asset_id: assetId })
    setAssetQuery((current) => {
      const next = { ...current }
      delete next[rowKey]
      return next
    })
    setAssetChoices((current) => {
      const next = { ...current }
      delete next[rowKey]
      return next
    })
  }

  // A default is applied only when the dictionary actually offers it, so a renamed or
  // retired item leaves the select empty rather than showing a value it cannot match.
  function newAssetRow(): AssetDraft {
    const pick = (field: DictionaryField) => {
      const wanted = ASSET_DEFAULTS[field]
      return dictionaries[field]?.includes(wanted) ? wanted : ''
    }
    return {
      ...emptyAsset(),
      flooding_design_standards: pick('flooding_design_standards'),
      flooding_impact: pick('flooding_impact'),
      flooding_service_eligibility: pick('flooding_service_eligibility'),
      post_project_asset_condition: pick('post_project_asset_condition') || null,
    }
  }

  async function submitDraft() {
    if (!draft) return
    // Required when creating by hand only. Imported and legacy projects are allowed
    // to have no name - 748 master rows do - so editing one must not force a name in.
    if (!draft.globalId && !draft.projectName.trim()) {
      setDraftError('Project name is required.')
      return
    }
    if (draft.cityworksWoId.trim() && workorderCheck?.checked && !workorderCheck.exists) {
      setDraftError(`Work order ${draft.cityworksWoId.trim()} was not found in Cityworks.`)
      return
    }
    setDraftBusy(true)
    setDraftError('')
    const payload = {
      project_name: draft.projectName.trim() || null,
      cityworks_wo_id: draft.cityworksWoId.trim() || null,
      source_of_analysis: draft.sourceOfAnalysis,
      date_of_analysis: draft.dateOfAnalysis,
      intake_method: draft.intakeMethod,
      assets: draft.assets.map(({ key: _key, ...asset }) => ({
        ...asset,
        construction_plan_id: asset.construction_plan_id?.trim() || null,
        critical_facility_id: asset.critical_facility_id?.trim() || null,
        post_project_asset_condition: asset.post_project_asset_condition || null,
        notes: asset.notes?.trim() || null,
      })),
    }
    try {
      if (draft.globalId && draft.recordRevision) {
        const response = await updateCloseoutProject(draft.globalId, {
          ...payload,
          record_revision: draft.recordRevision,
        })
        setDraft(null)
        setNotice('Project saved and resubmitted for review.')
        await refreshAfterChange(response.project.global_id)
      } else {
        const response = await createCloseoutProject(payload)
        setDraft(null)
        setNotice('Project submitted for review.')
        setTab('pending_review')
        await refreshAfterChange(response.project.global_id)
      }
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'The project could not be saved.')
    } finally {
      setDraftBusy(false)
    }
  }

  async function review(action: 'approve' | 'return') {
    if (!detail) return
    let memo: string | null = null
    if (action === 'return') {
      memo = await appPrompt('What should the submitter fix?', {
        title: 'Return project',
        confirmLabel: 'Return',
      })
      if (memo === null || !memo.trim()) return
    } else {
      memo = await appPrompt('Review memo (optional)', {
        title: 'Approve project',
        confirmLabel: 'Approve',
      })
      if (memo === null) return
    }
    try {
      await reviewCloseoutProject(detail.project.global_id, action, detail.project.record_revision, memo)
      setNotice(action === 'approve' ? 'Project approved.' : 'Project returned to the submitter.')
      setDetail(null)
      await reload(tab, search)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The review action failed.')
    }
  }

  async function removeProject() {
    if (!detail) return
    const confirmed = await appConfirm(
      `Delete ${detail.project.display_key} and its ${detail.assets.length} assets? This also removes its review history.`,
      { title: 'Delete project', confirmLabel: 'Delete' },
    )
    if (!confirmed) return
    try {
      await deleteCloseoutProject(detail.project.global_id, detail.project.record_revision)
      setNotice('Project deleted.')
      setDetail(null)
      await reload(tab, search)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The project could not be deleted.')
    }
  }

  function toggleSelected(globalId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(globalId)) next.delete(globalId)
      else next.add(globalId)
      return next
    })
  }

  function describeBatch(result: { reviewed?: number; deleted?: number; skipped: { reason: string }[] }, verb: string) {
    const count = result.reviewed ?? result.deleted ?? 0
    let message = `${count.toLocaleString()} project${count === 1 ? '' : 's'} ${verb}.`
    if (result.skipped.length) {
      message += ` Skipped ${result.skipped.length}: ${result.skipped[0].reason}`
      if (result.skipped.length > 1) message += ` (and ${result.skipped.length - 1} more)`
    }
    return message
  }

  async function batchReview(action: 'approve' | 'return') {
    const ids = [...selectedIds]
    if (!ids.length) return
    const memo = await appPrompt(
      action === 'return' ? 'What should the submitters fix?' : 'Review memo (optional)',
      {
        title: action === 'return' ? `Return ${ids.length} projects` : `Approve ${ids.length} projects`,
        confirmLabel: action === 'return' ? 'Return' : 'Approve',
      },
    )
    if (memo === null || (action === 'return' && !memo.trim())) return
    setBatchBusy(true)
    try {
      const result = await batchReviewCloseoutProjects(action, ids, memo)
      setNotice(describeBatch(result, action === 'approve' ? 'approved' : 'returned'))
      setSelectedIds(new Set())
      setDetail(null)
      await reload(tab, search)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The batch review failed.')
    } finally {
      setBatchBusy(false)
    }
  }

  async function batchDelete() {
    const ids = [...selectedIds]
    if (!ids.length) return
    const confirmed = await appConfirm(
      `Delete ${ids.length} project${ids.length === 1 ? '' : 's'}, including their assets and review history?`,
      { title: 'Delete selected projects', confirmLabel: 'Delete' },
    )
    if (!confirmed) return
    setBatchBusy(true)
    try {
      const result = await batchDeleteCloseoutProjects(ids)
      setNotice(describeBatch(result, 'deleted'))
      setSelectedIds(new Set())
      setDetail(null)
      await reload(tab, search)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The batch delete failed.')
    } finally {
      setBatchBusy(false)
    }
  }

  async function importWorkbook(file: File, dryRun: boolean) {
    setImportBusy(true)
    setImportSummary([])
    try {
      const buffer = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < buffer.length; index += chunk) {
        binary += String.fromCharCode(...buffer.subarray(index, index + chunk))
      }
      const summary = await importCloseoutExcel({
        file_name: file.name,
        file_base64: btoa(binary),
        dry_run: dryRun,
        approve_immediately: false,
      })
      const lines = [
        `${summary.row_count.toLocaleString()} rows → ${summary.project_count.toLocaleString()} projects.`,
        ...summary.errors,
      ]
      if (summary.imported) {
        lines.unshift('Imported for review.')
        setImportOpen(false)
        setNotice(`Imported ${summary.project_count.toLocaleString()} projects from ${file.name}.`)
        setTab('pending_review')
        await reload('pending_review', search)
      } else if (!summary.errors.length && dryRun) {
        lines.unshift('Validation passed. Import again without preview to commit.')
      }
      setImportSummary(lines)
    } catch (error) {
      setImportSummary([error instanceof Error ? error.message : 'The import failed.'])
    } finally {
      setImportBusy(false)
    }
  }

  async function exportWorkbook() {
    try {
      const spreadsheet = view === 'spreadsheet'
      const file = await exportCloseoutSelection(spreadsheet
        ? {
            status: sheetStatus,
            asset_keys: sortedSheetRows.map((row) => `${row.project_global_id}|${row['Asset ID']}`),
          }
        : {
            status: tab,
            project_global_ids: matchedRows.map((row) => row.global_id),
          })
      const stamp = new Date().toISOString().slice(0, 10)
      const name = `DesignProjectCloseOutAssetTable_${stamp}.xlsx`
      if (isDesktopRuntime()) {
        await saveExportAs(name, file.bytes, 'excel')
        setNotice(`Exported ${name}.`)
      }
    } catch (error) {
      if (error instanceof Error && /cancel/i.test(error.message)) return
      setErrorMessage(error instanceof Error ? error.message : 'The export failed.')
    }
  }

  const matchedRows = useMemo(() => {
    const statusRows = rows.filter((row) => row.status === tab)
    const query = search.trim()
    if (!query) return statusRows
    return statusRows
      .map((row, index) => ({
        row,
        index,
        score: fuzzyMatchScore(
          [row.display_key, row.cityworks_wo_id, row.source_of_analysis, row.date_of_analysis]
            .filter(Boolean)
            .join(' '),
          query,
        ),
      }))
      .filter((entry): entry is { row: CloseoutProject; index: number; score: number } => entry.score !== null)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((entry) => entry.row)
  }, [rows, tab, search])
  const pageCount = Math.max(1, Math.ceil(matchedRows.length / PROJECT_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleRows = useMemo(
    () => matchedRows.slice(currentPage * PROJECT_PAGE_SIZE, (currentPage + 1) * PROJECT_PAGE_SIZE),
    [matchedRows, currentPage],
  )

  function updateAsset(key: string, patch: Partial<AssetDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            assets: current.assets.map((asset) => (asset.key === key ? { ...asset, ...patch } : asset)),
          }
        : current,
    )
  }

  return (
    <div className="closeout-page">
      <header className="closeout-header">
        <div className="closeout-header-left">
          <div>
            <h1>Design Project Close-Out</h1>
            <p>Post-project asset assessments, reviewed before they reach the master table.</p>
          </div>
          <button type="button" onClick={() => setView(view === 'projects' ? 'spreadsheet' : 'projects')}>
            {view === 'projects' ? <Table2 size={15} /> : <LayoutList size={15} />}
            {view === 'projects' ? 'Spreadsheet view' : 'Project view'}
          </button>
        </div>
        <div className="closeout-header-actions">
          {canCreate ? (
            <>
              <button type="button" onClick={startManualProject}>
                <Plus size={15} /> New project
              </button>
              <button type="button" onClick={() => { setImportSummary([]); setImportOpen(true) }}>
                <FileUp size={15} /> Import Excel
              </button>
              <button type="button" onClick={() => { setCityworksRows([]); setCityworksQuery(''); setCityworksOpen(true) }}>
                <Wrench size={15} /> From Cityworks
              </button>
            </>
          ) : null}
          <button type="button" onClick={() => void exportWorkbook()}>
            <Download size={15} /> Export{' '}
            {view === 'spreadsheet'
              ? `${sortedSheetRows.length.toLocaleString()} row${sortedSheetRows.length === 1 ? '' : 's'}`
              : `${matchedRows.length.toLocaleString()} project${matchedRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </header>

      {notice ? (
        <div className="closeout-notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice('')}><X size={14} /></button>
        </div>
      ) : null}
      {errorMessage ? (
        <div className="closeout-error" role="alert">
          {errorMessage}
          <button type="button" aria-label="Dismiss" onClick={() => setErrorMessage('')}><X size={14} /></button>
        </div>
      ) : null}

      {view === 'spreadsheet' ? (
        <nav className="closeout-tabs" aria-label="Spreadsheet filter">
          <label className="closeout-sheet-filter">
            <span>Status</span>
            <select
              value={sheetStatus}
              onChange={(event) => setSheetStatus(event.currentTarget.value as CloseoutStatus | 'all')}
            >
              <option value="all">All</option>
              <option value="approved">Approved</option>
              <option value="pending_review">Pending review</option>
              <option value="returned">Returned</option>
            </select>
          </label>
          <span className="closeout-sheet-count">
            {sheetRows.length.toLocaleString()} row{sheetRows.length === 1 ? '' : 's'}
          </span>
        </nav>
      ) : (
      <nav className="closeout-tabs" aria-label="Project status">
        {(Object.keys(STATUS_LABELS) as CloseoutStatus[]).map((value) => (
          <button
            type="button"
            key={value}
            className={tab === value ? 'active' : ''}
            onClick={() => { setTab(value); setDetail(null) }}
          >
            {STATUS_LABELS[value]}
            <span className="closeout-count">{statusCounts[value]}</span>
          </button>
        ))}
        <div className="closeout-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Project name or WO number"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <button type="button" className="closeout-refresh" onClick={() => reload(tab, search)} aria-label="Refresh">
          <RefreshCw size={15} />
        </button>
      </nav>
      )}

      {selectedIds.size > 0 && view === 'projects' ? (
        <div className="closeout-batch-bar" role="toolbar" aria-label="Batch actions">
          <strong>{selectedIds.size.toLocaleString()} selected</strong>
          {canReviewSelection ? (
            <>
              {tab === 'pending_review' ? (
                <button type="button" className="approve" disabled={batchBusy} onClick={() => batchReview('approve')}>
                  <Check size={14} /> Approve selected
                </button>
              ) : null}
              {tab !== 'returned' ? (
                <button type="button" disabled={batchBusy} onClick={() => batchReview('return')}>
                  <CornerUpLeft size={14} /> {tab === 'approved' ? 'Return to edit' : 'Return selected'}
                </button>
              ) : null}
            </>
          ) : null}
          {canDelete ? (
            <button type="button" className="danger" disabled={batchBusy} onClick={batchDelete}>
              <Trash2 size={14} /> Delete selected
            </button>
          ) : null}
          <button type="button" disabled={batchBusy} onClick={() => setSelectedIds(new Set())}>
            Clear
          </button>
          {batchBusy ? <Loader2 className="spin" size={15} /> : null}
        </div>
      ) : null}

      {view === 'spreadsheet' ? (
        <section className="closeout-sheet-wrap" aria-label="Spreadsheet">
          {sheetLoading ? (
            <p className="closeout-empty"><Loader2 className="spin" size={16} /> Loading rows…</p>
          ) : (
            <table className="closeout-sheet">
              <thead>
                <tr>
                  {[...sheetHeadings, ...(sheetStatus === 'all' ? ['Status'] : [])].map((heading) => (
                    SHEET_UNSORTED_COLUMNS.has(heading) ? (
                      <th key={heading}><span className="closeout-sheet-plain">{heading}</span></th>
                    ) : (
                      <th key={heading} aria-sort={sheetSort.column === heading
                        ? (sheetSort.direction === 'asc' ? 'ascending' : 'descending')
                        : 'none'}>
                        <button type="button" onClick={() => toggleSheetSort(heading)}>
                          {heading}
                          <span aria-hidden="true">
                            {sheetSort.column === heading ? (sheetSort.direction === 'asc' ? '▲' : '▼') : ''}
                          </span>
                        </button>
                      </th>
                    )
                  ))}
                </tr>
                <tr className="closeout-sheet-filters">
                  {sheetColumns.map((heading) => (
                    <th key={heading}>
                      {SHEET_UNSORTED_COLUMNS.has(heading) ? null : sheetChoices[heading] ? (
                        <select
                          value={sheetFilters[heading] ?? ''}
                          onChange={(event) => setSheetFilter(heading, event.currentTarget.value)}
                        >
                          <option value="">All</option>
                          {sheetChoices[heading].map((choice) => (
                            <option key={choice} value={choice}>{choice}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="search"
                          placeholder="Filter"
                          value={sheetFilters[heading] ?? ''}
                          onChange={(event) => setSheetFilter(heading, event.currentTarget.value)}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedSheetRows.map((row, index) => (
                  <tr key={`${row.project_global_id}-${row['Asset ID']}-${index}`}>
                    {sheetHeadings.map((heading) => {
                      const value = String(row[heading] ?? '')
                      return (
                        <td key={heading} title={value}>
                          {heading === SHEET_WORKORDER_COLUMN ? renderWorkorderLink(value) : value}
                        </td>
                      )
                    })}
                    {sheetStatus === 'all' ? (
                      <td>{STATUS_LABELS[row.Status] ?? row.Status}</td>
                    ) : null}
                  </tr>
                ))}
                {!pagedSheetRows.length ? (
                  <tr><td colSpan={sheetColumns.length}>No rows match these filters.</td></tr>
                ) : null}
              </tbody>
            </table>
          )}
          {!sheetLoading && (
            <div className="closeout-pager closeout-sheet-pager">
              <div>
                <button type="button" disabled={sheetCurrentPage === 0} onClick={() => setSheetPage(sheetCurrentPage - 1)}>
                  Previous
                </button>
                <button
                  type="button"
                  disabled={sheetCurrentPage >= sheetPageCount - 1}
                  onClick={() => setSheetPage(sheetCurrentPage + 1)}
                >
                  Next
                </button>
              </div>
              <span>
                Page {sheetCurrentPage + 1} of {sheetPageCount} ·{' '}
                {sortedSheetRows.length.toLocaleString()} of {sheetRows.length.toLocaleString()} rows
                {Object.keys(sheetFilters).length ? ' (filtered)' : ''}
              </span>
              <div className="closeout-sheet-pagesize">
                {Object.keys(sheetFilters).length ? (
                  <button type="button" onClick={() => { setSheetFilters({}); setSheetPage(0) }}>Clear filters</button>
                ) : null}
                <label>
                  Rows
                  <select
                    value={sheetPageSize}
                    onChange={(event) => { setSheetPageSize(Number(event.currentTarget.value)); setSheetPage(0) }}
                  >
                    {SHEET_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
              </div>
            </div>
          )}
        </section>
      ) : (
      <div className="closeout-workspace">
        <section className="closeout-list" aria-label="Projects">
          {matchedRows.length ? (
            <label className="closeout-select-all">
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && matchedRows.every((row) => selectedIds.has(row.global_id))}
                onChange={(event) => {
                  setSelectedIds(event.currentTarget.checked
                    ? new Set(matchedRows.map((row) => row.global_id))
                    : new Set())
                }}
              />
              <span>
                {selectedIds.size
                  ? `${selectedIds.size.toLocaleString()} of ${matchedRows.length.toLocaleString()} selected`
                  : `Select all ${matchedRows.length.toLocaleString()}`}
              </span>
            </label>
          ) : null}
          {loading ? <p className="closeout-empty"><Loader2 className="spin" size={16} /> Loading projects…</p> : null}
          {!loading && !visibleRows.length ? (
            <p className="closeout-empty">No {STATUS_LABELS[tab].toLowerCase()} projects.</p>
          ) : null}
          {visibleRows.map((row) => (
            <div
              key={row.global_id}
              className={`closeout-project-row ${detail?.project.global_id === row.global_id ? 'active' : ''} ${selectedIds.has(row.global_id) ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                aria-label={`Select ${row.display_key}`}
                checked={selectedIds.has(row.global_id)}
                onChange={() => toggleSelected(row.global_id)}
              />
              <button type="button" onClick={() => openDetail(row.global_id)}>
              <strong>{row.display_key}</strong>
              <span className="closeout-project-meta">
                {row.source_of_analysis} · {formatDate(row.date_of_analysis)}
                {row.cityworks_wo_id ? ` · WO ${row.cityworks_wo_id}` : ''}
                {' · '}{row.asset_count ?? 0} asset{(row.asset_count ?? 0) === 1 ? '' : 's'} · {row.submitted_by ?? '—'}
              </span>
              </button>
            </div>
          ))}
          {matchedRows.length > PROJECT_PAGE_SIZE ? (
            <div className="closeout-pager">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </button>
              <span>
                Page {currentPage + 1} of {pageCount} · {matchedRows.length.toLocaleString()} projects
              </span>
              <button
                type="button"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          ) : null}
        </section>

        <section className="closeout-detail" aria-label="Project detail">
          {detailLoading ? <p className="closeout-empty"><Loader2 className="spin" size={16} /> Loading…</p> : null}
          {!detailLoading && !detail ? (
            <p className="closeout-empty">Select a project to see its assets and history.</p>
          ) : null}
          {detail && !detailLoading ? (
            <>
              <header className="closeout-detail-header">
                <div>
                  <h2>{detail.project.display_key}</h2>
                  <p>
                    {STATUS_LABELS[detail.project.status]} · submitted {formatDate(detail.project.submitted_at)} by{' '}
                    {detail.project.submitted_by ?? '—'}
                    {detail.project.reviewed_by
                      ? ` · reviewed ${formatDate(detail.project.reviewed_at)} by ${detail.project.reviewed_by}`
                      : ''}
                  </p>
                  {detail.project.review_memo ? (
                    <p className="closeout-memo">Review memo: {detail.project.review_memo}</p>
                  ) : null}
                </div>
                <div className="closeout-detail-actions">
                  {detail.can_review && detail.project.status === 'pending_review' ? (
                    <button type="button" className="approve" onClick={() => review('approve')}>
                      <Check size={15} /> Approve
                    </button>
                  ) : null}
                  {detail.can_review && detail.project.status !== 'returned' ? (
                    <button type="button" onClick={() => review('return')}>
                      <CornerUpLeft size={15} /> {detail.project.status === 'approved' ? 'Return to edit' : 'Return'}
                    </button>
                  ) : null}
                  {detail.can_edit ? (
                    <button type="button" onClick={() => startEdit(detail)}>
                      <Pencil size={15} /> Edit
                    </button>
                  ) : null}
                  {detail.can_delete ? (
                    <button type="button" className="danger" onClick={removeProject}>
                      <Trash2 size={15} /> Delete
                    </button>
                  ) : null}
                </div>
              </header>
              <div className="closeout-asset-table-wrap">
                <table className="closeout-asset-table">
                  <thead>
                    <tr>
                      <th>Asset ID</th>
                      <th>Plan ID</th>
                      <th>Design Standards</th>
                      <th>Impact</th>
                      <th>Service Eligibility</th>
                      <th>Condition</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.assets.map((asset) => (
                      <tr key={asset.global_id ?? asset.asset_id}>
                        <td>{asset.asset_id}</td>
                        <td>{asset.construction_plan_id ?? '—'}</td>
                        <td>{asset.flooding_design_standards ?? '—'}</td>
                        <td>{asset.flooding_impact ?? '—'}</td>
                        <td>{asset.flooding_service_eligibility ?? '—'}</td>
                        <td>{asset.post_project_asset_condition ?? '—'}</td>
                        <td className="closeout-notes-cell">{asset.notes ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      </div>
      )}

      {draft ? (
        <div className="closeout-dialog-backdrop" role="presentation" onClick={() => (draftBusy ? null : setDraft(null))}>
          <div className="closeout-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{draft.globalId ? 'Edit project' : 'New close-out project'}</strong>
              <button type="button" aria-label="Close" onClick={() => setDraft(null)}><X size={16} /></button>
            </header>
            <div className="closeout-dialog-body">
              <div className="closeout-field-row">
                <label>
                  <span>Project name{draft.globalId ? '' : ' *'}</span>
                  <input
                    value={draft.projectName}
                    onChange={(event) => setDraft({ ...draft, projectName: event.currentTarget.value })}
                    placeholder={draft.globalId ? 'Optional for Planning analyses' : 'Required'}
                    required={!draft.globalId}
                  />
                </label>
                {draft.cityworksWoId.trim() ? (
                  <label>
                    <span>Cityworks WO</span>
                    <input value={draft.cityworksWoId} readOnly />
                    {workorderCheck ? (
                      workorderCheck.exists ? (
                        <small className="closeout-wo-ok">
                          {workorderCheck.checked
                            ? `Found${workorderCheck.project_name ? `: ${workorderCheck.project_name}` : ''}`
                            : 'Cityworks mirror unavailable - not verified'}
                        </small>
                      ) : (
                        <small className="closeout-wo-bad">Not found in Cityworks</small>
                      )
                    ) : null}
                  </label>
                ) : null}
                <label>
                  <span>Source of analysis</span>
                  <select
                    value={draft.sourceOfAnalysis}
                    onChange={(event) => setDraft({ ...draft, sourceOfAnalysis: event.currentTarget.value })}
                  >
                    {dictionaries.source_of_analysis.map((label) => (
                      <option key={label} value={label}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Date of analysis</span>
                  <input
                    type="date"
                    value={draft.dateOfAnalysis}
                    onChange={(event) => setDraft({ ...draft, dateOfAnalysis: event.currentTarget.value })}
                  />
                </label>
              </div>

              <div className="closeout-draft-assets">
                <div className="closeout-draft-assets-header">
                  <strong>Assets ({draft.assets.length})</strong>
                  <button type="button" onClick={() => setDraft({ ...draft, assets: [...draft.assets, newAssetRow()] })}>
                    <Plus size={14} /> Add asset
                  </button>
                </div>
                <div className="closeout-draft-asset-grid">
                  <table className="closeout-draft-table">
                    <thead>
                      <tr>
                        <th>Asset ID</th>
                        <th>Plan ID</th>
                        <th>Design standards</th>
                        <th>Impact</th>
                        <th>Service eligibility</th>
                        <th>Condition</th>
                        <th>Notes</th>
                        <th aria-label="Remove" />
                      </tr>
                    </thead>
                    <tbody>
                      {draft.assets.map((asset) => (
                        <tr key={asset.key}>
                          <td>
                            <div className="closeout-asset-picker">
                              {asset.asset_id ? (
                                <div className="closeout-asset-chosen">
                                  <span title={asset.asset_id}>{asset.asset_id}</span>
                                  <button
                                    type="button"
                                    aria-label={`Clear ${asset.asset_id}`}
                                    onClick={() => chooseAsset(asset.key, '')}
                                  >
                                    <X size={12} />
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <input
                                    type="search"
                                    value={assetQuery[asset.key] ?? ''}
                                    placeholder={`Search (${ASSET_SEARCH_MIN}+)…`}
                                    autoComplete="off"
                                    role="combobox"
                                    aria-expanded={Boolean(assetChoices[asset.key]?.length)}
                                    maxLength={ASSET_ID_MAX}
                                    onFocus={(event) => setAssetAnchor(anchorFor(event.currentTarget))}
                                    onBlur={() => window.setTimeout(() => setAssetAnchor(null), 150)}
                                    onChange={(event) => {
                                      // Read from currentTarget before the updater runs: React
                                      // nulls it once the handler returns, and a functional
                                      // setState updater can be invoked after that.
                                      const value = event.currentTarget.value.slice(0, ASSET_ID_MAX)
                                      setAssetAnchor(anchorFor(event.currentTarget))
                                      setAssetQuery((current) => ({ ...current, [asset.key]: value }))
                                    }}
                                  />
                                  {(assetQuery[asset.key] ?? '').trim() && assetAnchor ? (
                                    <div
                                      className="closeout-asset-options"
                                      role="listbox"
                                      style={{ top: assetAnchor.top, left: assetAnchor.left, minWidth: assetAnchor.width }}
                                      onMouseDown={(event) => event.preventDefault()}
                                    >
                                      {(assetQuery[asset.key] ?? '').trim().length < ASSET_SEARCH_MIN ? (
                                        <p>Type at least {ASSET_SEARCH_MIN} characters.</p>
                                      ) : assetSearching === asset.key && !assetChoices[asset.key]?.length ? (
                                        <p>Searching…</p>
                                      ) : assetChoices[asset.key]?.length ? (
                                        assetChoices[asset.key].map((candidate) => (
                                          <button
                                            type="button"
                                            role="option"
                                            aria-selected="false"
                                            key={candidate.asset_id}
                                            onClick={() => chooseAsset(asset.key, candidate.asset_id)}
                                          >
                                            <strong>{candidate.asset_id}</strong>
                                            {candidate.subtitle ? <span>{candidate.subtitle}</span> : null}
                                          </button>
                                        ))
                                      ) : (
                                        <p>No matching asset in the inventory.</p>
                                      )}
                                    </div>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </td>
                          <td>
                            <input
                              value={asset.construction_plan_id ?? ''}
                              onChange={(event) => updateAsset(asset.key, { construction_plan_id: event.currentTarget.value || null })}
                            />
                          </td>
                          <td>
                            <select
                              value={asset.flooding_design_standards}
                              onChange={(event) => updateAsset(asset.key, { flooding_design_standards: event.currentTarget.value })}
                            >
                              <option value="">Select…</option>
                              {dictionaries.flooding_design_standards.map((label) => (
                                <option key={label} value={label}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              value={asset.flooding_impact}
                              onChange={(event) => updateAsset(asset.key, { flooding_impact: event.currentTarget.value })}
                            >
                              <option value="">Select…</option>
                              {dictionaries.flooding_impact.map((label) => (
                                <option key={label} value={label}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              value={asset.flooding_service_eligibility}
                              onChange={(event) => updateAsset(asset.key, { flooding_service_eligibility: event.currentTarget.value })}
                            >
                              <option value="">Select…</option>
                              {dictionaries.flooding_service_eligibility.map((label) => (
                                <option key={label} value={label}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              value={asset.post_project_asset_condition ?? ''}
                              onChange={(event) => updateAsset(asset.key, { post_project_asset_condition: event.currentTarget.value || null })}
                            >
                              <option value="">—</option>
                              {dictionaries.post_project_asset_condition.map((label) => (
                                <option key={label} value={label}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <textarea
                              rows={1}
                              value={asset.notes ?? ''}
                              placeholder="Required if the asset fails design standards"
                              onChange={(event) => updateAsset(asset.key, { notes: event.currentTarget.value || null })}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="closeout-row-remove"
                              aria-label={`Remove ${asset.asset_id || 'asset'}`}
                              onClick={() => setDraft({ ...draft, assets: draft.assets.filter((row) => row.key !== asset.key) })}
                              disabled={draft.assets.length === 1}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {draftError ? <p className="closeout-dialog-error">{draftError}</p> : null}
              <div className="closeout-dialog-actions">
                <button type="button" onClick={() => setDraft(null)} disabled={draftBusy}>Cancel</button>
                <button
                  type="button"
                  className="primary"
                  onClick={submitDraft}
                  disabled={draftBusy || (!draft.globalId && !draft.projectName.trim())}
                >
                  {draftBusy ? 'Saving…' : draft.globalId ? 'Save and resubmit' : 'Submit for review'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {importOpen ? (
        <div className="closeout-dialog-backdrop" role="presentation" onClick={() => (importBusy ? null : setImportOpen(false))}>
          <div className="closeout-dialog narrow" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Import from the Excel template</strong>
              <button type="button" aria-label="Close" onClick={() => setImportOpen(false)}><X size={16} /></button>
            </header>
            <div className="closeout-dialog-body">
              <p className="closeout-hint">
                <FileSpreadsheet size={15} /> The workbook must use the close-out Template sheet columns.
                Rows are grouped into projects by project name, WO, source, and date.
              </p>
              <div className="closeout-import-buttons">
                <label className="closeout-file-button">
                  {importBusy ? <Loader2 className="spin" size={15} /> : <FileUp size={15} />} Validate only
                  <input
                    type="file"
                    accept=".xlsx"
                    disabled={importBusy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      if (file) void importWorkbook(file, true)
                    }}
                  />
                </label>
                <label className="closeout-file-button primary">
                  {importBusy ? <Loader2 className="spin" size={15} /> : <FileUp size={15} />} Import
                  <input
                    type="file"
                    accept=".xlsx"
                    disabled={importBusy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      if (file) void importWorkbook(file, false)
                    }}
                  />
                </label>
              </div>
              {importSummary.length ? (
                <>
                  <div className="closeout-import-summary-header">
                    <strong>
                      {importSummary.length.toLocaleString()} line{importSummary.length === 1 ? '' : 's'}
                    </strong>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(importSummary.join('\n'))
                          setNotice('QA/QC issues copied to the clipboard.')
                        } catch {
                          setErrorMessage('The clipboard is not available.')
                        }
                      }}
                    >
                      <Copy size={13} /> Copy issues
                    </button>
                  </div>
                  <ul className="closeout-import-summary">
                    {importSummary.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {attachmentWo ? (
        <div className="closeout-dialog-backdrop elevated" role="presentation" onClick={() => (attachmentBusy ? null : setAttachmentWo(null))}>
          <div className="closeout-dialog narrow" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Start close-out for WO {attachmentWo}</strong>
              <button type="button" aria-label="Close" onClick={() => setAttachmentWo(null)}><X size={16} /></button>
            </header>
            <div className="closeout-dialog-body">
              {attachmentBusy && !attachmentResult ? (
                <p className="closeout-empty"><Loader2 className="spin" size={15} /> Checking the work order attachments…</p>
              ) : null}
              {attachmentResult ? (
                <>
                  {attachmentResult.selected ? (
                    <div className="closeout-attachment-pick">
                      <p className="closeout-hint">
                        <FileSpreadsheet size={15} />
                        <span>
                          <strong>{attachmentResult.selected.file_name}</strong>
                          {' · attached '}{formatDate(attachmentResult.selected.attached_at)}
                          {attachmentResult.selected.attached_by ? ` by ${attachmentResult.selected.attached_by}` : ''}
                        </span>
                      </p>
                      {attachmentResult.summary ? (
                        <p className="closeout-hint">
                          {attachmentResult.summary.row_count.toLocaleString()} rows →{' '}
                          {attachmentResult.summary.project_count.toLocaleString()} project
                          {attachmentResult.summary.project_count === 1 ? '' : 's'}
                          {attachmentResult.summary.errors.length
                            ? ` · ${attachmentResult.summary.errors.length.toLocaleString()} QA/QC issues`
                            : ' · QA/QC passed'}
                        </p>
                      ) : null}
                      {attachmentResult.summary?.errors.length ? (
                        <>
                          <div className="closeout-import-summary-header">
                            <strong>QA/QC issues</strong>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText((attachmentResult.summary?.errors ?? []).join(String.fromCharCode(10)))
                                  setNotice('QA/QC issues copied to the clipboard.')
                                } catch {
                                  setErrorMessage('The clipboard is not available.')
                                }
                              }}
                            >
                              <Copy size={13} /> Copy issues
                            </button>
                          </div>
                          <ul className="closeout-import-summary">
                            {attachmentResult.summary.errors.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
                          </ul>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="closeout-file-button primary"
                        disabled={attachmentBusy || Boolean(attachmentResult.summary?.errors.length)}
                        onClick={importAttachment}
                      >
                        {attachmentBusy ? <Loader2 className="spin" size={15} /> : <FileUp size={15} />}
                        Import the attached Excel
                      </button>
                    </div>
                  ) : (
                    <div className="closeout-attachment-pick">
                      <p className="closeout-hint">No eligible close-out Excel is attached to this work order.</p>
                      {attachmentResult.candidates.length ? (
                        <ul className="closeout-import-summary">
                          {attachmentResult.candidates.map((candidate) => (
                            <li key={candidate.image_path}>{candidate.file_name}: {candidate.reason}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="closeout-empty">The work order has no attachments.</p>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="closeout-file-button"
                    disabled={attachmentBusy}
                    onClick={() => {
                      const workorderId = attachmentWo
                      setAttachmentWo(null)
                      if (workorderId) void pullCityworksWorkorder(workorderId)
                    }}
                  >
                    <Wrench size={15} /> Pull the assets and fill in the assessments manually
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {cityworksOpen ? (
        <div className="closeout-dialog-backdrop" role="presentation" onClick={() => setCityworksOpen(false)}>
          <div className="closeout-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Closed and completed work orders</strong>
              <button type="button" aria-label="Close" onClick={() => setCityworksOpen(false)}><X size={16} /></button>
            </header>
            <div className="closeout-dialog-body">
              <div className="closeout-wo-modes" role="group" aria-label="Pull work orders by">
                <button
                  type="button"
                  className={cityworksMode === 'closed_date' ? 'active' : ''}
                  onClick={() => setCityworksMode('closed_date')}
                >
                  By finish date
                </button>
                <button
                  type="button"
                  className={cityworksMode === 'workorder' ? 'active' : ''}
                  onClick={() => setCityworksMode('workorder')}
                >
                  By work order number
                </button>
                {cityworksMode === 'closed_date' ? (
                  <label className="closeout-wo-date">
                    <span>Closed on or after</span>
                    <input
                      type="date"
                      value={cityworksDate}
                      onChange={(event) => setCityworksDate(event.currentTarget.value)}
                    />
                  </label>
                ) : (
                  <div className="closeout-search wide">
                    <Search size={15} aria-hidden="true" />
                    <input
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={WORKORDER_ID_MAX_DIGITS}
                      placeholder={`Work order number (up to ${WORKORDER_ID_MAX_DIGITS} digits)`}
                      value={cityworksQuery}
                      onChange={(event) => {
                        // Digits only, and never longer than a real work order id.
                        const value = event.currentTarget.value.replace(/\D+/g, '').slice(0, WORKORDER_ID_MAX_DIGITS)
                        setCityworksQuery(value)
                      }}
                    />
                  </div>
                )}
              </div>
              {errorMessage ? <p className="closeout-dialog-error">{errorMessage}</p> : null}
              <p className="closeout-hint">
                {cityworksMode === 'workorder' && cityworksQuery.trim()
                  ? `${cityworksRows.length.toLocaleString()} closed design work orders match.`
                  : cityworksMode === 'closed_date' && cityworksDate
                    ? `${cityworksRows.length.toLocaleString()} closed since ${cityworksDate}.`
                    : cityworksCutoff
                      ? `Design Team Project, Repair, Street Maintenance and Universal work orders finished after the latest analysis in the database (${cityworksCutoff}) and not yet closed out.`
                      : 'All closed Design Team Project work orders.'}
              </p>
              {cityworksBusy ? <p className="closeout-empty"><Loader2 className="spin" size={15} /> Loading…</p> : null}
              {!cityworksBusy ? (
                <div className="closeout-workorder-table-wrap">
                  <table className="closeout-sheet">
                    <thead>
                      <tr>
                        <th>WO</th>
                        <th>Closed</th>
                        <th>Project name</th>
                        <th>Storm assets</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {cityworksRows.map((row) => (
                        <tr key={row.workorder_id}>
                          <td>{renderWorkorderLink(row.workorder_id)}</td>
                          <td>{row.date_wo_closed ?? '—'}</td>
                          <td>{row.project_name || '—'}</td>
                          <td>{row.storm_asset_count}</td>
                          <td>
                            <button
                              type="button"
                              className="closeout-workorder-use"
                              onClick={() => openWorkorderChooser(row.workorder_id)}
                            >
                              Start close-out
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!cityworksRows.length ? (
                        <tr>
                          <td colSpan={5}>
                            {cityworksQuery.trim()
                              ? 'No closed design work order matches.'
                              : 'No closed design work orders newer than the latest analysis in the database.'}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
