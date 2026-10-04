import {
  ScenarioItem,
  ScenarioKey,
  applyContingency,
  formatChfPlain,
  formatChfRange,
  formatIsoDateSwiss,
  formatIsoDateTimeSwiss,
  itemIncluded,
  reserveRowReconciles,
  scenarioTotals,
  type ReserveProjectionRow,
} from "./calculations";

export const REPORT_SECTION_IDS = [
  "cover",
  "1-executive-summary",
  "2-property-profile",
  "3-methodology",
  "4-condition-overview",
  "5-key-findings",
  "6-recommended-measures",
  "7-roadmap",
  "8-cost-outlook",
  "9-reserve-outlook",
  "10-risks-unknowns",
  "11-next-steps",
  "appendix",
] as const;

export type Block =
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "note"; tone: "warning" | "info"; text: string }
  | { type: "kv"; rows: { label: string; value: string }[] }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface ReportSection {
  id: (typeof REPORT_SECTION_IDS)[number];
  title: string;
  blocks: Block[];
}

export interface ReportPhoto {
  id: string;
  caption: string;
  component: string;
}

export interface ReportComponentRow {
  code: string;
  name: string;
  condition: string;
  urgency: string;
  risk: string;
  priority: string;
  target: string;
  finding: string;
  issue: string;
  action: string;
  baseCost: string;
  planningCost: string;
  confidence: string;
  unknown: boolean;
  priorityReview: boolean;
}

export interface ReportMeasure {
  title: string;
  component: string;
  priority: string;
  target: string;
  earliest: string;
  latest: string;
  baseCost: string;
  status: string;
  dependencies: string;
  why: string;
  scenario: string;
}

export interface ReportModel {
  sections: ReportSection[];
  disclaimer: string;
  warnings: string[];
  errors: string[];
  photos: ReportPhoto[];
  scenarios: Record<ScenarioKey, { baseLow: number; baseHigh: number; planningLow: number; planningHigh: number; contingencyLow: number; contingencyHigh: number }>;
  blocked: boolean;
}

export interface ReportSource {
  branding: { companyName: string; productName: string; address: string; footer: string };
  disclaimer: string;
  formulaText: string;
  bandLegend: string;
  property: {
    name: string;
    addressLine: string;
    municipality: string;
    canton: string;
    country: string;
    yearBuilt: string;
    yearFirstOccupation: string;
    buildings: string;
    units: string;
    owners: string;
    floors: string;
    features: { label: string; value: string }[];
    isDemo: boolean;
  };
  assessment: {
    version: number;
    date: string;
    assessorName: string;
    status: string;
    overallConfidence: string;
    notes: string;
    contingencyPct: number;
    reportVersion: number;
  };
  completeness: { overall: number; propertyData: number; envelope: number; technical: number; financial: number; documentation: number };
  health: { label: string; score: string; note: string }[];
  components: ReportComponentRow[];
  measures: ReportMeasure[];
  scenarioItems: ScenarioItem[];
  roadmap: { year: number; lines: string[] }[];
  reserve: { scenarioLabel: string; rows: ReserveProjectionRow[]; note: string };
  warnings: string[];
  errors: string[];
  assumptions: string[];
  sources: string[];
  photos: ReportPhoto[];
  generatedAtIso: string;
  profileLines: { label: string; value: string }[];
}

function section(id: ReportSection["id"], title: string, blocks: Block[]): ReportSection {
  return { id, title, blocks };
}

