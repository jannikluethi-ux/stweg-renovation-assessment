"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CANTONS } from "@/domain/constants";
import type { ProfileFieldDTO } from "@/domain/dto";
import { createPropertyAction, updateProfileAction, updatePropertyAction } from "@/server/actions";
import type { PropertyWrite } from "@/lib/mutations";

function Notice({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) return <p className="msg error" role="alert">{error}</p>;
  if (saved) return <p className="msg ok" role="status">Saved. Your entries are stored.</p>;
  return null;
}

function num(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function PropertyForm({ mode, initial, propertyId }: { mode: "create" | "edit"; initial: PropertyWrite; propertyId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  function set<K extends keyof PropertyWrite>(key: K, value: PropertyWrite[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }
  async function submit() {
    setPending(true);
    setError(null);
    const result = mode === "create" ? await createPropertyAction(form) : await updatePropertyAction(propertyId || "", form);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (mode === "create" && result.id) router.push(`/properties/${result.id}`);
    else {
      setSaved(true);
      router.refresh();
    }
  }
  const yesNo = (key: keyof PropertyWrite, label: string) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <select aria-label={label} value={String(form[key])} onChange={(event) => set(key, event.target.value as PropertyWrite[typeof key])}>
        <option value="yes">Yes</option>
        <option value="no">No</option>
        <option value="unknown">Unknown</option>
      </select>
    </label>
  );
  const steps = mode === "create" ? step : 3;
  return (
    <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {mode === "create" ? (
        <div className="steps" aria-label="Wizard steps">
          <span className={step === 1 ? "on" : ""}>1. Place</span>
          <span className={step === 2 ? "on" : ""}>2. Size</span>
          <span className={step === 3 ? "on" : ""}>3. Features</span>
        </div>
      ) : null}
      {steps === 1 || mode === "edit" ? (
        <div className="fields">
          <label className="field wide"><span>Property name</span><input required value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label className="field wide"><span>Street</span><input value={form.street} onChange={(e) => set("street", e.target.value)} /></label>
          <label className="field"><span>ZIP</span><input inputMode="numeric" value={form.zip} onChange={(e) => set("zip", e.target.value)} /></label>
          <label className="field"><span>Municipality</span><input value={form.municipality} onChange={(e) => set("municipality", e.target.value)} /></label>
          <label className="field"><span>Canton</span>
            <select value={form.canton} onChange={(e) => set("canton", e.target.value)}>
              {CANTONS.map((canton) => <option key={canton.code} value={canton.code}>{canton.code} — {canton.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Country</span><input value={form.country} onChange={(e) => set("country", e.target.value)} /></label>
          {mode === "edit" ? (
            <label className="field"><span>Status</span>
              <select value={form.status} onChange={(e) => set("status", e.target.value)}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {(steps === 2 || mode === "edit") && mode === "create" ? (
        <div className="fields">
          <label className="field"><span>Year built</span><input value={form.yearBuilt ?? ""} onChange={(e) => set("yearBuilt", num(e.target.value))} /></label>
          <label className="field"><span>Year of first occupation</span><input value={form.yearFirstOccupation ?? ""} onChange={(e) => set("yearFirstOccupation", num(e.target.value))} /></label>
          <label className="field"><span>Buildings</span><input value={form.buildings ?? ""} onChange={(e) => set("buildings", num(e.target.value))} /></label>
          <label className="field"><span>Apartments / units</span><input value={form.units ?? ""} onChange={(e) => set("units", num(e.target.value))} /></label>
          <label className="field"><span>Owners</span><input value={form.owners ?? ""} onChange={(e) => set("owners", num(e.target.value))} /></label>
          <label className="field"><span>Floors</span><input value={form.floors ?? ""} onChange={(e) => set("floors", num(e.target.value))} /></label>
        </div>
      ) : null}
      {mode === "edit" ? (
        <div className="fields">
          <label className="field"><span>Year built</span><input value={form.yearBuilt ?? ""} onChange={(e) => set("yearBuilt", num(e.target.value))} /></label>
          <label className="field"><span>Year of first occupation</span><input value={form.yearFirstOccupation ?? ""} onChange={(e) => set("yearFirstOccupation", num(e.target.value))} /></label>
          <label className="field"><span>Buildings</span><input value={form.buildings ?? ""} onChange={(e) => set("buildings", num(e.target.value))} /></label>
          <label className="field"><span>Apartments / units</span><input value={form.units ?? ""} onChange={(e) => set("units", num(e.target.value))} /></label>
          <label className="field"><span>Owners</span><input value={form.owners ?? ""} onChange={(e) => set("owners", num(e.target.value))} /></label>
          <label className="field"><span>Floors</span><input value={form.floors ?? ""} onChange={(e) => set("floors", num(e.target.value))} /></label>
        </div>
      ) : null}
      {steps === 3 || mode === "edit" ? (
        <div className="fields">
          {yesNo("basementPresent", "Basement present")}
          {yesNo("undergroundParking", "Underground parking")}
          {yesNo("outdoorParking", "Outdoor parking")}
          {yesNo("hasLift", "Lift")}
          {yesNo("balconyTerrace", "Balcony / terrace")}
          {yesNo("garden", "Garden / common outdoor space")}
        </div>
      ) : null}
      <Notice error={error} saved={saved} />
      <div className="row">
        {mode === "create" && step > 1 ? <button type="button" className="btn secondary" onClick={() => setStep(step - 1)}>Back</button> : null}
        {mode === "create" && step < 3 ? <button type="button" className="btn" onClick={() => setStep(step + 1)}>Continue</button> : null}
        {mode === "edit" || step === 3 ? <button className="btn" type="submit" disabled={pending}>{pending ? "Saving…" : mode === "create" ? "Create property" : "Save property"}</button> : null}
      </div>
    </form>
  );
}

export function ProfileForm({ propertyId, initial }: { propertyId: string; initial: ProfileFieldDTO[] }) {
  const router = useRouter();
  const [fields, setFields] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const sections = ["Construction", "Technical systems", "Common areas"];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await updateProfileAction(propertyId, fields.map((field) => ({ key: field.key, status: field.status, value: field.value })));
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }
  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted">Each field can be known, unknown, or not applicable. Unknown is stored as unknown. Do not invent a value.</p>
      {sections.map((section) => (
        <section key={section} className="panel stack">
          <h2>{section}</h2>
          <div className="fields">
            {fields.map((field, index) => field.section === section ? (
              <div className="field" key={field.key}>
                <span>{field.label}</span>
                <select aria-label={`${field.label} status`} value={field.status} onChange={(event) => {
                  const status = event.target.value as ProfileFieldDTO["status"];
                  setFields((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, status } : item));
                  setSaved(false);
                }}>
                  <option value="known">Known</option>
                  <option value="unknown">Unknown</option>
                  <option value="na">Not applicable</option>
                </select>
                {field.status === "known" ? (
                  <input aria-label={field.label} value={field.value} onChange={(event) => {
                    const value = event.target.value;
                    setFields((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item));
                    setSaved(false);
                  }} />
                ) : <p className="muted">{field.status === "na" ? "Not applicable." : "Further technical verification recommended if this becomes relevant."}</p>}
              </div>
            ) : null)}
          </div>
        </section>
      ))}
      <Notice error={error} saved={saved} />
      <button className="btn" disabled={pending} type="submit">{pending ? "Saving…" : "Save building profile"}</button>
    </form>
  );
}
