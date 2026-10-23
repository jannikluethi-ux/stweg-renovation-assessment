import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../lib/schema";
import { PINNED_BASELINE_FINGERPRINT_V1, PINNED_BASELINE_STRUCTURAL_V1, readSchemaRows, structuralTables } from "../../lib/migrations/fingerprint";
import { HISTORY_TABLE_SQL, type ExpectedSchema, type RegistryView } from "../../lib/migrations/state";

/**
 * Synthetic schema fixtures for the A2 tests. Every DB is created in memory or
 * inside a marked disposable directory (withTempEnv / makeScratchDir); nothing
 * here touches a checkout's data/ directory.
 */

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** sha256, size, mtimeNs and inode of every entry in dir (sorted); used to prove "no new files, nothing changed". */
export function dirState(dir: string): string {
  return fs
    .readdirSync(dir)
    .sort()
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.lstatSync(p, { bigint: true });
      return `${f} ${st.isFile() ? sha256File(p) : st.isSymbolicLink() ? "symlink" : "dir"} ${st.size} ${st.mtimeNs} ${st.ino}`;
    })
    .join("\n");
}

/** The baseline schema exactly as the app creates it (HEAD SCHEMA_SQL). */
export function baselineSql(): string {
  return SCHEMA_SQL;
}

export function createDbFile(file: string, sql: string, opts: { wal?: boolean; pageSize?: number; userVersion?: number; applicationId?: number } = {}): void {
  const db = new Database(file);
  try {
    if (opts.pageSize) db.pragma(`page_size = ${opts.pageSize}`);
    if (opts.wal) db.pragma("journal_mode = WAL");
    db.exec(sql);
    if (opts.userVersion !== undefined) db.pragma(`user_version = ${opts.userVersion}`);
    if (opts.applicationId !== undefined) db.pragma(`application_id = ${opts.applicationId}`);
  } finally {
    db.close();
  }
}

export function memoryDb(sql: string): Database.Database {
  const db = new Database(":memory:");
  db.exec(sql);
  return db;
}

/** 64-hex fixture checksum derived from a label (fixtures only; the registry computes real ones). */
export function fixtureChecksum(label: string): string {
  return crypto.createHash("sha256").update(`fixture:${label}`).digest("hex");
}

/** Adds a history table with the given rows and user_version (fixture only; the runner does this for real). */
export function addHistory(
  db: Database.Database,
  rows: Array<{ id: number; name: string; checksum: string; kind?: string; checksumAlg?: string; fingerprintAfter?: string }>,
  userVersion = rows.length,
  ddl = HISTORY_TABLE_SQL,
): void {
  db.exec(ddl);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, name, checksum, checksum_alg, kind, applied_at, app_version, git_commit, runner_version, sqlite_version, duration_ms, fingerprint_after) VALUES (?, ?, ?, ?, ?, '2026-10-23T00:00:00.000Z', 'fixture', NULL, 'fixture', '3.49.2', 0, ?)",
  );
  for (const r of rows) {
    insert.run(r.id, r.name, r.checksum, r.checksumAlg ?? "stweg-mig-sha256-v1", r.kind ?? (r.id === 1 ? "baselined" : "applied"), r.fingerprintAfter ?? PINNED_BASELINE_FINGERPRINT_V1);
  }
  db.pragma(`user_version = ${userVersion}`);
}

let baselineReference: ExpectedSchema | null = null;
export function baselineExpected(): ExpectedSchema {
  if (!baselineReference) {
    const db = memoryDb(SCHEMA_SQL);
    baselineReference = { fingerprint: PINNED_BASELINE_FINGERPRINT_V1, structural: PINNED_BASELINE_STRUCTURAL_V1, rows: readSchemaRows(db), tables: structuralTables(db) };
    db.close();
  }
  return baselineReference;
}

export const FIXTURE_CHECKSUM = fixtureChecksum("0001_baseline");

/** A registry view with one migration (0001_baseline) whose result is the pinned baseline. */
export function fixtureRegistry(checksum = FIXTURE_CHECKSUM): RegistryView {
  return {
    entries: [{ id: 1, name: "0001_baseline", checksum }],
    expectedAfter: (k) => {
      if (k !== 1) throw new Error(`fixture registry has no migration ${k}`);
      return baselineExpected();
    },
    legacyBaseline: baselineExpected(),
  };
}

/** SCHEMA_SQL with one textual replacement; throws if the needle is missing (keeps fixtures honest). */
export function variantSql(needle: string, replacement: string): string {
  if (!SCHEMA_SQL.includes(needle)) throw new Error(`fixture needle not found: ${needle}`);
  return SCHEMA_SQL.replace(needle, replacement);
}
