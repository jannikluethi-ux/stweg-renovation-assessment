import { COMPONENT_GROUPS, CORE_DOCUMENT_CATEGORIES, PROFILE_FIELDS } from "./constants";

export interface CompletenessBreakdown {
  overall: number;
  propertyData: number;
  envelope: number;
  technical: number;
  financial: number;
  documentation: number;
}

export interface ProfileFieldState {
  key: string;
  status: "known" | "unknown" | "na";
  value: string | number | null;
}

export interface ComponentCompletenessInput {
  groupCode: string;
  conditionAnswered: boolean;
  urgencyAnswered: boolean;
  consequenceAnswered: boolean;
  escalationAnswered: boolean;
}

function percent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((done / total) * 100);
}

export function propertyDataCompleteness(fields: { filled: boolean }[]): number {
  return percent(fields.filter((f) => f.filled).length, fields.length);
}

export function groupAnswerCompleteness(components: ComponentCompletenessInput[], codes: string[]): number {
  const relevant = components.filter((c) => codes.includes(c.groupCode));
  const total = codes.length * 4;
  const done = relevant.reduce((sum, component) => {
    return (
      sum +
      Number(component.conditionAnswered) +
      Number(component.urgencyAnswered) +
      Number(component.consequenceAnswered) +
      Number(component.escalationAnswered)
    );
  }, 0);
  return percent(done, total);
}

export function profileCompleteness(fields: ProfileFieldState[], dimension: "envelope" | "technical" | "common"): number {
  const keys = new Set(PROFILE_FIELDS.filter((f) => f.dimension === dimension).map((f) => f.key));
  const applicable = fields.filter((f) => keys.has(f.key) && f.status !== "na");
  const done = applicable.filter((f) => f.status === "known" && f.value != null && String(f.value).trim() !== "").length;
  return percent(done, applicable.length);
}

export function blend(a: number, b: number): number {
  return Math.round((a + b) / 2);
}

export function financialCompleteness(values: Array<number | null>): number {
  return percent(values.filter((v) => v != null).length, values.length);
}

export function documentationCompleteness(presentCategories: string[]): number {
  const present = new Set(presentCategories);
  const done = CORE_DOCUMENT_CATEGORIES.filter((key) => present.has(key)).length;
  return percent(done, CORE_DOCUMENT_CATEGORIES.length);
}

export function overallCompleteness(parts: Omit<CompletenessBreakdown, "overall">): CompletenessBreakdown {
  const overall = Math.round(
    (parts.propertyData + parts.envelope + parts.technical + parts.financial + parts.documentation) / 5,
  );
  return { overall, ...parts };
}

export interface HealthDimension {
  key: "envelope" | "technical" | "common" | "financial" | "documentation";
  label: string;
  score: number | null;
  note: string;
}

export function conditionHealth(scores: Array<number | null>): { score: number | null; unknownCount: number } {
  const known = scores.filter((score): score is number => score != null);
  const unknownCount = scores.length - known.length;
  if (known.length === 0) {
    return { score: null, unknownCount };
  }
  const average = known.reduce((sum, score) => sum + ((5 - score) / 4) * 100, 0) / known.length;
  return { score: Math.round(average), unknownCount };
}

export function financialPreparedness(input: {
  balance: number | null;
  contribution: number | null;
  firstGapYear: number | null;
  currentYear: number;
}): HealthDimension {
  const base = "Planning Health Indicator for financial preparedness only. Not a safety rating, property value, or financing recommendation.";
  if (input.balance == null || input.contribution == null) {
    return {
      key: "financial",
      label: "Financial preparedness",
      score: null,
      note: `Insufficient reserve data. Unknown is not treated as prepared. ${base}`,
    };
  }
  if (input.balance < 0) {
    return { key: "financial", label: "Financial preparedness", score: 10, note: `Opening balance is already negative. ${base}` };
  }
  if (input.firstGapYear == null) {
    return {
      key: "financial",
      label: "Financial preparedness",
      score: 85,
      note: `No projected funding gap in the current roadmap window under the selected scenario. ${base}`,
    };
  }
  if (input.firstGapYear <= input.currentYear + 3) {
    return {
      key: "financial",
      label: "Financial preparedness",
      score: 30,
      note: `A projected funding gap falls within 3 years (${input.firstGapYear}). ${base}`,
    };
  }
  return {
    key: "financial",
    label: "Financial preparedness",
    score: 55,
    note: `A projected funding gap appears later in the window (${input.firstGapYear}). ${base}`,
  };
}

export function planningHealth(input: {
  envelopeConditions: Array<number | null>;
  technicalConditions: Array<number | null>;
  commonConditions: Array<number | null>;
  financial: HealthDimension;
  documentationScore: number;
}): HealthDimension[] {
  const describe = (label: string, key: HealthDimension["key"], scores: Array<number | null>): HealthDimension => {
    const health = conditionHealth(scores);
    const unknown =
      health.unknownCount > 0
        ? ` ${health.unknownCount} component score(s) excluded because they are unknown. Unknown is not treated as good.`
        : "";
    return {
      key,
      label,
      score: health.score,
      note: `Based only on entered condition scores (1 = healthier planning position, 5 = weaker). Not a safety rating or a property value.${unknown}`,
    };
  };
  return [
    describe("Building envelope", "envelope", input.envelopeConditions),
    describe("Technical systems", "technical", input.technicalConditions),
    describe("Common areas", "common", input.commonConditions),
    input.financial,
    {
      key: "documentation",
      label: "Documentation / information quality",
      score: input.documentationScore,
      note: "Share of core document categories on file. Not a judgement of document quality and not a safety rating.",
    },
  ];
}

export function codesFor(category: "envelope" | "technical" | "common"): string[] {
  return COMPONENT_GROUPS.filter((group) => group.category === category).map((group) => group.code);
}
