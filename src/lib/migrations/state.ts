import type Database from "better-sqlite3";
import {
  HISTORY_TABLE,
  type SchemaRow,
  type StructuralTable,
  fingerprintFromRows,
  objectDiff,
  readSchemaRows,
  structuralDiff,
  structuralV1,
} from "./fingerprint";
import { EXIT, type ReadRefusalCode, type SidecarRecord, type SnapshotOutcome, guardedSnapshotRead, openSnapshot } from "./snapshot-read";

/**
 * Schema state detection (Workshop 5B §C, §E.4, §F). Works on any connection;
 * `status` uses the in-memory snapshot connection, the runner re-detects on its
 * read-write connection inside BEGIN IMMEDIATE. Reads schema metadata, the
 * history table and pragmas only; never row data of application tables.
 */

export type SchemaState =
  | "EMPTY"
  | "LEGACY_BASELINE"
  | "LEGACY_UNKNOWN"
  | "MANAGED_CURRENT"
  | "MANAGED_PENDING"
  | "NEWER"
  | "INCONSISTENT";

/**
 * Pinned history-table DDL (5A §B.2, carried into 5B), exactly as the runner creates it and as
 * SQLite stores it in sqlite_schema. Any other definition is INCONSISTENT (X1 is checked separately).
 */
export const HISTORY_TABLE_SQL = `CREATE TABLE ${HISTORY_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  checksum_alg TEXT NOT NULL DEFAULT 'stweg-mig-sha256-v1',
  kind TEXT NOT NULL CHECK (kind IN ('applied', 'baselined')),
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  git_commit TEXT,
  runner_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  fingerprint_after TEXT NOT NULL
)`;
export const CHECKSUM_ALG_V1 = "stweg-mig-sha256-v1";
export const HISTORY_AUTOINDEX = `sqlite_autoindex_${HISTORY_TABLE}_1`;

export interface ExpectedSchema {
  fingerprint: string;
  structural: string;
  /** reference rows/structure for a names-only diff on mismatch (optional) */
  rows?: SchemaRow[];
  tables?: StructuralTable[];
}

/** What state detection needs to know about the code's migrations (the registry provides it from A2-2). */
export interface RegistryView {
  entries: ReadonlyArray<{ id: number; name: string; checksum: string }>;
  /** expected fingerprint/structure after migration k is applied (k >= 1) */
  expectedAfter(k: number): ExpectedSchema;
  /** the legacy (pre-history) schema that 0001_baseline adopts */
  legacyBaseline: ExpectedSchema;
}

export interface HistoryRow {
  id: number;
  name: string;
  checksum: string;
  checksum_alg: string;
  kind: string;
  applied_at: string;
  app_version: string;
  git_commit: string | null;
  runner_version: string;
  sqlite_version: string;
  duration_ms: number;
  fingerprint_after: string;
}

export interface StateReport {
  state: SchemaState;
  reasons: string[];
  userVersion: number;
  applicationId: number;
  encoding: string;
  pageSize: number;
  fingerprint: string;
  structural: string;
  fingerprintRows: number;
  history: Array<Pick<HistoryRow, "id" | "name" | "checksum" | "kind">>;
  registryHead: number;
  foreignKeyViolations: number;
  diff: string[];
}

function pragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }));
}

