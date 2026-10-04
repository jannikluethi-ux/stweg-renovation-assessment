import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { COMPONENT_GROUPS, CORE_DOCUMENT_CATEGORIES, ENERGY_TOPICS, PROFILE_FIELDS, CANTONS, DOCUMENT_CATEGORIES } from "../domain/constants";
import type {
  BrandingDTO,
  ComponentDTO,
  ComponentItemDTO,
  CostAssumptionDTO,
  DocumentDTO,
  EnergyDTO,
  FinancialDTO,
  InterventionDTO,
  LeadDTO,
  PhotoDTO,
  ProfileFieldDTO,
  PropertyDTO,
  SettingsDTO,
  UsefulLifeDTO,
} from "../domain/dto";
import {
  applyContingency,
  buildReserveYears,
  calculateCostLine,
  calculatePriority,
  coordinationMessages,
  formatChfRange,
  isHighPriorityBand,
  itemIncluded,
  requiresPriorityReview,
  reserveRowReconciles,
  roadmapYears,
  scenarioTotals,
  suggestPlanningWindow,
  validateInterventionYears,
  zurichYear,
  type CostOrigin,
  type PriorityThresholds,
  type PriorityWeights,
  type ScenarioItem,
  type ScenarioKey,
} from "../domain/calculations";
import {
  blend,
  documentationCompleteness,
  financialCompleteness,
  financialPreparedness,
  groupAnswerCompleteness,
  overallCompleteness,
  planningHealth,
  profileCompleteness,
  propertyDataCompleteness,
  codesFor,
  type CompletenessBreakdown,
  type HealthDimension,
  type ProfileFieldState,
} from "../domain/completeness";
import { draftFromEnteredData } from "../domain/assistant";
import { runQualityCheck, type QualityComponent, type QualityResult } from "../domain/quality";
import { buildReportModel, type ReportModel, type ReportSource } from "../domain/report";
import { canEditGlobalAssumptions, getDb, nowIso, writeAudit, type Role, type SessionUser } from "./db";

type Row = Record<string, any>;

function db(): Database.Database {
  return getDb();
}

