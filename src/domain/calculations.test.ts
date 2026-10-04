import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  applyContingency,
  calculateCostLine,
  calculatePriority,
  coordinationMessages,
  priorityBand,
  projectReserve,
  quantityTimesUnit,
  requiresPriorityReview,
  reserveRowReconciles,
  roundChf,
  scenarioTotals,
  suggestPlanningWindow,
  validateInterventionYears,
  type ScenarioItem,
} from "./calculations.ts";
import { runQualityCheck, type QualityComponent } from "./quality.ts";
import { REPORT_SECTION_IDS, buildReportModel, type ReportSource } from "./report.ts";
import { DEFAULT_DISCLAIMER } from "./constants.ts";

describe("priority", () => {
  it("places boundary scores on the published bands", () => {
    assert.equal(priorityBand(100, DEFAULT_THRESHOLDS), "Critical");
    assert.equal(priorityBand(80, DEFAULT_THRESHOLDS), "Critical");
    assert.equal(priorityBand(79, DEFAULT_THRESHOLDS), "High");
    assert.equal(priorityBand(60, DEFAULT_THRESHOLDS), "High");
    assert.equal(priorityBand(59, DEFAULT_THRESHOLDS), "Medium");
    assert.equal(priorityBand(40, DEFAULT_THRESHOLDS), "Medium");
    assert.equal(priorityBand(39, DEFAULT_THRESHOLDS), "Low");
    assert.equal(priorityBand(20, DEFAULT_THRESHOLDS), "Low");
    assert.equal(priorityBand(19, DEFAULT_THRESHOLDS), "Monitor");
    assert.equal(priorityBand(0, DEFAULT_THRESHOLDS), "Monitor");
  });

  it("normalizes the corners of the 1–5 scale", () => {
    const low = calculatePriority({ condition: 1, urgency: 1, consequence: 1, escalation: 1 });
    const high = calculatePriority({ condition: 5, urgency: 5, consequence: 5, escalation: 5 });
    const mid = calculatePriority({ condition: 4, urgency: 4, consequence: 4, escalation: 4 });
    assert.equal(low.score, 0);
    assert.equal(low.band, "Monitor");
    assert.equal(high.score, 100);
    assert.equal(high.band, "Critical");
    assert.equal(mid.score, 75);
    assert.equal(mid.band, "High");
  });

  it("does not score unknown or missing inputs as 1", () => {
    const unknown = calculatePriority({ condition: null, urgency: 4, consequence: 4, escalation: 4 });
    const asOne = calculatePriority({ condition: 1, urgency: 4, consequence: 4, escalation: 4 });
    assert.equal(unknown.score, null);
    assert.equal(unknown.band, null);
    assert.equal(unknown.incomplete, true);
    assert.notEqual(unknown.score, asOne.score);
    assert.match(unknown.message ?? "", /not treated as a good score/);
    assert.match(unknown.message ?? "", /Further technical verification recommended/);
    const missing = calculatePriority({ condition: 3, urgency: 3, consequence: 3, escalation: null });
    assert.equal(missing.score, null);
    assert.match(missing.message ?? "", /Cost escalation risk/);
  });
});

describe("priority review flag", () => {
  it("flags condition >= 4, urgency >= 4, or consequence >= 5", () => {
    assert.equal(requiresPriorityReview({ condition: 4, urgency: 1, consequence: 1 }), true);
    assert.equal(requiresPriorityReview({ condition: 1, urgency: 4, consequence: 1 }), true);
    assert.equal(requiresPriorityReview({ condition: 1, urgency: 1, consequence: 5 }), true);
    assert.equal(requiresPriorityReview({ condition: 3, urgency: 3, consequence: 4 }), false);
    assert.equal(requiresPriorityReview({ condition: null, urgency: 4, consequence: 1 }), true);
    assert.equal(requiresPriorityReview({ condition: null, urgency: null, consequence: null }), false);
  });
});

