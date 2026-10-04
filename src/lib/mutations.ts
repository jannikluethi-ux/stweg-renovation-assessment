import type Database from "better-sqlite3";
import { CANTONS, COMPONENT_GROUPS, CONFIDENCE_LEVELS, ENERGY_TOPICS, INTERVENTION_STATUSES, LEAD_STAGES, PROFILE_FIELDS, RECOMMENDED_ACTIONS } from "../domain/constants";
import type { ComponentDTO, EnergyDTO } from "../domain/dto";
import { thresholdsAreValid, validateInterventionYears, weightsAreValid, zurichYear, type PriorityThresholds, type PriorityWeights } from "../domain/calculations";
import { canEditGlobalAssumptions, getDb, nowIso, writeAudit, type SessionUser } from "./db";
import { componentCost, getProperty, getSettings, latestAssessmentId, loadBundle } from "./repo";

type Row = Record<string, any>;
type Result = { ok: true; id?: string } | { ok: false; error: string };

function database(): Database.Database {
  return getDb();
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return Number.NaN;
  return parsed;
}

function moneyOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return Math.round(parsed);
}

const TRI = new Set(["known", "unknown", "na"]);
const YES = new Set(["yes", "no", "unknown"]);

export interface PropertyWrite {
  name: string;
  street: string;
  zip: string;
  municipality: string;
  canton: string;
  country: string;
  yearBuilt: number | null;
  yearFirstOccupation: number | null;
  buildings: number | null;
  units: number | null;
  owners: number | null;
  floors: number | null;
  basementPresent: string;
  undergroundParking: string;
  outdoorParking: string;
  hasLift: string;
  balconyTerrace: string;
  garden: string;
  status: string;
}

function validateProperty(input: PropertyWrite): string | null {
  if (!clean(input.name)) return "Property name is required.";
  if (!clean(input.street) || !clean(input.municipality)) return "Street and municipality are required. Leave a field blank only when you use the profile's Unknown status.";
  if (input.zip && !/^\d{4}$/.test(input.zip.trim())) return "Swiss postal codes are 4 digits. Correct the ZIP or clear it.";
  if (!CANTONS.some((canton) => canton.code === input.canton)) return "Choose a Swiss canton from the list.";
  if (!clean(input.country)) return "Country is required. It defaults to Switzerland.";
  for (const [label, value] of [
    ["Year built", input.yearBuilt],
    ["Year of first occupation", input.yearFirstOccupation],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 1800 || value > zurichYear() + 2)) {
      return `${label} must be a reasonable year, or left empty if unknown.`;
    }
  }
  for (const [label, value] of [
    ["Buildings", input.buildings],
    ["Units", input.units],
    ["Owners", input.owners],
    ["Floors", input.floors],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0 || value > 5000)) return `${label} must be a whole number, or empty if unknown.`;
  }
  for (const value of [input.basementPresent, input.undergroundParking, input.outdoorParking, input.hasLift, input.balconyTerrace, input.garden]) {
    if (!YES.has(value)) return "Yes / no / unknown fields contain an invalid value.";
  }
  if (!["active", "archived"].includes(input.status)) return "Status must be active or archived.";
  return null;
}

export function createProperty(user: SessionUser, input: PropertyWrite): Result {
  const error = validateProperty(input);
  if (error) return { ok: false, error };
  const id = crypto.randomUUID();
  const ts = nowIso();
  const tx = database().transaction(() => {
    database()
      .prepare(
        `INSERT INTO properties (
          id, organization_id, name, street, zip, municipality, canton, country, year_built, year_first_occupation,
          buildings, units, owners, floors, basement_present, underground_parking, outdoor_parking, has_lift,
          balcony_terrace, garden, status, is_demo, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', ?, ?)`,
      )
      .run(
        id, user.organizationId, clean(input.name), clean(input.street), clean(input.zip), clean(input.municipality), input.canton,
        clean(input.country) || "Switzerland", input.yearBuilt, input.yearFirstOccupation, input.buildings, input.units, input.owners,
        input.floors, input.basementPresent, input.undergroundParking, input.outdoorParking, input.hasLift, input.balconyTerrace,
        input.garden, input.status, ts, ts,
      );
    database().prepare(`INSERT INTO building_profiles (property_id, updated_at) VALUES (?, ?)`).run(id, ts);
    writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "property", entityId: id, action: "create", newValue: { name: input.name } });
  });
  tx();
  return { ok: true, id };
}

export function updateProperty(user: SessionUser, propertyId: string, input: PropertyWrite): Result {
  const existing = getProperty(user.organizationId, propertyId);
  if (!existing) return { ok: false, error: "That property is not in your organization." };
  const error = validateProperty(input);
  if (error) return { ok: false, error };
  const ts = nowIso();
  database()
    .prepare(
      `UPDATE properties SET name=?, street=?, zip=?, municipality=?, canton=?, country=?, year_built=?, year_first_occupation=?,
       buildings=?, units=?, owners=?, floors=?, basement_present=?, underground_parking=?, outdoor_parking=?, has_lift=?,
       balcony_terrace=?, garden=?, status=?, updated_at=? WHERE id=? AND organization_id=?`,
    )
    .run(
      clean(input.name), clean(input.street), clean(input.zip), clean(input.municipality), input.canton, clean(input.country),
      input.yearBuilt, input.yearFirstOccupation, input.buildings, input.units, input.owners, input.floors, input.basementPresent,
      input.undergroundParking, input.outdoorParking, input.hasLift, input.balconyTerrace, input.garden, input.status, ts, propertyId, user.organizationId,
    );
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "property", entityId: propertyId, action: "update", previousValue: { name: existing.name }, newValue: { name: input.name } });
  return { ok: true, id: propertyId };
}

