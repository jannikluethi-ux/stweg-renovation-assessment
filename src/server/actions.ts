"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession, getCurrentUser } from "@/lib/auth";
import type { ComponentDTO, EnergyDTO } from "@/domain/dto";
import {
  applyOrganizationScoring,
  createAssessmentVersion,
  createProperty,
  deleteIntervention,
  generateReport,
  refreshComponentAssumption,
  saveAssessmentMeta,
  saveComponent,
  saveEnergy,
  saveFinancial,
  saveIntervention,
  saveLead,
  saveRoadmap,
  startAssessment,
  updateBranding,
  updateCostAssumption,
  updateProfile,
  updateProperty,
  updateSettings,
  updateUsefulLife,
  type FinancialWrite,
  type InterventionWrite,
  type LeadWrite,
  type PropertyWrite,
} from "@/lib/mutations";
import type { PriorityThresholds, PriorityWeights } from "@/domain/calculations";

type Row = Record<string, any>;

function refresh() {
  revalidatePath("/", "layout");
}

async function actor() {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: "Your session has ended. Sign in again. What you typed is still on this page." };
  return { user, error: null };
}

export async function loginAction(email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = getDb().prepare(`SELECT id, password_hash FROM users WHERE email = ?`).get(email.trim().toLowerCase()) as Row | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    return { ok: false, error: "Email or password is not recognised." };
  }
  const session = createSession(row.id);
  const jar = await cookies();
  jar.set("stweg_session", session.token, { httpOnly: true, sameSite: "lax", path: "/", expires: session.expires });
  return { ok: true };
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  destroySession(jar.get("stweg_session")?.value);
  jar.delete("stweg_session");
  refresh();
}

export async function createPropertyAction(input: PropertyWrite) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = createProperty(user, input);
  if (result.ok) refresh();
  return result;
}

export async function updatePropertyAction(propertyId: string, input: PropertyWrite) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateProperty(user, propertyId, input);
  if (result.ok) refresh();
  return result;
}

export async function updateProfileAction(propertyId: string, fields: { key: string; status: string; value: string }[]) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateProfile(user, propertyId, fields);
  if (result.ok) refresh();
  return result;
}

export async function startAssessmentAction(propertyId: string) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = startAssessment(user, propertyId);
  if (result.ok) refresh();
  return result;
}

export async function newVersionAction(assessmentId: string) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = createAssessmentVersion(user, assessmentId);
  if (result.ok) refresh();
  return result;
}

export async function saveComponentAction(assessmentId: string, input: ComponentDTO) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveComponent(user, assessmentId, input);
  if (result.ok) refresh();
  return result;
}

export async function refreshCostAction(componentId: string) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = refreshComponentAssumption(user, componentId);
  if (result.ok) refresh();
  return result;
}

export async function saveInterventionAction(assessmentId: string, input: InterventionWrite) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveIntervention(user, assessmentId, input);
  if (result.ok) refresh();
  return result;
}

export async function deleteInterventionAction(interventionId: string) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = deleteIntervention(user, interventionId);
  if (result.ok) refresh();
  return result;
}

export async function saveRoadmapAction(assessmentId: string, rows: { id: string; targetYear: number | null; earliestYear: number | null; latestYear: number | null; historical: boolean }[]) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveRoadmap(user, assessmentId, rows);
  if (result.ok) refresh();
  return result;
}

export async function saveFinancialAction(assessmentId: string, input: FinancialWrite) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveFinancial(user, assessmentId, input);
  if (result.ok) refresh();
  return result;
}

export async function saveAssessmentMetaAction(assessmentId: string, input: { assessmentDate: string; status: string; overallConfidence: string; notes: string; contingencyPct: number }) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveAssessmentMeta(user, assessmentId, input);
  if (result.ok) refresh();
  return result;
}

export async function applyScoringAction(assessmentId: string) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = applyOrganizationScoring(user, assessmentId);
  if (result.ok) refresh();
  return result;
}

export async function saveEnergyAction(assessmentId: string, rows: EnergyDTO[]) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveEnergy(user, assessmentId, rows);
  if (result.ok) refresh();
  return result;
}

export async function updateBrandingAction(input: { companyName: string; productName: string; address: string; footer: string }) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateBranding(user, input);
  if (result.ok) refresh();
  return result;
}

export async function updateSettingsAction(input: { weights: PriorityWeights; thresholds: PriorityThresholds; contingencyPct: number; disclaimer: string; regulatoryNotes: string }) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateSettings(user, input);
  if (result.ok) refresh();
  return result;
}

export async function updateCostAssumptionAction(input: { id: string; costBasis: string; unit: string; lowUnitCost: number; highUnitCost: number; region: string; effectiveDate: string; source: string; confidence: string; notes: string }) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateCostAssumption(user, input);
  if (result.ok) refresh();
  return result;
}

export async function updateUsefulLifeAction(input: { id: string; lifeLow: number; lifeHigh: number; notes: string }) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = updateUsefulLife(user, input);
  if (result.ok) refresh();
  return result;
}

export async function saveLeadAction(input: LeadWrite) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = saveLead(user, input);
  if (result.ok) refresh();
  return result;
}

export async function generateReportAction(assessmentId: string, acknowledgeWarnings: boolean) {
  const { user, error } = await actor();
  if (!user) return { ok: false as const, error: error! };
  const result = generateReport(user, assessmentId, acknowledgeWarnings);
  if (result.ok) refresh();
  return result;
}
