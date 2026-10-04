export interface BrandingDTO {
  organizationName: string;
  companyName: string;
  productName: string;
  address: string;
  footer: string;
}

export interface SettingsDTO {
  weights: { condition: number; urgency: number; consequence: number; escalation: number };
  thresholds: { critical: number; high: number; medium: number; low: number };
  contingencyPct: number;
  disclaimer: string;
  regulatoryNotes: string;
  conditionLabels: Record<string, string>;
  urgencyLabels: Record<string, string>;
}

export interface PropertyDTO {
  id: string;
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
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileFieldDTO {
  key: string;
  label: string;
  section: string;
  kind: "text" | "year";
  dimension: string;
  status: "known" | "unknown" | "na";
  value: string;
}

export interface ComponentItemDTO {
  id: string;
  itemKey: string;
  label: string;
  status: "known" | "unknown" | "na";
  observation: string;
  conditionScore: number | null;
  conditionUnknown: boolean;
}

export interface ComponentDTO {
  id: string;
  groupCode: string;
  groupName: string;
  category: string;
  conditionScore: number | null;
  conditionUnknown: boolean;
  urgencyScore: number | null;
  urgencyUnknown: boolean;
  consequenceScore: number | null;
  consequenceUnknown: boolean;
  escalationScore: number | null;
  escalationUnknown: boolean;
  installationYear: number | null;
  lastRenovationYear: number | null;
  usefulLifeLow: number | null;
  usefulLifeHigh: number | null;
  confidence: string;
  summary: string;
  mainIssue: string;
  recommendedAction: string;
  notes: string;
  quantity: number | null;
  quantityUnit: string;
  costOrigin: "assumption" | "manual" | "quoted";
  unitLow: number | null;
  unitHigh: number | null;
  costSourceNote: string;
  manualLow: number | null;
  manualHigh: number | null;
  reviewed: boolean;
  items: ComponentItemDTO[];
  updatedAt: string;
}

export interface InterventionDTO {
  id: string;
  componentId: string | null;
  groupCode: string | null;
  title: string;
  targetYear: number | null;
  earliestYear: number | null;
  latestYear: number | null;
  lowCost: number | null;
  highCost: number | null;
  useComponentCost: boolean;
  priorityLabel: string;
  includeLow: boolean;
  includeModerate: boolean;
  includeHigh: boolean;
  dependencies: string;
  status: string;
  notes: string;
  historical: boolean;
  updatedAt: string;
}

export interface FinancialDTO {
  id: string;
  reserveBalance: number | null;
  annualContribution: number | null;
  annualMaintenance: number | null;
  specialContributions: number | null;
  otherFundingAnnual: number | null;
  existingFinancingNote: string;
  otherObligations: number | null;
  notes: string;
}

export interface DocumentDTO {
  id: string;
  propertyId: string;
  propertyName: string;
  category: string;
  originalName: string;
  description: string;
  source: string;
  documentDate: string | null;
  uploadDate: string;
}

export interface PhotoDTO {
  id: string;
  componentId: string | null;
  caption: string;
  location: string;
  relevance: string;
  photoDate: string | null;
  createdAt: string;
}

export interface EnergyDTO {
  topicKey: string;
  investmentLow: number | null;
  investmentHigh: number | null;
  qualitativeBenefit: string;
  dependencyNote: string;
  verificationRequired: boolean;
  notes: string;
}

export interface LeadDTO {
  id: string;
  name: string;
  leadOrganization: string;
  propertyId: string | null;
  contact: string;
  source: string;
  stage: string;
  estimatedOpportunity: number | null;
  nextAction: string;
  notes: string;
  updatedAt: string;
}

export interface CostAssumptionDTO {
  id: string;
  componentType: string;
  costBasis: string;
  unit: string;
  lowUnitCost: number;
  highUnitCost: number;
  region: string;
  effectiveDate: string;
  source: string;
  confidence: string;
  notes: string;
}

export interface UsefulLifeDTO {
  id: string;
  groupCode: string;
  lifeLow: number;
  lifeHigh: number;
  notes: string;
}