export function updateProfile(user: SessionUser, propertyId: string, fields: { key: string; status: string; value: string }[]): Result {
  if (!getProperty(user.organizationId, propertyId)) return { ok: false, error: "That property is not in your organization." };
  const allowed = new Map(PROFILE_FIELDS.map((field) => [field.key, field]));
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const field of fields) {
    const def = allowed.get(field.key);
    if (!def) return { ok: false, error: "A profile field was not recognised, so nothing was saved." };
    if (!TRI.has(field.status)) return { ok: false, error: `${def.label}: status must be known, unknown, or not applicable.` };
    let stored: string | number | null = null;
    if (field.status === "known") {
      if (def.kind === "year") {
        if (!field.value.trim()) return { ok: false, error: `${def.label} needs a year, or mark it unknown. Nothing was saved.` };
        const year = Number(field.value);
        if (!Number.isInteger(year) || year < 1800 || year > 2100) return { ok: false, error: `${def.label} must be a four-digit year, or marked unknown.` };
        stored = year;
      } else {
        stored = field.value.trim();
      }
    }
    assignments.push(`${field.key} = ?`, `${field.key}_status = ?`);
    values.push(stored, field.status);
  }
  assignments.push("updated_at = ?");
  values.push(nowIso(), propertyId);
  database().prepare(`UPDATE building_profiles SET ${assignments.join(", ")} WHERE property_id = ?`).run(...values);
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "property", entityId: propertyId, action: "update_profile", newValue: { fields: fields.length } });
  return { ok: true, id: propertyId };
}

function insertFramework(database: Database.Database, assessmentId: string, organizationId: string, ts: string): void {
  const assumptions = database.prepare(`SELECT * FROM cost_assumptions WHERE organization_id = ?`).all(organizationId) as Row[];
  const lives = database.prepare(`SELECT * FROM useful_life_defaults WHERE organization_id = ?`).all(organizationId) as Row[];
  for (const group of COMPONENT_GROUPS) {
    const componentId = crypto.randomUUID();
    const assumption = assumptions.find((row) => row.component_type === group.code);
    const life = lives.find((row) => row.group_code === group.code);
    database
      .prepare(
        `INSERT INTO assessment_components (
          id, assessment_id, group_code, group_name, category, confidence, quantity_unit, cost_origin, unit_low, unit_high,
          cost_source_note, useful_life_low, useful_life_high, reviewed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, 'assumption', ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        componentId, assessmentId, group.code, group.name, group.category, assumption?.unit ?? "", assumption?.low_unit_cost ?? null,
        assumption?.high_unit_cost ?? null, assumption?.source ?? "", life?.life_low ?? null, life?.life_high ?? null, ts, ts,
      );
    for (const item of group.items) {
      database.prepare(`INSERT INTO component_items (id, component_id, item_key, label, status, observation) VALUES (?, ?, ?, ?, 'unknown', '')`).run(crypto.randomUUID(), componentId, item.key, item.label);
    }
  }
}

export function startAssessment(user: SessionUser, propertyId: string): Result {
  if (!getProperty(user.organizationId, propertyId)) return { ok: false, error: "That property is not in your organization." };
  if (latestAssessmentId(user.organizationId, propertyId)) {
    return { ok: false, error: "This property already has an assessment. Create a new version instead of overwriting it." };
  }
  const settings = getSettings(user.organizationId);
  const id = crypto.randomUUID();
  const ts = nowIso();
  const tx = database().transaction(() => {
    database()
      .prepare(
        `INSERT INTO assessments (
          id, property_id, organization_id, assessor_id, assessment_date, status, version, overall_confidence, notes, contingency_pct,
          weight_condition, weight_urgency, weight_consequence, weight_escalation, band_critical, band_high, band_medium, band_low, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', 1, 'unknown', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, propertyId, user.organizationId, user.id, ts.slice(0, 10), settings.contingencyPct, settings.weights.condition, settings.weights.urgency,
        settings.weights.consequence, settings.weights.escalation, settings.thresholds.critical, settings.thresholds.high, settings.thresholds.medium,
        settings.thresholds.low, ts, ts,
      );
    insertFramework(database(), id, user.organizationId, ts);
    database()
      .prepare(
        `INSERT INTO financial_profiles (id, property_id, assessment_id, existing_financing_note, notes, created_at, updated_at)
         VALUES (?, ?, ?, '', '', ?, ?)`,
      )
      .run(crypto.randomUUID(), propertyId, id, ts, ts);
    writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "assessment", entityId: id, action: "create", newValue: { version: 1, propertyId } });
  });
  tx();
  return { ok: true, id };
}

