import { DEPENDENCY_RULES, ROADMAP_YEAR_SPAN, VERIFICATION_TEXT } from "./constants";

export interface PriorityWeights {
  condition: number;
  urgency: number;
  consequence: number;
  escalation: number;
}

export interface PriorityThresholds {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
  condition: 0.3,
  urgency: 0.3,
  consequence: 0.25,
  escalation: 0.15,
};

export const DEFAULT_THRESHOLDS: PriorityThresholds = {
  critical: 80,
  high: 60,
  medium: 40,
  low: 20,
};

export type PriorityBand = "Critical" | "High" | "Medium" | "Low" | "Monitor";

export interface ScoreInput {
  condition: number | null;
  urgency: number | null;
  consequence: number | null;
  escalation: number | null;
}

export interface PriorityResult {
  score: number | null;
  band: PriorityBand | null;
  incomplete: boolean;
  message: string | null;
  formula: string;
}

export function roundChf(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Cannot round a non-finite CHF amount.");
  }
  return Math.round(value);
}

export function formatChfPlain(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const rounded = Math.round(amount);
  const negative = rounded < 0;
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${negative ? "-" : ""}CHF ${digits}`;
}

export function formatChfRange(low: number | null, high: number | null): string {
  if (low == null || high == null) return "—";
  return `${formatChfPlain(low)} – ${formatChfPlain(high)}`;
}

export function formatIsoDateSwiss(iso: string | null | undefined): string {
  if (!iso) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

export function formatIsoDateTimeSwiss(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatIsoDateSwiss(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")} Zurich`;
}

export function zurichYear(date = new Date()): number {
  const y = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", year: "numeric" }).format(date);
  return Number(y);
}

export function roadmapYears(startYear: number): number[] {
  return Array.from({ length: ROADMAP_YEAR_SPAN + 1 }, (_, i) => startYear + i);
}

export function weightSum(weights: PriorityWeights): number {
  return weights.condition + weights.urgency + weights.consequence + weights.escalation;
}