export function detectState(db: Database.Database, registry: RegistryView): StateReport {
  const rows = readSchemaRows(db);
  const fp = fingerprintFromRows(rows);
  const struct = structuralV1(db);
  const userVersion = pragmaNumber(db, "user_version");
  const applicationId = pragmaNumber(db, "application_id");
  const encoding = String(db.pragma("encoding", { simple: true }));
  const pageSize = pragmaNumber(db, "page_size");
  const fkRows = (db.pragma("foreign_key_check") as unknown[]).length;
  const head = registry.entries.length === 0 ? 0 : Math.max(...registry.entries.map((e) => e.id));
  const reasons: string[] = [];
  const report = (state: SchemaState, history: HistoryRow[] = [], diff: string[] = []): StateReport => ({
    state,
    reasons,
    userVersion,
    applicationId,
    encoding,
    pageSize,
    fingerprint: fp.sha256,
    structural: struct.sha256,
    fingerprintRows: fp.rows,
    history: history.map((h) => ({ id: h.id, name: h.name, checksum: h.checksum, kind: h.kind })),
    registryHead: head,
    foreignKeyViolations: fkRows,
    diff,
  });
  const diffAgainst = (expected: ExpectedSchema) => [
    ...(expected.rows ? objectDiff(expected.rows, rows) : []),
    ...(expected.tables ? structuralDiff(expected.tables, struct.tables) : []),
  ];

  // Checks independent of the history (5B §E.4).
  if (applicationId !== 0) reasons.push(`application_id is ${applicationId}, expected 0 (O-7)`);
  if (encoding !== "UTF-8") reasons.push(`encoding is ${encoding}, expected UTF-8`);
  if (fkRows > 0) reasons.push(`foreign_key_check reported ${fkRows} violation(s)`);

  const historyRows = rows.filter((r) => r.tbl_name === HISTORY_TABLE);
  const historyTable = historyRows.find((r) => r.type === "table" && r.name === HISTORY_TABLE);
  const userObjects = rows.filter((r) => r.tbl_name !== HISTORY_TABLE && !(r.name.startsWith("sqlite_") && !r.name.startsWith("sqlite_autoindex_")));

  if (!historyTable) {
    if (historyRows.length > 0) {
      reasons.push(`objects reference ${HISTORY_TABLE} but the table is missing`);
      return report("INCONSISTENT");
    }
    if (userVersion !== 0) {
      reasons.push(`user_version is ${userVersion} but there is no ${HISTORY_TABLE} table`);
      return report("INCONSISTENT");
    }
    if (userObjects.length === 0) return report(reasons.length ? "INCONSISTENT" : "EMPTY");
    const base = registry.legacyBaseline;
    if (fp.sha256 === base.fingerprint && struct.sha256 === base.structural) return report(reasons.length ? "INCONSISTENT" : "LEGACY_BASELINE");
    if (fp.sha256 === base.fingerprint) reasons.push("fingerprint matches the baseline but the structural snapshot differs");
    else reasons.push("schema does not match the legacy baseline");
    return report("LEGACY_UNKNOWN", [], diffAgainst(base));
  }

  // History present: verify its definition (X1, checked separately).
  if (historyTable.sql !== HISTORY_TABLE_SQL) reasons.push(`${HISTORY_TABLE} definition differs from the pinned DDL`);
  for (const r of historyRows) {
    if (r === historyTable) continue;
    if (!(r.type === "index" && r.name === HISTORY_AUTOINDEX && r.sql === null)) reasons.push(`unexpected object on ${HISTORY_TABLE}: ${r.type} ${r.name}`);
  }
  if (!historyRows.some((r) => r.name === HISTORY_AUTOINDEX)) reasons.push(`${HISTORY_TABLE} is missing its UNIQUE(name) index`);
  if (reasons.length) return report("INCONSISTENT");

  let history: HistoryRow[];
  try {
    history = db.prepare(`SELECT id, name, checksum, checksum_alg, kind, applied_at, app_version, git_commit, runner_version, sqlite_version, duration_ms, fingerprint_after FROM ${HISTORY_TABLE} ORDER BY id`).all() as HistoryRow[];
  } catch (error) {
    reasons.push(`${HISTORY_TABLE} could not be read: ${(error as Error).message}`);
    return report("INCONSISTENT");
  }
  if (history.length === 0) {
    reasons.push(`${HISTORY_TABLE} is empty`);
    return report("INCONSISTENT", history);
  }
  history.forEach((h, i) => {
    if (h.id !== i + 1) reasons.push(`history ids are not contiguous from 1 (position ${i + 1} has id ${h.id})`);
    if (h.kind !== "applied" && !(h.kind === "baselined" && h.id === 1)) reasons.push(`history id ${h.id} has kind ${h.kind}`);
    if (h.checksum_alg !== CHECKSUM_ALG_V1) reasons.push(`history id ${h.id} has checksum_alg ${h.checksum_alg}`);
  });
  if (reasons.length) return report("INCONSISTENT", history);
  const top = history.length;
  if (userVersion !== top) {
    reasons.push(`user_version ${userVersion} does not equal the highest history id ${top}`);
    return report("INCONSISTENT", history);
  }
  for (const h of history) {
    const entry = registry.entries.find((e) => e.id === h.id);
    if (!entry) continue; // newer than this code
    if (entry.name !== h.name) reasons.push(`history id ${h.id}: stored name ${h.name} differs from registry name ${entry.name}`);
    if (entry.checksum !== h.checksum) reasons.push(`history id ${h.id} (${h.name}): stored checksum ${h.checksum} differs from registry checksum ${entry.checksum}`);
  }
  for (const h of history) {
    if (h.id > head) continue;
    if (h.fingerprint_after !== registry.expectedAfter(h.id).fingerprint) reasons.push(`history id ${h.id}: recorded fingerprint_after differs from the registry's expected fingerprint`);
  }
  if (reasons.length) return report("INCONSISTENT", history);
  if (top > head) {
    reasons.push(`database is at version ${top}, this code knows up to ${head}`);
    return report("NEWER", history);
  }
  const expected = registry.expectedAfter(top);
  if (fp.sha256 !== expected.fingerprint || struct.sha256 !== expected.structural) {
    reasons.push(`schema does not match the expected schema after version ${top} (drift)`);
    return report("INCONSISTENT", history, diffAgainst(expected));
  }
  return report(top === head ? "MANAGED_CURRENT" : "MANAGED_PENDING", history);
}