export function createAssessmentVersion(user: SessionUser, assessmentId: string): Result {
  const current = database().prepare(`SELECT * FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!current) return { ok: false, error: "That assessment is not in your organization." };
  const max = database().prepare(`SELECT MAX(version) AS version FROM assessments WHERE property_id = ?`).get(current.property_id) as Row;
  const version = Number(max.version) + 1;
  const id = crypto.randomUUID();
  const ts = nowIso();
  const tx = database().transaction(() => {
    database()
      .prepare(
        `INSERT INTO assessments (
          id, property_id, organization_id, assessor_id, assessment_date, status, version, parent_assessment_id, overall_confidence, notes, contingency_pct,
          weight_condition, weight_urgency, weight_consequence, weight_escalation, band_critical, band_high, band_medium, band_low, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, current.property_id, user.organizationId, user.id, ts.slice(0, 10), version, current.id, current.overall_confidence,
        `${current.notes}\nCopied forward from version ${current.version}. Historical version retained.`.trim(), current.contingency_pct,
        current.weight_condition, current.weight_urgency, current.weight_consequence, current.weight_escalation, current.band_critical,
        current.band_high, current.band_medium, current.band_low, ts, ts,
      );
    const components = database().prepare(`SELECT * FROM assessment_components WHERE assessment_id = ?`).all(current.id) as Row[];
    const idMap = new Map<string, string>();
    for (const component of components) {
      const newId = crypto.randomUUID();
      idMap.set(component.id, newId);
      database()
        .prepare(
          `INSERT INTO assessment_components (
            id, assessment_id, group_code, group_name, category, condition_score, condition_unknown, urgency_score, urgency_unknown,
            consequence_score, consequence_unknown, escalation_score, escalation_unknown, installation_year, last_renovation_year,
            useful_life_low, useful_life_high, confidence, current_condition_summary, main_issue, recommended_action, notes, quantity,
            quantity_unit, cost_origin, unit_low, unit_high, cost_source_note, manual_low, manual_high, reviewed, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId, id, component.group_code, component.group_name, component.category, component.condition_score, component.condition_unknown,
          component.urgency_score, component.urgency_unknown, component.consequence_score, component.consequence_unknown, component.escalation_score,
          component.escalation_unknown, component.installation_year, component.last_renovation_year, component.useful_life_low, component.useful_life_high,
          component.confidence, component.current_condition_summary, component.main_issue, component.recommended_action, component.notes, component.quantity,
          component.quantity_unit, component.cost_origin, component.unit_low, component.unit_high, component.cost_source_note, component.manual_low,
          component.manual_high, component.reviewed, ts, ts,
        );
      const items = database().prepare(`SELECT * FROM component_items WHERE component_id = ?`).all(component.id) as Row[];
      for (const item of items) {
        database()
          .prepare(`INSERT INTO component_items (id, component_id, item_key, label, status, observation, condition_score, condition_unknown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), newId, item.item_key, item.label, item.status, item.observation, item.condition_score, item.condition_unknown);
      }
    }
    const interventions = database().prepare(`SELECT * FROM interventions WHERE assessment_id = ?`).all(current.id) as Row[];
    for (const item of interventions) {
      database()
        .prepare(
          `INSERT INTO interventions (
            id, assessment_id, property_id, component_id, title, target_year, earliest_year, latest_year, low_cost, high_cost, use_component_cost,
            priority_label, include_low, include_moderate, include_high, dependencies, status, notes, historical, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(), id, current.property_id, item.component_id ? idMap.get(item.component_id) ?? null : null, item.title, item.target_year,
          item.earliest_year, item.latest_year, item.low_cost, item.high_cost, item.use_component_cost, item.priority_label, item.include_low,
          item.include_moderate, item.include_high, item.dependencies, item.status, item.notes, item.historical, ts, ts,
        );
    }
    const financial = database().prepare(`SELECT * FROM financial_profiles WHERE assessment_id = ?`).get(current.id) as Row | undefined;
    if (financial) {
      database()
        .prepare(
          `INSERT INTO financial_profiles (
            id, property_id, assessment_id, reserve_balance, annual_contribution, annual_maintenance, special_contributions, other_funding_annual,
            existing_financing_note, other_obligations, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(), current.property_id, id, financial.reserve_balance, financial.annual_contribution, financial.annual_maintenance,
          financial.special_contributions, financial.other_funding_annual, financial.existing_financing_note, financial.other_obligations, financial.notes, ts, ts,
        );
    }
    const energy = database().prepare(`SELECT * FROM energy_measures WHERE assessment_id = ?`).all(current.id) as Row[];
    for (const item of energy) {
      database()
        .prepare(
          `INSERT INTO energy_measures (id, assessment_id, topic_key, investment_low, investment_high, qualitative_benefit, dependency_note, verification_required, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), id, item.topic_key, item.investment_low, item.investment_high, item.qualitative_benefit, item.dependency_note, item.verification_required, item.notes);
    }
    const photos = database().prepare(`SELECT * FROM photos WHERE assessment_id = ?`).all(current.id) as Row[];
    for (const photo of photos) {
      database()
        .prepare(
          `INSERT INTO photos (id, organization_id, property_id, assessment_id, component_id, filename, caption, location, relevance, photo_date, storage_reference, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(), photo.organization_id, photo.property_id, id, photo.component_id ? idMap.get(photo.component_id) ?? null : null,
          photo.filename, photo.caption, photo.location, photo.relevance, photo.photo_date, photo.storage_reference, ts,
        );
    }
    writeAudit(database(), {
      organizationId: user.organizationId,
      userId: user.id,
      entity: "assessment",
      entityId: id,
      action: "create_version",
      previousValue: { id: current.id, version: current.version },
      newValue: { version },
    });
  });
  tx();
  return { ok: true, id };
}

function parseScore(value: number | null, unknown: boolean, label: string): { score: number | null; unknown: number; error?: string } {
  if (unknown) return { score: null, unknown: 1 };
  if (value == null) return { score: null, unknown: 0 };
  if (!Number.isInteger(value) || value < 1 || value > 5) return { score: null, unknown: 0, error: `${label} must be 1–5 or explicitly Unknown.` };
  return { score: value, unknown: 0 };
}

