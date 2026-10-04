"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CANTONS, DOCUMENT_CATEGORIES, LEAD_STAGES } from "@/domain/constants";
import type { CostAssumptionDTO, LeadDTO, UsefulLifeDTO } from "@/domain/dto";
import { loginAction, logoutAction, saveLeadAction, updateBrandingAction, updateCostAssumptionAction, updateSettingsAction, updateUsefulLifeAction, generateReportAction, startAssessmentAction } from "@/server/actions";
import type { PriorityThresholds, PriorityWeights } from "@/domain/calculations";

function Notice({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) return <p className="msg error" role="alert">{error}</p>;
  if (saved) return <p className="msg ok" role="status">Saved.</p>;
  return null;
}
function intOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@stweg.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="stack panel" onSubmit={async (event) => {
      event.preventDefault();
      setPending(true);
      const result = await loginAction(email, password);
      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    }}>
      <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <Notice error={error} saved={false} />
      <button className="btn" disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return <button type="button" className="btn secondary" onClick={async () => { await logoutAction(); router.push("/login"); router.refresh(); }}>Sign out</button>;
}

export function StartAssessmentButton({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button type="button" className="btn" onClick={async () => {
        const result = await startAssessmentAction(propertyId);
        if (!result.ok || !result.id) setError(result.ok ? "Assessment was not created." : result.error);
        else router.push(`/assessments/${result.id}`);
      }}>Start assessment</button>
      {error ? <p className="msg error" role="alert">{error}</p> : null}
    </div>
  );
}

export function LeadForm({ initial, properties }: { initial: LeadDTO | null; properties: { id: string; name: string }[] }) {
  const router = useRouter();
  const [form, setForm] = useState({
    id: initial?.id,
    name: initial?.name ?? "",
    leadOrganization: initial?.leadOrganization ?? "",
    propertyId: initial?.propertyId ?? "",
    contact: initial?.contact ?? "",
    source: initial?.source ?? "",
    stage: initial?.stage ?? "Lead",
    estimatedOpportunity: initial?.estimatedOpportunity ?? null,
    nextAction: initial?.nextAction ?? "",
    notes: initial?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form className="stack panel" onSubmit={async (event) => {
      event.preventDefault();
      const result = await saveLeadAction({ ...form, propertyId: form.propertyId || null });
      if (!result.ok) setError(result.error);
      else {
        setError(null);
        setSaved(true);
        if (!form.id) setForm({ id: undefined, name: "", leadOrganization: "", propertyId: "", contact: "", source: "", stage: "Lead", estimatedOpportunity: null, nextAction: "", notes: "" });
        router.refresh();
      }
    }}>
      <div className="fields">
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Organization</span><input value={form.leadOrganization} onChange={(e) => setForm({ ...form, leadOrganization: e.target.value })} /></label>
        <label className="field"><span>Property</span>
          <select value={form.propertyId ?? ""} onChange={(e) => setForm({ ...form, propertyId: e.target.value })}>
            <option value="">None</option>
            {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Contact</span><input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></label>
        <label className="field"><span>Source</span><input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
        <label className="field"><span>Stage</span>
          <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
            {LEAD_STAGES.map((stage) => <option key={stage}>{stage}</option>)}
          </select>
        </label>
        <label className="field"><span>Estimated opportunity (CHF)</span><input value={form.estimatedOpportunity ?? ""} onChange={(e) => setForm({ ...form, estimatedOpportunity: intOrNull(e.target.value) })} /></label>
        <label className="field"><span>Next action</span><input value={form.nextAction} onChange={(e) => setForm({ ...form, nextAction: e.target.value })} /></label>
        <label className="field wide"><span>Notes</span><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      <p className="muted">This is a lead list, not accounting. No invoice is created.</p>
      <Notice error={error} saved={saved} />
      <button className="btn" type="submit">{initial ? "Save lead" : "Add lead"}</button>
    </form>
  );
}

export function DocumentUpload({ properties }: { properties: { id: string; name: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <form className="stack panel" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setPending(true);
      setError(null);
      const response = await fetch("/api/uploads/document", { method: "POST", body: new FormData(form) });
      const payload = await response.json().catch(() => ({ error: "Upload failed." }));
      setPending(false);
      if (!response.ok) {
        setError(payload.error || "We could not store that document. The form is unchanged. Please retry.");
        return;
      }
      setSaved(true);
      form.reset();
      router.refresh();
    }}>
      <div className="fields">
        <label className="field"><span>Property</span>
          <select name="propertyId" required defaultValue={properties[0]?.id ?? ""}>
            {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Category</span>
          <select name="category" required defaultValue="property_plans">
            {DOCUMENT_CATEGORIES.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}
          </select>
        </label>
        <label className="field wide"><span>File</span><input name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx" /></label>
        <label className="field"><span>Document name</span><input name="name" placeholder="Uses the file name if empty" /></label>
        <label className="field"><span>Document date</span><input name="documentDate" type="date" /></label>
        <label className="field"><span>Source</span><input name="source" /></label>
        <label className="field wide"><span>Description</span><textarea name="description" /></label>
      </div>
      <Notice error={error} saved={saved} />
      <button className="btn" disabled={pending} type="submit">{pending ? "Uploading…" : "Upload document"}</button>
    </form>
  );
}

export function PhotoUpload({ componentId }: { componentId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="row" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      data.set("componentId", componentId);
      const response = await fetch("/api/uploads/photo", { method: "POST", body: data });
      const payload = await response.json().catch(() => ({ error: "Upload failed." }));
      if (!response.ok) {
        setError(payload.error || "We could not store that photo. Please retry.");
        return;
      }
      setError(null);
      form.reset();
      router.refresh();
    }}>
      <input type="file" name="file" accept=".jpg,.jpeg,.png" aria-label="Component photo" required />
      <input name="caption" aria-label="Caption" placeholder="Caption" />
      <button className="btn secondary" type="submit">Attach photo</button>
      {error ? <p className="msg error" role="alert">{error}</p> : null}
    </form>
  );
}