function n(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function i(value: unknown): number | null {
  const parsed = n(value);
  return parsed == null ? null : Math.round(parsed);
}

function b(value: unknown): boolean {
  return value === 1 || value === true;
}

function parseLabels(raw: string, fallback: Record<string, string>): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function getBranding(organizationId: string): BrandingDTO {
  const row = db().prepare(`SELECT name, company_name, product_name, address, footer FROM organizations WHERE id = ?`).get(organizationId) as Row | undefined;
  if (!row) throw new Error("Organization not found.");
  return {
    organizationName: row.name,
    companyName: row.company_name,
    productName: row.product_name,
    address: row.address,
    footer: row.footer,
  };
}

export function getSettings(organizationId: string): SettingsDTO {
  const row = db().prepare(`SELECT * FROM org_settings WHERE organization_id = ?`).get(organizationId) as Row | undefined;
  if (!row) throw new Error("Organization settings are missing. Run npm run seed.");
  return mapSettings(row);
}

function mapSettings(row: Row): SettingsDTO {
  return {
    weights: {
      condition: row.weight_condition,
      urgency: row.weight_urgency,
      consequence: row.weight_consequence,
      escalation: row.weight_escalation,
    },
    thresholds: {
      critical: row.band_critical,
      high: row.band_high,
      medium: row.band_medium,
      low: row.band_low,
    },
    contingencyPct: row.contingency_pct,
    disclaimer: row.disclaimer,
    regulatoryNotes: row.regulatory_notes,
    conditionLabels: parseLabels(row.condition_labels_json, {}),
    urgencyLabels: parseLabels(row.urgency_labels_json, {}),
  };
}

function mapProperty(row: Row): PropertyDTO {
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    zip: row.zip,
    municipality: row.municipality,
    canton: row.canton,
    country: row.country,
    yearBuilt: n(row.year_built),
    yearFirstOccupation: n(row.year_first_occupation),
    buildings: n(row.buildings),
    units: n(row.units),
    owners: n(row.owners),
    floors: n(row.floors),
    basementPresent: row.basement_present,
    undergroundParking: row.underground_parking,
    outdoorParking: row.outdoor_parking,
    hasLift: row.has_lift,
    balconyTerrace: row.balcony_terrace,
    garden: row.garden,
    status: row.status,
    isDemo: b(row.is_demo),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProperties(organizationId: string, filter: { q?: string; canton?: string; status?: string; municipality?: string }): PropertyDTO[] {
  const q = (filter.q ?? "").trim();
  const canton = filter.canton ?? "";
  const status = filter.status ?? "";
  const municipality = (filter.municipality ?? "").trim();
  const rows = db()
    .prepare(
      `SELECT * FROM properties
       WHERE organization_id = ?
         AND (? = '' OR name LIKE ? OR municipality LIKE ? OR street LIKE ?)
         AND (? = '' OR canton = ?)
         AND (? = '' OR status = ?)
         AND (? = '' OR municipality LIKE ?)
       ORDER BY name COLLATE NOCASE`,
    )
    .all(organizationId, q, `%${q}%`, `%${q}%`, `%${q}%`, canton, canton, status, status, municipality, `%${municipality}%`) as Row[];
  return rows.map(mapProperty);
}

export function getProperty(organizationId: string, propertyId: string): PropertyDTO | null {
  const row = db().prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ?`).get(propertyId, organizationId) as Row | undefined;
  return row ? mapProperty(row) : null;
}

export function getProfile(propertyId: string): ProfileFieldDTO[] {
  const row = db().prepare(`SELECT * FROM building_profiles WHERE property_id = ?`).get(propertyId) as Row | undefined;
  return PROFILE_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    section: field.section,
    kind: field.kind,
    dimension: field.dimension,
    status: ((row?.[`${field.key}_status`] as ProfileFieldDTO["status"]) ?? "unknown"),
    value: row?.[field.key] == null ? "" : String(row[field.key]),
  }));
}

function weightsOf(row: Row): PriorityWeights {
  return {
    condition: row.weight_condition,
    urgency: row.weight_urgency,
    consequence: row.weight_consequence,
    escalation: row.weight_escalation,
  };
}

function thresholdsOf(row: Row): PriorityThresholds {
  return { critical: row.band_critical, high: row.band_high, medium: row.band_medium, low: row.band_low };
}

function mapItem(row: Row): ComponentItemDTO {
  return {
    id: row.id,
    itemKey: row.item_key,
    label: row.label,
    status: row.status,
    observation: row.observation,
    conditionScore: n(row.condition_score),
    conditionUnknown: b(row.condition_unknown),
  };
}

function mapComponent(row: Row, items: ComponentItemDTO[]): ComponentDTO {
  return {
    id: row.id,
    groupCode: row.group_code,
    groupName: row.group_name,
    category: row.category,
    conditionScore: n(row.condition_score),
    conditionUnknown: b(row.condition_unknown),
    urgencyScore: n(row.urgency_score),
    urgencyUnknown: b(row.urgency_unknown),
    consequenceScore: n(row.consequence_score),
    consequenceUnknown: b(row.consequence_unknown),
    escalationScore: n(row.escalation_score),
    escalationUnknown: b(row.escalation_unknown),
    installationYear: n(row.installation_year),
    lastRenovationYear: n(row.last_renovation_year),
    usefulLifeLow: n(row.useful_life_low),
    usefulLifeHigh: n(row.useful_life_high),
    confidence: row.confidence,
    summary: row.current_condition_summary,
    mainIssue: row.main_issue,
    recommendedAction: row.recommended_action,
    notes: row.notes,
    quantity: n(row.quantity),
    quantityUnit: row.quantity_unit,
    costOrigin: row.cost_origin,
    unitLow: n(row.unit_low),
    unitHigh: n(row.unit_high),
    costSourceNote: row.cost_source_note,
    manualLow: n(row.manual_low),
    manualHigh: n(row.manual_high),
    reviewed: b(row.reviewed),
    items,
    updatedAt: row.updated_at,
  };
}

export function componentCost(component: ComponentDTO) {
  return calculateCostLine({
    quantity: component.quantity,
    unitLow: component.unitLow,
    unitHigh: component.unitHigh,
    manualLow: component.manualLow,
    manualHigh: component.manualHigh,
    origin: component.costOrigin,
  });
}

export function scoreInput(component: ComponentDTO) {
  return {
    condition: component.conditionUnknown ? null : component.conditionScore,
    urgency: component.urgencyUnknown ? null : component.urgencyScore,
    consequence: component.consequenceUnknown ? null : component.consequenceScore,
    escalation: component.escalationUnknown ? null : component.escalationScore,
  };
}

function mapIntervention(row: Row, component: ComponentDTO | undefined): InterventionDTO {
  let low = n(row.low_cost);
  let high = n(row.high_cost);
  if (b(row.use_component_cost) && component) {
    const cost = componentCost(component);
    low = cost.low;
    high = cost.high;
  }
  return {
    id: row.id,
    componentId: row.component_id,
    groupCode: component?.groupCode ?? null,
    title: row.title,
    targetYear: n(row.target_year),
    earliestYear: n(row.earliest_year),
    latestYear: n(row.latest_year),
    lowCost: low,
    highCost: high,
    useComponentCost: b(row.use_component_cost),
    priorityLabel: row.priority_label,
    includeLow: b(row.include_low),
    includeModerate: b(row.include_moderate),
    includeHigh: b(row.include_high),
    dependencies: row.dependencies,
    status: row.status,
    notes: row.notes,
    historical: b(row.historical),
    updatedAt: row.updated_at,
  };
}

function mapFinancial(row: Row | undefined): FinancialDTO | null {
  if (!row) return null;
  return {
    id: row.id,
    reserveBalance: n(row.reserve_balance),
    annualContribution: n(row.annual_contribution),
    annualMaintenance: n(row.annual_maintenance),
    specialContributions: n(row.special_contributions),
    otherFundingAnnual: n(row.other_funding_annual),
    existingFinancingNote: row.existing_financing_note,
    otherObligations: n(row.other_obligations),
    notes: row.notes,
  };
}

export interface AssessmentMeta {
  id: string;
  propertyId: string;
  propertyName: string;
  version: number;
  status: string;
  assessmentDate: string;
  assessorName: string;
  overallConfidence: string;
  notes: string;
  contingencyPct: number;
  weights: PriorityWeights;
  thresholds: PriorityThresholds;
  parentAssessmentId: string | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

function mapAssessment(row: Row): AssessmentMeta {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    version: row.version,
    status: row.status,
    assessmentDate: row.assessment_date,
    assessorName: row.assessor_name ?? "—",
    overallConfidence: row.overall_confidence,
    notes: row.notes,
    contingencyPct: row.contingency_pct,
    weights: weightsOf(row),
    thresholds: thresholdsOf(row),
    parentAssessmentId: row.parent_assessment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: b(row.is_demo),
  };
}

const ASSESSMENT_SELECT = `
  SELECT a.*, p.name AS property_name, p.is_demo, u.name AS assessor_name
  FROM assessments a
  JOIN properties p ON p.id = a.property_id
  LEFT JOIN users u ON u.id = a.assessor_id
`;

export function listAssessments(organizationId: string, status = ""): AssessmentMeta[] {
  const rows = db()
    .prepare(`${ASSESSMENT_SELECT} WHERE a.organization_id = ? AND (? = '' OR a.status = ?) ORDER BY p.name, a.version DESC`)
    .all(organizationId, status, status) as Row[];
  return rows.map(mapAssessment);
}

export function latestAssessmentId(organizationId: string, propertyId: string): string | null {
  const row = db()
    .prepare(`SELECT id FROM assessments WHERE organization_id = ? AND property_id = ? ORDER BY version DESC LIMIT 1`)
    .get(organizationId, propertyId) as Row | undefined;
  return row?.id ?? null;
}

export interface Bundle {
  property: PropertyDTO;
  profile: ProfileFieldDTO[];
  assessment: AssessmentMeta;
  components: ComponentDTO[];
  interventions: InterventionDTO[];
  financial: FinancialDTO | null;
  documents: DocumentDTO[];
  photos: PhotoDTO[];
  energy: EnergyDTO[];
  branding: BrandingDTO;
  settings: SettingsDTO;
  completeness: CompletenessBreakdown & { common: number };
  health: HealthDimension[];
  quality: QualityResult;
  reserveRows: ReturnType<typeof buildReserveYears>;
  reserveScenario: ScenarioKey;
  coordination: string[];
  assistant: ReturnType<typeof draftFromEnteredData>;
  versions: { id: string; version: number; status: string; assessmentDate: string }[];
}

export function loadBundle(organizationId: string, assessmentId: string, scenario: ScenarioKey = "moderate"): Bundle | null {
  const assessmentRow = db().prepare(`${ASSESSMENT_SELECT} WHERE a.id = ? AND a.organization_id = ?`).get(assessmentId, organizationId) as Row | undefined;
  if (!assessmentRow) return null;
  const assessment = mapAssessment(assessmentRow);
  const property = getProperty(organizationId, assessment.propertyId);
  if (!property) return null;
  const profile = getProfile(property.id);
  const componentRows = db().prepare(`SELECT * FROM assessment_components WHERE assessment_id = ? ORDER BY group_code`).all(assessment.id) as Row[];
  const itemRows = db()
    .prepare(`SELECT i.* FROM component_items i JOIN assessment_components c ON c.id = i.component_id WHERE c.assessment_id = ? ORDER BY i.label`)
    .all(assessment.id) as Row[];
  const itemsByComponent = new Map<string, ComponentItemDTO[]>();
  for (const item of itemRows) {
    const list = itemsByComponent.get(item.component_id) ?? [];
    list.push(mapItem(item));
    itemsByComponent.set(item.component_id, list);
  }
  const components = componentRows.map((row) => mapComponent(row, itemsByComponent.get(row.id) ?? []));
  const byId = new Map(components.map((component) => [component.id, component]));
  const interventionRows = db().prepare(`SELECT * FROM interventions WHERE assessment_id = ? ORDER BY target_year IS NULL, target_year, title`).all(assessment.id) as Row[];
  const interventions = interventionRows.map((row) => mapIntervention(row, row.component_id ? byId.get(row.component_id) : undefined));
  const financial = mapFinancial(db().prepare(`SELECT * FROM financial_profiles WHERE assessment_id = ?`).get(assessment.id) as Row | undefined);
  const documents = listDocuments(organizationId, property.id);
  const photos = (db().prepare(`SELECT * FROM photos WHERE assessment_id = ? ORDER BY created_at`).all(assessment.id) as Row[]).map(mapPhoto);
  const energyRows = db().prepare(`SELECT * FROM energy_measures WHERE assessment_id = ?`).all(assessment.id) as Row[];
  const energy = ENERGY_TOPICS.map((topic) => {
    const row = energyRows.find((item) => item.topic_key === topic.key);
    return {
      topicKey: topic.key,
      investmentLow: n(row?.investment_low),
      investmentHigh: n(row?.investment_high),
      qualitativeBenefit: row?.qualitative_benefit ?? "",
      dependencyNote: row?.dependency_note ?? "",
      verificationRequired: row ? b(row.verification_required) : true,
      notes: row?.notes ?? "",
    } satisfies EnergyDTO;
  });
  const versions = (db().prepare(`SELECT id, version, status, assessment_date FROM assessments WHERE property_id = ? ORDER BY version`).all(property.id) as Row[]).map((row) => ({
    id: row.id,
    version: row.version,
    status: row.status,
    assessmentDate: row.assessment_date,
  }));
  const branding = getBranding(organizationId);
  const settings = getSettings(organizationId);
  const completeness = computeCompleteness(property, profile, components, financial, documents);
  const scenarioItems = toScenarioItems(interventions);
  const year = zurichYear();
  const reserveScenario = scenario;
  const expenditureByYear: Record<number, number> = {};
  for (const item of scenarioItems) {
    if (!itemIncluded(item, reserveScenario) || item.year == null || item.high == null) continue;
    expenditureByYear[item.year] = (expenditureByYear[item.year] ?? 0) + item.high;
  }
  const reserveRows =
    financial && financial.reserveBalance != null && financial.annualContribution != null
      ? buildReserveYears({
          openingBalance: financial.reserveBalance,
          annualContribution: financial.annualContribution,
          otherFundingAnnual: financial.otherFundingAnnual ?? 0,
          specialContribution: financial.specialContributions ?? 0,
          expenditureByYear,
          startYear: year,
        })
      : [];
  const firstGap = reserveRows.find((row) => row.fundingGap)?.year ?? null;
  const health = planningHealth({
    envelopeConditions: components.filter((c) => c.category === "envelope").map((c) => (c.conditionUnknown ? null : c.conditionScore)),
    technicalConditions: components.filter((c) => c.category === "technical").map((c) => (c.conditionUnknown ? null : c.conditionScore)),
    commonConditions: components.filter((c) => c.category === "common").map((c) => (c.conditionUnknown ? null : c.conditionScore)),
    financial: financialPreparedness({
      balance: financial?.reserveBalance ?? null,
      contribution: financial?.annualContribution ?? null,
      firstGapYear: firstGap,
      currentYear: year,
    }),
    documentationScore: completeness.documentation,
  });
  const quality = runQualityCheck({
    propertyName: property.name,
    street: property.street,
    municipality: property.municipality,
    canton: property.canton,
    assessmentDate: assessment.assessmentDate,
    components: components.map(toQualityComponent),
    interventions: interventions.map((item) => ({
      title: item.title,
      targetYear: item.targetYear,
      earliestYear: item.earliestYear,
      latestYear: item.latestYear,
      historical: item.historical,
      low: item.lowCost,
      high: item.highCost,
    })),
    reserveBalance: financial?.reserveBalance ?? null,
    annualContribution: financial?.annualContribution ?? null,
    disclaimer: settings.disclaimer,
    currentYear: year,
    reserveChecked: reserveRows.length > 0,
    reserveReconciles: reserveRows.length > 0 && reserveRows.every(reserveRowReconciles),
  });
  for (const intervention of interventions) {
    if ((intervention.includeLow || intervention.includeModerate || intervention.includeHigh) && (intervention.lowCost == null || intervention.highCost == null)) {
      quality.warnings.push(`${intervention.title}: no cost range is available, so it is excluded from totals until a range is entered.`);
    }
  }
  const activeCodes = [
    ...interventions.filter((item) => item.groupCode && (item.includeLow || item.includeModerate || item.includeHigh)).map((item) => item.groupCode as string),
    ...energy.filter((item) => item.investmentLow != null || item.investmentHigh != null || item.notes.trim()).map((item) => item.topicKey),
  ];
  if (interventions.some((item) => item.groupCode === "B" && item.includeHigh)) activeCodes.push("insulation");
  const coordination = coordinationMessages(activeCodes);
  const assistant = draftFromEnteredData({
    propertyName: property.name,
    components: components.map((component) => {
      const priority = calculatePriority(scoreInput(component), assessment.weights, assessment.thresholds);
      return {
        groupCode: component.groupCode,
        groupName: component.groupName,
        reviewed: component.reviewed,
        ...scoreInput(component),
        conditionUnknown: component.conditionUnknown || component.conditionScore == null,
        urgencyUnknown: component.urgencyUnknown || component.urgencyScore == null,
        consequenceUnknown: component.consequenceUnknown || component.consequenceScore == null,
        escalationUnknown: component.escalationUnknown || component.escalationScore == null,
        summary: component.summary,
        mainIssue: component.mainIssue,
        recommendedAction: component.recommendedAction,
        notes: component.notes,
        priorityScore: priority.score,
        priorityBand: priority.band,
        priorityMessage: priority.message,
      };
    }),
    activeCodes,
    missingProfileFields: profile.filter((field) => field.status === "unknown" || (field.status === "known" && !field.value.trim())).map((field) => field.label),
    fundingGapYears: reserveRows.filter((row) => row.fundingGap).map((row) => row.year),
  });
  return {
    property,
    profile,
    assessment,
    components,
    interventions,
    financial,
    documents,
    photos,
    energy,
    branding,
    settings,
    completeness,
    health,
    quality,
    reserveRows,
    reserveScenario,
    coordination,
    assistant,
    versions,
  };
}

function toScenarioItems(interventions: InterventionDTO[]): (ScenarioItem & { high: number | null })[] {
  return interventions.map((item) => ({
    title: item.title,
    low: item.lowCost ?? 0,
    high: item.highCost ?? 0,
    includeLow: item.includeLow && item.lowCost != null && item.highCost != null,
    includeModerate: item.includeModerate && item.lowCost != null && item.highCost != null,
    includeHigh: item.includeHigh && item.lowCost != null && item.highCost != null,
    year: item.targetYear,
  }));
}

export function scenarioItemsOf(interventions: InterventionDTO[]): ScenarioItem[] {
  return toScenarioItems(interventions);
}

function toQualityComponent(component: ComponentDTO): QualityComponent {
  const cost = componentCost(component);
  return {
    groupCode: component.groupCode,
    groupName: component.groupName,
    reviewed: component.reviewed,
    condition: component.conditionScore,
    conditionUnknown: component.conditionUnknown,
    urgency: component.urgencyScore,
    urgencyUnknown: component.urgencyUnknown,
    consequence: component.consequenceScore,
    consequenceUnknown: component.consequenceUnknown,
    escalation: component.escalationScore,
    escalationUnknown: component.escalationUnknown,
    installationYear: component.installationYear,
    notes: component.notes,
    confidence: component.confidence,
    costLow: cost.low,
    costHigh: cost.high,
    costOrigin: component.costOrigin,
    costUnavailable: cost.method === "unavailable",
    assumptionSource: component.costSourceNote,
  };
}

function computeCompleteness(property: PropertyDTO, profile: ProfileFieldDTO[], components: ComponentDTO[], financial: FinancialDTO | null, documents: DocumentDTO[]): CompletenessBreakdown & { common: number } {
  const propertyData = propertyDataCompleteness([
    { filled: Boolean(property.name.trim()) },
    { filled: Boolean(property.street.trim()) },
    { filled: /^\d{4}$/.test(property.zip) },
    { filled: Boolean(property.municipality.trim()) },
    { filled: Boolean(property.canton.trim()) },
    { filled: Boolean(property.country.trim()) },
    { filled: property.yearBuilt != null },
    { filled: property.yearFirstOccupation != null },
    { filled: property.buildings != null },
    { filled: property.units != null },
    { filled: property.owners != null },
    { filled: property.floors != null },
    { filled: property.basementPresent !== "unknown" },
    { filled: property.undergroundParking !== "unknown" },
    { filled: property.outdoorParking !== "unknown" },
    { filled: property.hasLift !== "unknown" },
    { filled: property.balconyTerrace !== "unknown" },
    { filled: property.garden !== "unknown" },
  ]);
  const answered = components.map((component) => ({
    groupCode: component.groupCode,
    conditionAnswered: component.conditionUnknown || component.conditionScore != null,
    urgencyAnswered: component.urgencyUnknown || component.urgencyScore != null,
    consequenceAnswered: component.consequenceUnknown || component.consequenceScore != null,
    escalationAnswered: component.escalationUnknown || component.escalationScore != null,
  }));
  const states: ProfileFieldState[] = profile.map((field) => ({
    key: field.key,
    status: field.status,
    value: field.value,
  }));
  const envelope = blend(groupAnswerCompleteness(answered, codesFor("envelope")), profileCompleteness(states, "envelope"));
  const technical = blend(groupAnswerCompleteness(answered, codesFor("technical")), profileCompleteness(states, "technical"));
  const common = blend(groupAnswerCompleteness(answered, codesFor("common")), profileCompleteness(states, "common"));
  const financialScore = financialCompleteness([
    financial?.reserveBalance ?? null,
    financial?.annualContribution ?? null,
    financial?.annualMaintenance ?? null,
    financial?.specialContributions ?? null,
    financial?.otherFundingAnnual ?? null,
  ]);
  const documentation = documentationCompleteness(documents.map((doc) => doc.category));
  const base = overallCompleteness({ propertyData, envelope, technical, financial: financialScore, documentation });
  return { ...base, overall: Math.round((propertyData + envelope + technical + financialScore + documentation + common) / 6), common };
}

function mapPhoto(row: Row): PhotoDTO {
  return {
    id: row.id,
    componentId: row.component_id,
    caption: row.caption,
    location: row.location,
    relevance: row.relevance,
    photoDate: row.photo_date,
    createdAt: row.created_at,
  };
}

export function listDocuments(organizationId: string, propertyId = "", category = ""): DocumentDTO[] {
  const rows = db()
    .prepare(
      `SELECT d.*, p.name AS property_name
       FROM documents d JOIN properties p ON p.id = d.property_id
       WHERE d.organization_id = ? AND (? = '' OR d.property_id = ?) AND (? = '' OR d.category = ?)
       ORDER BY d.upload_date DESC`,
    )
    .all(organizationId, propertyId, propertyId, category, category) as Row[];
  return rows.map((row) => ({
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    category: row.category,
    originalName: row.original_name,
    description: row.description,
    source: row.source,
    documentDate: row.document_date,
    uploadDate: row.upload_date,
  }));
}

export function listCostAssumptions(organizationId: string): CostAssumptionDTO[] {
  const rows = db().prepare(`SELECT * FROM cost_assumptions WHERE organization_id = ? ORDER BY component_type`).all(organizationId) as Row[];
  return rows.map((row) => ({
    id: row.id,
    componentType: row.component_type,
    costBasis: row.cost_basis,
    unit: row.unit,
    lowUnitCost: row.low_unit_cost,
    highUnitCost: row.high_unit_cost,
    region: row.region,
    effectiveDate: row.effective_date,
    source: row.source,
    confidence: row.confidence,
    notes: row.notes,
  }));
}

export function listUsefulLife(organizationId: string): UsefulLifeDTO[] {
  const rows = db().prepare(`SELECT * FROM useful_life_defaults WHERE organization_id = ? ORDER BY group_code`).all(organizationId) as Row[];
  return rows.map((row) => ({ id: row.id, groupCode: row.group_code, lifeLow: row.life_low, lifeHigh: row.life_high, notes: row.notes }));
}

export function listLeads(organizationId: string): LeadDTO[] {
  const rows = db().prepare(`SELECT * FROM leads WHERE organization_id = ? ORDER BY updated_at DESC`).all(organizationId) as Row[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    leadOrganization: row.lead_organization,
    propertyId: row.property_id,
    contact: row.contact,
    source: row.source,
    stage: row.stage,
    estimatedOpportunity: n(row.estimated_opportunity),
    nextAction: row.next_action,
    notes: row.notes,
    updatedAt: row.updated_at,
  }));
}

export function listAudit(organizationId: string, limit = 40): { id: string; entity: string; entityId: string; action: string; timestamp: string; actor: string }[] {
  const rows = db()
    .prepare(
      `SELECT a.id, a.entity, a.entity_id, a.action, a.timestamp, COALESCE(u.name, 'System') AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.organization_id = ? ORDER BY a.timestamp DESC LIMIT ?`,
    )
    .all(organizationId, limit) as Row[];
  return rows.map((row) => ({ id: row.id, entity: row.entity, entityId: row.entity_id, action: row.action, timestamp: row.timestamp, actor: row.actor }));
}

export function listUsers(organizationId: string): { id: string; name: string; email: string; role: Role }[] {
  return db().prepare(`SELECT id, name, email, role FROM users WHERE organization_id = ? ORDER BY name`).all(organizationId) as { id: string; name: string; email: string; role: Role }[];
}

export interface DashboardData {
  propertyCount: number;
  activeAssessments: number;
  reviewAssessments: number;
  completedAssessments: number;
  highRiskProperties: number;
  exposureLow: number;
  exposureHigh: number;
  planningLow: number;
  planningHigh: number;
  highPriorityComponents: { propertyName: string; name: string; priority: string; propertyId: string; assessmentId: string }[];
  soonInterventions: { title: string; year: number; propertyName: string; assessmentId: string }[];
  reserveGaps: { propertyName: string; year: number; assessmentId: string }[];
  overdue: { propertyName: string; assessmentDate: string; assessmentId: string }[];
  activity: { id: string; entity: string; action: string; timestamp: string; actor: string }[];
  properties: { id: string; name: string; municipality: string; canton: string; isDemo: boolean; health: HealthDimension[]; completeness: number }[];
}

export function loadDashboard(organizationId: string): DashboardData {
  const properties = listProperties(organizationId, {});
  const assessments = listAssessments(organizationId);
  const latest = new Map<string, AssessmentMeta>();
  for (const assessment of assessments) {
    const current = latest.get(assessment.propertyId);
    if (!current || assessment.version > current.version) latest.set(assessment.propertyId, assessment);
  }
  const year = zurichYear();
  let highRiskProperties = 0;
  let exposureLow = 0;
  let exposureHigh = 0;
  let planningLow = 0;
  let planningHigh = 0;
  const highPriorityComponents: DashboardData["highPriorityComponents"] = [];
  const soonInterventions: DashboardData["soonInterventions"] = [];
  const reserveGaps: DashboardData["reserveGaps"] = [];
  const overdue: DashboardData["overdue"] = [];
  const propertyCards: DashboardData["properties"] = [];
  for (const property of properties) {
    const assessment = latest.get(property.id);
    if (!assessment) {
      propertyCards.push({ id: property.id, name: property.name, municipality: property.municipality, canton: property.canton, isDemo: property.isDemo, health: [], completeness: 0 });
      continue;
    }
    const bundle = loadBundle(organizationId, assessment.id, "moderate");
    if (!bundle) continue;
    propertyCards.push({
      id: property.id,
      name: property.name,
      municipality: property.municipality,
      canton: property.canton,
      isDemo: property.isDemo,
      health: bundle.health,
      completeness: bundle.completeness.overall,
    });
    let propertyHigh = false;
    for (const component of bundle.components) {
      const priority = calculatePriority(scoreInput(component), assessment.weights, assessment.thresholds);
      const review = requiresPriorityReview(scoreInput(component));
      if (isHighPriorityBand(priority.band) || review) propertyHigh = true;
      if (isHighPriorityBand(priority.band)) {
        highPriorityComponents.push({
          propertyName: property.name,
          name: component.groupName,
          priority: `${priority.score} ${priority.band}`,
          propertyId: property.id,
          assessmentId: assessment.id,
        });
      }
    }
    if (propertyHigh) highRiskProperties += 1;
    const items = scenarioItemsOf(bundle.interventions);
    const totals = scenarioTotals(items, "moderate");
    const planning = applyContingency(totals.low, totals.high, assessment.contingencyPct);
    exposureLow += planning.baseLow;
    exposureHigh += planning.baseHigh;
    planningLow += planning.planningLow;
    planningHigh += planning.planningHigh;
    for (const intervention of bundle.interventions) {
      if (intervention.targetYear != null && intervention.targetYear >= year && intervention.targetYear <= year + 3 && intervention.status !== "Completed" && intervention.status !== "Deferred") {
        soonInterventions.push({ title: intervention.title, year: intervention.targetYear, propertyName: property.name, assessmentId: assessment.id });
      }
    }
    for (const row of bundle.reserveRows) {
      if (row.fundingGap) {
        reserveGaps.push({ propertyName: property.name, year: row.year, assessmentId: assessment.id });
        break;
      }
    }
    const assessmentTime = Date.parse(`${assessment.assessmentDate}T00:00:00Z`);
    if (!Number.isNaN(assessmentTime) && Date.now() - assessmentTime > 365 * 24 * 3600 * 1000) {
      overdue.push({ propertyName: property.name, assessmentDate: assessment.assessmentDate, assessmentId: assessment.id });
    }
  }
  return {
    propertyCount: properties.length,
    activeAssessments: assessments.filter((item) => item.status === "draft" || item.status === "in_review").length,
    reviewAssessments: assessments.filter((item) => item.status === "in_review").length,
    completedAssessments: assessments.filter((item) => item.status === "completed").length,
    highRiskProperties,
    exposureLow,
    exposureHigh,
    planningLow,
    planningHigh,
    highPriorityComponents,
    soonInterventions: soonInterventions.sort((a, b) => a.year - b.year),
    reserveGaps,
    overdue,
    activity: listAudit(organizationId, 8),
    properties: propertyCards,
  };
}

export function makeReportSource(bundle: Bundle, generatedAtIso: string, reportVersion: number): ReportSource {
  const year = zurichYear();
  const items = scenarioItemsOf(bundle.interventions);
  const componentRows = bundle.components.map((component) => {
    const priority = calculatePriority(scoreInput(component), bundle.assessment.weights, bundle.assessment.thresholds);
    const cost = componentCost(component);
    const planning = cost.low != null && cost.high != null ? applyContingency(cost.low, cost.high, bundle.assessment.contingencyPct) : null;
    const linked = bundle.interventions.filter((item) => item.componentId === component.id && item.targetYear != null);
    const window =
      component.installationYear != null && component.usefulLifeLow != null && component.usefulLifeHigh != null
        ? suggestPlanningWindow(component.installationYear, component.usefulLifeLow, component.usefulLifeHigh, year)
        : null;
    const unknown = component.conditionUnknown || component.urgencyUnknown || component.consequenceUnknown || component.escalationUnknown;
    return {
      code: component.groupCode,
      name: component.groupName,
      condition: component.conditionUnknown ? "Unknown" : component.conditionScore == null ? "Not scored" : String(component.conditionScore),
      urgency: component.urgencyUnknown ? "Unknown" : component.urgencyScore == null ? "Not scored" : String(component.urgencyScore),
      risk: component.consequenceUnknown ? "Unknown" : component.consequenceScore == null ? "Not scored" : String(component.consequenceScore),
      priority: priority.score == null ? "Not calculated" : `${priority.score} ${priority.band}`,
      target: linked[0]?.targetYear ? String(linked[0].targetYear) : window ? `Suggestion ${window.windowStart}–${window.windowEnd}` : "Not scheduled",
      finding: component.summary,
      issue: component.mainIssue,
      action: component.recommendedAction,
      baseCost: formatChfRange(cost.low, cost.high),
      planningCost: planning ? formatChfRange(planning.planningLow, planning.planningHigh) : "—",
      confidence: component.confidence,
      unknown,
      priorityReview: requiresPriorityReview(scoreInput(component)),
    };
  });
  const measures = bundle.interventions.map((item) => ({
    title: item.title,
    component: bundle.components.find((component) => component.id === item.componentId)?.groupName ?? "—",
    priority: item.priorityLabel || "—",
    target: item.targetYear ? String(item.targetYear) : "Not set",
    earliest: item.earliestYear ? String(item.earliestYear) : "—",
    latest: item.latestYear ? String(item.latestYear) : "—",
    baseCost: formatChfRange(item.lowCost, item.highCost),
    status: item.status,
    dependencies: item.dependencies,
    why: item.notes,
    scenario: [item.includeLow ? "Low" : null, item.includeModerate ? "Moderate" : null, item.includeHigh ? "High" : null].filter(Boolean).join(", ") || "None",
  }));
  const roadmap = roadmapYears(year).map((yearNumber) => ({
    year: yearNumber,
    lines: bundle.interventions.filter((item) => item.targetYear === yearNumber).map((item) => `${item.title} (${formatChfRange(item.lowCost, item.highCost)})`),
  }));
  const feature = (label: string, value: string) => ({ label, value: value === "yes" ? "Yes" : value === "no" ? "No" : "Unknown" });
  return {
    branding: {
      companyName: bundle.branding.companyName,
      productName: bundle.branding.productName,
      address: bundle.branding.address,
      footer: bundle.branding.footer,
    },
    disclaimer: bundle.settings.disclaimer,
    formulaText: calculatePriority({ condition: 1, urgency: 1, consequence: 1, escalation: 1 }, bundle.assessment.weights, bundle.assessment.thresholds).formula,
    bandLegend: `${bundle.assessment.thresholds.critical}–100 Critical, ${bundle.assessment.thresholds.high}–${bundle.assessment.thresholds.critical - 1} High, ${bundle.assessment.thresholds.medium}–${bundle.assessment.thresholds.high - 1} Medium, ${bundle.assessment.thresholds.low}–${bundle.assessment.thresholds.medium - 1} Low, 0–${bundle.assessment.thresholds.low - 1} Monitor`,
    property: {
      name: bundle.property.name,
      addressLine: `${bundle.property.street}, ${bundle.property.zip} ${bundle.property.municipality}`.trim(),
      municipality: bundle.property.municipality,
      canton: bundle.property.canton,
      country: bundle.property.country,
      yearBuilt: bundle.property.yearBuilt ? String(bundle.property.yearBuilt) : "Unknown",
      yearFirstOccupation: bundle.property.yearFirstOccupation ? String(bundle.property.yearFirstOccupation) : "Unknown",
      buildings: bundle.property.buildings ? String(bundle.property.buildings) : "Unknown",
      units: bundle.property.units ? String(bundle.property.units) : "Unknown",
      owners: bundle.property.owners ? String(bundle.property.owners) : "Unknown",
      floors: bundle.property.floors ? String(bundle.property.floors) : "Unknown",
      features: [
        feature("Basement", bundle.property.basementPresent),
        feature("Underground parking", bundle.property.undergroundParking),
        feature("Outdoor parking", bundle.property.outdoorParking),
        feature("Lift", bundle.property.hasLift),
        feature("Balcony / terrace", bundle.property.balconyTerrace),
        feature("Garden / common outdoor space", bundle.property.garden),
      ],
      isDemo: bundle.property.isDemo,
    },
    assessment: {
      version: bundle.assessment.version,
      date: bundle.assessment.assessmentDate,
      assessorName: bundle.assessment.assessorName,
      status: bundle.assessment.status,
      overallConfidence: bundle.assessment.overallConfidence,
      notes: bundle.assessment.notes,
      contingencyPct: bundle.assessment.contingencyPct,
      reportVersion,
    },
    completeness: bundle.completeness,
    health: bundle.health.map((item) => ({
      label: item.label,
      score: item.score == null ? "Unknown" : String(item.score),
      note: item.note,
    })),
    components: componentRows,
    measures,
    scenarioItems: items,
    roadmap,
    reserve: {
      scenarioLabel: bundle.reserveScenario === "low" ? "Low / minimum intervention" : bundle.reserveScenario === "high" ? "High / comprehensive" : "Moderate / recommended",
      rows: bundle.reserveRows,
      note: "Opening reserve + contributions + other funding − planned expenditure = closing reserve. Annual maintenance is recorded separately and is not part of this formula. Existing financing notes are context only. No financing product is recommended.",
    },
    warnings: bundle.quality.warnings,
    errors: bundle.quality.errors,
    assumptions: [
      ...new Set(bundle.components.map((component) => component.costSourceNote).filter(Boolean)),
      bundle.settings.regulatoryNotes,
    ].filter(Boolean),
    sources: bundle.documents.map((doc) => `${doc.originalName} — ${doc.category}${doc.documentDate ? `, document date ${doc.documentDate}` : ""}`),
    photos: bundle.photos.map((photo) => ({
      id: photo.id,
      caption: photo.caption,
      component: bundle.components.find((component) => component.id === photo.componentId)?.groupName ?? "Property",
    })),
    generatedAtIso,
    profileLines: bundle.profile.map((field) => ({
      label: field.label,
      value: field.status === "na" ? "Not applicable" : field.status === "unknown" || !field.value.trim() ? "Unknown" : field.value,
    })),
  };
}

export function buildBundleReport(bundle: Bundle, reportVersion = 1): ReportModel {
  return buildReportModel(makeReportSource(bundle, nowIso(), reportVersion));
}

export function uploadsRoot(): string {
  return path.join(process.cwd(), "data", "uploads");
}

export function assertInsideUploads(storageReference: string): string {
  const root = path.resolve(uploadsRoot());
  const target = path.resolve(root, storageReference);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("That file path is not allowed.");
  }
  return target;
}

export function getStoredFile(organizationId: string, kind: "documents" | "photos", id: string): { absolutePath: string; filename: string } | null {
  const row = (kind === "documents"
    ? db().prepare(`SELECT storage_reference, filename, original_name AS download_name FROM documents WHERE id = ? AND organization_id = ?`).get(id, organizationId)
    : db().prepare(`SELECT storage_reference, filename, filename AS download_name FROM photos WHERE id = ? AND organization_id = ?`).get(id, organizationId)) as Row | undefined;
  if (!row) return null;
  const absolutePath = assertInsideUploads(row.storage_reference);
  if (!fs.existsSync(absolutePath)) return null;
  return { absolutePath, filename: row.download_name || row.filename };
}

export function saveUploadedFile(input: {
  user: SessionUser;
  propertyId: string;
  category: string;
  originalName: string;
  description: string;
  source: string;
  documentDate: string | null;
  bytes: Buffer;
}): { ok: true; id: string } | { ok: false; error: string } {
  const property = getProperty(input.user.organizationId, input.propertyId);
  if (!property) return { ok: false, error: "That property is not in your organization." };
  if (!DOCUMENT_CATEGORIES.some((category) => category.key === input.category)) {
    return { ok: false, error: "Choose a document category from the list." };
  }
  const ext = path.extname(input.originalName).replace(".", "").toLowerCase();
  if (!["pdf", "jpg", "jpeg", "png", "docx", "xlsx"].includes(ext)) {
    return { ok: false, error: "Only PDF, JPG, JPEG, PNG, DOCX and XLSX files can be uploaded." };
  }
  if (input.bytes.length === 0) return { ok: false, error: "The file is empty." };
  if (input.bytes.length > 20 * 1024 * 1024) return { ok: false, error: "Files must be 20 MB or smaller." };
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const relative = path.join(input.user.organizationId, input.propertyId, filename);
  const absolute = assertInsideUploads(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, input.bytes);
  const uploaded = nowIso();
  db()
    .prepare(
      `INSERT INTO documents (id, organization_id, property_id, category, filename, original_name, description, source, document_date, upload_date, storage_reference, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.user.organizationId, input.propertyId, input.category, filename, path.basename(input.originalName), input.description, input.source, input.documentDate, uploaded, relative, input.user.id, uploaded);
  writeAudit(db(), { organizationId: input.user.organizationId, userId: input.user.id, entity: "document", entityId: id, action: "create", newValue: { name: input.originalName, category: input.category, propertyId: input.propertyId } });
  return { ok: true, id };
}

export function savePhoto(input: {
  user: SessionUser;
  componentId: string;
  caption: string;
  location: string;
  relevance: string;
  photoDate: string | null;
  originalName: string;
  bytes: Buffer;
}): { ok: true } | { ok: false; error: string } {
  const row = db()
    .prepare(
      `SELECT c.id, c.assessment_id, a.property_id, a.organization_id
       FROM assessment_components c JOIN assessments a ON a.id = c.assessment_id
       WHERE c.id = ? AND a.organization_id = ?`,
    )
    .get(input.componentId, input.user.organizationId) as Row | undefined;
  if (!row) return { ok: false, error: "That component is not in your organization." };
  const ext = path.extname(input.originalName).replace(".", "").toLowerCase();
  if (!["jpg", "jpeg", "png"].includes(ext)) return { ok: false, error: "Component photos must be JPG or PNG. The application does not diagnose images." };
  if (input.bytes.length === 0 || input.bytes.length > 20 * 1024 * 1024) return { ok: false, error: "Photo must be between 1 byte and 20 MB." };
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const relative = path.join(input.user.organizationId, row.property_id, filename);
  const absolute = assertInsideUploads(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, input.bytes);
  db()
    .prepare(
      `INSERT INTO photos (id, organization_id, property_id, assessment_id, component_id, filename, caption, location, relevance, photo_date, storage_reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.user.organizationId, row.property_id, row.assessment_id, row.id, filename, input.caption, input.location, input.relevance, input.photoDate, relative, nowIso());
  return { ok: true };
}

export { canEditGlobalAssumptions, CANTONS, CORE_DOCUMENT_CATEGORIES };