export function saveComponent(user: SessionUser, assessmentId: string, input: ComponentDTO): Result {
  const existing = database()
    .prepare(
      `SELECT c.*, a.organization_id, a.weight_condition, a.weight_urgency, a.weight_consequence, a.weight_escalation, a.band_critical, a.band_high, a.band_medium, a.band_low
       FROM assessment_components c JOIN assessments a ON a.id = c.assessment_id
       WHERE c.id = ? AND c.assessment_id = ? AND a.organization_id = ?`,
    )
    .get(input.id, assessmentId, user.organizationId) as Row | undefined;
  if (!existing) return { ok: false, error: "This component could not be saved because it is not in your assessment." };
  const condition = parseScore(input.conditionScore, input.conditionUnknown, "Condition");
  const urgency = parseScore(input.urgencyScore, input.urgencyUnknown, "Urgency");
  const consequence = parseScore(input.consequenceScore, input.consequenceUnknown, "Consequence");
  const escalation = parseScore(input.escalationScore, input.escalationUnknown, "Cost escalation risk");
  const scoreError = condition.error || urgency.error || consequence.error || escalation.error;
  if (scoreError) return { ok: false, error: scoreError };
  if (input.quantity != null && (!Number.isFinite(input.quantity) || input.quantity < 0)) return { ok: false, error: "Quantity cannot be negative. Leave it empty if it is unknown." };
  for (const [label, value] of [["Manual low", input.manualLow], ["Manual high", input.manualHigh], ["Unit low", input.unitLow], ["Unit high", input.unitHigh]] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) return { ok: false, error: `${label} cannot be negative.` };
  }
  if (!["assumption", "manual", "quoted"].includes(input.costOrigin)) return { ok: false, error: "Cost origin must be assumption, manual, or quoted." };
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(input.confidence)) return { ok: false, error: "Confidence must be high, medium, low, or unknown." };
  if (input.recommendedAction && !(RECOMMENDED_ACTIONS as readonly string[]).includes(input.recommendedAction)) {
    return { ok: false, error: "Recommended action must be one of the listed actions." };
  }
  for (const year of [input.installationYear, input.lastRenovationYear, input.usefulLifeLow, input.usefulLifeHigh]) {
    if (year != null && (!Number.isInteger(year) || year < 1 || year > 2100)) return { ok: false, error: "Year and useful-life values must be whole numbers in a reasonable range." };
  }
  const unitLow = user.role === "admin" ? input.unitLow : existing.unit_low;
  const unitHigh = user.role === "admin" ? input.unitHigh : existing.unit_high;
  const ts = nowIso();
  const tx = database().transaction(() => {
    database()
      .prepare(
        `UPDATE assessment_components SET
          condition_score=?, condition_unknown=?, urgency_score=?, urgency_unknown=?, consequence_score=?, consequence_unknown=?,
          escalation_score=?, escalation_unknown=?, installation_year=?, last_renovation_year=?, useful_life_low=?, useful_life_high=?,
          confidence=?, current_condition_summary=?, main_issue=?, recommended_action=?, notes=?, quantity=?, quantity_unit=?, cost_origin=?,
          unit_low=?, unit_high=?, cost_source_note=?, manual_low=?, manual_high=?, reviewed=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        condition.score, condition.unknown, urgency.score, urgency.unknown, consequence.score, consequence.unknown, escalation.score, escalation.unknown,
        input.installationYear, input.lastRenovationYear, input.usefulLifeLow, input.usefulLifeHigh, input.confidence, input.summary.trim(), input.mainIssue.trim(),
        input.recommendedAction, input.notes.trim(), input.quantity, input.quantityUnit.trim(), input.costOrigin, unitLow, unitHigh, input.costSourceNote.trim(),
        input.manualLow, input.manualHigh, input.reviewed ? 1 : 0, ts, input.id,
      );
    for (const item of input.items) {
      if (!TRI.has(item.status)) throw new Error(`${item.label}: status must be known, unknown, or not applicable.`);
      const itemScore = parseScore(item.conditionScore, item.conditionUnknown, item.label);
      if (itemScore.error) throw new Error(itemScore.error);
      database()
        .prepare(`UPDATE component_items SET status=?, observation=?, condition_score=?, condition_unknown=? WHERE id=? AND component_id=?`)
        .run(item.status, item.observation.trim(), itemScore.score, itemScore.unknown, item.id, input.id);
    }
    const saved = {
      ...input,
      unitLow,
      unitHigh,
      conditionScore: condition.score,
      conditionUnknown: Boolean(condition.unknown),
      urgencyScore: urgency.score,
      urgencyUnknown: Boolean(urgency.unknown),
      consequenceScore: consequence.score,
      consequenceUnknown: Boolean(consequence.unknown),
      escalationScore: escalation.score,
      escalationUnknown: Boolean(escalation.unknown),
    } as ComponentDTO;
    const cost = componentCost(saved);
    database().prepare(`UPDATE interventions SET low_cost=?, high_cost=?, updated_at=? WHERE component_id=? AND use_component_cost=1`).run(cost.low, cost.high, ts, input.id);
    database().prepare(`UPDATE assessments SET updated_at=? WHERE id=?`).run(ts, assessmentId);
    writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "assessment", entityId: assessmentId, action: "update_component", newValue: { group: input.groupCode } });
  });
  try {
    tx();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "We could not save this component. Your changes are still on this page. Please retry." };
  }
  return { ok: true, id: input.id };
}

export function refreshComponentAssumption(user: SessionUser, componentId: string): Result {
  const row = database()
    .prepare(
      `SELECT c.id, c.group_code, a.organization_id, a.id AS assessment_id
       FROM assessment_components c JOIN assessments a ON a.id = c.assessment_id
       WHERE c.id = ? AND a.organization_id = ?`,
    )
    .get(componentId, user.organizationId) as Row | undefined;
  if (!row) return { ok: false, error: "Component not found in your organization." };
  const assumption = database().prepare(`SELECT * FROM cost_assumptions WHERE organization_id = ? AND component_type = ?`).get(user.organizationId, row.group_code) as Row | undefined;
  if (!assumption) return { ok: false, error: "There is no library assumption for this component yet." };
  database()
    .prepare(`UPDATE assessment_components SET unit_low=?, unit_high=?, quantity_unit=?, cost_source_note=?, cost_origin='assumption', updated_at=? WHERE id=?`)
    .run(assumption.low_unit_cost, assumption.high_unit_cost, assumption.unit, assumption.source, nowIso(), componentId);
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "assessment", entityId: row.assessment_id, action: "refresh_cost_snapshot", newValue: { componentId } });
  return { ok: true, id: componentId };
}

export interface InterventionWrite {
  id?: string;
  componentId: string | null;
  title: string;
  targetYear: number | null;
  earliestYear: number | null;
  latestYear: number | null;
  lowCost: number | null;
  highCost: number | null;
  useComponentCost: boolean;
  includeLow: boolean;
  includeModerate: boolean;
  includeHigh: boolean;
  dependencies: string;
  status: string;
  notes: string;
  historical: boolean;
}

export function saveIntervention(user: SessionUser, assessmentId: string, input: InterventionWrite): Result {
  const assessment = database().prepare(`SELECT * FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!assessment) return { ok: false, error: "That assessment is not in your organization." };
  if (!clean(input.title)) return { ok: false, error: "Intervention title is required. Nothing was saved." };
  if (!(INTERVENTION_STATUSES as readonly string[]).includes(input.status)) return { ok: false, error: "Choose an intervention status from the list." };
  const yearCheck = validateInterventionYears(
    { title: input.title, targetYear: input.targetYear, earliestYear: input.earliestYear, latestYear: input.latestYear, historical: input.historical },
    zurichYear(),
  );
  if (!yearCheck.ok) return { ok: false, error: yearCheck.errors.join(" ") };
  if ((input.lowCost != null && input.lowCost < 0) || (input.highCost != null && input.highCost < 0)) return { ok: false, error: "Costs cannot be negative." };
  if (input.lowCost != null && input.highCost != null && input.lowCost > input.highCost) return { ok: false, error: "The low end of the range cannot exceed the high end." };
  let componentId = input.componentId || null;
  if (componentId) {
    const component = database().prepare(`SELECT id FROM assessment_components WHERE id = ? AND assessment_id = ?`).get(componentId, assessmentId) as Row | undefined;
    if (!component) return { ok: false, error: "The linked component is not part of this assessment." };
  }
  const ts = nowIso();
  const id = input.id || crypto.randomUUID();
  const existing = input.id
    ? (database().prepare(`SELECT * FROM interventions WHERE id = ? AND assessment_id = ?`).get(input.id, assessmentId) as Row | undefined)
    : undefined;
  if (input.id && !existing) return { ok: false, error: "That intervention no longer exists. Refresh the page before trying again. Your typed values are still on this form." };
  if (existing) {
    database()
      .prepare(
        `UPDATE interventions SET component_id=?, title=?, target_year=?, earliest_year=?, latest_year=?, low_cost=?, high_cost=?, use_component_cost=?,
         include_low=?, include_moderate=?, include_high=?, dependencies=?, status=?, notes=?, historical=?, updated_at=? WHERE id=?`,
      )
      .run(
        componentId, clean(input.title), input.targetYear, input.earliestYear, input.latestYear, input.lowCost, input.highCost, input.useComponentCost ? 1 : 0,
        input.includeLow ? 1 : 0, input.includeModerate ? 1 : 0, input.includeHigh ? 1 : 0, input.dependencies.trim(), input.status, input.notes.trim(),
        input.historical ? 1 : 0, ts, id,
      );
  } else {
    database()
      .prepare(
        `INSERT INTO interventions (
          id, assessment_id, property_id, component_id, title, target_year, earliest_year, latest_year, low_cost, high_cost, use_component_cost,
          priority_label, include_low, include_moderate, include_high, dependencies, status, notes, historical, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, assessmentId, assessment.property_id, componentId, clean(input.title), input.targetYear, input.earliestYear, input.latestYear, input.lowCost,
        input.highCost, input.useComponentCost ? 1 : 0, input.includeLow ? 1 : 0, input.includeModerate ? 1 : 0, input.includeHigh ? 1 : 0,
        input.dependencies.trim(), input.status, input.notes.trim(), input.historical ? 1 : 0, ts, ts,
      );
  }
  writeAudit(database(), {
    organizationId: user.organizationId,
    userId: user.id,
    entity: "intervention",
    entityId: id,
    action: existing ? "update" : "create",
    previousValue: existing ? { title: existing.title, targetYear: existing.target_year } : null,
    newValue: { title: input.title, targetYear: input.targetYear },
  });
  return { ok: true, id };
}

export function deleteIntervention(user: SessionUser, interventionId: string): Result {
  const row = database()
    .prepare(`SELECT i.* FROM interventions i JOIN assessments a ON a.id = i.assessment_id WHERE i.id = ? AND a.organization_id = ?`)
    .get(interventionId, user.organizationId) as Row | undefined;
  if (!row) return { ok: false, error: "That intervention is not in your organization." };
  database().prepare(`DELETE FROM interventions WHERE id = ?`).run(interventionId);
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "intervention", entityId: interventionId, action: "delete", previousValue: { title: row.title } });
  return { ok: true };
}

export function saveRoadmap(user: SessionUser, assessmentId: string, rows: { id: string; targetYear: number | null; earliestYear: number | null; latestYear: number | null; historical: boolean }[]): Result {
  const assessment = database().prepare(`SELECT id FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!assessment) return { ok: false, error: "That assessment is not in your organization." };
  const errors: string[] = [];
  for (const row of rows) {
    const titleRow = database().prepare(`SELECT title FROM interventions WHERE id = ? AND assessment_id = ?`).get(row.id, assessmentId) as Row | undefined;
    if (!titleRow) return { ok: false, error: "One intervention was not found. Nothing was saved." };
    const check = validateInterventionYears({ title: titleRow.title, ...row }, zurichYear());
    errors.push(...check.errors);
  }
  if (errors.length) return { ok: false, error: errors.join(" ") };
  const ts = nowIso();
  const tx = database().transaction(() => {
    for (const row of rows) {
      database().prepare(`UPDATE interventions SET target_year=?, earliest_year=?, latest_year=?, historical=?, updated_at=? WHERE id=? AND assessment_id=?`).run(row.targetYear, row.earliestYear, row.latestYear, row.historical ? 1 : 0, ts, row.id, assessmentId);
      writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "intervention", entityId: row.id, action: "update_year", newValue: { targetYear: row.targetYear } });
    }
  });
  tx();
  return { ok: true, id: assessmentId };
}