export function SettingsForms({
  isAdmin,
  branding,
  settings,
  assumptions,
  lives,
}: {
  isAdmin: boolean;
  branding: { companyName: string; productName: string; address: string; footer: string };
  settings: { weights: PriorityWeights; thresholds: PriorityThresholds; contingencyPct: number; disclaimer: string; regulatoryNotes: string };
  assumptions: CostAssumptionDTO[];
  lives: UsefulLifeDTO[];
}) {
  const router = useRouter();
  const [brand, setBrand] = useState(branding);
  const [score, setScore] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!isAdmin) {
    return <p className="msg warn">Project managers can read these settings but cannot edit global cost assumptions, weights, thresholds, the default contingency, the disclaimer, or branding.</p>;
  }
  return (
    <div className="stack">
      <form className="panel stack" onSubmit={async (event) => {
        event.preventDefault();
        const result = await updateBrandingAction(brand);
        if (!result.ok) setError(result.error);
        else { setSaved(true); setError(null); router.refresh(); }
      }}>
        <h2>Branding</h2>
        <div className="fields">
          <label className="field"><span>Company name</span><input value={brand.companyName} onChange={(e) => setBrand({ ...brand, companyName: e.target.value })} /></label>
          <label className="field"><span>Product name</span><input value={brand.productName} onChange={(e) => setBrand({ ...brand, productName: e.target.value })} /></label>
          <label className="field wide"><span>Address</span><textarea value={brand.address} onChange={(e) => setBrand({ ...brand, address: e.target.value })} /></label>
          <label className="field wide"><span>Report footer</span><textarea value={brand.footer} onChange={(e) => setBrand({ ...brand, footer: e.target.value })} /></label>
        </div>
        <button className="btn" type="submit">Save branding</button>
      </form>
      <form className="panel stack" onSubmit={async (event) => {
        event.preventDefault();
        const result = await updateSettingsAction(score);
        if (!result.ok) setError(result.error);
        else { setSaved(true); setError(null); router.refresh(); }
      }}>
        <h2>Scoring, contingency, disclaimer</h2>
        <div className="fields">
          {(["condition", "urgency", "consequence", "escalation"] as const).map((key) => (
            <label className="field" key={key}><span>{key} weight</span>
              <input value={score.weights[key]} onChange={(e) => setScore({ ...score, weights: { ...score.weights, [key]: Number(e.target.value) } })} />
            </label>
          ))}
          {(["critical", "high", "medium", "low"] as const).map((key) => (
            <label className="field" key={key}><span>{key} threshold</span>
              <input value={score.thresholds[key]} onChange={(e) => setScore({ ...score, thresholds: { ...score.thresholds, [key]: Number(e.target.value) } })} />
            </label>
          ))}
          <label className="field"><span>Default contingency %</span><input value={score.contingencyPct} onChange={(e) => setScore({ ...score, contingencyPct: Number(e.target.value) })} /></label>
          <label className="field wide"><span>Disclaimer</span><textarea value={score.disclaimer} onChange={(e) => setScore({ ...score, disclaimer: e.target.value })} /></label>
          <label className="field wide"><span>Regulatory / assumption notes</span><textarea value={score.regulatoryNotes} onChange={(e) => setScore({ ...score, regulatoryNotes: e.target.value })} /></label>
        </div>
        <button className="btn" type="submit">Save settings</button>
      </form>
      {assumptions.map((assumption) => <CostEditor key={assumption.id} assumption={assumption} onError={setError} onSaved={() => { setSaved(true); router.refresh(); }} />)}
      {lives.map((life) => <LifeEditor key={life.id} life={life} onError={setError} onSaved={() => { setSaved(true); router.refresh(); }} />)}
      <Notice error={error} saved={saved} />
    </div>
  );
}