export function weightsAreValid(weights: PriorityWeights): boolean {
  const values = [weights.condition, weights.urgency, weights.consequence, weights.escalation];
  if (values.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return false;
  return Math.abs(weightSum(weights) - 1) < 0.001;
}

export function thresholdsAreValid(t: PriorityThresholds): boolean {
  return (
    Number.isFinite(t.critical) &&
    t.critical <= 100 &&
    t.critical > t.high &&
    t.high > t.medium &&
    t.medium > t.low &&
    t.low > 0
  );
}

export function formatWeight(weight: number): string {
  return weight.toFixed(2);
}

export function priorityFormulaText(weights: PriorityWeights): string {
  return `Priority = Condition×${formatWeight(weights.condition)} + Urgency×${formatWeight(weights.urgency)} + Consequence×${formatWeight(weights.consequence)} + Cost Escalation Risk×${formatWeight(weights.escalation)}, normalized to 0–100.`;
}

export function bandLegend(t: PriorityThresholds): string {
  return `${t.critical}–100 Critical, ${t.high}–${t.critical - 1} High, ${t.medium}–${t.high - 1} Medium, ${t.low}–${t.medium - 1} Low, 0–${t.low - 1} Monitor`;
}

export function priorityBand(score: number, thresholds: PriorityThresholds): PriorityBand {
  if (score >= thresholds.critical) return "Critical";
  if (score >= thresholds.high) return "High";
  if (score >= thresholds.medium) return "Medium";
  if (score >= thresholds.low) return "Low";
  return "Monitor";
}

function isValidScore(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function calculatePriority(
  input: ScoreInput,
  weights: PriorityWeights = DEFAULT_WEIGHTS,
  thresholds: PriorityThresholds = DEFAULT_THRESHOLDS,
): PriorityResult {
  const formula = priorityFormulaText(weights);
  const fields: { label: string; value: number | null; weight: number }[] = [
    { label: "Condition", value: input.condition, weight: weights.condition },
    { label: "Urgency", value: input.urgency, weight: weights.urgency },
    { label: "Consequence", value: input.consequence, weight: weights.consequence },
    { label: "Cost escalation risk", value: input.escalation, weight: weights.escalation },
  ];
  const missing = fields.filter((f) => f.value == null).map((f) => f.label);
  if (missing.length > 0) {
    return {
      score: null,
      band: null,
      incomplete: true,
      message: `Priority not calculated because ${missing.join(", ")} is unknown or missing. Unknown is not treated as a good score. ${VERIFICATION_TEXT}`,
      formula,
    };
  }
  for (const field of fields) {
    if (!isValidScore(field.value as number)) {
      return {
        score: null,
        band: null,
        incomplete: true,
        message: `${field.label} must be an integer from 1 to 5, or explicitly unknown. It was not scored as 1.`,
        formula,
      };
    }
  }
  const sum = weightSum(weights);
  if (!(sum > 0) || !weightsAreValid(weights)) {
    return {
      score: null,
      band: null,
      incomplete: true,
      message: "Priority weights must be between 0 and 1 and sum to 1.00. Priority was not calculated.",
      formula,
    };
  }
  const weighted = fields.reduce((total, field) => total + (field.value as number) * field.weight, 0);
  const normalized = ((weighted - sum) / (sum * 4)) * 100;
  const score = Math.min(100, Math.max(0, Math.round(normalized)));
  return {
    score,
    band: priorityBand(score, thresholds),
    incomplete: false,
    message: null,
    formula,
  };
}

export function requiresPriorityReview(input: {
  condition: number | null;
  urgency: number | null;
  consequence: number | null;
}): boolean {
  if (input.condition != null && input.condition >= 4) return true;
  if (input.urgency != null && input.urgency >= 4) return true;
  if (input.consequence != null && input.consequence >= 5) return true;
  return false;
}

export type CostOrigin = "assumption" | "manual" | "quoted";

export interface CostLineInput {
  quantity: number | null;
  unitLow: number | null;
  unitHigh: number | null;
  manualLow: number | null;
  manualHigh: number | null;
  origin: CostOrigin;
}

export interface CostLineResult {
  low: number | null;
  high: number | null;
  method: "quantity" | "manual" | "quoted" | "unavailable";
  confidence: "high" | "medium" | "low" | "unknown";
  note: string;
}

export function quantityTimesUnit(quantity: number, unitCost: number): number {
  if (quantity === 0) return 0;
  return roundChf(quantity * unitCost);
}

export function calculateCostLine(input: CostLineInput): CostLineResult {
  if (input.origin === "manual" || input.origin === "quoted") {
    if (input.manualLow == null || input.manualHigh == null) {
      return {
        low: null,
        high: null,
        method: "unavailable",
        confidence: "unknown",
        note: "A manual or quoted range was selected, but both ends of the range are required.",
      };
    }
    return {
      low: roundChf(input.manualLow),
      high: roundChf(input.manualHigh),
      method: input.origin === "quoted" ? "quoted" : "manual",
      confidence: "low",
      note:
        input.origin === "quoted"
          ? "Externally quoted range recorded by the user. This is not a system-generated market price and is not guaranteed."
          : "Manually entered range. Quantity was not used. Confidence is low and verification is requested. This is not a contractor quotation.",
    };
  }
  const hasQuantity = input.quantity != null && Number.isFinite(input.quantity);
  const hasUnits = input.unitLow != null && input.unitHigh != null && Number.isFinite(input.unitLow) && Number.isFinite(input.unitHigh);
  if (!hasQuantity || !hasUnits) {
    if (input.manualLow != null && input.manualHigh != null) {
      return {
        low: roundChf(input.manualLow),
        high: roundChf(input.manualHigh),
        method: "manual",
        confidence: "low",
        note: "Quantity or unit cost is unknown. Manual range used. Confidence is low. Verification requested. This is not a contractor quotation.",
      };
    }
    return {
      low: null,
      high: null,
      method: "unavailable",
      confidence: "unknown",
      note: "No quantity and no manual range. An indicative cost cannot be produced.",
    };
  }
  if ((input.quantity as number) < 0 || (input.unitLow as number) < 0 || (input.unitHigh as number) < 0) {
    return {
      low: null,
      high: null,
      method: "unavailable",
      confidence: "unknown",
      note: "Quantity and unit costs cannot be negative.",
    };
  }
  return {
    low: quantityTimesUnit(input.quantity as number, input.unitLow as number),
    high: quantityTimesUnit(input.quantity as number, input.unitHigh as number),
    method: "quantity",
    confidence: input.quantity === 0 ? "high" : "low",
    note:
      input.quantity === 0
        ? "Quantity is zero, so the indicative base estimate is CHF 0."
        : "System-generated planning estimate from quantity × unit assumption. Indicative only. Not a contractor quotation. Subject to technical inspection, tender and market conditions.",
  };
}

export interface ContingencyResult {
  baseLow: number;
  baseHigh: number;
  contingencyPct: number;
  contingencyLow: number;
  contingencyHigh: number;
  planningLow: number;
  planningHigh: number;
}

export function applyContingency(baseLow: number, baseHigh: number, contingencyPct: number): ContingencyResult {
  const low = roundChf(baseLow);
  const high = roundChf(baseHigh);
  const contingencyLow = roundChf((low * contingencyPct) / 100);
  const contingencyHigh = roundChf((high * contingencyPct) / 100);
  return {
    baseLow: low,
    baseHigh: high,
    contingencyPct,
    contingencyLow,
    contingencyHigh,
    planningLow: low + contingencyLow,
    planningHigh: high + contingencyHigh,
  };
}

export type ScenarioKey = "low" | "moderate" | "high";

export interface ScenarioItem {
  low: number;
  high: number;
  includeLow: boolean;
  includeModerate: boolean;
  includeHigh: boolean;
  year: number | null;
  title?: string;
}

export function itemIncluded(item: ScenarioItem, scenario: ScenarioKey): boolean {
  if (scenario === "low") return item.includeLow;
  if (scenario === "moderate") return item.includeModerate;
  return item.includeHigh;
}

export function scenarioTotals(items: ScenarioItem[], scenario: ScenarioKey): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (const item of items) {
    if (!itemIncluded(item, scenario)) continue;
    low += roundChf(item.low);
    high += roundChf(item.high);
  }
  return { low: roundChf(low), high: roundChf(high) };
}

export function annualExpenditure(
  items: ScenarioItem[],
  scenario: ScenarioKey,
): { year: number; low: number; high: number }[] {
  const map = new Map<number, { low: number; high: number }>();
  for (const item of items) {
    if (!itemIncluded(item, scenario) || item.year == null) continue;
    const current = map.get(item.year) ?? { low: 0, high: 0 };
    current.low += roundChf(item.low);
    current.high += roundChf(item.high);
    map.set(item.year, current);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, value]) => ({ year, low: roundChf(value.low), high: roundChf(value.high) }));
}