export interface FinancialWrite {
  reserveBalance: number | null;
  annualContribution: number | null;
  annualMaintenance: number | null;
  specialContributions: number | null;
  otherFundingAnnual: number | null;
  existingFinancingNote: string;
  otherObligations: number | null;
  notes: string;
}

export function saveFinancial(user: SessionUser, assessmentId: string, input: FinancialWrite): Result {
  const assessment = database().prepare(`SELECT * FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!assessment) return { ok: false, error: "That assessment is not in your organization." };
  const fields: [string, number | null][] = [
    ["Reserve balance", input.reserveBalance],
    ["Annual contribution", input.annualContribution],
    ["Annual maintenance", input.annualMaintenance],
    ["Special contributions", input.specialContributions],
    ["Other funding", input.otherFundingAnnual],
    ["Other obligations", input.otherObligations],
  ];
  for (const [label, value] of fields) {
    if (value != null && (!Number.isFinite(value) || !Number.isInteger(value))) return { ok: false, error: `${label} must be a whole CHF amount, or left empty.` };
  }
  for (const [label, value] of fields.slice(1)) {
    if (value != null && value < 0) return { ok: false, error: `${label} cannot be negative. A negative reserve balance, if real, is entered only in the opening balance.` };
  }
  const ts = nowIso();
  const existing = database().prepare(`SELECT * FROM financial_profiles WHERE assessment_id = ?`).get(assessmentId) as Row | undefined;
  if (existing) {
    database()
      .prepare(
        `UPDATE financial_profiles SET reserve_balance=?, annual_contribution=?, annual_maintenance=?, special_contributions=?, other_funding_annual=?,
         existing_financing_note=?, other_obligations=?, notes=?, updated_at=? WHERE assessment_id=?`,
      )
      .run(input.reserveBalance, input.annualContribution, input.annualMaintenance, input.specialContributions, input.otherFundingAnnual, input.existingFinancingNote.trim(), input.otherObligations, input.notes.trim(), ts, assessmentId);
  } else {
    database()
      .prepare(
        `INSERT INTO financial_profiles (
          id, property_id, assessment_id, reserve_balance, annual_contribution, annual_maintenance, special_contributions, other_funding_annual,
          existing_financing_note, other_obligations, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), assessment.property_id, assessmentId, input.reserveBalance, input.annualContribution, input.annualMaintenance, input.specialContributions, input.otherFundingAnnual, input.existingFinancingNote.trim(), input.otherObligations, input.notes.trim(), ts, ts);
  }
  writeAudit(database(), {
    organizationId: user.organizationId,
    userId: user.id,
    entity: "financial_profile",
    entityId: assessmentId,
    action: existing ? "update" : "create",
    previousValue: existing ? { reserve: existing.reserve_balance, contribution: existing.annual_contribution } : null,
    newValue: { reserve: input.reserveBalance, contribution: input.annualContribution },
  });
  return { ok: true, id: assessmentId };
}

