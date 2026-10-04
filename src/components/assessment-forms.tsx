"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CONFIDENCE_LEVELS, ENERGY_TOPICS, INTERVENTION_STATUSES, RECOMMENDED_ACTIONS } from "@/domain/constants";
import type { ComponentDTO, EnergyDTO, FinancialDTO, InterventionDTO } from "@/domain/dto";
import {
  applyContingency,
  calculateCostLine,
  calculatePriority,
  formatChfRange,
  suggestPlanningWindow,
  type PriorityThresholds,
  type PriorityWeights,
} from "@/domain/calculations";
import {
  applyScoringAction,
  deleteInterventionAction,
  refreshCostAction,
  saveAssessmentMetaAction,
  saveComponentAction,
  saveEnergyAction,
  saveFinancialAction,
  saveInterventionAction,
  saveRoadmapAction,
  newVersionAction,
} from "@/server/actions";
import type { InterventionWrite } from "@/lib/mutations";

function Notice({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) return <p className="msg error" role="alert">{error}</p>;
  if (saved) return <p className="msg ok" role="status">Saved. Your entries are stored.</p>;
  return null;
}
function intOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
function floatOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ScoreSelect({ label, score, unknown, onChange }: { label: string; score: number | null; unknown: boolean; onChange: (score: number | null, unknown: boolean) => void }) {
  const value = unknown ? "unknown" : score == null ? "" : String(score);
  return (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => {
        const next = event.target.value;
        if (next === "unknown") onChange(null, true);
        else if (next === "") onChange(null, false);
        else onChange(Number(next), false);
      }}>
        <option value="">Not scored</option>
        <option value="unknown">Unknown</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
      </select>
    </label>
  );
}

