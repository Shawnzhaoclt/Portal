import { AlertTriangle, Check, CircleDot, Crosshair, LoaderCircle, MapPinned } from "lucide-react";
import { useMemo, useState } from "react";

import type { FailureConsequenceResult, FailureDefect, ImpactedFeature } from "./failureConsequence";

/**
 * The right-hand consequence inspector: failure scenarios, summary KPIs, affected
 * features and method notes. Shared between the risk map's full 2D/3D panel and the
 * CCTV review's 3D-only view, so the two resources cannot drift apart. Simulated-defect
 * placement needs a 2D map to click, so those controls only render when the host
 * supplies them.
 */
type Tab = "summary" | "features" | "method";

export const SOURCE_LABELS: Record<FailureDefect["source"], string> = {
  itpipes: "ITPipes observed",
  cityworks: "Cityworks observed",
  inventory: "Structure invert",
  simulated: "Simulated",
};

type SimulationControls = {
  simulating: boolean;
  onToggle: (active: boolean) => void;
};

type Props = {
  error: string;
  loading: boolean;
  result: FailureConsequenceResult | null;
  flashedFeatureId: string | null;
  flashTargetLabel: string;
  onFlashFeature: (featureId: string) => void;
  onSelectDefect: (defect: FailureDefect) => void;
  simulation?: SimulationControls;
};

