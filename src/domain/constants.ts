export const PRODUCT_FALLBACK_NAME = "STWEG Renovation Assessment";
export const FAMILY_FALLBACK_NAME = "STWEG & Property Project Office";

export const CANTONS: { code: string; name: string }[] = [
  { code: "AG", name: "Aargau" },
  { code: "AI", name: "Appenzell Innerrhoden" },
  { code: "AR", name: "Appenzell Ausserrhoden" },
  { code: "BE", name: "Bern" },
  { code: "BL", name: "Basel-Landschaft" },
  { code: "BS", name: "Basel-Stadt" },
  { code: "FR", name: "Fribourg" },
  { code: "GE", name: "Genève" },
  { code: "GL", name: "Glarus" },
  { code: "GR", name: "Graubünden" },
  { code: "JU", name: "Jura" },
  { code: "LU", name: "Luzern" },
  { code: "NE", name: "Neuchâtel" },
  { code: "NW", name: "Nidwalden" },
  { code: "OW", name: "Obwalden" },
  { code: "SG", name: "St. Gallen" },
  { code: "SH", name: "Schaffhausen" },
  { code: "SO", name: "Solothurn" },
  { code: "SZ", name: "Schwyz" },
  { code: "TG", name: "Thurgau" },
  { code: "TI", name: "Ticino" },
  { code: "UR", name: "Uri" },
  { code: "VD", name: "Vaud" },
  { code: "VS", name: "Valais" },
  { code: "ZG", name: "Zug" },
  { code: "ZH", name: "Zürich" },
];

export const DOCUMENT_CATEGORIES: { key: string; label: string }[] = [
  { key: "property_plans", label: "Property plans" },
  { key: "building_descriptions", label: "Building descriptions" },
  { key: "previous_renovation_records", label: "Previous renovation records" },
  { key: "previous_inspection_reports", label: "Previous inspection reports" },
  { key: "energy_certificates", label: "Energy certificates" },
  { key: "heating_service_records", label: "Heating service records" },
  { key: "maintenance_contracts", label: "Maintenance contracts" },
  { key: "owners_meeting_minutes", label: "Owners' meeting minutes" },
  { key: "reserve_fund_information", label: "Reserve-fund information" },
  { key: "contractor_offers", label: "Contractor offers" },
  { key: "invoices", label: "Invoices" },
  { key: "photos", label: "Photos" },
];

export const CORE_DOCUMENT_CATEGORIES = [
  "property_plans",
  "previous_inspection_reports",
  "energy_certificates",
  "heating_service_records",
  "reserve_fund_information",
  "owners_meeting_minutes",
  "photos",
  "maintenance_contracts",
] as const;

export const LEAD_STAGES = [
  "Lead",
  "Contacted",
  "Assessment Proposed",
  "Assessment Won",
  "Assessment Completed",
  "Renovation Opportunity",
  "Project Won",
  "Lost",
] as const;

export const INTERVENTION_STATUSES = [
  "Not assessed",
  "Recommended",
  "Planned",
  "Approved",
  "Tendering",
  "Contracted",
  "Completed",
  "Deferred",
] as const;

export const RECOMMENDED_ACTIONS = [
  "inspect",
  "maintain",
  "repair",
  "refurbish",
  "replace",
  "monitor",
  "investigate",
] as const;

export const ASSESSMENT_STATUSES = ["draft", "in_review", "completed"] as const;

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "unknown"] as const;

export const ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "docx", "xlsx"] as const;

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const DEFAULT_DISCLAIMER =
  "This assessment is a planning and decision-support document based on the information available at the time of assessment. Cost figures are indicative planning estimates and are not contractor quotations. Remaining useful-life estimates are indicative and should not be interpreted as guaranteed service-life or failure predictions. Technical, structural, legal, energy and regulatory matters requiring specialist assessment must be verified by appropriately qualified professionals before implementation.";

