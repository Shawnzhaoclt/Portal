import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ClipboardList, Database, Download, Filter, LoaderCircle, MapPinned, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { openFileLocation } from "../../../desktop/runtime";

import {
  exportAssetExtract,
  fetchAssetExtractCatalog,
  previewAssetExtract,
  resolveAssetExtractBoundaries,
  searchAssetExtractBoundaries,
  type AssetExtractArea,
  type AssetExtractAssetType,
  type AssetExtractAssignmentState,
  type AssetExtractBoundaryCandidate,
  type AssetExtractCatalog,
  type AssetExtractFilter,
  type AssetExtractOperator,
  type AssetExtractPayload,
  type AssetExtractPreview,
  type AssetExtractRelatedKey,
  type AssetExtractSelectedAsset,
  type AssetExtractTypeCatalog,
} from "./assetExtract";
// The lookup already answers to this map's View permission, so the same search
// and record reader serve here rather than a second copy behind a new endpoint.
import {
  fetchRecord,
  portalAssetType,
  searchRecords,
  type RecordKind,
  type RecordSummary,
} from "../../tables/work-management-lookup/api";

type AreaOption = { id: string; label: string; area: AssetExtractArea };
type Step = "area" | "filters" | "data" | "review";
type SelectionMode = "draw" | "existing" | "records";
type SelectedRecord = { kind: RecordKind; id: string; label: string; assets: AssetExtractSelectedAsset[] };

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "area", label: "Selection" },
  { id: "filters", label: "Assets & filters" },
  { id: "data", label: "Data" },
  { id: "review", label: "Review" },
];
const ASSET_TYPES: AssetExtractAssetType[] = ["structure", "pipe", "channel"];
const RELATED_KEYS: AssetExtractRelatedKey[] = ["service_requests", "investigations", "inspections", "work_orders", "itpipes_defects", "pipe_risk"];
const OPERATOR_LABELS: Record<AssetExtractOperator, string> = {
  eq: "Equals", ne: "Does not equal", contains: "Contains", starts_with: "Starts with",
  gt: "Greater than", gte: "At least", lt: "Less than", lte: "At most",
  is_null: "Is empty", is_not_null: "Is not empty",
};

