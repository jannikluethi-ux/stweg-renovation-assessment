export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  footer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('project_manager', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  weight_condition REAL NOT NULL,
  weight_urgency REAL NOT NULL,
  weight_consequence REAL NOT NULL,
  weight_escalation REAL NOT NULL,
  band_critical INTEGER NOT NULL,
  band_high INTEGER NOT NULL,
  band_medium INTEGER NOT NULL,
  band_low INTEGER NOT NULL,
  contingency_pct REAL NOT NULL,
  disclaimer TEXT NOT NULL,
  regulatory_notes TEXT NOT NULL DEFAULT '',
  condition_labels_json TEXT NOT NULL,
  urgency_labels_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  street TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  municipality TEXT NOT NULL DEFAULT '',
  canton TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'Switzerland',
  year_built INTEGER,
  year_first_occupation INTEGER,
  buildings INTEGER,
  units INTEGER,
  owners INTEGER,
  floors INTEGER,
  basement_present TEXT NOT NULL DEFAULT 'unknown',
  underground_parking TEXT NOT NULL DEFAULT 'unknown',
  outdoor_parking TEXT NOT NULL DEFAULT 'unknown',
  has_lift TEXT NOT NULL DEFAULT 'unknown',
  balcony_terrace TEXT NOT NULL DEFAULT 'unknown',
  garden TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active',
  is_demo INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS building_profiles (
  property_id TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  structural_system TEXT NOT NULL DEFAULT '',
  structural_system_status TEXT NOT NULL DEFAULT 'unknown',
  roof_type TEXT NOT NULL DEFAULT '',
  roof_type_status TEXT NOT NULL DEFAULT 'unknown',
  facade_type TEXT NOT NULL DEFAULT '',
  facade_type_status TEXT NOT NULL DEFAULT 'unknown',
  insulation TEXT NOT NULL DEFAULT '',
  insulation_status TEXT NOT NULL DEFAULT 'unknown',
  window_type TEXT NOT NULL DEFAULT '',
  window_type_status TEXT NOT NULL DEFAULT 'unknown',
  window_replacement_year INTEGER,
  window_replacement_year_status TEXT NOT NULL DEFAULT 'unknown',
  balcony_construction TEXT NOT NULL DEFAULT '',
  balcony_construction_status TEXT NOT NULL DEFAULT 'unknown',
  basement_construction TEXT NOT NULL DEFAULT '',
  basement_construction_status TEXT NOT NULL DEFAULT 'unknown',
  heating_type TEXT NOT NULL DEFAULT '',
  heating_type_status TEXT NOT NULL DEFAULT 'unknown',
  heating_installation_year INTEGER,
  heating_installation_year_status TEXT NOT NULL DEFAULT 'unknown',
  heating_distribution TEXT NOT NULL DEFAULT '',
  heating_distribution_status TEXT NOT NULL DEFAULT 'unknown',
  hot_water_system TEXT NOT NULL DEFAULT '',
  hot_water_system_status TEXT NOT NULL DEFAULT 'unknown',
  hot_water_installation_year INTEGER,
  hot_water_installation_year_status TEXT NOT NULL DEFAULT 'unknown',
  ventilation TEXT NOT NULL DEFAULT '',
  ventilation_status TEXT NOT NULL DEFAULT 'unknown',
  cooling TEXT NOT NULL DEFAULT '',
  cooling_status TEXT NOT NULL DEFAULT 'unknown',
  electrical_system TEXT NOT NULL DEFAULT '',
  electrical_system_status TEXT NOT NULL DEFAULT 'unknown',
  solar_pv TEXT NOT NULL DEFAULT '',
  solar_pv_status TEXT NOT NULL DEFAULT 'unknown',
  ev_charging TEXT NOT NULL DEFAULT '',
  ev_charging_status TEXT NOT NULL DEFAULT 'unknown',
  plumbing TEXT NOT NULL DEFAULT '',
  plumbing_status TEXT NOT NULL DEFAULT 'unknown',
  drainage TEXT NOT NULL DEFAULT '',
  drainage_status TEXT NOT NULL DEFAULT 'unknown',
  lift_info TEXT NOT NULL DEFAULT '',
  lift_info_status TEXT NOT NULL DEFAULT 'unknown',
  entrance TEXT NOT NULL DEFAULT '',
  entrance_status TEXT NOT NULL DEFAULT 'unknown',
  staircase TEXT NOT NULL DEFAULT '',
  staircase_status TEXT NOT NULL DEFAULT 'unknown',
  corridor TEXT NOT NULL DEFAULT '',
  corridor_status TEXT NOT NULL DEFAULT 'unknown',
  basement_area TEXT NOT NULL DEFAULT '',
  basement_area_status TEXT NOT NULL DEFAULT 'unknown',
  laundry TEXT NOT NULL DEFAULT '',
  laundry_status TEXT NOT NULL DEFAULT 'unknown',
  garage_area TEXT NOT NULL DEFAULT '',
  garage_area_status TEXT NOT NULL DEFAULT 'unknown',
  technical_rooms TEXT NOT NULL DEFAULT '',
  technical_rooms_status TEXT NOT NULL DEFAULT 'unknown',
  outdoor_areas TEXT NOT NULL DEFAULT '',
  outdoor_areas_status TEXT NOT NULL DEFAULT 'unknown',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assessor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assessment_date TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_assessment_id TEXT,
  overall_confidence TEXT NOT NULL DEFAULT 'medium',
  notes TEXT NOT NULL DEFAULT '',
  contingency_pct REAL NOT NULL,
  weight_condition REAL NOT NULL,
  weight_urgency REAL NOT NULL,
  weight_consequence REAL NOT NULL,
  weight_escalation REAL NOT NULL,
  band_critical INTEGER NOT NULL,
  band_high INTEGER NOT NULL,
  band_medium INTEGER NOT NULL,
  band_low INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (property_id, version)
);

CREATE TABLE IF NOT EXISTS assessment_components (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  group_code TEXT NOT NULL,
  group_name TEXT NOT NULL,
  category TEXT NOT NULL,
  condition_score INTEGER,
  condition_unknown INTEGER NOT NULL DEFAULT 0,
  urgency_score INTEGER,
  urgency_unknown INTEGER NOT NULL DEFAULT 0,
  consequence_score INTEGER,
  consequence_unknown INTEGER NOT NULL DEFAULT 0,
  escalation_score INTEGER,
  escalation_unknown INTEGER NOT NULL DEFAULT 0,
  installation_year INTEGER,
  last_renovation_year INTEGER,
  useful_life_low INTEGER,
  useful_life_high INTEGER,
  confidence TEXT NOT NULL DEFAULT 'unknown',
  current_condition_summary TEXT NOT NULL DEFAULT '',
  main_issue TEXT NOT NULL DEFAULT '',
  recommended_action TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  quantity REAL,
  quantity_unit TEXT NOT NULL DEFAULT '',
  cost_origin TEXT NOT NULL DEFAULT 'assumption',
  unit_low INTEGER,
  unit_high INTEGER,
  cost_source_note TEXT NOT NULL DEFAULT '',
  manual_low INTEGER,
  manual_high INTEGER,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (assessment_id, group_code)
);

CREATE TABLE IF NOT EXISTS component_items (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES assessment_components(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  observation TEXT NOT NULL DEFAULT '',
  condition_score INTEGER,
  condition_unknown INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, item_key)
);

CREATE TABLE IF NOT EXISTS cost_assumptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  unit TEXT NOT NULL,
  low_unit_cost INTEGER NOT NULL,
  high_unit_cost INTEGER NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  effective_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'low',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, component_type)
);