export const DEFAULT_CONDITION_LABELS: Record<string, string> = {
  "1": "Very good — Recently renewed / no meaningful intervention expected.",
  "2": "Good — Normal wear; maintenance only.",
  "3": "Fair — Aging component; intervention should be planned.",
  "4": "Poor — Significant deterioration; renovation should be scheduled.",
  "5": "Critical — Urgent intervention / investigation required.",
  unknown: "Unknown — not treated as good. Further technical verification recommended.",
};

export const DEFAULT_URGENCY_LABELS: Record<string, string> = {
  "1": "Long term — likely more than 10 years.",
  "2": "Medium term — approximately 7–10 years.",
  "3": "Planned — approximately 4–7 years.",
  "4": "Near term — approximately 1–3 years.",
  "5": "Immediate — 0–12 months / urgent investigation.",
  unknown: "Unknown — not treated as long-term. Further technical verification recommended.",
};

export const VERIFICATION_TEXT = "Further technical verification recommended.";

export const ROADMAP_YEAR_SPAN = 15;

export interface CatalogItem {
  key: string;
  label: string;
}

export interface CatalogGroup {
  code: string;
  name: string;
  category: "envelope" | "technical" | "common";
  items: CatalogItem[];
}

export const COMPONENT_GROUPS: CatalogGroup[] = [
  {
    code: "A",
    name: "Roof",
    category: "envelope",
    items: [
      { key: "covering", label: "Roof covering" },
      { key: "waterproofing", label: "Waterproofing" },
      { key: "insulation", label: "Insulation" },
      { key: "drainage", label: "Drainage" },
      { key: "roof_windows", label: "Roof windows" },
      { key: "flashings", label: "Flashings" },
      { key: "penetrations", label: "Penetrations" },
      { key: "visible_defects", label: "Visible defects" },
      { key: "previous_renovation", label: "Previous renovation" },
      { key: "remaining_life", label: "Estimated remaining useful life" },
    ],
  },
  {
    code: "B",
    name: "Façade",
    category: "envelope",
    items: [
      { key: "render", label: "Render / cladding" },
      { key: "insulation", label: "Insulation" },
      { key: "cracks", label: "Cracks" },
      { key: "moisture", label: "Moisture" },
      { key: "thermal", label: "Thermal performance" },
      { key: "coating", label: "Paint / coating" },
      { key: "joints", label: "Joints" },
      { key: "balconies", label: "Balconies attached to façade" },
      { key: "previous_renovation", label: "Previous renovation" },
    ],
  },
  {
    code: "C",
    name: "Windows / external doors",
    category: "envelope",
    items: [
      { key: "frame", label: "Frame condition" },
      { key: "glazing", label: "Glazing" },
      { key: "seals", label: "Seals" },
      { key: "thermal", label: "Thermal performance" },
      { key: "condensation", label: "Condensation" },
      { key: "mechanisms", label: "Opening mechanisms" },
      { key: "age", label: "Age" },
      { key: "replacement_history", label: "Replacement history" },
    ],
  },
  {
    code: "D",
    name: "Balconies / terraces",
    category: "envelope",
    items: [
      { key: "waterproofing", label: "Waterproofing" },
      { key: "surface", label: "Surface" },
      { key: "drainage", label: "Drainage" },
      { key: "railings", label: "Railings" },
      { key: "concrete", label: "Concrete" },
      { key: "cracks", label: "Cracks" },
      { key: "corrosion", label: "Corrosion" },
      { key: "edge", label: "Edge details" },
    ],
  },
  {
    code: "E",
    name: "Heating",
    category: "technical",
    items: [
      { key: "system_type", label: "System type" },
      { key: "energy_source", label: "Energy source" },
      { key: "age", label: "Age" },
      { key: "efficiency", label: "Efficiency" },
      { key: "maintenance", label: "Maintenance history" },
      { key: "replacement_availability", label: "Replacement availability" },
      { key: "regulatory", label: "Regulatory / energy considerations" },
      { key: "distribution", label: "Distribution system" },
      { key: "controls", label: "Controls" },
    ],
  },
  {
    code: "F",
    name: "Hot water",
    category: "technical",
    items: [
      { key: "system_type", label: "System type" },
      { key: "age", label: "Age" },
      { key: "storage", label: "Storage" },
      { key: "efficiency", label: "Efficiency" },
      { key: "condition", label: "Condition" },
      { key: "horizon", label: "Replacement horizon" },
    ],
  },
  {
    code: "G",
    name: "Ventilation",
    category: "technical",
    items: [
      { key: "system", label: "System" },
      { key: "age", label: "Age" },
      { key: "operation", label: "Operation" },
      { key: "maintenance", label: "Maintenance" },
      { key: "indoor_air", label: "Indoor-air considerations" },
      { key: "horizon", label: "Replacement horizon" },
    ],
  },
  {
    code: "H",
    name: "Electrical",
    category: "technical",
    items: [
      { key: "age", label: "Age" },
      { key: "main_distribution", label: "Main distribution" },
      { key: "common", label: "Common-area electrical system" },
      { key: "capacity", label: "Capacity" },
      { key: "safety", label: "Safety concerns" },
      { key: "ev", label: "EV charging readiness" },
      { key: "pv", label: "PV readiness" },
    ],
  },
  {
    code: "I",
    name: "Plumbing",
    category: "technical",
    items: [
      { key: "supply", label: "Supply pipes" },
      { key: "drainage", label: "Drainage" },
      { key: "common", label: "Common pipes" },
      { key: "age", label: "Age" },
      { key: "material", label: "Material" },
      { key: "corrosion", label: "Visible corrosion" },
      { key: "leakage", label: "Leakage history" },
    ],
  },
  {
    code: "J",
    name: "Lift",
    category: "technical",
    items: [
      { key: "age", label: "Age" },
      { key: "maintenance", label: "Maintenance" },
      { key: "modernization", label: "Modernization history" },
      { key: "accessibility", label: "Accessibility" },
      { key: "horizon", label: "Replacement horizon" },
    ],
  },
  {
    code: "K",
    name: "Underground parking / garage",
    category: "common",
    items: [
      { key: "concrete", label: "Concrete" },
      { key: "waterproofing", label: "Waterproofing" },
      { key: "drainage", label: "Drainage" },
      { key: "ventilation", label: "Ventilation" },
      { key: "lighting", label: "Lighting" },
      { key: "ev", label: "EV readiness" },
      { key: "structure", label: "Structural observations" },
    ],
  },
  {
    code: "L",
    name: "Common areas",
    category: "common",
    items: [
      { key: "flooring", label: "Flooring" },
      { key: "walls", label: "Walls" },
      { key: "ceilings", label: "Ceilings" },
      { key: "lighting", label: "Lighting" },
      { key: "entrance", label: "Entrance" },
      { key: "staircases", label: "Staircases" },
      { key: "doors", label: "Doors" },
      { key: "accessibility", label: "Accessibility" },
      { key: "general", label: "General condition" },
    ],
  },
  {
    code: "M",
    name: "Outdoor areas",
    category: "common",
    items: [
      { key: "paving", label: "Paving" },
      { key: "drainage", label: "Drainage" },
      { key: "retaining", label: "Retaining structures" },
      { key: "landscaping", label: "Landscaping" },
      { key: "fences", label: "Fences" },
      { key: "lighting", label: "Lighting" },
      { key: "play", label: "Play areas if applicable" },
    ],
  },
];