export function saveAssessmentMeta(user: SessionUser, assessmentId: string, input: { assessmentDate: string; status: string; overallConfidence: string; notes: string; contingencyPct: number }): Result {
  const existing = database().prepare(`SELECT * FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!existing) return { ok: false, error: "That assessment is not in your organization." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.assessmentDate)) return { ok: false, error: "Assessment date must be a real date." };
  if (!["draft", "in_review", "completed"].includes(input.status)) return { ok: false, error: "Status must be draft, in review, or completed." };
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(input.overallConfidence)) return { ok: false, error: "Confidence must be high, medium, low, or unknown." };
  if (!Number.isFinite(input.contingencyPct) || input.contingencyPct < 0 || input.contingencyPct > 100) return { ok: false, error: "Contingency must be between 0 and 100 percent." };
  const ts = nowIso();
  database()
    .prepare(`UPDATE assessments SET assessment_date=?, status=?, overall_confidence=?, notes=?, contingency_pct=?, updated_at=? WHERE id=?`)
    .run(input.assessmentDate, input.status, input.overallConfidence, input.notes, input.contingencyPct, ts, assessmentId);
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "assessment", entityId: assessmentId, action: "update", previousValue: { status: existing.status }, newValue: { status: input.status, contingencyPct: input.contingencyPct } });
  return { ok: true, id: assessmentId };
}

export function applyOrganizationScoring(user: SessionUser, assessmentId: string): Result {
  const existing = database().prepare(`SELECT id, status FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!existing) return { ok: false, error: "That assessment is not in your organization." };
  if (existing.status === "completed") return { ok: false, error: "Completed assessments keep their scoring settings. Create a new version to apply new settings." };
  const settings = getSettings(user.organizationId);
  database()
    .prepare(
      `UPDATE assessments SET weight_condition=?, weight_urgency=?, weight_consequence=?, weight_escalation=?, band_critical=?, band_high=?, band_medium=?, band_low=?, updated_at=? WHERE id=?`,
    )
    .run(settings.weights.condition, settings.weights.urgency, settings.weights.consequence, settings.weights.escalation, settings.thresholds.critical, settings.thresholds.high, settings.thresholds.medium, settings.thresholds.low, nowIso(), assessmentId);
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "assessment", entityId: assessmentId, action: "apply_scoring_settings" });
  return { ok: true, id: assessmentId };
}