export interface ReserveYearInput {
  year: number;
  contribution: number;
  otherFunding: number;
  plannedExpenditure: number;
}

export interface ReserveProjectionRow {
  year: number;
  opening: number;
  contributions: number;
  otherFunding: number;
  plannedExpenditure: number;
  closing: number;
  fundingGap: boolean;
}

export function reserveRowReconciles(row: ReserveProjectionRow): boolean {
  return row.closing === row.opening + row.contributions + row.otherFunding - row.plannedExpenditure;
}

export function projectReserve(openingBalance: number, years: ReserveYearInput[]): ReserveProjectionRow[] {
  const rows: ReserveProjectionRow[] = [];
  let opening = roundChf(openingBalance);
  for (const year of years) {
    const contributions = roundChf(year.contribution);
    const otherFunding = roundChf(year.otherFunding);
    const plannedExpenditure = roundChf(year.plannedExpenditure);
    const closing = opening + contributions + otherFunding - plannedExpenditure;
    const row: ReserveProjectionRow = {
      year: year.year,
      opening,
      contributions,
      otherFunding,
      plannedExpenditure,
      closing,
      fundingGap: closing < 0,
    };
    rows.push(row);
    opening = closing;
  }
  return rows;
}

export function buildReserveYears(params: {
  openingBalance: number;
  annualContribution: number;
  otherFundingAnnual: number;
  specialContribution: number;
  expenditureByYear: Record<number, number>;
  startYear: number;
}): ReserveProjectionRow[] {
  const years = roadmapYears(params.startYear).map((year, index) => ({
    year,
    contribution: params.annualContribution,
    otherFunding: params.otherFundingAnnual + (index === 0 ? params.specialContribution : 0),
    plannedExpenditure: params.expenditureByYear[year] ?? 0,
  }));
  return projectReserve(params.openingBalance, years);
}