describe("cost", () => {
  it("calculates the heating example, contingency, and whole CHF", () => {
    const line = calculateCostLine({
      quantity: 24,
      unitLow: 8000,
      unitHigh: 12000,
      manualLow: null,
      manualHigh: null,
      origin: "assumption",
    });
    assert.equal(line.low, 192000);
    assert.equal(line.high, 288000);
    const planning = applyContingency(line.low!, line.high!, 15);
    assert.equal(planning.contingencyLow, 28800);
    assert.equal(planning.contingencyHigh, 43200);
    assert.equal(planning.planningLow, 220800);
    assert.equal(planning.planningHigh, 331200);
    assert.equal(planning.planningLow, planning.baseLow + planning.contingencyLow);
  });

  it("returns zero for a zero quantity and rounds fractional products", () => {
    const zero = calculateCostLine({
      quantity: 0,
      unitLow: 8000,
      unitHigh: 12000,
      manualLow: 500,
      manualHigh: 900,
      origin: "assumption",
    });
    assert.equal(zero.low, 0);
    assert.equal(zero.high, 0);
    assert.equal(quantityTimesUnit(1.5, 100.4), 151);
    assert.equal(roundChf(150.6), 151);
  });

  it("sums scenario totals from inclusion flags only", () => {
    const items = [
      { low: 192000, high: 288000, includeLow: true, includeModerate: true, includeHigh: true, year: 2028 },
      { low: 6000, high: 12000, includeLow: true, includeModerate: true, includeHigh: true, year: 2027 },
      { low: 1000, high: 2000, includeLow: false, includeModerate: true, includeHigh: true, year: 2031 },
    ];
    assert.deepEqual(scenarioTotals(items, "low"), { low: 198000, high: 300000 });
    assert.deepEqual(scenarioTotals(items, "moderate"), { low: 199000, high: 302000 });
    assert.deepEqual(scenarioTotals(items, "high"), { low: 199000, high: 302000 });
    const withContingency = applyContingency(198000, 300000, 15);
    assert.equal(withContingency.planningLow, 227700);
    assert.equal(withContingency.planningHigh, 345000);
  });
});

describe("reserve fund", () => {
  it("rolls opening, contributions, other funding and expenditure, including a negative balance", () => {
    const rows = projectReserve(100, [
      { year: 2026, contribution: 50, otherFunding: 10, plannedExpenditure: 30 },
      { year: 2027, contribution: 50, otherFunding: 0, plannedExpenditure: 200 },
    ]);
    assert.equal(rows[0].opening, 100);
    assert.equal(rows[0].closing, 130);
    assert.equal(rows[0].fundingGap, false);
    assert.equal(rows[1].opening, 130);
    assert.equal(rows[1].closing, -20);
    assert.equal(rows[1].fundingGap, true);
    assert.ok(rows.every(reserveRowReconciles));
  });
});

describe("roadmap window", () => {
  it("suggests 2026–2034 for a 2004 installation with a 20–30 year life and does not make it mandatory", () => {
    const window = suggestPlanningWindow(2004, 20, 30, 2026);
    assert.equal(window.ageYears, 22);
    assert.equal(window.windowStart, 2026);
    assert.equal(window.windowEnd, 2034);
    assert.equal(window.mandatory, false);
    assert.match(window.text, /not a mandatory replacement/);
  });

  it("rejects a past target year unless it is historical", () => {
    const bad = validateInterventionYears(
      { title: "Heating", targetYear: 2020, earliestYear: null, latestYear: null, historical: false },
      2026,
    );
    assert.equal(bad.ok, false);
    const historical = validateInterventionYears(
      { title: "Heating", targetYear: 2020, earliestYear: null, latestYear: null, historical: true },
      2026,
    );
    assert.equal(historical.ok, true);
  });
});

describe("coordination", () => {
  it("recommends coordinating façade and windows without claiming a saving", () => {
    const messages = coordinationMessages(["B", "C"]);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /not an automatic cost saving/);
  });
});

function component(partial: Partial<QualityComponent> & Pick<QualityComponent, "groupCode" | "groupName">): QualityComponent {
  return {
    reviewed: true,
    condition: 2,
    conditionUnknown: false,
    urgency: 2,
    urgencyUnknown: false,
    consequence: 2,
    consequenceUnknown: false,
    escalation: 2,
    escalationUnknown: false,
    installationYear: 2004,
    notes: "Noted.",
    confidence: "medium",
    costLow: 1000,
    costHigh: 2000,
    costOrigin: "assumption",
    costUnavailable: false,
    assumptionSource: "DEMO synthetic assumption",
    ...partial,
  };
}

describe("quality check", () => {
  const groups = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
  const names = ["Roof", "Façade", "Windows", "Balconies", "Heating", "Hot water", "Ventilation", "Electrical", "Plumbing", "Lift", "Garage", "Common areas", "Outdoor areas"];

  it("separates a missing score error from an explicit unknown warning", () => {
    const components = groups.map((code, index) =>
      component({
        groupCode: code,
        groupName: names[index],
        condition: code === "E" ? null : 2,
        conditionUnknown: false,
        escalationUnknown: code === "G",
        escalation: code === "G" ? null : 2,
        notes: code === "E" ? "" : "Noted.",
      }),
    );
    const result = runQualityCheck({
      propertyName: "STWEG Sonnenhof",
      street: "Seestrasse 48",
      municipality: "Zollikon",
      canton: "ZH",
      assessmentDate: "2026-10-04",
      components,
      interventions: [],
      reserveBalance: 85000,
      annualContribution: 18000,
      disclaimer: DEFAULT_DISCLAIMER,
      currentYear: 2026,
      reserveReconciles: true,
      reserveChecked: true,
    });
    assert.ok(result.errors.some((error) => error.includes("Heating has no condition score")));
    assert.ok(result.warnings.some((warning) => warning.includes("Ventilation") && warning.includes("Further technical verification recommended")));
    assert.equal(result.canGenerateReport, false);
  });
});

