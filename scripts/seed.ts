import fs from "node:fs";
import path from "node:path";
import { COMPONENT_GROUPS, DEFAULT_CONDITION_LABELS, DEFAULT_DISCLAIMER, DEFAULT_URGENCY_LABELS } from "../src/domain/constants";
import { applyContingency, calculateCostLine } from "../src/domain/calculations";
import { getDb, nowIso } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { componentCost, loadBundle } from "../src/lib/repo";

const ORG = "org_demo";
const PM = "user_demo_pm";
const ADMIN = "user_demo_admin";
const PROP = "prop_sonnenhof";
const ASMT = "asmt_sonnenhof_v1";
const FIN = "fin_sonnenhof_v1";
const SOURCE = "DEMO synthetic assumption — not market data or a contractor quotation. Zurich region placeholder, effective 2026-01-01.";
const ts = nowIso();

const costs: Record<string, [string, string, number, number]> = {
  A: ["per m²", "m²", 180, 320],
  B: ["per m²", "m²", 220, 480],
  C: ["per apartment", "apartment", 12000, 18000],
  D: ["per apartment", "apartment", 2500, 6000],
  E: ["per apartment", "apartment", 8000, 12000],
  F: ["per apartment", "apartment", 1500, 2500],
  G: ["per system", "system", 25000, 60000],
  H: ["per apartment", "apartment", 2000, 4500],
  I: ["per apartment", "apartment", 3000, 7000],
  J: ["per system", "system", 35000, 70000],
  K: ["per m²", "m²", 80, 180],
  L: ["fixed allowance", "allowance", 40000, 90000],
  M: ["fixed allowance", "allowance", 15000, 45000],
};

const components: Record<string, {
  c: number; u: number; k: number; e: number | null; eUnknown?: boolean;
  life: [number, number]; qty: number; action: string; confidence: string;
  summary: string; issue: string; notes: string;
}> = {
  A: { c: 3, u: 3, k: 4, e: 3, life: [25, 40], qty: 860, action: "repair", confidence: "medium", summary: "Synthetic demo entry: tiled roof original to 2004, condition scored 3 (fair). Not a site inspection.", issue: "Age puts waterproofing into a planning window. No leak is asserted beyond the entered consequence score.", notes: "Synthetic note. Technical inspection recommended before expenditure." },
  B: { c: 2, u: 2, k: 2, e: 2, life: [30, 50], qty: 2400, action: "maintain", confidence: "medium", summary: "Synthetic demo entry: rendered façade scored 2 (good). Maintenance only on the entered score.", issue: "No entered defect requires near-term façade replacement.", notes: "Optional insulation appears only in the comprehensive scenario." },
  C: { c: 3, u: 3, k: 3, e: 3, life: [25, 35], qty: 24, action: "replace", confidence: "medium", summary: "Synthetic demo entry: original 2004 windows scored 3 (fair).", issue: "Thermal performance and seals are aging on the entered score. Coordinate with any façade scaffolding.", notes: "Quantity is 24 apartments, not a counted window schedule." },
  D: { c: 3, u: 2, k: 3, e: 2, life: [25, 40], qty: 24, action: "repair", confidence: "low", summary: "Synthetic demo entry: balcony waterproofing scored 3. Edge details are partly unknown.", issue: "Waterproofing should be planned with façade access. Not a structural diagnosis.", notes: "Confidence is low because edge details are marked unknown." },
  E: { c: 4, u: 4, k: 4, e: 4, life: [20, 30], qty: 24, action: "replace", confidence: "low", summary: "Synthetic demo entry: central gas heating from 2004 scored condition 4 and urgency 4.", issue: "Age is 22 years against an entered useful life of 20–30 years. Priority review is flagged by the rule, not by a failure prediction.", notes: "Priority review: condition and urgency are both 4. Further technical verification recommended before tender. Demo cost uses CHF 8,000–12,000 per apartment." },
  F: { c: 3, u: 3, k: 3, e: 2, life: [15, 25], qty: 24, action: "replace", confidence: "medium", summary: "Synthetic demo entry: central hot water from 2004 scored 3.", issue: "The lower useful-life bound is already behind 2026. That is a planning suggestion, not a failure date.", notes: "Coordinate with the heating decision." },
  G: { c: 3, u: 2, k: 2, e: null, eUnknown: true, life: [20, 30], qty: 3, action: "investigate", confidence: "unknown", summary: "Synthetic demo entry: mostly window ventilation. Cost escalation risk is explicitly unknown.", issue: "No numeric priority is calculated while escalation risk is unknown.", notes: "Unknown is not treated as good. Further technical verification recommended." },
  H: { c: 2, u: 2, k: 3, e: 2, life: [30, 40], qty: 24, action: "monitor", confidence: "medium", summary: "Synthetic demo entry: 2004 common electrical installation scored 2. Capacity for EV is not demonstrated.", issue: "EV readiness depends on a capacity check. No safety defect is invented here.", notes: "Safety sub-item is marked unknown on purpose." },
  I: { c: 3, u: 2, k: 3, e: 2, life: [30, 50], qty: 24, action: "monitor", confidence: "low", summary: "Synthetic demo entry: supply and drainage scored 3 from age only.", issue: "Material and leakage history are thinly documented in the demo set.", notes: "Low confidence. Not a camera survey." },
  J: { c: 2, u: 2, k: 3, e: 2, life: [25, 40], qty: 3, action: "monitor", confidence: "medium", summary: "Synthetic demo entry: three lifts from 2004, condition 2, described as maintained.", issue: "Modernization is not indicated by the condition score. Accessibility is only generally noted.", notes: "No modernization is placed on the moderate path." },
  K: { c: 3, u: 3, k: 4, e: 3, life: [30, 50], qty: 900, action: "repair", confidence: "medium", summary: "Synthetic demo entry: underground garage scored 3, with drainage called out as the planning issue.", issue: "Consequence 4 reflects water-management exposure in the demo score, not an observed structural failure.", notes: "Coordinate waterproofing with drainage. Quantity 900 m² is a synthetic allowance." },
  L: { c: 2, u: 2, k: 2, e: 1, life: [20, 30], qty: 1, action: "maintain", confidence: "medium", summary: "Synthetic demo entry: entrances and stairs scored 2.", issue: "No near-term common-area replacement is indicated by the entered scores.", notes: "Included in the comprehensive scenario only as an optional refurbishment allowance." },
  M: { c: 2, u: 1, k: 1, e: 1, life: [15, 25], qty: 1, action: "maintain", confidence: "low", summary: "Synthetic demo entry: paving and landscaping scored 2.", issue: "Play areas are marked not applicable.", notes: "Low confidence outdoor note. Not a survey." },
};

