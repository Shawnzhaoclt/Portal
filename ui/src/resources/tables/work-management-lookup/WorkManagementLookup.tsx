import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardList, ExternalLink, LoaderCircle, Search, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { openExternalUrl } from '../../../desktop/runtime'
import { openPortalResource } from '../../../lib/portalNavigation'
import {
  fetchRecord,
  portalAssetType,
  searchRecords,
  type PortalAssetType,
  type RecordDetail,
  type RecordKind,
  type RecordSummary,
} from './api'
import './WorkManagementLookup.css'

const KIND_ORDER: RecordKind[] = ['service_request', 'inspection', 'investigation', 'work_order']
const KIND_LABELS: Record<RecordKind, string> = {
  service_request: 'Service requests',
  inspection: 'Inspections',
  investigation: 'Investigations',
  work_order: 'Work orders',
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The lookup failed.'
}

/** Carries the asset through, and marks the visit as coming from the map so a
 * reader who reaches Asset History this way inherits the map's access. */
function openAssetHistory(assetId: string, assetType: PortalAssetType) {
  const query = new URLSearchParams({ assetId, assetType, returnTo: 'map' })
  openPortalResource(`/asset-history?${query}`)
}

/** A plain anchor does nothing inside the desktop webview: it refuses to
 * navigate away and opens no window. The host has to be asked. */
function openCityworks(url: string) {
  void openExternalUrl(url).catch((error: unknown) =>
    toast.error(error instanceof Error ? error.message : 'Cityworks could not be opened.'),
  )
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return value
}