CREATE TABLE IF NOT EXISTS useful_life_defaults (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_code TEXT NOT NULL,
  life_low INTEGER NOT NULL,
  life_high INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (organization_id, group_code)
);

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  component_id TEXT REFERENCES assessment_components(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  target_year INTEGER,
  earliest_year INTEGER,
  latest_year INTEGER,
  low_cost INTEGER,
  high_cost INTEGER,
  use_component_cost INTEGER NOT NULL DEFAULT 0,
  priority_label TEXT NOT NULL DEFAULT '',
  include_low INTEGER NOT NULL DEFAULT 0,
  include_moderate INTEGER NOT NULL DEFAULT 0,
  include_high INTEGER NOT NULL DEFAULT 0,
  dependencies TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  historical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_profiles (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id) ON DELETE CASCADE,
  reserve_balance INTEGER,
  annual_contribution INTEGER,
  annual_maintenance INTEGER,
  special_contributions INTEGER,
  other_funding_annual INTEGER,
  existing_financing_note TEXT NOT NULL DEFAULT '',
  other_obligations INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  document_date TEXT,
  upload_date TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  assessment_id TEXT REFERENCES assessments(id) ON DELETE CASCADE,
  component_id TEXT REFERENCES assessment_components(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  relevance TEXT NOT NULL DEFAULT '',
  photo_date TEXT,
  storage_reference TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT,
  status TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (assessment_id, version)
);

CREATE TABLE IF NOT EXISTS energy_measures (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  investment_low INTEGER,
  investment_high INTEGER,
  qualitative_benefit TEXT NOT NULL DEFAULT '',
  dependency_note TEXT NOT NULL DEFAULT '',
  verification_required INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (assessment_id, topic_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lead_organization TEXT NOT NULL DEFAULT '',
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  contact TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  estimated_opportunity INTEGER,
  next_action TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_properties_org ON properties(organization_id);
CREATE INDEX IF NOT EXISTS idx_assessments_org ON assessments(organization_id);
CREATE INDEX IF NOT EXISTS idx_assessments_property ON assessments(property_id);
CREATE INDEX IF NOT EXISTS idx_components_assessment ON assessment_components(assessment_id);
CREATE INDEX IF NOT EXISTS idx_interventions_assessment ON interventions(assessment_id);
CREATE INDEX IF NOT EXISTS idx_documents_property ON documents(property_id);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, timestamp);
`;