const db = getDb();
const uploadDir = path.join(process.cwd(), "data", "uploads", ORG);
fs.rmSync(uploadDir, { recursive: true, force: true });
db.prepare(`DELETE FROM organizations WHERE id = ?`).run(ORG);

const tx = db.transaction(() => {
  db.prepare(`INSERT INTO organizations (id, name, company_name, product_name, address, footer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ORG, "STWEG & Property Project Office", "STWEG & Property Project Office", "STWEG Renovation Assessment",
    "Seestrasse 1, 8001 Zürich, Switzerland", "Planning document. Indicative estimates only. Not an engineering certificate.", ts, ts,
  );
  const insertUser = db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insertUser.run(PM, ORG, "Demo Project Manager", "demo@stweg.local", hashPassword("Demo-Sonnenhof-2026"), "project_manager", ts, ts);
  insertUser.run(ADMIN, ORG, "Demo Administrator", "admin@stweg.local", hashPassword("Admin-Sonnenhof-2026"), "admin", ts, ts);
  db.prepare(
    `INSERT INTO org_settings (organization_id, weight_condition, weight_urgency, weight_consequence, weight_escalation, band_critical, band_high, band_medium, band_low, contingency_pct, disclaimer, regulatory_notes, condition_labels_json, urgency_labels_json, updated_at)
     VALUES (?, 0.30, 0.30, 0.25, 0.15, 80, 60, 40, 20, 15, ?, ?, ?, ?, ?)`,
  ).run(ORG, DEFAULT_DISCLAIMER, "No canton-specific legal rule is hard-coded. Regulatory, energy and safety matters must be verified by qualified professionals. These notes are configurable.", JSON.stringify(DEFAULT_CONDITION_LABELS), JSON.stringify(DEFAULT_URGENCY_LABELS), ts);
  db.prepare(
    `INSERT INTO properties (id, organization_id, name, street, zip, municipality, canton, country, year_built, year_first_occupation, buildings, units, owners, floors, basement_present, underground_parking, outdoor_parking, has_lift, balcony_terrace, garden, status, is_demo, metadata_json, created_at, updated_at)
     VALUES (?, ?, 'STWEG Sonnenhof', 'Seestrasse 48', '8702', 'Zollikon', 'ZH', 'Switzerland', 2004, 2005, 3, 24, 24, 4, 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'active', 1, ?, ?, ?)`,
  ).run(PROP, ORG, JSON.stringify({ demo: true, label: "DEMO / synthetic" }), ts, ts);
  db.prepare(`INSERT INTO building_profiles (property_id, updated_at) VALUES (?, ?)`).run(PROP, ts);
  const profile: Record<string, { status: string; value: string | number | null }> = {
    structural_system: { status: "known", value: "Reinforced concrete frame (synthetic)" },
    roof_type: { status: "known", value: "Pitched tile roof (synthetic)" },
    facade_type: { status: "known", value: "Rendered façade (synthetic)" },
    insulation: { status: "known", value: "2004-era insulation, extent not measured" },
    window_type: { status: "known", value: "Original double glazing (synthetic)" },
    window_replacement_year: { status: "unknown", value: null },
    balcony_construction: { status: "known", value: "Concrete slabs with railing (synthetic)" },
    basement_construction: { status: "known", value: "Concrete basement (synthetic)" },
    heating_type: { status: "known", value: "Central gas boilers (synthetic)" },
    heating_installation_year: { status: "known", value: 2004 },
    heating_distribution: { status: "known", value: "Radiators (synthetic)" },
    hot_water_system: { status: "known", value: "Central storage linked to heating (synthetic)" },
    hot_water_installation_year: { status: "known", value: 2004 },
    ventilation: { status: "known", value: "Mostly window ventilation (synthetic)" },
    cooling: { status: "unknown", value: "" },
    electrical_system: { status: "known", value: "2004 common distribution (synthetic)" },
    solar_pv: { status: "known", value: "No PV recorded" },
    ev_charging: { status: "unknown", value: "" },
    plumbing: { status: "known", value: "Mixed supply, age-based note only" },
    drainage: { status: "known", value: "Gravity drainage, garage called out separately" },
    lift_info: { status: "known", value: "Three passenger lifts, described as maintained" },
    entrance: { status: "known", value: "Three entrances, condition aligned with score 2" },
    staircase: { status: "known", value: "Concrete stairs (synthetic)" },
    corridor: { status: "known", value: "Painted corridors (synthetic)" },
    basement_area: { status: "known", value: "Storage cellars (synthetic)" },
    laundry: { status: "known", value: "Common laundry present (synthetic)" },
    garage_area: { status: "known", value: "Underground garage, synthetic area 900 m²" },
    technical_rooms: { status: "known", value: "Heating plant in basement (synthetic)" },
    outdoor_areas: { status: "known", value: "Paved access and small garden (synthetic)" },
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, field] of Object.entries(profile)) {
    sets.push(`${key} = ?`, `${key}_status = ?`);
    values.push(field.value, field.status);
  }
  values.push(ts, PROP);
  db.prepare(`UPDATE building_profiles SET ${sets.join(", ")}, updated_at = ? WHERE property_id = ?`).run(...values);

  for (const [code, cost] of Object.entries(costs)) {
    db.prepare(
      `INSERT INTO cost_assumptions (id, organization_id, component_type, cost_basis, unit, low_unit_cost, high_unit_cost, region, effective_date, source, confidence, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Zurich', '2026-01-01', ?, 'low', 'Synthetic development assumption. Not a quotation.', ?, ?)`,
    ).run(`cost_${code}`, ORG, code, cost[0], cost[1], cost[2], cost[3], SOURCE, ts, ts);
    db.prepare(`INSERT INTO useful_life_defaults (id, organization_id, group_code, life_low, life_high, notes) VALUES (?, ?, ?, ?, ?, 'Synthetic default, not a guaranteed service life.')`).run(`life_${code}`, ORG, code, components[code].life[0], components[code].life[1]);
  }

  db.prepare(
    `INSERT INTO assessments (id, property_id, organization_id, assessor_id, assessment_date, status, version, overall_confidence, notes, contingency_pct, weight_condition, weight_urgency, weight_consequence, weight_escalation, band_critical, band_high, band_medium, band_low, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-10-04', 'in_review', 1, 'medium', 'Synthetic demo assessment for the STWEG workflow. Not a site inspection.', 15, 0.30, 0.30, 0.25, 0.15, 80, 60, 40, 20, ?, ?)`,
  ).run(ASMT, PROP, ORG, PM, ts, ts);

  const insertComponent = db.prepare(
    `INSERT INTO assessment_components (id, assessment_id, group_code, group_name, category, condition_score, condition_unknown, urgency_score, urgency_unknown, consequence_score, consequence_unknown, escalation_score, escalation_unknown, installation_year, useful_life_low, useful_life_high, confidence, current_condition_summary, main_issue, recommended_action, notes, quantity, quantity_unit, cost_origin, unit_low, unit_high, cost_source_note, reviewed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, ?, ?, 2004, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assumption', ?, ?, ?, 1, ?, ?)`,
  );
  const insertItem = db.prepare(`INSERT INTO component_items (id, component_id, item_key, label, status, observation, condition_unknown) VALUES (?, ?, ?, ?, ?, ?, 0)`);
  for (const group of COMPONENT_GROUPS) {
    const data = components[group.code];
    const cost = costs[group.code];
    const id = `cmp_${group.code}`;
    insertComponent.run(id, ASMT, group.code, group.name, group.category, data.c, data.u, data.k, data.eUnknown ? null : data.e, data.eUnknown ? 1 : 0, data.life[0], data.life[1], data.confidence, data.summary, data.issue, data.action, data.notes, data.qty, cost[1], cost[2], cost[3], SOURCE, ts, ts);
    for (const item of group.items) {
      let status = "known";
      let observation = `Synthetic demo observation for ${item.label}. Not an inspection result.`;
      if (group.code === "G" && item.key === "indoor_air") { status = "unknown"; observation = "Indoor-air performance was not entered."; }
      if (group.code === "H" && item.key === "safety") { status = "unknown"; observation = "No safety inspection result is on file."; }
      if (group.code === "D" && item.key === "edge") { status = "unknown"; observation = "Edge details were not documented."; }
      if (group.code === "M" && item.key === "play") { status = "na"; observation = "No play area in the synthetic description."; }
      insertItem.run(`item_${group.code}_${item.key}`, id, item.key, item.label, status, observation);
    }
  }

  const insertIntervention = db.prepare(
    `INSERT INTO interventions (id, assessment_id, property_id, component_id, title, target_year, earliest_year, latest_year, low_cost, high_cost, use_component_cost, priority_label, include_low, include_moderate, include_high, dependencies, status, notes, historical, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recommended', ?, 0, ?, ?)`,
  );
  const interventions: unknown[][] = [
    ["int_heat_inspect", "cmp_E", "Heating plant technical inspection", 2027, 2026, 2027, 6000, 12000, 0, "High", 1, 1, 1, "Precedes replacement.", "Synthetic allowance for inspection only. Not a quotation."],
    ["int_heat", "cmp_E", "Heating system replacement", 2028, 2026, 2034, 192000, 288000, 1, "High", 1, 1, 1, "Coordinate with hot water and any PV decision.", "Uses 24 apartments × CHF 8,000–12,000. Suggested window 2026–2034 is not mandatory. Target year 2028 was set manually."],
    ["int_hw", "cmp_F", "Hot water renewal", 2029, 2026, 2029, 36000, 60000, 1, "Medium", 0, 1, 1, "Coordinate with heating replacement.", "Component cost. Not in the minimum scenario."],
    ["int_garage", "cmp_K", "Garage waterproofing and drainage", 2030, 2028, 2032, 72000, 162000, 1, "Medium", 0, 1, 1, "Coordinate with drainage.", "900 m² × CHF 80–180. Synthetic quantity."],
    ["int_roof", "cmp_A", "Roof covering and waterproofing", 2031, 2026, 2034, 154800, 275200, 1, "Medium", 0, 1, 1, "", "860 m² × CHF 180–320. Synthetic area."],
    ["int_windows", "cmp_C", "Window replacement", 2032, 2029, 2039, 288000, 432000, 1, "Medium", 0, 1, 1, "Coordinate with façade scaffolding.", "24 apartments × CHF 12,000–18,000."],
    ["int_facade", "cmp_B", "Optional façade insulation and coating", 2033, 2031, 2036, 528000, 1152000, 1, "Low", 0, 0, 1, "Coordinate with windows.", "Comprehensive scenario only. Condition score is 2, so this is optional modernization, not a required replacement."],
    ["int_pv", null, "Optional PV array", 2034, 2032, 2036, 54000, 84000, 0, "Monitor", 0, 0, 1, "Heating replacement may influence PV planning.", "30 kWp × synthetic CHF 1,800–2,800/kWp. No energy saving is claimed."],
    ["int_ev", "cmp_H", "EV charging readiness", 2034, 2032, 2036, 15000, 36000, 0, "Low", 0, 0, 1, "Depends on electrical capacity.", "6 points × synthetic CHF 2,500–6,000. Not a grid approval."],
    ["int_common", "cmp_L", "Optional common-area refurbishment", 2035, 2033, 2038, 40000, 90000, 1, "Low", 0, 0, 1, "", "Fixed allowance. Comprehensive scenario only."],
    ["int_vent", "cmp_G", "Ventilation concept study", 2035, 2026, 2036, 15000, 40000, 0, "Not calculated", 0, 0, 1, "", "Study only. Escalation risk is unknown, so this is not a replacement decision."],
    ["int_out", "cmp_M", "Optional outdoor areas", 2036, 2034, 2038, 15000, 45000, 1, "Monitor", 0, 0, 1, "", "Fixed allowance. Comprehensive scenario only."],
  ];
  for (const row of interventions) {
    insertIntervention.run(row[0], ASMT, PROP, row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13], row[14], ts, ts);
  }

  db.prepare(
    `INSERT INTO financial_profiles (id, property_id, assessment_id, reserve_balance, annual_contribution, annual_maintenance, special_contributions, other_funding_annual, existing_financing_note, other_obligations, notes, created_at, updated_at)
     VALUES (?, ?, ?, 85000, 18000, 24000, 0, 0, 'None recorded. This application does not recommend a financing product.', 0, 'Synthetic demo reserve. Annual maintenance is recorded and is not deducted in the reserve formula.', ?, ?)`,
  ).run(FIN, PROP, ASMT, ts, ts);

  db.prepare(`INSERT INTO energy_measures (id, assessment_id, topic_key, investment_low, investment_high, qualitative_benefit, dependency_note, verification_required, notes) VALUES (?, ?, 'pv', 54000, 84000, 'Could be coordinated with roof access. No saving is calculated from the entered data.', 'Heating replacement may influence PV planning.', 1, 'Synthetic. Technical verification required.')`).run("en_pv", ASMT);
  db.prepare(`INSERT INTO energy_measures (id, assessment_id, topic_key, investment_low, investment_high, qualitative_benefit, dependency_note, verification_required, notes) VALUES (?, ?, 'ev_charging', 15000, 36000, 'Readiness only. No tariff or saving is stated.', 'Electrical capacity.', 1, 'Synthetic.')`).run("en_ev", ASMT);
  db.prepare(`INSERT INTO energy_measures (id, assessment_id, topic_key, investment_low, investment_high, qualitative_benefit, dependency_note, verification_required, notes) VALUES (?, ?, 'heating_replacement', 192000, 288000, 'Replaces an aging plant on the entered scores. Efficiency gain is not quantified.', 'Hot water and PV.', 1, 'Matches the heating component range. Not a quotation.')`).run("en_heat", ASMT);

  const dir = path.join(process.cwd(), "data", "uploads", ORG, PROP);
  fs.mkdirSync(dir, { recursive: true });
  const pdf = Buffer.from(`%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nDEMO synthetic document. Not a real record.\n`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(dir, "doc_plans.pdf"), pdf);
  fs.writeFileSync(path.join(dir, "doc_reserve.pdf"), pdf);
  fs.writeFileSync(path.join(dir, "photo_heat.png"), png);
  const insertDoc = db.prepare(`INSERT INTO documents (id, organization_id, property_id, category, filename, original_name, description, source, document_date, upload_date, storage_reference, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'DEMO synthetic file', '2026-01-15', ?, ?, ?, ?)`);
  insertDoc.run("doc_plans", ORG, PROP, "property_plans", "doc_plans.pdf", "Sonnenhof-plans-DEMO.pdf", "Synthetic plan placeholder.", ts, path.join(ORG, PROP, "doc_plans.pdf"), PM, ts);
  insertDoc.run("doc_reserve", ORG, PROP, "reserve_fund_information", "doc_reserve.pdf", "Sonnenhof-reserve-DEMO.pdf", "Synthetic reserve note. Not a bank statement.", ts, path.join(ORG, PROP, "doc_reserve.pdf"), PM, ts);
  insertDoc.run("doc_photo", ORG, PROP, "photos", "photo_heat.png", "heating-plant-DEMO.png", "Synthetic photo placeholder. Not diagnosed.", ts, path.join(ORG, PROP, "photo_heat.png"), PM, ts);
  db.prepare(`INSERT INTO photos (id, organization_id, property_id, assessment_id, component_id, filename, caption, location, relevance, photo_date, storage_reference, created_at) VALUES ('photo_heat', ?, ?, ?, 'cmp_E', 'photo_heat.png', 'Synthetic heating-plant photo. Not an inspection image and not auto-diagnosed.', 'Basement plant room (synthetic)', 'Illustration only', '2026-10-04', ?, ?)`).run(ORG, PROP, ASMT, path.join(ORG, PROP, "photo_heat.png"), ts);

  db.prepare(`INSERT INTO leads (id, organization_id, name, lead_organization, property_id, contact, source, stage, estimated_opportunity, next_action, notes, created_at, updated_at) VALUES ('lead_demo', ?, 'Maria Keller', 'Verwaltung Sonnenhof (DEMO)', ?, 'maria.keller@example.invalid', 'Referral', 'Assessment Proposed', 4800, 'Confirm the document list', 'Synthetic lead for the assessment service. Not an invoice and not a renovation contract.', ?, ?)`).run(ORG, PROP, ts, ts);
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, entity, entity_id, action, timestamp, new_value) VALUES ('audit_property', ?, ?, 'property', ?, 'create', ?, '{"name":"STWEG Sonnenhof"}')`).run(ORG, PM, PROP, ts);
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, entity, entity_id, action, timestamp, new_value) VALUES ('audit_assessment', ?, ?, 'assessment', ?, 'create', ?, '{"version":1}')`).run(ORG, PM, ASMT, ts);
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, entity, entity_id, action, timestamp, new_value) VALUES ('audit_financial', ?, ?, 'financial_profile', ?, 'create', ?, '{"reserve":85000}')`).run(ORG, PM, FIN, ts);
});
tx();

const heatingRow = db.prepare(`SELECT quantity, unit_low, unit_high, cost_origin FROM assessment_components WHERE id = 'cmp_E'`).get() as { quantity: number; unit_low: number; unit_high: number; cost_origin: "assumption" };
const heating = calculateCostLine({ quantity: heatingRow.quantity, unitLow: heatingRow.unit_low, unitHigh: heatingRow.unit_high, manualLow: null, manualHigh: null, origin: heatingRow.cost_origin });
const planning = applyContingency(heating.low ?? 0, heating.high ?? 0, 15);
if (heating.low !== 192000 || heating.high !== 288000 || planning.planningLow !== 220800 || planning.planningHigh !== 331200) {
  throw new Error(`Heating seed mismatch: ${heating.low}-${heating.high} planning ${planning.planningLow}-${planning.planningHigh}`);
}
const bundle = loadBundle(ORG, ASMT, "moderate");
if (!bundle) throw new Error("Demo bundle did not load.");
const fromBundle = componentCost(bundle.components.find((component) => component.groupCode === "E")!);
if (fromBundle.low !== 192000 || fromBundle.high !== 288000) throw new Error("Bundle heating cost mismatch.");
if (!bundle.reserveRows.some((row) => row.fundingGap)) throw new Error("Expected a projected funding gap in the demo reserve.");
if (bundle.quality.errors.length) {
  console.error(bundle.quality.errors);
  throw new Error("Demo assessment has quality errors.");
}
console.log(`Seeded STWEG Sonnenhof.`);
console.log(`Heating base ${heating.low}–${heating.high}; contingency 15% ${planning.contingencyLow}–${planning.contingencyHigh}; planning ${planning.planningLow}–${planning.planningHigh}.`);
console.log(`Funding gap years: ${bundle.reserveRows.filter((row) => row.fundingGap).map((row) => row.year).join(", ")}`);
console.log(`Demo login: demo@stweg.local / Demo-Sonnenhof-2026`);
console.log(`Admin login: admin@stweg.local / Admin-Sonnenhof-2026`);
