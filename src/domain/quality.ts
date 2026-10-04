import { COMPONENT_GROUPS, VERIFICATION_TEXT } from "./constants";
import { requiresPriorityReview, validateInterventionYears } from "./calculations";

export interface QualityComponent {
  groupCode: string;
  groupName: string;
  reviewed: boolean;
  condition: number | null;
  conditionUnknown: boolean;
  urgency: number | null;
  urgencyUnknown: boolean;
  consequence: number | null;
  consequenceUnknown: boolean;
  escalation: number | null;
  escalationUnknown: boolean;
  installationYear: number | null;
  notes: string;
  confidence: string;
  costLow: number | null;
  costHigh: number | null;
  costOrigin: "assumption" | "manual" | "quoted";
  costUnavailable: boolean;
  assumptionSource: string;
}

export interface QualityIntervention {
  title: string;
  targetYear: number | null;
  earliestYear: number | null;
  latestYear: number | null;
  historical: boolean;
  low: number | null;
  high: number | null;
}

export interface QualityInput {
  propertyName: string;
  street: string;
  municipality: string;
  canton: string;
  assessmentDate: string | null;
  components: QualityComponent[];
  interventions: QualityIntervention[];
  reserveBalance: number | null;
  annualContribution: number | null;
  disclaimer: string;
  currentYear: number;
  reserveReconciles: boolean;
  reserveChecked: boolean;
}

export interface QualityResult {
  errors: string[];
  warnings: string[];
  canGenerateReport: boolean;
}

function scoreError(name: string, label: string, value: number | null, unknown: boolean): string | null {
  if (unknown) return null;
  if (value == null) {
    return `${name} has no ${label} score. Mark it Unknown if it cannot be verified. Do not leave it blank, and do not treat it as good.`;
  }
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return `${name}: ${label} must be an integer from 1 to 5.`;
  }
  return null;
}

export function runQualityCheck(input: QualityInput): QualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input.propertyName.trim() || !input.street.trim() || !input.municipality.trim() || !input.canton.trim()) {
    errors.push("Property address is incomplete. Name, street, municipality and canton are required before a report can be generated.");
  }
  if (!input.assessmentDate) errors.push("Assessment date is missing.");
  if (!input.disclaimer.trim()) errors.push("Report disclaimer is empty. An administrator must configure it before a report can be generated.");

  const byCode = new Map(input.components.map((component) => [component.groupCode, component]));
  for (const group of COMPONENT_GROUPS) {
    const component = byCode.get(group.code);
    if (!component) {
      errors.push(`${group.name} is missing from this assessment.`);
      continue;
    }
    if (!component.reviewed) errors.push(`${component.groupName} has not been reviewed.`);
    for (const issue of [
      scoreError(component.groupName, "condition", component.condition, component.conditionUnknown),
      scoreError(component.groupName, "urgency", component.urgency, component.urgencyUnknown),
      scoreError(component.groupName, "consequence", component.consequence, component.consequenceUnknown),
      scoreError(component.groupName, "cost escalation risk", component.escalation, component.escalationUnknown),
    ]) {
      if (issue) errors.push(issue);
    }
    if (component.conditionUnknown || component.urgencyUnknown || component.consequenceUnknown || component.escalationUnknown) {
      warnings.push(`${component.groupName}: one or more scores are unknown. ${VERIFICATION_TEXT}`);
    }
    if (component.installationYear == null) warnings.push(`${component.groupName}: installation year is unknown.`);
    if (component.costLow != null && component.costLow < 0) errors.push(`${component.groupName}: cost is negative.`);
    if (component.costHigh != null && component.costHigh < 0) errors.push(`${component.groupName}: cost is negative.`);
    if (component.costLow != null && component.costHigh != null && component.costLow > component.costHigh) {
      errors.push(`${component.groupName}: the low cost is higher than the high cost.`);
    }
    if (component.costUnavailable) warnings.push(`${component.groupName}: no indicative cost range is available.`);
    if (component.costOrigin === "assumption" && !component.costUnavailable) {
      warnings.push(`${component.groupName}: cost estimate is based on a planning assumption${component.assumptionSource ? ` (${component.assumptionSource})` : ""}, not a quotation.`);
    }
    if (component.confidence === "low" || component.confidence === "unknown") {
      warnings.push(`${component.groupName}: confidence is ${component.confidence}.`);
    }
    const review = requiresPriorityReview({
      condition: component.conditionUnknown ? null : component.condition,
      urgency: component.urgencyUnknown ? null : component.urgency,
      consequence: component.consequenceUnknown ? null : component.consequence,
    });
    if (review && !component.notes.trim()) {
      errors.push(`${component.groupName} is flagged for priority review but has no notes.`);
    }
  }

  for (const intervention of input.interventions) {
    const yearCheck = validateInterventionYears(
      {
        title: intervention.title,
        targetYear: intervention.targetYear,
        earliestYear: intervention.earliestYear,
        latestYear: intervention.latestYear,
        historical: intervention.historical,
      },
      input.currentYear,
    );
    errors.push(...yearCheck.errors);
    warnings.push(...yearCheck.warnings);
    if (intervention.low != null && intervention.low < 0) errors.push(`${intervention.title}: cost is negative.`);
    if (intervention.high != null && intervention.high < 0) errors.push(`${intervention.title}: cost is negative.`);
    if (intervention.low != null && intervention.high != null && intervention.low > intervention.high) {
      errors.push(`${intervention.title}: the low cost is higher than the high cost.`);
    }
  }

  if (input.reserveBalance == null) warnings.push("Reserve balance has not been provided.");
  if (input.annualContribution == null) warnings.push("Annual reserve contribution has not been provided.");
  if (input.reserveChecked && !input.reserveReconciles) {
    errors.push("Reserve calculation does not reconcile to opening + contributions + other funding − planned expenditure.");
  }

  return { errors, warnings, canGenerateReport: errors.length === 0 };
}