export const ENERGY_TOPICS: { key: string; label: string }[] = [
  { key: "heating_replacement", label: "Heating replacement" },
  { key: "insulation", label: "Insulation" },
  { key: "windows", label: "Windows" },
  { key: "pv", label: "Photovoltaic (PV)" },
  { key: "ev_charging", label: "EV charging" },
  { key: "lighting", label: "Lighting" },
  { key: "energy_monitoring", label: "Energy monitoring" },
];

export interface ProfileFieldDef {
  key: string;
  label: string;
  section: "Construction" | "Technical systems" | "Common areas";
  kind: "text" | "year";
  dimension: "envelope" | "technical" | "common";
}

export const PROFILE_FIELDS: ProfileFieldDef[] = [
  { key: "structural_system", label: "Structural system", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "roof_type", label: "Roof type", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "facade_type", label: "Façade type", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "insulation", label: "Insulation information", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "window_type", label: "Window type", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "window_replacement_year", label: "Window replacement year", section: "Construction", kind: "year", dimension: "envelope" },
  { key: "balcony_construction", label: "Balcony construction", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "basement_construction", label: "Basement construction", section: "Construction", kind: "text", dimension: "envelope" },
  { key: "heating_type", label: "Heating type", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "heating_installation_year", label: "Heating installation year", section: "Technical systems", kind: "year", dimension: "technical" },
  { key: "heating_distribution", label: "Heating distribution", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "hot_water_system", label: "Hot water system", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "hot_water_installation_year", label: "Hot water installation year", section: "Technical systems", kind: "year", dimension: "technical" },
  { key: "ventilation", label: "Ventilation", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "cooling", label: "Cooling", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "electrical_system", label: "Electrical system", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "solar_pv", label: "Solar / PV", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "ev_charging", label: "EV charging", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "plumbing", label: "Plumbing", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "drainage", label: "Drainage", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "lift_info", label: "Lift", section: "Technical systems", kind: "text", dimension: "technical" },
  { key: "entrance", label: "Entrance", section: "Common areas", kind: "text", dimension: "common" },
  { key: "staircase", label: "Staircase", section: "Common areas", kind: "text", dimension: "common" },
  { key: "corridor", label: "Corridor", section: "Common areas", kind: "text", dimension: "common" },
  { key: "basement_area", label: "Basement", section: "Common areas", kind: "text", dimension: "common" },
  { key: "laundry", label: "Laundry", section: "Common areas", kind: "text", dimension: "common" },
  { key: "garage_area", label: "Garage", section: "Common areas", kind: "text", dimension: "common" },
  { key: "technical_rooms", label: "Technical rooms", section: "Common areas", kind: "text", dimension: "common" },
  { key: "outdoor_areas", label: "Outdoor areas", section: "Common areas", kind: "text", dimension: "common" },
];