/** States that `status` reports with exit 0; everything else is exit 2 (refused) or 6 (undeterminable). */
export const STATUS_OK_STATES: ReadonlySet<SchemaState> = new Set(["EMPTY", "LEGACY_BASELINE", "MANAGED_CURRENT", "MANAGED_PENDING"]);

export type StatusResult =
  | { ok: true; exitCode: 0 | 2; read: "absent" | "zero-bytes" | "bytes"; sha256: string | null; sidecars: SidecarRecord; report: StateReport | null; state: SchemaState }
  | { ok: false; exitCode: 2 | 6; code: ReadRefusalCode; message: string; sidecars: SidecarRecord | null };

/** Full `status`: path guard, snapshot read, in-memory open, integrity check, state detection. */
export function snapshotStatus(dbPath: string, registry: RegistryView, cwd: string = process.cwd()): StatusResult {
  return statusFromOutcome(guardedSnapshotRead(dbPath, cwd), registry);
}

export function statusFromOutcome(outcome: SnapshotOutcome, registry: RegistryView): StatusResult {
  if (outcome.kind === "refused") return { ok: false, exitCode: outcome.exitCode, code: outcome.code, message: outcome.message, sidecars: outcome.sidecars };
  if (outcome.kind === "empty") return { ok: true, exitCode: 0, read: outcome.reason, sha256: null, sidecars: outcome.sidecars, report: null, state: "EMPTY" };
  const opened = openSnapshot(outcome.buffer);
  if ("code" in opened) return { ok: false, exitCode: EXIT.REFUSED, code: opened.code, message: opened.message, sidecars: outcome.sidecars };
  try {
    const report = detectState(opened.db, registry);
    return { ok: true, exitCode: STATUS_OK_STATES.has(report.state) ? 0 : 2, read: "bytes", sha256: outcome.sha256, sidecars: outcome.sidecars, report, state: report.state };
  } finally {
    opened.db.close();
  }
}

/** Human-readable status. Names, hashes and counts only; never row values. */
export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];
  const side = (s: SidecarRecord | null) =>
    s ? `-wal ${s.wal ? `${s.wal.size} bytes` : "absent"}; -shm ${s.shm ? `present (${s.shm.size} bytes, ignored for content)` : "absent"}; -journal ${s.journal ? "present" : "absent"}` : "not inspected";
  if (!result.ok) {
    lines.push(`state: ${result.code === "UNDETERMINABLE_WAL_PENDING" ? "UNDETERMINABLE_WAL_PENDING" : "REFUSED"}`);
    lines.push(`reason: ${result.code}: ${result.message}`);
    lines.push(`sidecars: ${side(result.sidecars)}`);
    lines.push(`exit: ${result.exitCode}`);
    return lines.join("\n");
  }
  lines.push(`state: ${result.state}`);
  lines.push(`read: ${result.read}${result.sha256 ? ` sha256=${result.sha256}` : ""}`);
  lines.push(`sidecars: ${side(result.sidecars)}`);
  const r = result.report;
  if (r) {
    lines.push(`fingerprint_v1: ${r.fingerprint} (${r.fingerprintRows} rows)`);
    lines.push(`structural_v1: ${r.structural}`);
    lines.push(`user_version: ${r.userVersion}; application_id: ${r.applicationId}; encoding: ${r.encoding}; page_size: ${r.pageSize}`);
    lines.push(`history: ${r.history.length ? r.history.map((h) => `${h.id} ${h.name} ${h.kind} ${h.checksum}`).join("; ") : "none"}; registry head: ${r.registryHead}`);
    lines.push(`foreign_key_check: ${r.foreignKeyViolations} violation(s)`);
    for (const reason of r.reasons) lines.push(`reason: ${reason}`);
    for (const d of r.diff) lines.push(`diff: ${d}`);
  }
  lines.push(`exit: ${result.exitCode}`);
  return lines.join("\n");
}