export function saveEnergy(user: SessionUser, assessmentId: string, rows: EnergyDTO[]): Result {
  const assessment = database().prepare(`SELECT id FROM assessments WHERE id = ? AND organization_id = ?`).get(assessmentId, user.organizationId) as Row | undefined;
  if (!assessment) return { ok: false, error: "That assessment is not in your organization." };
  for (const row of rows) {
    if (!ENERGY_TOPICS.some((topic) => topic.key === row.topicKey)) return { ok: false, error: "Unknown energy topic. Nothing was saved." };
    if ((row.investmentLow != null && row.investmentLow < 0) || (row.investmentHigh != null && row.investmentHigh < 0)) {
      return { ok: false, error: "Energy investment ranges cannot be negative." };
    }
  }
  const tx = database().transaction(() => {
    for (const row of rows) {
      database()
        .prepare(
          `INSERT INTO energy_measures (id, assessment_id, topic_key, investment_low, investment_high, qualitative_benefit, dependency_note, verification_required, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(assessment_id, topic_key) DO UPDATE SET
             investment_low=excluded.investment_low, investment_high=excluded.investment_high, qualitative_benefit=excluded.qualitative_benefit,
             dependency_note=excluded.dependency_note, verification_required=excluded.verification_required, notes=excluded.notes`,
        )
        .run(crypto.randomUUID(), assessmentId, row.topicKey, row.investmentLow, row.investmentHigh, row.qualitativeBenefit.trim(), row.dependencyNote.trim(), row.verificationRequired ? 1 : 0, row.notes.trim());
    }
  });
  tx();
  return { ok: true, id: assessmentId };
}

export function updateBranding(user: SessionUser, input: { companyName: string; productName: string; address: string; footer: string }): Result {
  if (!canEditGlobalAssumptions(user.role)) return { ok: false, error: "Only an administrator can edit branding." };
  if (!clean(input.companyName) || !clean(input.productName)) return { ok: false, error: "Company name and product name are required." };
  const ts = nowIso();
  database().prepare(`UPDATE organizations SET company_name=?, product_name=?, address=?, footer=?, updated_at=? WHERE id=?`).run(clean(input.companyName), clean(input.productName), input.address.trim(), input.footer.trim(), ts, user.organizationId);
  return { ok: true };
}

export function updateSettings(user: SessionUser, input: { weights: PriorityWeights; thresholds: PriorityThresholds; contingencyPct: number; disclaimer: string; regulatoryNotes: string }): Result {
  if (!canEditGlobalAssumptions(user.role)) return { ok: false, error: "Project managers cannot edit global cost assumptions or scoring settings." };
  if (!weightsAreValid(input.weights)) return { ok: false, error: "Weights must be between 0 and 1 and sum to 1.00. Nothing was saved." };
  if (!thresholdsAreValid(input.thresholds)) return { ok: false, error: "Priority thresholds must descend from Critical to Low, with Critical at or below 100." };
  if (!Number.isFinite(input.contingencyPct) || input.contingencyPct < 0 || input.contingencyPct > 100) return { ok: false, error: "Contingency must be between 0 and 100 percent." };
  if (!clean(input.disclaimer)) return { ok: false, error: "The disclaimer cannot be empty." };
  database()
    .prepare(
      `UPDATE org_settings SET weight_condition=?, weight_urgency=?, weight_consequence=?, weight_escalation=?, band_critical=?, band_high=?, band_medium=?, band_low=?,
       contingency_pct=?, disclaimer=?, regulatory_notes=?, updated_at=? WHERE organization_id=?`,
    )
    .run(
      input.weights.condition, input.weights.urgency, input.weights.consequence, input.weights.escalation, Math.round(input.thresholds.critical), Math.round(input.thresholds.high),
      Math.round(input.thresholds.medium), Math.round(input.thresholds.low), input.contingencyPct, input.disclaimer.trim(), input.regulatoryNotes.trim(), nowIso(), user.organizationId,
    );
  return { ok: true };
}

export function updateCostAssumption(user: SessionUser, input: { id: string; costBasis: string; unit: string; lowUnitCost: number; highUnitCost: number; region: string; effectiveDate: string; source: string; confidence: string; notes: string }): Result {
  if (!canEditGlobalAssumptions(user.role)) return { ok: false, error: "Project managers cannot edit global cost assumptions." };
  const row = database().prepare(`SELECT id FROM cost_assumptions WHERE id = ? AND organization_id = ?`).get(input.id, user.organizationId) as Row | undefined;
  if (!row) return { ok: false, error: "That cost assumption is not in your organization." };
  if (!Number.isInteger(input.lowUnitCost) || !Number.isInteger(input.highUnitCost) || input.lowUnitCost < 0 || input.highUnitCost < input.lowUnitCost) {
    return { ok: false, error: "Unit costs must be whole CHF amounts, with the low end at or below the high end." };
  }
  if (!clean(input.source)) return { ok: false, error: "A source or reference is required so the assumption is not presented as a fact." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) return { ok: false, error: "Effective date must be YYYY-MM-DD." };
  database()
    .prepare(`UPDATE cost_assumptions SET cost_basis=?, unit=?, low_unit_cost=?, high_unit_cost=?, region=?, effective_date=?, source=?, confidence=?, notes=?, updated_at=? WHERE id=?`)
    .run(input.costBasis.trim(), input.unit.trim(), input.lowUnitCost, input.highUnitCost, input.region.trim(), input.effectiveDate, input.source.trim(), input.confidence, input.notes.trim(), nowIso(), input.id);
  return { ok: true, id: input.id };
}