export default function AssetDataExtractPanel({
  areas,
  onActivateDraw,
  onClose,
  onPreview,
  onSelectArea,
  onUseCurrentExtent,
  onUseBoundaryArea,
  open,
  selectedAreaId,
}: {
  areas: AreaOption[];
  onActivateDraw: (tool: "polygon" | "circle" | "rectangle") => void;
  onClose: () => void;
  onPreview: (preview: AssetExtractPreview | null) => void;
  onSelectArea: (id: string) => void;
  onUseCurrentExtent: () => void;
  onUseBoundaryArea: (area: AssetExtractArea, label: string) => void;
  open: boolean;
  selectedAreaId: string | null;
}) {
  const [catalog, setCatalog] = useState<AssetExtractCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [step, setStep] = useState<Step>("area");
  const [selectedTypes, setSelectedTypes] = useState<AssetExtractAssetType[]>([...ASSET_TYPES]);
  const [assignmentStates, setAssignmentStates] = useState<AssetExtractAssignmentState[]>(["assigned", "unassigned", "not_evaluated"]);
  const [filters, setFilters] = useState<Partial<Record<AssetExtractAssetType, AssetExtractFilter[]>>>({});
  const [fields, setFields] = useState<Partial<Record<AssetExtractAssetType, string[]>>>({});
  const [related, setRelated] = useState<Record<AssetExtractRelatedKey, boolean>>(() => Object.fromEntries(RELATED_KEYS.map((key) => [key, true])) as Record<AssetExtractRelatedKey, boolean>);
  const [relatedMode, setRelatedMode] = useState<"all" | "most_recent">("all");
  const [fieldSearch, setFieldSearch] = useState("");
  const [areaMode, setAreaMode] = useState<SelectionMode>("draw");
  const [recordSearch, setRecordSearch] = useState("");
  const [recordCandidates, setRecordCandidates] = useState<RecordSummary[]>([]);
  const [recordSearching, setRecordSearching] = useState(false);
  const [recordLoading, setRecordLoading] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [selectedRecords, setSelectedRecords] = useState<SelectedRecord[]>([]);
  const [boundarySourceId, setBoundarySourceId] = useState("");
  const [boundarySearch, setBoundarySearch] = useState("");
  const [boundaryCandidates, setBoundaryCandidates] = useState<AssetExtractBoundaryCandidate[]>([]);
  const [selectedBoundaryIds, setSelectedBoundaryIds] = useState<string[]>([]);
  const [boundaryLoading, setBoundaryLoading] = useState(false);
  const [boundaryError, setBoundaryError] = useState("");
  const [preview, setPreview] = useState<AssetExtractPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState<"excel" | "geopackage" | null>(null);
  const [error, setError] = useState("");

  const selectedArea = areas.find((area) => area.id === selectedAreaId) || null;
  const activeStepIndex = STEPS.findIndex((item) => item.id === step);
  // One asset can be named by several records; the extract wants it once.
  const selectedAssets = useMemo(() => {
    const seen = new Set<string>();
    const unique: AssetExtractSelectedAsset[] = [];
    for (const record of selectedRecords) {
      for (const asset of record.assets) {
        const key = `${asset.asset_type}:${asset.asset_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(asset);
      }
    }
    return unique;
  }, [selectedRecords]);
  const payload = useMemo<AssetExtractPayload | null>(() => {
    const base = {
      asset_types: selectedTypes,
      assignment_states: assignmentStates,
      filters,
      fields,
      include_related: related,
      related_mode: relatedMode,
    };
    if (areaMode === "records") {
      return selectedAssets.length ? { ...base, asset_ids: selectedAssets } : null;
    }
    return selectedArea ? { ...base, area: selectedArea.area.geometry } : null;
  }, [areaMode, assignmentStates, fields, filters, related, relatedMode, selectedArea, selectedAssets, selectedTypes]);
  const signature = useMemo(() => payload ? JSON.stringify({
    area: payload.area,
    asset_ids: payload.asset_ids,
    asset_types: payload.asset_types,
    assignment_states: payload.assignment_states,
    filters: payload.filters,
  }) : "", [payload]);

  useEffect(() => {
    if (!open || catalog) return;
    setCatalogError("");
    fetchAssetExtractCatalog()
      .then((value) => {
        setCatalog(value);
        setFields(Object.fromEntries(ASSET_TYPES.map((assetType) => [assetType, value.asset_types[assetType].default_fields])));
        setBoundarySourceId((current) => current || value.boundary_sources[0]?.id || "");
      })
      .catch((reason: Error) => setCatalogError(reason.message));
  }, [catalog, open]);

  useEffect(() => {
    if (!open || areaMode !== "existing" || !boundarySourceId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setBoundaryLoading(true);
      setBoundaryError("");
      searchAssetExtractBoundaries(boundarySourceId, boundarySearch)
        .then((value) => { if (active) setBoundaryCandidates(value.items); })
        .catch((reason: Error) => { if (active) setBoundaryError(reason.message); })
        .finally(() => { if (active) setBoundaryLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [areaMode, boundarySearch, boundarySourceId, open]);

  useEffect(() => {
    if (!open || areaMode !== "records") return;
    const wanted = recordSearch.trim();
    if (wanted.length < 2) {
      setRecordCandidates([]);
      setRecordSearching(false);
      return;
    }
    let active = true;
    setRecordSearching(true);
    const timer = window.setTimeout(() => {
      searchRecords(wanted)
        .then((value) => { if (active) setRecordCandidates(value.matches || []); })
        .catch((reason: Error) => { if (active) { setRecordCandidates([]); setRecordError(reason.message); } })
        .finally(() => { if (active) setRecordSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [areaMode, open, recordSearch]);

  useEffect(() => {
    setPreview(null);
    onPreview(null);
  }, [onPreview, signature]);

  if (!open) return null;

  const updateType = (assetType: AssetExtractAssetType) => {
    setSelectedTypes((current) => current.includes(assetType) ? current.filter((value) => value !== assetType) : [...current, assetType]);
  };
  const updateAssignment = (status: AssetExtractAssignmentState) => {
    setAssignmentStates((current) => current.includes(status) ? current.filter((value) => value !== status) : [...current, status]);
  };
  const addFilter = (assetType: AssetExtractAssetType) => {
    const field = catalog?.asset_types[assetType].filter_fields.find((item) => item.filterable);
    if (!field) return;
    setFilters((current) => ({ ...current, [assetType]: [...(current[assetType] || []), { id: crypto.randomUUID(), field: field.name, operator: field.operators[0], value: "" }] }));
  };
  const updateFilter = (assetType: AssetExtractAssetType, id: string, patch: Partial<AssetExtractFilter>) => {
    setFilters((current) => ({ ...current, [assetType]: (current[assetType] || []).map((rule) => rule.id === id ? { ...rule, ...patch } : rule) }));
  };
  const removeFilter = (assetType: AssetExtractAssetType, id: string) => {
    setFilters((current) => ({ ...current, [assetType]: (current[assetType] || []).filter((rule) => rule.id !== id) }));
  };
  const toggleBoundary = (id: string) => {
    setSelectedBoundaryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };
  const addRecord = async (candidate: RecordSummary) => {
    setRecordSearch("");
    setRecordCandidates([]);
    if (selectedRecords.some((item) => item.kind === candidate.kind && item.id === candidate.id)) return;
    setRecordLoading(true);
    setRecordError("");
    try {
      const detail = await fetchRecord(candidate.kind, candidate.id);
      const assets: AssetExtractSelectedAsset[] = [];
      for (const asset of detail.assets) {
        const assetType = portalAssetType(asset.asset_type);
        if (assetType) assets.push({ asset_type: assetType, asset_id: asset.asset_id });
      }
      const label = `${candidate.kind_label} ${candidate.id}`;
      setSelectedRecords((current) => [...current, { kind: candidate.kind, id: candidate.id, label, assets }]);
      if (!assets.length) setRecordError(`${label} names no pipes, structures, or channels.`);
    } catch (reason) {
      setRecordError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecordLoading(false);
    }
  };
  const removeRecord = (record: SelectedRecord) => {
    setRecordError("");
    setSelectedRecords((current) => current.filter((item) => !(item.kind === record.kind && item.id === record.id)));
  };
  const useSelectedBoundaries = async () => {
    if (!boundarySourceId || !selectedBoundaryIds.length) return;
    setBoundaryLoading(true);
    setBoundaryError("");
    try {
      const value = await resolveAssetExtractBoundaries(boundarySourceId, selectedBoundaryIds);
      onUseBoundaryArea(value.area, value.label);
      toast.success(`${value.label} selected as the export area.`);
    } catch (reason) {
      setBoundaryError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBoundaryLoading(false);
    }
  };
  const runPreview = async () => {
    if (!payload) {
      setError(areaMode === "records"
        ? "Add a work-management record that names at least one pipe, structure, or channel."
        : "Select or create an export area first.");
      setStep("area");
      return;
    }
    if (!selectedTypes.length || !assignmentStates.length) {
      setError("Select at least one asset type and assignment status.");
      setStep("filters");
      return;
    }
    setPreviewing(true);
    setError("");
    try {
      const value = await previewAssetExtract(payload);
      setPreview(value);
      onPreview(value);
      setStep("review");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewing(false);
    }
  };
  const runExport = async (format: "excel" | "geopackage") => {
    if (!payload || !preview) return;
    setExporting(format);
    setError("");
    try {
      const saved = await exportAssetExtract(payload, format);
      if (saved === null) {
        toast.info("Export cancelled.");
      } else {
        if (format === "excel") {
          toast.success("Excel workbook saved and opened.");
        } else {
          toast.success("GeoPackage saved.", {
            action: typeof saved === "string" ? { label: "Open file location", onClick: () => void openFileLocation(saved) } : undefined,
          });
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  };

  const selectionReady = areaMode === "records" ? selectedAssets.length > 0 : Boolean(selectedArea);
  const selectionSummary = areaMode === "records"
    ? selectedAssets.length
      ? `${selectedAssets.length.toLocaleString()} asset${selectedAssets.length === 1 ? "" : "s"} from ${selectedRecords.length} record${selectedRecords.length === 1 ? "" : "s"}.`
      : "Search for a record to select the assets it names."
    : selectedArea
      ? `${selectedArea.label} is ready.`
      : "Draw an area or select an existing boundary.";

  return (
    <aside className="asset-extract-panel absolute bottom-3 right-3 top-3 z-50 grid w-[640px] max-w-[calc(100vw-76px)] grid-rows-[56px_50px_minmax(0,1fr)_64px] overflow-hidden rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--panel-text)] shadow-[0_20px_60px_rgba(0,0,0,.34)]" aria-label="Asset data extract">
      <header className="flex items-center justify-between border-b border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-sm bg-[var(--panel-active-bg)] text-[var(--accent)]"><Database className="h-4 w-4" /></span>
          <div><strong className="block text-[14px] font-semibold">Asset Data Extract</strong><span className="block text-[10px] text-[var(--panel-muted)]">Spatial and attribute export</span></div>
        </div>
        <button className="grid h-9 w-9 place-items-center hover:bg-[var(--row-hover)]" type="button" onClick={onClose} aria-label="Close Asset Data Extract"><X className="h-4 w-4" /></button>
      </header>
      <nav className="grid grid-cols-4 border-b border-[var(--panel-border)] bg-[var(--panel-bg)]" aria-label="Extract steps">
        {STEPS.map((item, index) => <button key={item.id} className={`border-r border-[var(--panel-border)] px-2 text-[11px] font-semibold last:border-r-0 ${step === item.id ? "bg-[var(--accent)] text-white" : "text-[var(--panel-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--panel-text)]"}`} type="button" onClick={() => setStep(item.id)}><span className="mr-1.5 opacity-70">{index + 1}</span>{item.label}</button>)}
      </nav>
      <div className="min-h-0 overflow-y-auto p-4">
        {!catalog && !catalogError ? <EmptyState icon={<LoaderCircle className="h-5 w-5 animate-spin" />} text="Loading active inventory schema..." /> : null}
        {catalogError ? <ErrorBox text={catalogError} /> : null}
        {catalog && step === "area" ? <section className="grid gap-4">
          <SectionTitle title="Choose what to export" subtitle="Scope the extract by an area on the map, or by the assets named on work-management records." />
          <div className="grid grid-cols-3 gap-2"><ChoiceButton active={areaMode === "draw"} label="Draw area" onClick={() => setAreaMode("draw")} /><ChoiceButton active={areaMode === "existing"} label="Existing boundary" onClick={() => setAreaMode("existing")} /><ChoiceButton active={areaMode === "records"} label="By record number" onClick={() => setAreaMode("records")} /></div>
          {areaMode === "records" ? <div className="grid gap-3 border border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-[var(--panel-muted)]" />
              <input className="asset-extract-boundary-search-input h-10 w-full border border-[var(--panel-border)] bg-[var(--input-bg)] pl-10 pr-9 text-[11px] text-[var(--panel-text)]" value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="Service request, work order, inspection or investigation ID" />
              {recordSearching || recordLoading ? <LoaderCircle className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--accent)]" /> : null}
            </label>
            {recordCandidates.length ? <div className="max-h-52 overflow-y-auto border border-[var(--panel-border)] bg-[var(--panel-bg)]">
              {recordCandidates.map((candidate) => <button key={`${candidate.kind}-${candidate.id}`} className="flex min-h-11 w-full items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--row-hover)]" type="button" onClick={() => void addRecord(candidate)}>
                <span className="w-[104px] shrink-0 text-[9px] font-semibold uppercase tracking-[.06em] text-[var(--accent)]">{candidate.kind_label}</span>
                <strong className="shrink-0 text-[11px]">{candidate.id}</strong>
                <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--panel-muted)]">{candidate.title || candidate.subtitle || "No description"}</span>
              </button>)}
            </div> : recordSearch.trim().length >= 2 && !recordSearching ? <p className="px-1 text-[10px] text-[var(--panel-muted)]">No record matches that number.</p> : null}
            {selectedRecords.length ? <div className="grid gap-1.5">
              {selectedRecords.map((record) => <div key={`${record.kind}-${record.id}`} className="flex items-center gap-2 border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2">
                <ClipboardList className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                <strong className="text-[11px]">{record.label}</strong>
                <span className="text-[10px] text-[var(--panel-muted)]">{record.assets.length} asset{record.assets.length === 1 ? "" : "s"}</span>
                <button className="ml-auto grid h-7 w-7 place-items-center text-red-600 hover:bg-[var(--row-hover)]" type="button" onClick={() => removeRecord(record)} aria-label={`Remove ${record.label}`}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>)}
            </div> : null}
            {selectedAssets.length ? <div className="max-h-44 overflow-y-auto border border-[var(--panel-border)] bg-[var(--panel-bg)]">
              {selectedAssets.map((asset) => <div key={`${asset.asset_type}:${asset.asset_id}`} className="flex items-center gap-3 border-b border-[var(--panel-border)] px-3 py-1.5 last:border-b-0">
                <span className="w-[72px] shrink-0 text-[9px] font-semibold uppercase tracking-[.06em] text-[var(--panel-muted)]">{asset.asset_type}</span>
                <strong className="text-[11px]">{asset.asset_id}</strong>
              </div>)}
            </div> : null}
            {recordError ? <ErrorBox text={recordError} warning /> : null}
          </div> : areaMode === "draw" ? <div className="grid gap-3 border border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ActionButton label="Polygon" onClick={() => onActivateDraw("polygon")} />
              <ActionButton label="Rectangle" onClick={() => onActivateDraw("rectangle")} />
              <ActionButton label="Circle" onClick={() => onActivateDraw("circle")} />
              <ActionButton label="Map extent" onClick={onUseCurrentExtent} />
            </div>
            <div className="max-h-52 overflow-y-auto border border-[var(--panel-border)] bg-[var(--panel-bg)]">
              {!areas.length ? <div className="grid h-24 place-items-center px-4 text-center text-[11px] text-[var(--panel-muted)]">No drawings yet. Use a tool above to mark the export area.</div> : areas.map((area) => { const active = area.id === selectedAreaId; return <button key={area.id} className={`flex min-h-11 w-full items-center gap-3 border-b border-[var(--panel-border)] px-3 py-2 text-left last:border-b-0 ${active ? "bg-[var(--panel-active-bg)]" : "hover:bg-[var(--row-hover)]"}`} type="button" onClick={() => onSelectArea(area.id)}>
                <span className={`grid h-4 w-4 shrink-0 place-items-center border ${active ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--panel-border)]"}`}>{active ? <Check className="h-3 w-3" /> : null}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{area.label}</span>
              </button>; })}
            </div>
          </div> : <div className="grid gap-3 border border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] p-3">
            <div className="grid grid-cols-2 gap-2">{catalog.boundary_sources.map((source) => <ChoiceButton key={source.id} active={boundarySourceId === source.id} label={source.label} onClick={() => { setBoundarySourceId(source.id); setBoundarySearch(""); setBoundaryCandidates([]); setSelectedBoundaryIds([]); }} />)}</div>
            <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-[var(--panel-muted)]" /><input className="asset-extract-boundary-search-input h-10 w-full border border-[var(--panel-border)] bg-[var(--input-bg)] pl-10 pr-3 text-[11px] text-[var(--panel-text)]" value={boundarySearch} onChange={(event) => setBoundarySearch(event.target.value)} placeholder={boundarySourceId === "culvert" ? "Facility ID, location, or grid" : "Work zone name"} /></label>
            <div className="max-h-52 overflow-y-auto border border-[var(--panel-border)] bg-[var(--panel-bg)]">
              {boundaryLoading && !boundaryCandidates.length ? <div className="grid h-24 place-items-center"><LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent)]" /></div> : null}
              {!boundaryLoading && !boundaryCandidates.length ? <div className="grid h-24 place-items-center px-4 text-center text-[11px] text-[var(--panel-muted)]">No matching boundaries.</div> : null}
              {boundaryCandidates.map((candidate) => { const active = selectedBoundaryIds.includes(candidate.id); return <button key={candidate.id} className={`flex min-h-11 w-full items-center gap-3 border-b border-[var(--panel-border)] px-3 py-2 text-left last:border-b-0 ${active ? "bg-[var(--panel-active-bg)]" : "hover:bg-[var(--row-hover)]"}`} type="button" onClick={() => toggleBoundary(candidate.id)}><span className={`grid h-4 w-4 shrink-0 place-items-center border ${active ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--panel-border)]"}`}>{active ? <Check className="h-3 w-3" /> : null}</span><span className="min-w-0 flex-1"><strong className="block truncate text-[11px]">{candidate.label}</strong>{candidate.subtitle ? <span className="block truncate text-[9px] text-[var(--panel-muted)]">{candidate.subtitle}</span> : null}</span></button>; })}
            </div>
            <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-semibold text-[var(--panel-muted)]">{selectedBoundaryIds.length} selected</span><button className="inline-flex h-9 items-center gap-2 bg-[var(--accent)] px-4 text-[11px] font-semibold text-white disabled:opacity-45" type="button" disabled={!selectedBoundaryIds.length || boundaryLoading} onClick={useSelectedBoundaries}>{boundaryLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <MapPinned className="h-4 w-4" />}Use selection</button></div>
            {boundaryError ? <ErrorBox text={boundaryError} /> : null}
          </div>}
          <div className={`flex items-center gap-2 border px-3 py-2 text-[11px] font-semibold ${selectionReady ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}>{areaMode === "records" ? <ClipboardList className="h-4 w-4 shrink-0" /> : <MapPinned className="h-4 w-4 shrink-0" />}{selectionSummary}</div>
        </section> : null}
        {catalog && step === "filters" ? <section className="grid gap-5">
          <SectionTitle title="Assets and filters" subtitle="Rules within each asset type are combined with AND." />
          <div><FieldHeading>Asset types</FieldHeading><div className="mt-2 grid grid-cols-3 gap-2">{ASSET_TYPES.map((assetType) => <ChoiceButton key={assetType} active={selectedTypes.includes(assetType)} label={catalog.asset_types[assetType].label} onClick={() => updateType(assetType)} />)}</div></div>
          <div><FieldHeading>Assignment status</FieldHeading><div className="mt-2 grid grid-cols-2 gap-2">{catalog.assignment_states.map((item) => <ChoiceButton key={item.value} active={assignmentStates.includes(item.value)} label={item.label} onClick={() => updateAssignment(item.value)} />)}</div></div>
          {selectedTypes.map((assetType) => <div key={assetType} className="border border-[var(--panel-border)]">
            <div className="flex h-11 items-center justify-between bg-[var(--panel-toolbar-bg)] px-3"><strong className="text-[12px]">{catalog.asset_types[assetType].label} filters</strong><button className="inline-flex h-8 items-center gap-1 border border-[var(--panel-border)] px-2 text-[10px] font-semibold hover:border-[var(--accent)]" type="button" onClick={() => addFilter(assetType)}><Plus className="h-3.5 w-3.5" />Add rule</button></div>
            <div className="grid gap-2 p-3">{!(filters[assetType] || []).length ? <span className="text-[11px] text-[var(--panel-muted)]">No attribute filters.</span> : (filters[assetType] || []).map((rule) => {
              const typeCatalog = catalog.asset_types[assetType]; const field = typeCatalog.filter_fields.find((item) => item.name === rule.field) || typeCatalog.filter_fields[0]; const noValue = rule.operator === "is_null" || rule.operator === "is_not_null";
              return <div key={rule.id} className="grid grid-cols-[minmax(0,1.2fr)_150px_minmax(100px,1fr)_34px] gap-2">
                <select className="h-9 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px]" value={rule.field} onChange={(event) => { const next = typeCatalog.filter_fields.find((item) => item.name === event.target.value)!; updateFilter(assetType, rule.id, { field: next.name, operator: next.operators[0], value: "" }); }}>{typeCatalog.filter_fields.filter((item) => item.filterable).map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}</select>
                <select className="h-9 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px]" value={rule.operator} onChange={(event) => updateFilter(assetType, rule.id, { operator: event.target.value as AssetExtractOperator })}>{field.operators.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}</select>
                <input className="h-9 min-w-0 border border-[var(--panel-border)] bg-[var(--input-bg)] px-2 text-[11px] disabled:opacity-45" type={field.type === "number" ? "number" : field.type === "date" ? "datetime-local" : "text"} disabled={noValue} value={rule.value} onChange={(event) => updateFilter(assetType, rule.id, { value: event.target.value })} placeholder="Value" />
                <button className="grid h-9 place-items-center border border-[var(--panel-border)] text-red-600 hover:border-red-500" type="button" onClick={() => removeFilter(assetType, rule.id)} aria-label="Remove filter"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>;
            })}</div>
          </div>)}
        </section> : null}
        {catalog && step === "data" ? <section className="grid gap-5">
          <SectionTitle title="Fields and related data" subtitle="Choose inventory attributes and normalized Asset History sections." />
          <label className="relative block"><Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--panel-muted)]" /><input className="h-10 w-full border border-[var(--panel-border)] bg-[var(--input-bg)] pl-10 pr-3 text-[11px]" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="Find an inventory field" /></label>
          {selectedTypes.map((assetType) => <FieldSelectionCard
            key={assetType}
            catalog={catalog.asset_types[assetType]}
            search={fieldSearch}
            selected={fields[assetType] || []}
            onChange={(values) => setFields((current) => ({ ...current, [assetType]: values }))}
          />)}
          <div><FieldHeading>Related Asset History data</FieldHeading><div className="mt-2 grid grid-cols-2 gap-2">{catalog.related_sections.map((item) => <ChoiceButton key={item.key} active={related[item.key]} label={item.label} onClick={() => setRelated((current) => ({ ...current, [item.key]: !current[item.key] }))} />)}</div></div>
          <div><FieldHeading>Related record coverage</FieldHeading><div className="mt-2 grid grid-cols-2 gap-2"><ChoiceButton active={relatedMode === "all"} label="All related records" onClick={() => setRelatedMode("all")} /><ChoiceButton active={relatedMode === "most_recent"} label="Most recent only" onClick={() => setRelatedMode("most_recent")} /></div><p className="mt-2 text-[10px] leading-4 text-[var(--panel-muted)]">Most recent keeps one newest Cityworks record per asset and category. For ITPipes, it keeps every defect from the newest inspection.</p></div>
        </section> : null}
        {catalog && step === "review" ? <section className="grid gap-4">
          <SectionTitle title="Review and export" subtitle="Preview is authoritative; the map displays at most 5,000 selected features." />
          {!preview ? <EmptyState icon={<Database className="h-5 w-5" />} text="Run Preview to calculate the complete filtered selection." /> : <>
            <div className="grid grid-cols-4 gap-2"><Metric label="Total assets" value={preview.total} />{ASSET_TYPES.map((assetType) => <Metric key={assetType} label={catalog.asset_types[assetType].label} value={preview.counts_by_type[assetType] || 0} />)}</div>
            <div className="grid grid-cols-4 gap-2">{catalog.assignment_states.map((item) => <Metric key={item.value} label={item.label} value={preview.counts_by_status[item.value] || 0} tone={item.value} />)}</div>
            {preview.warnings.map((warning) => <ErrorBox key={warning} text={warning} warning />)}
            {preview.truncated ? <ErrorBox warning text={`Map preview is limited to ${preview.preview_limit.toLocaleString()} features. Export includes all ${preview.total.toLocaleString()} selected assets.`} /> : null}
            <div className="grid grid-cols-2 gap-3 border-t border-[var(--panel-border)] pt-4"><button className="inline-flex h-11 items-center justify-center gap-2 bg-[var(--accent)] px-4 text-[12px] font-semibold text-white disabled:opacity-50" type="button" disabled={Boolean(exporting) || preview.total === 0 || preview.total > catalog.limits.export} onClick={() => runExport("excel")}>{exporting === "excel" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Export Excel</button><button className="inline-flex h-11 items-center justify-center gap-2 border border-[var(--accent)] bg-[var(--control-bg)] px-4 text-[12px] font-semibold text-[var(--accent)] disabled:opacity-50" type="button" disabled={Boolean(exporting) || preview.total === 0 || preview.total > catalog.limits.export} onClick={() => runExport("geopackage")}>{exporting === "geopackage" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}Export GeoPackage</button></div>
          </>}
        </section> : null}
        {error ? <div className="mt-4"><ErrorBox text={error} /></div> : null}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] px-4">
        <button className="inline-flex h-9 items-center gap-1.5 border border-[var(--panel-border)] px-3 text-[11px] font-semibold disabled:opacity-40" type="button" disabled={activeStepIndex === 0} onClick={() => setStep(STEPS[Math.max(0, activeStepIndex - 1)].id)}><ChevronLeft className="h-4 w-4" />Back</button>
        <div className="flex items-center gap-2"><button className="inline-flex h-9 items-center gap-1.5 border border-[var(--panel-border)] px-3 text-[11px] font-semibold" type="button" onClick={() => { setFilters({}); setPreview(null); onPreview(null); }}><RotateCcw className="h-3.5 w-3.5" />Reset filters</button><button className="inline-flex h-9 items-center gap-1.5 bg-[var(--accent)] px-4 text-[11px] font-semibold text-white disabled:opacity-50" type="button" disabled={previewing || !payload} onClick={activeStepIndex < STEPS.length - 1 ? () => setStep(STEPS[activeStepIndex + 1].id) : runPreview}>{previewing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : activeStepIndex < STEPS.length - 1 ? <><span>Next</span><ChevronRight className="h-4 w-4" /></> : <><Check className="h-4 w-4" />Run preview</>}</button></div>
      </footer>
    </aside>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div><h2 className="text-[18px] font-semibold">{title}</h2><p className="mt-1 text-[11px] text-[var(--panel-muted)]">{subtitle}</p></div>; }
function FieldHeading({ children }: { children: React.ReactNode }) { return <h3 className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--panel-muted)]">{children}</h3>; }
function FieldSelectionCard({ catalog, onChange, search, selected }: { catalog: AssetExtractTypeCatalog; onChange: (values: string[]) => void; search: string; selected: string[] }) {
  const requiredField = catalog.id_field;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleFields = catalog.fields.filter((field) => !normalizedSearch || field.label.toLowerCase().includes(normalizedSearch) || field.name.toLowerCase().includes(normalizedSearch));
  const selectedFields = Array.from(new Set([requiredField, ...selected]));
  const selectedSet = new Set(selectedFields);
  const setSelection = (values: string[]) => onChange(Array.from(new Set([requiredField, ...values])));
  const toggleField = (fieldName: string) => {
    if (fieldName === requiredField) return;
    setSelection(selectedSet.has(fieldName) ? selectedFields.filter((value) => value !== fieldName) : [...selectedFields, fieldName]);
  };
  return <section className="overflow-hidden border border-[var(--panel-border)] bg-[var(--panel-bg)]">
    <header className="flex min-h-12 items-center justify-between gap-3 bg-[var(--panel-toolbar-bg)] px-3 py-2">
      <div className="min-w-0"><strong className="block text-[12px]">{catalog.label}</strong><span className="block text-[10px] text-[var(--panel-muted)]">{selectedSet.size} of {catalog.fields.length} fields selected</span></div>
      <div className="flex shrink-0 items-center gap-1">
        <FieldCardAction label="Defaults" onClick={() => setSelection(catalog.default_fields)} />
        <FieldCardAction label="All" onClick={() => setSelection(catalog.fields.map((field) => field.name))} />
        <FieldCardAction label="Clear" onClick={() => setSelection([])} />
      </div>
    </header>
    <div className="asset-extract-field-grid grid max-h-44 grid-cols-1 gap-x-3 overflow-y-auto p-2 sm:grid-cols-2">
      {visibleFields.length ? visibleFields.map((field) => {
        const required = field.name === requiredField;
        return <label key={field.name} className="asset-extract-field-option flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--row-hover)]" title={`${field.label} (${field.name})`}>
          <input className="asset-extract-field-checkbox" type="checkbox" checked={selectedSet.has(field.name)} disabled={required} onChange={() => toggleField(field.name)} />
          <span className="min-w-0 flex-1 truncate">{field.label}</span>
          {required ? <span className="shrink-0 text-[8px] font-semibold uppercase tracking-[.06em] text-[var(--panel-muted)]">ID</span> : null}
        </label>;
      }) : <span className="col-span-full px-2 py-5 text-center text-[11px] text-[var(--panel-muted)]">No fields match this search.</span>}
    </div>
  </section>;
}
function FieldCardAction({ label, onClick }: { label: string; onClick: () => void }) { return <button className="h-7 border border-[var(--panel-border)] bg-[var(--control-bg)] px-2 text-[9px] font-semibold text-[var(--panel-text)] hover:border-[var(--accent)] hover:text-[var(--accent)]" type="button" onClick={onClick}>{label}</button>; }
function ChoiceButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) { return <button className={`flex h-10 items-center gap-2 border px-3 text-left text-[11px] font-semibold ${active ? "border-[var(--accent)] bg-[var(--panel-active-bg)] text-[var(--accent)]" : "border-[var(--panel-border)] bg-[var(--input-bg)] text-[var(--panel-text)] hover:border-[var(--accent)]"}`} type="button" aria-pressed={active} onClick={onClick}><span className={`grid h-4 w-4 place-items-center border ${active ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--panel-border)]"}`}>{active ? <Check className="h-3 w-3" /> : null}</span><span className="truncate">{label}</span></button>; }
function ActionButton({ label, onClick }: { label: string; onClick: () => void }) { return <button className="h-10 border border-[var(--panel-border)] bg-[var(--control-bg)] px-3 text-[11px] font-semibold hover:border-[var(--accent)] hover:bg-[var(--row-hover)]" type="button" onClick={onClick}>{label}</button>; }
function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="grid min-h-52 place-items-center border border-dashed border-[var(--panel-border)] bg-[var(--panel-toolbar-bg)] p-6 text-center text-[12px] text-[var(--panel-muted)]"><div className="grid justify-items-center gap-3">{icon}<span>{text}</span></div></div>; }
function ErrorBox({ text, warning = false }: { text: string; warning?: boolean }) { return <div className={`border px-3 py-2 text-[11px] font-semibold ${warning ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-300 bg-red-50 text-red-800"}`}>{text}</div>; }
function Metric({ label, value, tone }: { label: string; value: number; tone?: AssetExtractAssignmentState }) { const toneClass = tone === "assigned" ? "border-emerald-300 bg-emerald-50" : tone === "unassigned" ? "border-red-300 bg-red-50" : "border-[var(--panel-border)] bg-[var(--input-bg)]"; return <div className={`border p-3 ${toneClass}`}><span className="block truncate text-[9px] font-semibold uppercase tracking-[.06em] text-[var(--panel-muted)]">{label}</span><strong className="mt-1 block text-[18px]">{value.toLocaleString()}</strong></div>; }