export default function ConsequenceInspector({
  error,
  loading,
  result,
  flashedFeatureId,
  flashTargetLabel,
  onFlashFeature,
  onSelectDefect,
  simulation,
}: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const active = result?.defects.find((item) => item.id === result.active_defect_id) ?? null;
  const located = (result?.defects.filter((item) => item.located) ?? []).toSorted((left, right) => {
    const leftRisk = left.condition_risk ?? Number.NEGATIVE_INFINITY;
    const rightRisk = right.condition_risk ?? Number.NEGATIVE_INFINITY;
    return rightRisk - leftRisk;
  });
  const unlocated = result?.defects.filter((item) => !item.located) ?? [];
  const influencedFeatures = useMemo(
    () => (result?.analysis?.impacted_features ?? []).filter((feature) => feature.is_influenced),
    [result?.analysis?.impacted_features],
  );
  const groupedFeatures = useMemo(() => {
    const groups = new Map<string, { label: string; category: string; count: number }>();
    for (const feature of influencedFeatures) {
      const current = groups.get(feature.category);
      if (current) current.count += 1;
      else groups.set(feature.category, { label: feature.label, category: feature.category, count: 1 });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [influencedFeatures]);

  return (
    <aside className="failure-consequence-inspector">
      {error ? <div className="failure-consequence-error"><AlertTriangle size={17} />{error}</div> : null}
      {loading ? <div className="failure-consequence-loading"><LoaderCircle className="spin" size={20} />Analyzing local spatial sources…</div> : null}

      <section className="failure-consequence-scenario">
        <div className="failure-consequence-section-heading">
          <div><span>Failure scenarios</span><strong>{located.length ? `${located.length} mapped scenario${located.length === 1 ? "" : "s"}` : "Asset-wide screening"}</strong></div>
          {active ? <span className={`failure-source-badge ${active.source}`}>{SOURCE_LABELS[active.source]}</span> : null}
        </div>
        {located.length ? (
          <div className="failure-defect-list">
            {located.map((defect) => (
              <button
                type="button"
                key={defect.id}
                className={`failure-defect-row ${defect.id === result?.active_defect_id ? "active" : ""}`}
                onClick={() => onSelectDefect(defect)}
              >
                <span className={`failure-defect-symbol ${defect.source}`}><CircleDot size={16} /></span>
                <span><strong>{defect.label}</strong><small>{SOURCE_LABELS[defect.source]}{defect.station_feet != null ? ` · ${defect.station_feet.toFixed(1)} ft` : ""}</small></span>
                <span className="failure-defect-risk">{defect.condition_risk == null ? "—" : defect.condition_risk.toFixed(1)}</span>
                {defect.id === result?.active_defect_id ? <Check size={17} /> : null}
              </button>
            ))}
          </div>
        ) : !loading ? (
          <div className="failure-no-scenario" role="status">
            <AlertTriangle size={18} />
            <div>
              <strong>No mapped observed defect</strong>
              <span>
                {unlocated.length
                  ? `${unlocated.length} latest-inspection defect${unlocated.length === 1 ? " is" : "s are"} missing usable stationing or direction.`
                  : "The latest inspections contain no defect with a usable map location."}
              </span>
            </div>
          </div>
        ) : null}
        {located.length && unlocated.length ? <p className="failure-unlocated">{unlocated.length} additional latest-inspection defect{unlocated.length === 1 ? "" : "s"} could not be mapped.</p> : null}
        <div className={`failure-simulate ${simulation?.simulating ? "active" : ""} ${!located.length ? "recommended" : ""}`}>
          {simulation ? (
            <button type="button" className={`failure-place-defect ${simulation.simulating ? "cancel" : ""}`} onClick={() => simulation.onToggle(!simulation.simulating)}>
              <Crosshair size={17} /> {simulation.simulating ? "Cancel placement" : "Place on map"}
            </button>
          ) : null}
          <span className="failure-depth-method">Depth is calculated from DEM ground and interpolated asset invert.</span>
        </div>
      </section>

      <nav className="failure-consequence-tabs" aria-label="Consequence result views">
        {(["summary", "features", "method"] as const).map((value) => (
          <button type="button" key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "features" ? "Affected features" : value[0].toUpperCase() + value.slice(1)}</button>
        ))}
      </nav>

      <section className="failure-consequence-body">
        {tab === "summary" ? (
          <>
            <div className="failure-kpis">
              <div><span>Max. ZOI radius</span><strong>{result?.analysis ? `${result.analysis.maximum_zoi_radius_feet.toFixed(1)} ft` : "—"}</strong></div>
              <div><span>Affected features</span><strong>{result?.analysis?.total_impacted ?? 0}</strong></div>
              <div><span>Condition risk</span><strong>{active?.condition_risk == null ? "—" : active.condition_risk.toFixed(1)}</strong></div>
            </div>
            <div className="failure-summary-list">
              {groupedFeatures.slice(0, 8).map((item) => <div key={item.category}><span>{item.label}</span><strong>{item.count}</strong></div>)}
              {!groupedFeatures.length ? <p className="failure-empty">No configured consequence features are influenced by the active scenario.</p> : null}
            </div>
          </>
        ) : null}
        {tab === "features" ? (
          <div className="failure-feature-list">
            {influencedFeatures.map((feature) => (
              <button
                type="button"
                key={feature.id}
                className={flashedFeatureId === feature.id ? "flashing" : ""}
                onClick={() => onFlashFeature(feature.id)}
                title={`Flash ${feature.label} on the ${flashTargetLabel}`}
              >
                <MapPinned size={17} />
                <div>
                  <strong>{feature.label}</strong>
                  <span>{feature.relationship === "direct" ? "Direct contact" : "Within zone of influence"}</span>
                  <small>{influenceMeasurementLabel(feature)}</small>
                </div>
                <small>{feature.source_table}</small>
              </button>
            ))}
            {!influencedFeatures.length ? <p className="failure-empty">No affected features are available for this scenario.</p> : null}
          </div>
        ) : null}
        {tab === "method" ? (
          <div className="failure-method">
            <div className="failure-method-formula">
              <span>Zone of influence</span>
              <strong>{result?.method.zoi_formula ?? "3 ft + (2 × relative depth)"}</strong>
            </div>
            <div className="failure-method-note">
              <strong>Latest inspections only</strong>
              <p>The latest ITPipes and Cityworks inspections are evaluated; older inspections are not substituted.</p>
            </div>
            <div className="failure-method-note">
              <strong>Screening result</strong>
              <p>Results are transient and read-only. Verify findings in the field before making an engineering decision.</p>
            </div>
          </div>
        ) : null}
        {result?.warnings.map((warning) => <div className="failure-warning" key={warning}><AlertTriangle size={15} />{warning}</div>)}
      </section>
    </aside>
  );
}

export function influenceMeasurementLabel(feature: ImpactedFeature): string {
  if (feature.measurement_type === "area" && feature.influenced_area_sqft != null) {
    const percentage = feature.influenced_percent == null ? "" : ` · ${feature.influenced_percent.toFixed(1)}%`;
    return `${feature.influenced_area_sqft.toLocaleString(undefined, { maximumFractionDigits: 1 })} sq ft${percentage}`;
  }
  if (feature.measurement_type === "length" && feature.influenced_length_feet != null) {
    const percentage = feature.influenced_percent == null ? "" : ` · ${feature.influenced_percent.toFixed(1)}%`;
    return `${feature.influenced_length_feet.toLocaleString(undefined, { maximumFractionDigits: 1 })} ft influenced${percentage}`;
  }
  return "Inside scenario ZOI";
}