function CostEditor({ assumption, onError, onSaved }: { assumption: CostAssumptionDTO; onError: (value: string | null) => void; onSaved: () => void }) {
  const [form, setForm] = useState(assumption);
  return (
    <form className="panel stack" onSubmit={async (event) => {
      event.preventDefault();
      const result = await updateCostAssumptionAction(form);
      if (!result.ok) onError(result.error);
      else { onError(null); onSaved(); }
    }}>
      <h2>Cost assumption {form.componentType}</h2>
      <div className="fields">
        <label className="field"><span>Basis</span><input value={form.costBasis} onChange={(e) => setForm({ ...form, costBasis: e.target.value })} /></label>
        <label className="field"><span>Unit</span><input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></label>
        <label className="field"><span>Low unit cost</span><input value={form.lowUnitCost} onChange={(e) => setForm({ ...form, lowUnitCost: Number(e.target.value) })} /></label>
        <label className="field"><span>High unit cost</span><input value={form.highUnitCost} onChange={(e) => setForm({ ...form, highUnitCost: Number(e.target.value) })} /></label>
        <label className="field"><span>Region</span><input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label>
        <label className="field"><span>Effective date</span><input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} /></label>
        <label className="field wide"><span>Source</span><input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
        <label className="field wide"><span>Notes</span><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>
      <button className="btn secondary" type="submit">Save assumption</button>
    </form>
  );
}

function LifeEditor({ life, onError, onSaved }: { life: UsefulLifeDTO; onError: (value: string | null) => void; onSaved: () => void }) {
  const [form, setForm] = useState(life);
  return (
    <form className="panel row" onSubmit={async (event) => {
      event.preventDefault();
      const result = await updateUsefulLifeAction(form);
      if (!result.ok) onError(result.error);
      else { onError(null); onSaved(); }
    }}>
      <strong>{form.groupCode}</strong>
      <label className="field"><span>Life low</span><input value={form.lifeLow} onChange={(e) => setForm({ ...form, lifeLow: Number(e.target.value) })} /></label>
      <label className="field"><span>Life high</span><input value={form.lifeHigh} onChange={(e) => setForm({ ...form, lifeHigh: Number(e.target.value) })} /></label>
      <button className="btn secondary" type="submit">Save life</button>
    </form>
  );
}

export function GenerateReportButton({ assessmentId }: { assessmentId: string }) {
  const router = useRouter();
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <div className="stack">
      <label><input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} /> I have reviewed the warnings. Generate the report anyway if only warnings remain.</label>
      <button type="button" className="btn" onClick={async () => {
        const result = await generateReportAction(assessmentId, acknowledge);
        if (!result.ok) {
          setError(result.error);
          setErrors("errors" in result && result.errors ? result.errors : []);
          return;
        }
        router.push(`/reports/${assessmentId}`);
        router.refresh();
      }}>Generate released report</button>
      {error ? <p className="msg error" role="alert">{error}</p> : null}
      {errors.length ? <ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul> : null}
    </div>
  );
}

export function PrintButton() {
  return <button type="button" className="btn" onClick={() => window.print()}>Print / save as PDF</button>;
}

export function PropertyFilters({ q, canton, status, municipality }: { q: string; canton: string; status: string; municipality: string }) {
  return (
    <form className="fields" method="get">
      <label className="field"><span>Search name or municipality</span><input name="q" defaultValue={q} /></label>
      <label className="field"><span>Municipality</span><input name="municipality" defaultValue={municipality} /></label>
      <label className="field"><span>Canton</span>
        <select name="canton" defaultValue={canton}><option value="">All</option>{CANTONS.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}</select>
      </label>
      <label className="field"><span>Status</span>
        <select name="status" defaultValue={status}><option value="">All</option><option value="active">Active</option><option value="archived">Archived</option></select>
      </label>
      <button className="btn" type="submit">Filter</button>
    </form>
  );
}