export function updateUsefulLife(user: SessionUser, input: { id: string; lifeLow: number; lifeHigh: number; notes: string }): Result {
  if (!canEditGlobalAssumptions(user.role)) return { ok: false, error: "Project managers cannot edit global useful-life defaults." };
  const row = database().prepare(`SELECT id FROM useful_life_defaults WHERE id = ? AND organization_id = ?`).get(input.id, user.organizationId) as Row | undefined;
  if (!row) return { ok: false, error: "That useful-life default is not in your organization." };
  if (!Number.isInteger(input.lifeLow) || !Number.isInteger(input.lifeHigh) || input.lifeLow <= 0 || input.lifeHigh < input.lifeLow) {
    return { ok: false, error: "Useful life must be a positive whole-year range, low then high." };
  }
  database().prepare(`UPDATE useful_life_defaults SET life_low=?, life_high=?, notes=? WHERE id=?`).run(input.lifeLow, input.lifeHigh, input.notes.trim(), input.id);
  return { ok: true };
}

export interface LeadWrite {
  id?: string;
  name: string;
  leadOrganization: string;
  propertyId: string | null;
  contact: string;
  source: string;
  stage: string;
  estimatedOpportunity: number | null;
  nextAction: string;
  notes: string;
}

export function saveLead(user: SessionUser, input: LeadWrite): Result {
  if (!clean(input.name)) return { ok: false, error: "Lead name is required." };
  if (!(LEAD_STAGES as readonly string[]).includes(input.stage)) return { ok: false, error: "Choose a lead stage from the list." };
  if (input.estimatedOpportunity != null && (!Number.isInteger(input.estimatedOpportunity) || input.estimatedOpportunity < 0)) {
    return { ok: false, error: "Estimated opportunity must be a whole CHF amount, or empty. This is not an invoice." };
  }
  if (input.propertyId && !getProperty(user.organizationId, input.propertyId)) return { ok: false, error: "That property is not in your organization." };
  const ts = nowIso();
  if (input.id) {
    const existing = database().prepare(`SELECT id FROM leads WHERE id = ? AND organization_id = ?`).get(input.id, user.organizationId) as Row | undefined;
    if (!existing) return { ok: false, error: "That lead is not in your organization." };
    database()
      .prepare(`UPDATE leads SET name=?, lead_organization=?, property_id=?, contact=?, source=?, stage=?, estimated_opportunity=?, next_action=?, notes=?, updated_at=? WHERE id=?`)
      .run(clean(input.name), input.leadOrganization.trim(), input.propertyId, input.contact.trim(), input.source.trim(), input.stage, input.estimatedOpportunity, input.nextAction.trim(), input.notes.trim(), ts, input.id);
    return { ok: true, id: input.id };
  }
  const id = crypto.randomUUID();
  database()
    .prepare(
      `INSERT INTO leads (id, organization_id, name, lead_organization, property_id, contact, source, stage, estimated_opportunity, next_action, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, user.organizationId, clean(input.name), input.leadOrganization.trim(), input.propertyId, input.contact.trim(), input.source.trim(), input.stage, input.estimatedOpportunity, input.nextAction.trim(), input.notes.trim(), ts, ts);
  return { ok: true, id };
}

export function generateReport(user: SessionUser, assessmentId: string, acknowledgeWarnings: boolean): Result & { warnings?: string[]; errors?: string[] } {
  const bundle = loadBundle(user.organizationId, assessmentId, "moderate");
  if (!bundle) return { ok: false, error: "That assessment is not in your organization." };
  if (!bundle.quality.canGenerateReport) {
    return { ok: false, error: "The report was not generated because quality errors remain.", errors: bundle.quality.errors, warnings: bundle.quality.warnings };
  }
  if (bundle.quality.warnings.length > 0 && !acknowledgeWarnings) {
    return { ok: false, error: "Review the warnings and confirm that the report should still be generated. Nothing was released.", warnings: bundle.quality.warnings };
  }
  const versionRow = database().prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM reports WHERE assessment_id = ?`).get(assessmentId) as Row;
  const version = Number(versionRow.version) + 1;
  const id = crypto.randomUUID();
  const ts = nowIso();
  database()
    .prepare(`INSERT INTO reports (id, assessment_id, organization_id, version, generated_at, generated_by, status, warnings_json) VALUES (?, ?, ?, ?, ?, ?, 'released', ?)`)
    .run(id, assessmentId, user.organizationId, version, ts, user.id, JSON.stringify(bundle.quality.warnings));
  writeAudit(database(), { organizationId: user.organizationId, userId: user.id, entity: "report", entityId: id, action: "create", newValue: { assessmentId, version } });
  return { ok: true, id };
}

export function latestReportVersion(assessmentId: string): number {
  const row = database().prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM reports WHERE assessment_id = ?`).get(assessmentId) as Row;
  return Number(row.version);
}

export function listReports(organizationId: string): { id: string; assessmentId: string; propertyName: string; version: number; assessmentVersion: number; generatedAt: string; status: string }[] {
  const rows = database()
    .prepare(
      `SELECT r.id, r.assessment_id, r.version, r.generated_at, r.status, p.name AS property_name, a.version AS assessment_version
       FROM reports r JOIN assessments a ON a.id = r.assessment_id JOIN properties p ON p.id = a.property_id
       WHERE r.organization_id = ? ORDER BY r.generated_at DESC`,
    )
    .all(organizationId) as Row[];
  return rows.map((row) => ({
    id: row.id,
    assessmentId: row.assessment_id,
    propertyName: row.property_name,
    version: row.version,
    assessmentVersion: row.assessment_version,
    generatedAt: row.generated_at,
    status: row.status,
  }));
}