export interface PlanningWindow {
  ageYears: number;
  windowStart: number;
  windowEnd: number;
  lowerBoundReached: boolean;
  elapsed: boolean;
  mandatory: false;
  text: string;
}

export function suggestPlanningWindow(
  installationYear: number,
  usefulLifeLow: number,
  usefulLifeHigh: number,
  currentYear: number,
): PlanningWindow {
  const ageYears = currentYear - installationYear;
  const rawStart = installationYear + usefulLifeLow;
  const rawEnd = installationYear + usefulLifeHigh;
  const elapsed = rawEnd < currentYear;
  const lowerBoundReached = ageYears >= usefulLifeLow;
  const windowStart = elapsed ? currentYear : Math.max(currentYear, rawStart);
  const windowEnd = elapsed ? currentYear : Math.max(windowStart, rawEnd);
  const elapsedNote = elapsed
    ? " The indicative useful-life range is already behind the current year. That is not a failure date and replacement is not mandatory."
    : "";
  return {
    ageYears,
    windowStart,
    windowEnd,
    lowerBoundReached,
    elapsed,
    mandatory: false,
    text: `Suggested planning window ${windowStart}–${windowEnd} (age ${ageYears} years). This is a suggestion, not a mandatory replacement date.${elapsedNote}`,
  };
}

export interface YearCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateInterventionYears(
  input: {
    title: string;
    targetYear: number | null;
    earliestYear: number | null;
    latestYear: number | null;
    historical: boolean;
  },
  currentYear: number,
): YearCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const years: { label: string; value: number | null }[] = [
    { label: "target year", value: input.targetYear },
    { label: "earliest year", value: input.earliestYear },
    { label: "latest year", value: input.latestYear },
  ];
  for (const year of years) {
    if (year.value == null) continue;
    if (!Number.isInteger(year.value) || year.value < 1900 || year.value > 2100) {
      errors.push(`${input.title}: ${year.label} ${year.value} is not a reasonable year.`);
    }
  }
  if (input.targetYear == null) {
    warnings.push(`${input.title}: no target year has been set.`);
  } else if (input.targetYear < currentYear && !input.historical) {
    errors.push(
      `${input.title}: target year ${input.targetYear} is before ${currentYear}. Mark it as historical or move it to the current year or later.`,
    );
  }
  if (input.earliestYear != null && input.latestYear != null && input.earliestYear > input.latestYear) {
    errors.push(`${input.title}: earliest year is after the latest recommended year.`);
  }
  if (input.targetYear != null && input.earliestYear != null && input.targetYear < input.earliestYear) {
    errors.push(`${input.title}: target year is earlier than the earliest recommended year.`);
  }
  if (input.targetYear != null && input.latestYear != null && input.targetYear > input.latestYear) {
    errors.push(`${input.title}: target year is later than the latest recommended year.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function coordinationMessages(activeCodes: string[]): string[] {
  const present = new Set(activeCodes);
  const messages: string[] = [];
  for (const rule of DEPENDENCY_RULES) {
    if (present.has(rule.left) && present.has(rule.right)) messages.push(rule.message);
  }
  return messages;
}

export function isHighPriorityBand(band: PriorityBand | null): boolean {
  return band === "Critical" || band === "High";
}