export default function WorkManagementLookup({ embedded = false }: { embedded?: boolean } = {}) {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<RecordSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const searchToken = useRef(0)

  const open = useCallback(async (kind: RecordKind, id: string) => {
    setBusy(true)
    try {
      setDetail(await fetchRecord(kind, id))
      setCandidates([])
      setQuery('')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }, [])

  // Search as the reader types, the way the map's asset search does. The token
  // keeps a slow response from overwriting the answer to a later keystroke.
  useEffect(() => {
    const wanted = query.trim()
    if (wanted.length < 2) {
      setCandidates([])
      setSearching(false)
      return
    }
    const token = ++searchToken.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      searchRecords(wanted)
        .then((response) => {
          if (searchToken.current !== token) return
          setCandidates(response.matches || [])
        })
        .catch((error: unknown) => {
          if (searchToken.current !== token) return
          setCandidates([])
          toast.error(errorText(error))
        })
        .finally(() => {
          if (searchToken.current === token) setSearching(false)
        })
    }, 260)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!embedded) document.title = 'Work Management Lookup'
  }, [embedded])

  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    rows: (detail?.related || []).filter((item) => item.kind === kind),
  })).filter((group) => group.rows.length > 0)

  return (
    <div className={embedded ? 'work-lookup work-lookup--embedded' : 'work-lookup'}>
      {embedded ? null : (
        <header className="work-lookup__header">
          <div>
            <p className="work-lookup__eyebrow">Cityworks</p>
            <h1>Work Management Lookup</h1>
            <p className="work-lookup__lede">
              Start from a record number and see the asset it concerned and every request, inspection,
              investigation and work order linked to it.
            </p>
          </div>
        </header>
      )}

      <div className="work-lookup__search">
        <label className="work-lookup__search-control">
          <Search size={19} />
          <input
            autoFocus
            type="text"
            placeholder="Service request, work order, inspection or investigation ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {searching || busy ? <LoaderCircle className="spin" size={18} /> : null}
        </label>
        {candidates.length ? (
          <div className="work-lookup__candidates" role="listbox">
            {candidates.map((match) => (
              <button
                key={`${match.kind}-${match.id}`}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => void open(match.kind, match.id)}
              >
                <span className={`work-lookup__kind work-lookup__kind--${match.kind}`}>{match.kind_label}</span>
                <strong>{match.id}</strong>
                <span className="work-lookup__candidate-title">{match.title || 'No description'}</span>
                <small>{match.subtitle || ''}</small>
                <small className="work-lookup__candidate-meta">
                  {match.status || 'No status'} · {formatDate(match.opened_at)}
                </small>
              </button>
            ))}
          </div>
        ) : query.trim().length >= 2 && !searching ? (
          <p className="work-lookup__empty">No record matches that number, problem or address.</p>
        ) : null}
      </div>

      {detail ? (
        <>
          <section className="work-lookup__panel work-lookup__record">
            <header>
              <div>
                <p className="work-lookup__eyebrow">{detail.record.kind_label}</p>
                <h2>
                  {detail.record.id}
                  {detail.record.title ? <span> · {detail.record.title}</span> : null}
                </h2>
              </div>
              {detail.record.cityworks_url ? (
                <button type="button" className="button" onClick={() => openCityworks(detail.record.cityworks_url!)}>
                  <ExternalLink size={15} /> Open in Cityworks
                </button>
              ) : null}
            </header>
            <div className="work-lookup__facts">
              <div><span>Status</span><strong>{detail.record.status || '—'}</strong></div>
              <div><span>Opened</span><strong>{formatDate(detail.record.opened_at)}</strong></div>
              <div><span>Closed</span><strong>{formatDate(detail.record.closed_at)}</strong></div>
              <div><span>Linked records</span><strong>{detail.related.length}</strong></div>
            </div>
          </section>

          <div className="work-lookup__detail">
          <section className="work-lookup__panel">
            <header>
              <h2><Wrench size={16} /> Assets</h2>
              <p>
                {detail.assets.length
                  ? 'Every pipe, structure and channel reached through this record.'
                  : detail.record.kind === 'service_request'
                    ? 'A service request carries no asset of its own. It reaches assets through the inspections and work orders raised from it, and none of those name a pipe, structure or channel.'
                    : 'This record names no pipe, structure or channel. Cityworks may still have attached it to a parcel, culvert or inventory area.'}
              </p>
            </header>
            {detail.assets.length ? (
              <table className="work-lookup__table">
                <thead>
                  <tr><th>Asset</th><th>Type</th><th>Reached by</th><th /></tr>
                </thead>
                <tbody>
                  {detail.assets.map((asset) => {
                    const historyType = portalAssetType(asset.asset_type)
                    return (
                      <tr key={`${asset.asset_type}-${asset.asset_id}`}>
                        <td><strong>{asset.asset_id}</strong></td>
                        <td>{asset.asset_type || '—'}</td>
                        <td>{asset.reached_by}</td>
                        <td className="work-lookup__actions">
                          {historyType ? (
                            <button
                              type="button"
                              className="table-link"
                              onClick={() => openAssetHistory(asset.asset_id, historyType)}
                            >
                              Asset history
                            </button>
                          ) : (
                            <span
                              className="work-lookup__muted"
                              title="Asset History covers structures, pipes and channels."
                            >
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : null}
          </section>

          <div className="work-lookup__groups">
          {grouped.map((group) => (
            <section className="work-lookup__panel" key={group.kind}>
              <header>
                <h2><ClipboardList size={16} /> {group.label}</h2>
                <p>{group.rows.length} linked to this record.</p>
              </header>
              <table className="work-lookup__table">
                <thead>
                  <tr><th>Number</th><th>Description</th><th>Status</th><th>Opened</th><th>Why it is here</th><th /></tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.kind}-${row.id}`} className={row.available ? undefined : 'is-reference'}>
                      <td><strong>{row.id}</strong></td>
                      <td>
                        {row.title || (row.available ? '—' : 'Not held in Portal’s copy of Cityworks')}
                      </td>
                      <td>{row.status || '—'}</td>
                      <td>{formatDate(row.opened_at)}</td>
                      <td>{row.link_reason || '—'}</td>
                      <td className="work-lookup__actions">
                        {row.available ? (
                          <button type="button" className="table-link" onClick={() => void open(row.kind, row.id)}>
                            Open
                          </button>
                        ) : null}
                        {row.cityworks_url ? (
                          <button type="button" className="table-link" onClick={() => openCityworks(row.cityworks_url!)}>
                            Cityworks
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          </div>
          </div>

          {detail.counts.not_in_portal ? (
            <p className="work-lookup__note">
              {detail.counts.not_in_portal} linked record
              {detail.counts.not_in_portal === 1 ? ' is' : 's are'} referenced by Cityworks but not held in
              Portal’s copy, which mirrors a filtered slice of the work-management database. Their numbers and
              Cityworks links are still shown.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