export function buildReportModel(source: ReportSource): ReportModel {
  const contingencyPct = source.assessment.contingencyPct;
  const scenarios = {
    low: pack("low"),
    moderate: pack("moderate"),
    high: pack("high"),
  };

  function pack(key: ScenarioKey) {
    const totals = scenarioTotals(source.scenarioItems, key);
    const included = source.scenarioItems.filter((item) => itemIncluded(item, key));
    const summedLow = included.reduce((sum, item) => sum + Math.round(item.low), 0);
    const summedHigh = included.reduce((sum, item) => sum + Math.round(item.high), 0);
    if (totals.low !== summedLow || totals.high !== summedHigh) {
      throw new Error("Scenario totals do not reconcile.");
    }
    const planning = applyContingency(totals.low, totals.high, contingencyPct);
    if (planning.planningLow !== planning.baseLow + planning.contingencyLow) {
      throw new Error("Planning budget does not reconcile to base plus contingency.");
    }
    return planning;
  }

  for (const row of source.reserve.rows) {
    if (!reserveRowReconciles(row)) {
      throw new Error(`Reserve year ${row.year} does not reconcile.`);
    }
  }

  const gapYears = source.reserve.rows.filter((row) => row.fundingGap).map((row) => row.year);
  const moderate = scenarios.moderate;
  const reviewNames = source.components.filter((c) => c.priorityReview).map((c) => c.name);
  const unknownNames = source.components.filter((c) => c.unknown).map((c) => c.name);

  const nextSteps = [
    "Confirm the entered facts with the owners and the available documents before any decision.",
    "Where a score is unknown, obtain further technical verification before treating the component as understood.",
    "Use the ranges as indicative planning estimates only. Obtain a measured specification and tender before committing expenditure.",
  ];
  if (reviewNames.length) {
    nextSteps.push(`Arrange technical inspection for priority-review items before implementation: ${reviewNames.join(", ")}.`);
  }
  if (gapYears.length) {
    nextSteps.push(
      `Review the reserve contribution and the timing of works with the owners. A projected funding gap appears in ${gapYears.join(", ")}. This report does not recommend a financing product.`,
    );
  }
  if (source.property.isDemo) {
    nextSteps.push("This file is DEMO / synthetic and must not be used as market evidence or as a client deliverable.");
  }

  const sections: ReportSection[] = [
    section("cover", "Cover", [
      { type: "h3", text: source.branding.productName },
      { type: "p", text: source.branding.companyName },
      { type: "kv", rows: [
        { label: "Property", value: source.property.name },
        { label: "Address", value: source.property.addressLine },
        { label: "Assessment date", value: formatIsoDateSwiss(source.assessment.date) },
        { label: "Prepared by", value: source.assessment.assessorName },
        { label: "Assessment version", value: `v${source.assessment.version}` },
        { label: "Report version", value: `v${source.assessment.reportVersion}` },
        { label: "Generated", value: formatIsoDateTimeSwiss(source.generatedAtIso) },
      ] },
      ...(source.property.isDemo
        ? [{ type: "note" as const, tone: "warning" as const, text: "DEMO / synthetic data. Not a real inspection and not market data." }]
        : []),
    ]),
    section("1-executive-summary", "1. Executive summary", [
      { type: "p", text: `This is a planning summary for ${source.property.name}. It describes entered condition scores, indicative cost ranges and a reserve projection. It is not an engineering certificate and it does not state a single construction price.` },
      { type: "p", text: `Assessment completeness is ${source.completeness.overall}% (property data ${source.completeness.propertyData}%, building envelope ${source.completeness.envelope}%, technical systems ${source.completeness.technical}%, financial data ${source.completeness.financial}%, documentation ${source.completeness.documentation}%). Overall confidence recorded: ${source.assessment.overallConfidence}.` },
      { type: "p", text: reviewNames.length ? `Priority review is flagged for: ${reviewNames.join(", ")}.` : "No component currently meets the priority-review rule (condition ≥ 4, urgency ≥ 4, or consequence ≥ 5)." },
      { type: "p", text: `Indicative 15-year exposure on the moderate / recommended path: base ${formatChfRange(moderate.baseLow, moderate.baseHigh)}; planning budget including ${contingencyPct}% contingency shown separately ${formatChfRange(moderate.planningLow, moderate.planningHigh)}. Subject to technical inspection, tender and market conditions.` },
      { type: "p", text: gapYears.length ? `Projected funding gap in: ${gapYears.join(", ")}.` : "No projected funding gap under the reserve inputs used for this report." },
      ...(source.assessment.notes.trim() ? [{ type: "p" as const, text: `Assessor note: ${source.assessment.notes.trim()}` }] : []),
    ]),
    section("2-property-profile", "2. Property profile", [
      { type: "kv", rows: [
        { label: "Address", value: source.property.addressLine },
        { label: "Municipality", value: source.property.municipality },
        { label: "Canton", value: source.property.canton },
        { label: "Country", value: source.property.country },
        { label: "Year built", value: source.property.yearBuilt },
        { label: "First occupation", value: source.property.yearFirstOccupation },
        { label: "Buildings", value: source.property.buildings },
        { label: "Apartments / units", value: source.property.units },
        { label: "Owners", value: source.property.owners },
        { label: "Floors", value: source.property.floors },
        ...source.property.features,
      ] },
      { type: "h3", text: "Building profile" },
      { type: "kv", rows: source.profileLines },
    ]),
    section("3-methodology", "3. Assessment methodology", [
      { type: "p", text: "Components are scored separately for condition, urgency, consequence and cost-escalation risk. These are not collapsed into one arbitrary judgement. Unknown is never treated as good." },
      { type: "p", text: source.formulaText },
      { type: "p", text: `Bands: ${source.bandLegend}.` },
      { type: "p", text: "If any of the four inputs is unknown or missing, that component has no numeric priority and is flagged. It is not silently scored as 1." },
      { type: "p", text: "Costs are ranges. The base estimate is quantity × unit assumption, or a manual or quoted range when quantity is unknown. Contingency is shown separately and is not hidden inside component unit costs. Base + contingency = planning budget range." },
      { type: "p", text: "Reserve projection: Opening + Contributions + Other funding − Planned expenditure = Closing. A negative closing balance is labelled Projected funding gap. No financing product is recommended." },
      { type: "p", text: "A useful-life window is a planning suggestion only. It is not a mandatory replacement date and not a predicted failure date." },
      { type: "note", tone: "info", text: "Planning Health Indicator dimensions, where shown, are not a safety rating, an engineering certification, or a property value." },
    ]),
    section("4-condition-overview", "4. Condition overview", [
      { type: "table", headers: ["Component", "Condition", "Urgency", "Risk", "Priority", "Target"], rows: source.components.map((c) => [c.name, c.condition, c.urgency, c.risk, c.priority, c.target]) },
    ]),
    section("5-key-findings", "5. Key findings", source.components.filter((c) => c.priorityReview || c.unknown || c.finding.trim()).map((c) => ({
      type: "p" as const,
      text: `${c.name}. What is recorded: ${c.finding.trim() || "No written finding has been entered."} Why it matters: ${c.issue.trim() || "No separate issue statement has been entered."} When: ${c.target}. What it might cost (indicative base / planning): ${c.baseCost} / ${c.planningCost}. Next: ${c.action || "not stated"}. ${c.unknown ? "Further technical verification recommended." : ""} ${c.priorityReview ? "Flagged for priority review." : ""}`.replace(/\s+/g, " ").trim(),
    })).concat(source.components.every((c) => !c.finding.trim()) ? [{ type: "p" as const, text: "No written findings have been entered." }] : [])),
    section("6-recommended-measures", "6. Recommended renovation measures", [
      source.measures.length
        ? { type: "table", headers: ["Measure", "Component", "Priority", "Target", "Base range", "Status", "Scenarios", "Dependencies"], rows: source.measures.map((m) => [m.title, m.component, m.priority, m.target, m.baseCost, m.status, m.scenario, m.dependencies || "—"]) }
        : { type: "p", text: "No interventions have been entered." },
      ...source.measures.filter((m) => m.why.trim()).map((m) => ({ type: "p" as const, text: `${m.title}: ${m.why.trim()}` })),
    ]),
    section("7-roadmap", "7. 15-year roadmap", [
      { type: "p", text: "Years are those saved on each intervention. A suggested useful-life window never overwrites a manually set year." },
      { type: "table", headers: ["Year", "Interventions"], rows: source.roadmap.map((row) => [String(row.year), row.lines.join("; ") || "—"]) },
    ]),
    section("8-cost-outlook", "8. Cost outlook", [
      { type: "p", text: "Figures below are indicative planning estimates, not contractor quotations. They are subject to technical inspection, tender and market conditions. Contingency is shown separately." },
      { type: "table", headers: ["Scenario", "Base estimate", "Contingency", "Planning budget range"], rows: (["low", "moderate", "high"] as ScenarioKey[]).map((key) => {
        const value = scenarios[key];
        const label = key === "low" ? "Low / minimum intervention" : key === "moderate" ? "Moderate / recommended" : "High / comprehensive";
        return [label, formatChfRange(value.baseLow, value.baseHigh), `${contingencyPct}% · ${formatChfRange(value.contingencyLow, value.contingencyHigh)}`, formatChfRange(value.planningLow, value.planningHigh)];
      }) },
      { type: "h3", text: "Component base and planning ranges" },
      { type: "table", headers: ["Component", "Base estimate", "Planning range (base + contingency)"], rows: source.components.map((c) => [c.name, c.baseCost, c.planningCost]) },
    ]),
    section("9-reserve-outlook", "9. Reserve-fund outlook", [
      { type: "p", text: source.reserve.note },
      { type: "p", text: `Scenario used for planned expenditure: ${source.reserve.scenarioLabel}. Planned expenditure uses the high end of each included base estimate so the gap test is conservative. It is still an indicative figure, not a price.` },
      { type: "table", headers: ["Year", "Opening", "Contributions", "Other funding", "Planned expenditure", "Closing", "Flag"], rows: source.reserve.rows.map((row) => [
        String(row.year),
        formatChfPlain(row.opening),
        formatChfPlain(row.contributions),
        formatChfPlain(row.otherFunding),
        formatChfPlain(row.plannedExpenditure),
        formatChfPlain(row.closing),
        row.fundingGap ? "Projected funding gap" : "—",
      ]) },
      { type: "note", tone: gapYears.length ? "warning" : "info", text: gapYears.length ? `Projected funding gap in ${gapYears.join(", ")}. No financing product is recommended.` : "Closing balances stay at or above zero under these inputs." },
    ]),
    section("10-risks-unknowns", "10. Risks and unknowns", [
      ...(unknownNames.length ? [{ type: "p" as const, text: `Unknown or incomplete scoring: ${unknownNames.join(", ")}. Further technical verification recommended.` }] : [{ type: "p" as const, text: "No component is marked unknown." }]),
      ...source.warnings.map((warning) => ({ type: "note" as const, tone: "warning" as const, text: warning })),
      ...(source.warnings.length === 0 ? [{ type: "p" as const, text: "No quality warnings were open when this report model was built." }] : []),
    ]),
    section("11-next-steps", "11. Recommended next steps", nextSteps.map((text) => ({ type: "p", text }))),
    section("appendix", "Appendix", [
      { type: "h3", text: "Assessment details" },
      { type: "kv", rows: [
        { label: "Status", value: source.assessment.status },
        { label: "Confidence", value: source.assessment.overallConfidence },
        { label: "Version", value: `v${source.assessment.version}` },
      ] },
      { type: "h3", text: "Planning Health Indicator" },
      { type: "table", headers: ["Dimension", "Indicator", "Meaning"], rows: source.health.map((h) => [h.label, h.score, h.note]) },
      { type: "h3", text: "Assumptions" },
      ...source.assumptions.map((text) => ({ type: "p" as const, text })),
      { type: "h3", text: "Data sources" },
      ...(source.sources.length ? source.sources.map((text) => ({ type: "p" as const, text })) : [{ type: "p" as const, text: "No documents have been recorded." }]),
      { type: "h3", text: "Photographs" },
      { type: "p", text: source.photos.length ? "Photographs are attached to components. The application does not diagnose defects from images." : "No photographs are attached." },
      ...source.photos.map((photo) => ({ type: "p" as const, text: `${photo.component}: ${photo.caption || "No caption"}` })),
      { type: "h3", text: "Disclaimer" },
      { type: "p", text: source.disclaimer },
      { type: "p", text: source.branding.footer },
      { type: "p", text: source.branding.address },
    ]),
  ];

  if (sections.map((item) => item.id).join() !== REPORT_SECTION_IDS.join()) {
    throw new Error("Report sections are incomplete.");
  }

  return {
    sections,
    disclaimer: source.disclaimer,
    warnings: source.warnings,
    errors: source.errors,
    photos: source.photos,
    scenarios,
    blocked: source.errors.length > 0,
  };
}