export const DEPENDENCY_RULES: { left: string; right: string; message: string }[] = [
  {
    left: "B",
    right: "C",
    message:
      "Façade insulation should be coordinated with window replacement. Consider coordinating these measures to avoid duplicate mobilization/scaffolding costs. This is a recommendation, not an automatic cost saving.",
  },
  {
    left: "E",
    right: "pv",
    message:
      "Heating replacement may influence PV planning. Consider coordinating these measures. This is not an automatic cost saving.",
  },
  {
    left: "E",
    right: "insulation",
    message:
      "Heating replacement may interact with insulation works. Consider coordinating these measures. This is not an automatic cost saving.",
  },
  {
    left: "D",
    right: "B",
    message:
      "Balcony waterproofing may share scaffolding with façade works. Consider coordinating these measures to avoid duplicate mobilization/scaffolding costs. This is not an automatic cost saving.",
  },
  {
    left: "K",
    right: "I",
    message:
      "Garage waterproofing should be considered together with drainage. This is a coordination recommendation, not an automatic cost saving.",
  },
  {
    left: "H",
    right: "ev_charging",
    message:
      "EV charging should be considered together with electrical capacity. This is not an automatic cost saving.",
  },
];

export function categoryLabel(key: string): string {
  return DOCUMENT_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export function cantonName(code: string): string {
  return CANTONS.find((c) => c.code === code)?.name ?? code;
}
