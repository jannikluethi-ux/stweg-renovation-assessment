import { VERIFICATION_TEXT } from "./constants";
import { coordinationMessages } from "./calculations";

export interface AssistantComponent {
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
  summary: string;
  mainIssue: string;
  recommendedAction: string;
  notes: string;
  priorityScore: number | null;
  priorityBand: string | null;
  priorityMessage: string | null;
}

export interface AssistantDraft {
  label: string;
  missing: string[];
  questions: string[];
  findings: string[];
  clientExplanation: string[];
  dependencies: string[];
}

function scoreText(value: number | null, unknown: boolean): string {
  if (unknown || value == null) return "unknown";
  return String(value);
}

export function draftFromEnteredData(input: {
  propertyName: string;
  components: AssistantComponent[];
  activeCodes: string[];
  missingProfileFields: string[];
  fundingGapYears: number[];
}): AssistantDraft {
  const missing: string[] = [];
  const questions: string[] = [];
  const findings: string[] = [];

  for (const field of input.missingProfileFields) {
    missing.push(`Property profile: ${field} is unknown or blank.`);
    questions.push(`What is known about ${field}? If it is not applicable, mark it as not applicable rather than guessing.`);
  }

  for (const component of input.components) {
    if (!component.reviewed) {
      missing.push(`${component.groupName} has not been reviewed.`);
      questions.push(`Has ${component.groupName} been reviewed, or should it stay unassessed for now?`);
    }
    const unknownFields = [
      component.conditionUnknown || component.condition == null ? "condition" : null,
      component.urgencyUnknown || component.urgency == null ? "urgency" : null,
      component.consequenceUnknown || component.consequence == null ? "consequence" : null,
      component.escalationUnknown || component.escalation == null ? "cost escalation risk" : null,
    ].filter((field): field is string => Boolean(field));
    if (unknownFields.length > 0) {
      missing.push(`${component.groupName}: ${unknownFields.join(", ")} is unknown or missing.`);
      questions.push(`What verified information exists for ${component.groupName} (${unknownFields.join(", ")})? ${VERIFICATION_TEXT}`);
    }
    const entered = [component.summary, component.mainIssue, component.notes].map((text) => text.trim()).filter(Boolean);
    if (entered.length === 0) {
      findings.push(`No written finding has been entered for ${component.groupName}. This draft does not invent one.`);
      continue;
    }
    const priority = component.priorityScore == null ? "priority not calculated" : `priority ${component.priorityScore}${component.priorityBand ? ` (${component.priorityBand})` : ""}`;
    findings.push(
      `Based only on entered data for ${component.groupName}: condition ${scoreText(component.condition, component.conditionUnknown)}, urgency ${scoreText(component.urgency, component.urgencyUnknown)}, consequence ${scoreText(component.consequence, component.consequenceUnknown)}, cost escalation risk ${scoreText(component.escalation, component.escalationUnknown)}; ${priority}. Entered text: ${entered.join(" ")}`,
    );
  }

  const clientExplanation: string[] = [
    `Draft explanation for ${input.propertyName || "this property"}, written only from stored fields. It is not an engineering opinion and it does not certify safety.`,
  ];
  const scored = input.components.filter((component) => component.priorityBand);
  if (scored.length === 0) {
    clientExplanation.push("No numeric priorities are available yet because scores are missing or unknown. Unknown has not been treated as good.");
  } else {
    const highlights = scored
      .filter((component) => component.priorityBand === "Critical" || component.priorityBand === "High")
      .map((component) => `${component.groupName} (${component.priorityBand})`);
    clientExplanation.push(
      highlights.length
        ? `Entered scores currently place the following in Critical or High: ${highlights.join(", ")}. Any cost mentioned elsewhere is an indicative planning range, subject to technical inspection, tender and market conditions.`
        : "No component with a complete score is currently in the Critical or High band. This is a planning observation, not a safety certification.",
    );
  }
  if (input.fundingGapYears.length > 0) {
    clientExplanation.push(
      `The reserve projection, using the published formula, shows a projected funding gap in ${input.fundingGapYears.join(", ")}. This draft does not recommend a financing product.`,
    );
  }

  return {
    label:
      "Draft from entered data. This panel does not inspect the building, does not act as an engineer, does not certify structural safety, does not give legal advice, and does not guarantee costs.",
    missing,
    questions,
    findings,
    clientExplanation,
    dependencies: coordinationMessages(input.activeCodes),
  };
}