describe("report", () => {
  it("includes every required section, the disclaimer, warnings, and reconciled totals", () => {
    const items: ScenarioItem[] = [
      { title: "Heating system replacement", low: 192000, high: 288000, includeLow: true, includeModerate: true, includeHigh: true, year: 2028 },
      { title: "Heating plant technical inspection", low: 6000, high: 12000, includeLow: true, includeModerate: true, includeHigh: true, year: 2027 },
    ];
    const source: ReportSource = {
      branding: { companyName: "STWEG & Property Project Office", productName: "STWEG Renovation Assessment", address: "Zürich", footer: "Indicative only." },
      disclaimer: DEFAULT_DISCLAIMER,
      formulaText: "Priority = Condition×0.30 + Urgency×0.30 + Consequence×0.25 + Cost Escalation Risk×0.15, normalized to 0–100.",
      bandLegend: "80–100 Critical, 60–79 High, 40–59 Medium, 20–39 Low, 0–19 Monitor",
      property: {
        name: "STWEG Sonnenhof",
        addressLine: "Seestrasse 48, 8702 Zollikon",
        municipality: "Zollikon",
        canton: "ZH",
        country: "Switzerland",
        yearBuilt: "2004",
        yearFirstOccupation: "2005",
        buildings: "3",
        units: "24",
        owners: "24",
        floors: "4",
        features: [],
        isDemo: true,
      },
      assessment: {
        version: 1,
        date: "2026-10-04",
        assessorName: "Demo Project Manager",
        status: "in_review",
        overallConfidence: "medium",
        notes: "Synthetic.",
        contingencyPct: 15,
        reportVersion: 1,
      },
      completeness: { overall: 80, propertyData: 100, envelope: 100, technical: 90, financial: 100, documentation: 38 },
      health: [{ label: "Building envelope", score: "70", note: "Not a safety rating." }],
      components: [
        {
          code: "E",
          name: "Heating",
          condition: "4",
          urgency: "4",
          risk: "4",
          priority: "75 High",
          target: "2028",
          finding: "Synthetic demo entry.",
          issue: "Age and condition.",
          action: "replace",
          baseCost: "CHF 192'000 – CHF 288'000",
          planningCost: "CHF 220'800 – CHF 331'200",
          confidence: "low",
          unknown: false,
          priorityReview: true,
        },
      ],
      measures: [],
      scenarioItems: items,
      roadmap: [{ year: 2028, lines: ["Heating system replacement"] }],
      reserve: {
        scenarioLabel: "Moderate / recommended",
        note: "Opening + contributions + other funding − planned expenditure = closing.",
        rows: projectReserve(85000, [
          { year: 2026, contribution: 18000, otherFunding: 0, plannedExpenditure: 0 },
          { year: 2028, contribution: 18000, otherFunding: 0, plannedExpenditure: 288000 },
        ]),
      },
      warnings: ["Heating: cost estimate is based on a planning assumption, not a quotation."],
      errors: [],
      assumptions: ["DEMO synthetic assumption — not market data."],
      sources: ["Reserve-fund information (synthetic)."],
      photos: [],
      generatedAtIso: "2026-10-04T14:00:00.000Z",
      profileLines: [{ label: "Heating type", value: "Known — gas" }],
    };
    const model = buildReportModel(source);
    assert.deepEqual(model.sections.map((section) => section.id), [...REPORT_SECTION_IDS]);
    assert.ok(model.disclaimer.includes("indicative planning estimates"));
    assert.ok(model.warnings.length >= 1);
    assert.equal(model.scenarios.moderate.baseLow, 198000);
    assert.equal(model.scenarios.moderate.baseHigh, 300000);
    assert.equal(model.scenarios.moderate.planningLow, 227700);
    assert.equal(model.scenarios.moderate.planningHigh, 345000);
    const cost = model.sections.find((section) => section.id === "8-cost-outlook");
    const text = JSON.stringify(cost);
    assert.match(text, /CHF 198'000/);
    assert.match(text, /CHF 220'800/);
    const reserve = model.sections.find((section) => section.id === "9-reserve-outlook");
    assert.match(JSON.stringify(reserve), /Projected funding gap/);
  });
});