export function ComponentForm({
  assessmentId,
  component,
  weights,
  thresholds,
  contingencyPct,
  currentYear,
  isAdmin,
}: {
  assessmentId: string;
  component: ComponentDTO;
  weights: PriorityWeights;
  thresholds: PriorityThresholds;
  contingencyPct: number;
  currentYear: number;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState(component);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  function patch(partial: Partial<ComponentDTO>) {
    setForm((current) => ({ ...current, ...partial }));
    setSaved(false);
  }
  const priority = calculatePriority(
    {
      condition: form.conditionUnknown ? null : form.conditionScore,
      urgency: form.urgencyUnknown ? null : form.urgencyScore,
      consequence: form.consequenceUnknown ? null : form.consequenceScore,
      escalation: form.escalationUnknown ? null : form.escalationScore,
    },
    weights,
    thresholds,
  );
  const cost = calculateCostLine({
    quantity: form.quantity,
    unitLow: form.unitLow,
    unitHigh: form.unitHigh,
    manualLow: form.manualLow,
    manualHigh: form.manualHigh,
    origin: form.costOrigin,
  });
  const planning = cost.low != null && cost.high != null ? applyContingency(cost.low, cost.high, contingencyPct) : null;
  const window = form.installationYear && form.usefulLifeLow && form.usefulLifeHigh
    ? suggestPlanningWindow(form.installationYear, form.usefulLifeLow, form.usefulLifeHigh, currentYear)
    : null;
  async function save() {
    setPending(true);
    setError(null);
    const result = await saveComponentAction(assessmentId, form);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }
  return (
    <div className="stack">
      <div className="fields">
        <ScoreSelect label="Condition" score={form.conditionScore} unknown={form.conditionUnknown} onChange={(score, unknown) => patch({ conditionScore: score, conditionUnknown: unknown })} />
        <ScoreSelect label="Urgency" score={form.urgencyScore} unknown={form.urgencyUnknown} onChange={(score, unknown) => patch({ urgencyScore: score, urgencyUnknown: unknown })} />
        <ScoreSelect label="Consequence" score={form.consequenceScore} unknown={form.consequenceUnknown} onChange={(score, unknown) => patch({ consequenceScore: score, consequenceUnknown: unknown })} />
        <ScoreSelect label="Cost escalation risk" score={form.escalationScore} unknown={form.escalationUnknown} onChange={(score, unknown) => patch({ escalationScore: score, escalationUnknown: unknown })} />
      </div>
      <p className="formula">{priority.score == null ? priority.message : `Priority ${priority.score} — ${priority.band}`}</p>
      {(form.conditionUnknown || form.urgencyUnknown || form.consequenceUnknown || form.escalationUnknown) ? <p className="msg warn">Further technical verification recommended. Unknown is not treated as good and is excluded from the numeric priority.</p> : null}
      <div className="fields">
        <label className="field wide"><span>Current condition</span><textarea value={form.summary} onChange={(e) => patch({ summary: e.target.value })} /></label>
        <label className="field wide"><span>Main issue</span><textarea value={form.mainIssue} onChange={(e) => patch({ mainIssue: e.target.value })} /></label>
        <label className="field"><span>Recommended action</span>
          <select value={form.recommendedAction} onChange={(e) => patch({ recommendedAction: e.target.value })}>
            <option value="">Not set</option>
            {RECOMMENDED_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
        </label>
        <label className="field"><span>Confidence</span>
          <select value={form.confidence} onChange={(e) => patch({ confidence: e.target.value })}>
            {CONFIDENCE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
        <label className="field"><span>Installation year</span><input value={form.installationYear ?? ""} onChange={(e) => patch({ installationYear: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Last major renovation year</span><input value={form.lastRenovationYear ?? ""} onChange={(e) => patch({ lastRenovationYear: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Useful life low (years)</span><input value={form.usefulLifeLow ?? ""} onChange={(e) => patch({ usefulLifeLow: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Useful life high (years)</span><input value={form.usefulLifeHigh ?? ""} onChange={(e) => patch({ usefulLifeHigh: intOrNull(e.target.value) })} /></label>
        <label className="field wide"><span>Notes</span><textarea value={form.notes} onChange={(e) => patch({ notes: e.target.value })} /></label>
      </div>
      {window ? <p className="muted">{window.text}</p> : null}
      <h3>Indicative cost</h3>
      <p className="muted">Base estimate and contingency stay separate. Amounts are rounded to whole CHF. This is not a quotation.</p>
      <div className="fields">
        <label className="field"><span>Cost origin</span>
          <select value={form.costOrigin} onChange={(e) => patch({ costOrigin: e.target.value as ComponentDTO["costOrigin"] })}>
            <option value="assumption">System-generated planning estimate</option>
            <option value="manual">Manually entered range</option>
            <option value="quoted">Externally quoted range</option>
          </select>
        </label>
        <label className="field"><span>Quantity</span><input value={form.quantity ?? ""} onChange={(e) => patch({ quantity: floatOrNull(e.target.value) })} /></label>
        <label className="field"><span>Unit</span><input value={form.quantityUnit} onChange={(e) => patch({ quantityUnit: e.target.value })} readOnly={form.costOrigin === "assumption" && !isAdmin} /></label>
        <label className="field"><span>Low unit cost (CHF)</span><input value={form.unitLow ?? ""} onChange={(e) => patch({ unitLow: intOrNull(e.target.value) })} readOnly={!isAdmin || form.costOrigin !== "assumption"} /></label>
        <label className="field"><span>High unit cost (CHF)</span><input value={form.unitHigh ?? ""} onChange={(e) => patch({ unitHigh: intOrNull(e.target.value) })} readOnly={!isAdmin || form.costOrigin !== "assumption"} /></label>
        <label className="field"><span>Manual / quoted low (CHF)</span><input value={form.manualLow ?? ""} onChange={(e) => patch({ manualLow: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Manual / quoted high (CHF)</span><input value={form.manualHigh ?? ""} onChange={(e) => patch({ manualHigh: intOrNull(e.target.value) })} /></label>
        <label className="field wide"><span>Source / reference</span><input value={form.costSourceNote} onChange={(e) => patch({ costSourceNote: e.target.value })} /></label>
      </div>
      <p>Base estimate: {formatChfRange(cost.low, cost.high)}</p>
      {planning ? (
        <p>Contingency {contingencyPct}%: {formatChfRange(planning.contingencyLow, planning.contingencyHigh)}. Planning budget range: {formatChfRange(planning.planningLow, planning.planningHigh)}.</p>
      ) : <p className="muted">{cost.note}</p>}
      <p className="muted">{cost.note}</p>
      {!isAdmin ? <p className="muted">Project managers cannot edit library unit costs. Refresh the snapshot or enter a manual range.</p> : null}
      <label className="field"><span><input type="checkbox" checked={form.reviewed} onChange={(e) => patch({ reviewed: e.target.checked })} /> Mark this component reviewed</span></label>
      <h3>Sub-items</h3>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Item</th><th>Status</th><th>Observation</th></tr></thead>
          <tbody>
            {form.items.map((item, index) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td>
                  <select aria-label={`${item.label} status`} value={item.status} onChange={(event) => {
                    const status = event.target.value as ComponentDTO["items"][number]["status"];
                    setForm((current) => ({ ...current, items: current.items.map((row, rowIndex) => rowIndex === index ? { ...row, status } : row) }));
                    setSaved(false);
                  }}>
                    <option value="known">Known</option>
                    <option value="unknown">Unknown</option>
                    <option value="na">Not applicable</option>
                  </select>
                </td>
                <td><input aria-label={`${item.label} observation`} value={item.observation} onChange={(event) => {
                  const observation = event.target.value;
                  setForm((current) => ({ ...current, items: current.items.map((row, rowIndex) => rowIndex === index ? { ...row, observation } : row) }));
                  setSaved(false);
                }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Notice error={error} saved={saved} />
      <div className="row">
        <button type="button" className="btn" disabled={pending} onClick={() => void save()}>{pending ? "Saving…" : "Save component"}</button>
        <button type="button" className="btn secondary" onClick={async () => {
          const result = await refreshCostAction(form.id);
          if (!result.ok) setError(result.error);
          else router.refresh();
        }}>Refresh unit costs from library</button>
      </div>
    </div>
  );
}

function interventionState(item: InterventionDTO): InterventionWrite {
  return {
    id: item.id,
    componentId: item.componentId,
    title: item.title,
    targetYear: item.targetYear,
    earliestYear: item.earliestYear,
    latestYear: item.latestYear,
    lowCost: item.lowCost,
    highCost: item.highCost,
    useComponentCost: item.useComponentCost,
    includeLow: item.includeLow,
    includeModerate: item.includeModerate,
    includeHigh: item.includeHigh,
    dependencies: item.dependencies,
    status: item.status,
    notes: item.notes,
    historical: item.historical,
  };
}

export function InterventionForm({ assessmentId, initial, components }: { assessmentId: string; initial: InterventionDTO | null; components: { id: string; groupName: string }[] }) {
  const router = useRouter();
  const blank: InterventionWrite = {
    componentId: components[0]?.id ?? null,
    title: "",
    targetYear: null,
    earliestYear: null,
    latestYear: null,
    lowCost: null,
    highCost: null,
    useComponentCost: false,
    includeLow: false,
    includeModerate: true,
    includeHigh: true,
    dependencies: "",
    status: "Recommended",
    notes: "",
    historical: false,
  };
  const [form, setForm] = useState<InterventionWrite>(initial ? interventionState(initial) : blank);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  function patch(partial: Partial<InterventionWrite>) {
    setForm((current) => ({ ...current, ...partial }));
    setSaved(false);
  }
  return (
    <form className="stack panel" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true);
      setError(null);
      const result = await saveInterventionAction(assessmentId, form);
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      if (!form.id) setForm(blank);
      router.refresh();
    }}>
      <div className="fields">
        <label className="field wide"><span>Title</span><input value={form.title} onChange={(e) => patch({ title: e.target.value })} /></label>
        <label className="field"><span>Component</span>
          <select value={form.componentId ?? ""} onChange={(e) => patch({ componentId: e.target.value || null })}>
            <option value="">None</option>
            {components.map((component) => <option key={component.id} value={component.id}>{component.groupName}</option>)}
          </select>
        </label>
        <label className="field"><span>Status</span>
          <select value={form.status} onChange={(e) => patch({ status: e.target.value })}>
            {INTERVENTION_STATUSES.map((status) => <option key={status}>{status}</option>)}
          </select>
        </label>
        <label className="field"><span>Target year</span><input value={form.targetYear ?? ""} onChange={(e) => patch({ targetYear: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Earliest year</span><input value={form.earliestYear ?? ""} onChange={(e) => patch({ earliestYear: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Latest year</span><input value={form.latestYear ?? ""} onChange={(e) => patch({ latestYear: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Base low (CHF)</span><input value={form.lowCost ?? ""} onChange={(e) => patch({ lowCost: intOrNull(e.target.value) })} disabled={form.useComponentCost} /></label>
        <label className="field"><span>Base high (CHF)</span><input value={form.highCost ?? ""} onChange={(e) => patch({ highCost: intOrNull(e.target.value) })} disabled={form.useComponentCost} /></label>
        <label className="field wide"><span>Dependencies</span><input value={form.dependencies} onChange={(e) => patch({ dependencies: e.target.value })} /></label>
        <label className="field wide"><span>Notes</span><textarea value={form.notes} onChange={(e) => patch({ notes: e.target.value })} /></label>
      </div>
      <div className="row">
        <label><input type="checkbox" checked={form.useComponentCost} onChange={(e) => patch({ useComponentCost: e.target.checked })} /> Use component cost</label>
        <label><input type="checkbox" checked={form.includeLow} onChange={(e) => patch({ includeLow: e.target.checked })} /> Low scenario</label>
        <label><input type="checkbox" checked={form.includeModerate} onChange={(e) => patch({ includeModerate: e.target.checked })} /> Moderate scenario</label>
        <label><input type="checkbox" checked={form.includeHigh} onChange={(e) => patch({ includeHigh: e.target.checked })} /> High scenario</label>
        <label><input type="checkbox" checked={form.historical} onChange={(e) => patch({ historical: e.target.checked })} /> Historical</label>
      </div>
      <Notice error={error} saved={saved} />
      <div className="row">
        <button className="btn" disabled={pending} type="submit">{pending ? "Saving…" : initial ? "Save intervention" : "Add intervention"}</button>
        {initial ? <button type="button" className="btn danger" onClick={async () => {
          if (!confirm("Delete this intervention? This cannot be undone.")) return;
          const result = await deleteInterventionAction(initial.id);
          if (!result.ok) setError(result.error);
          else router.refresh();
        }}>Delete</button> : null}
      </div>
    </form>
  );
}

export function RoadmapForm({ assessmentId, rows }: { assessmentId: string; rows: InterventionDTO[] }) {
  const router = useRouter();
  const [items, setItems] = useState(rows.map((row) => ({ id: row.id, title: row.title, targetYear: row.targetYear, earliestYear: row.earliestYear, latestYear: row.latestYear, historical: row.historical })));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true);
      setError(null);
      const result = await saveRoadmapAction(assessmentId, items.map(({ id, targetYear, earliestYear, latestYear, historical }) => ({ id, targetYear, earliestYear, latestYear, historical })));
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    }}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Intervention</th><th>Earliest</th><th>Target</th><th>Latest</th><th>Historical</th></tr></thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id}>
                <td>{item.title}</td>
                <td><input aria-label={`${item.title} earliest year`} value={item.earliestYear ?? ""} onChange={(e) => setItems((current) => current.map((row, i) => i === index ? { ...row, earliestYear: intOrNull(e.target.value) } : row))} /></td>
                <td><input aria-label={`${item.title} target year`} value={item.targetYear ?? ""} onChange={(e) => setItems((current) => current.map((row, i) => i === index ? { ...row, targetYear: intOrNull(e.target.value) } : row))} /></td>
                <td><input aria-label={`${item.title} latest year`} value={item.latestYear ?? ""} onChange={(e) => setItems((current) => current.map((row, i) => i === index ? { ...row, latestYear: intOrNull(e.target.value) } : row))} /></td>
                <td><input type="checkbox" aria-label={`${item.title} historical`} checked={item.historical} onChange={(e) => setItems((current) => current.map((row, i) => i === index ? { ...row, historical: e.target.checked } : row))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Notice error={error} saved={saved} />
      <button className="btn" disabled={pending} type="submit">{pending ? "Saving…" : "Save roadmap years"}</button>
    </form>
  );
}

export function FinancialForm({ assessmentId, initial }: { assessmentId: string; initial: FinancialDTO | null }) {
  const router = useRouter();
  const [form, setForm] = useState({
    reserveBalance: initial?.reserveBalance ?? null,
    annualContribution: initial?.annualContribution ?? null,
    annualMaintenance: initial?.annualMaintenance ?? null,
    specialContributions: initial?.specialContributions ?? null,
    otherFundingAnnual: initial?.otherFundingAnnual ?? null,
    existingFinancingNote: initial?.existingFinancingNote ?? "",
    otherObligations: initial?.otherObligations ?? null,
    notes: initial?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const field = (key: "reserveBalance" | "annualContribution" | "annualMaintenance" | "specialContributions" | "otherFundingAnnual" | "otherObligations", label: string) => (
    <label className="field" key={key}><span>{label} (CHF)</span>
      <input value={form[key] ?? ""} onChange={(e) => { setForm({ ...form, [key]: intOrNull(e.target.value) }); setSaved(false); }} />
    </label>
  );
  return (
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true);
      const result = await saveFinancialAction(assessmentId, form);
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setError(null);
      router.refresh();
    }}>
      <div className="fields">
        {field("reserveBalance", "Current reserve fund")}
        {field("annualContribution", "Annual reserve contribution")}
        {field("annualMaintenance", "Current annual maintenance budget")}
        {field("specialContributions", "Special contribution (first projection year)")}
        {field("otherFundingAnnual", "Other funding per year")}
        {field("otherObligations", "Other known obligations (recorded, not in the formula)")}
        <label className="field wide"><span>Existing financing note</span><textarea value={form.existingFinancingNote} onChange={(e) => setForm({ ...form, existingFinancingNote: e.target.value })} /></label>
        <label className="field wide"><span>Notes</span><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      <p className="muted">Formula: Opening + Contributions + Other funding − Planned expenditure = Closing. A negative closing balance is a projected funding gap. This screen never recommends a financing product. Maintenance is context only.</p>
      <Notice error={error} saved={saved} />
      <button className="btn" disabled={pending} type="submit">{pending ? "Saving…" : "Save financial profile"}</button>
    </form>
  );
}

export function MetaForm({ assessmentId, initial }: { assessmentId: string; initial: { assessmentDate: string; status: string; overallConfidence: string; notes: string; contingencyPct: number } }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true);
      const result = await saveAssessmentMetaAction(assessmentId, form);
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setError(null);
      router.refresh();
    }}>
      <div className="fields">
        <label className="field"><span>Assessment date</span><input type="date" value={form.assessmentDate} onChange={(e) => setForm({ ...form, assessmentDate: e.target.value })} /></label>
        <label className="field"><span>Status</span>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="draft">Draft</option>
            <option value="in_review">In review</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label className="field"><span>Overall confidence</span>
          <select value={form.overallConfidence} onChange={(e) => setForm({ ...form, overallConfidence: e.target.value })}>
            {CONFIDENCE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
        <label className="field"><span>Contingency % for this assessment</span><input value={form.contingencyPct} onChange={(e) => setForm({ ...form, contingencyPct: Number(e.target.value) })} /></label>
        <label className="field wide"><span>Assessment notes</span><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      {form.contingencyPct < 10 || form.contingencyPct > 20 ? <p className="msg warn">The usual planning range is 10–20%. {form.contingencyPct}% will still be used if you save it.</p> : null}
      <Notice error={error} saved={saved} />
      <div className="row">
        <button className="btn" disabled={pending} type="submit">{pending ? "Saving…" : "Save assessment details"}</button>
        <button type="button" className="btn secondary" onClick={async () => {
          const result = await applyScoringAction(assessmentId);
          if (!result.ok) setError(result.error);
          else router.refresh();
        }}>Apply current organization scoring settings</button>
      </div>
    </form>
  );
}

export function EnergyForm({ assessmentId, initial }: { assessmentId: string; initial: EnergyDTO[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      const result = await saveEnergyAction(assessmentId, rows);
      if (!result.ok) setError(result.error);
      else {
        setError(null);
        setSaved(true);
        router.refresh();
      }
    }}>
      <p className="muted">Qualitative only. Do not enter a savings claim unless the source data supports it. Technical verification stays required.</p>
      {rows.map((row, index) => (
        <div className="panel fields" key={row.topicKey}>
          <h3 className="wide">{ENERGY_TOPICS.find((topic) => topic.key === row.topicKey)?.label}</h3>
          <label className="field"><span>Investment low (CHF)</span><input value={row.investmentLow ?? ""} onChange={(e) => setRows((current) => current.map((item, i) => i === index ? { ...item, investmentLow: intOrNull(e.target.value) } : item))} /></label>
          <label className="field"><span>Investment high (CHF)</span><input value={row.investmentHigh ?? ""} onChange={(e) => setRows((current) => current.map((item, i) => i === index ? { ...item, investmentHigh: intOrNull(e.target.value) } : item))} /></label>
          <label className="field wide"><span>Qualitative benefit</span><input value={row.qualitativeBenefit} onChange={(e) => setRows((current) => current.map((item, i) => i === index ? { ...item, qualitativeBenefit: e.target.value } : item))} /></label>
          <label className="field wide"><span>Dependency</span><input value={row.dependencyNote} onChange={(e) => setRows((current) => current.map((item, i) => i === index ? { ...item, dependencyNote: e.target.value } : item))} /></label>
          <label className="field wide"><span>Notes</span><input value={row.notes} onChange={(e) => setRows((current) => current.map((item, i) => i === index ? { ...item, notes: e.target.value } : item))} /></label>
        </div>
      ))}
      <Notice error={error} saved={saved} />
      <button className="btn" type="submit">Save energy notes</button>
    </form>
  );
}

export function VersionButton({ assessmentId }: { assessmentId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button type="button" className="btn secondary" onClick={async () => {
        const result = await newVersionAction(assessmentId);
        if (!result.ok || !result.id) setError(result.ok ? "No version id returned." : result.error);
        else router.push(`/assessments/${result.id}`);
      }}>Create new version</button>
      {error ? <p className="msg error" role="alert">{error}</p> : null}
    </div>
  );
}
