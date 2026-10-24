import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ConfigError } from "../lib/config";
import { PINNED_BASELINE_FINGERPRINT_V1, PINNED_BASELINE_STRUCTURAL_V1, fingerprintV1, structuralV1 } from "../lib/migrations/fingerprint";
import { findHolders } from "../lib/migrations/holders";
import { MIGRATIONS, buildRegistry, registryView, type MigrationDefinition, type RegistryEntry } from "../lib/migrations/registry";
import { RUN_LOG_DIR_NAME, TEST_ENV, applyMigrations, setRunnerHooksForTests, statusWithRunLog, type ApplyResult } from "../lib/migrations/runner";
import { interruptedRuns, listRunLogs, readRunLog } from "../lib/migrations/runlog";
import { snapshotStatus } from "../lib/migrations/state";
import { SCHEMA_SQL } from "../lib/schema";
import { createDbFile, dirState, sha256File } from "./fixtures/schema-fixtures";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * A2-3: migration runner, run log and holder check. Synthetic databases in
 * marked disposable directories only; child processes for crash, concurrency
 * and holder tests. The checkout's data/ directory must be unchanged.
 */

const ROOT = process.cwd();
const REAL_DATA = path.join(ROOT, "data");
const realBefore = fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none";
after(() => assert.equal(fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none", realBefore, "checkout data/ must be unchanged"));

/** node with the tsx loader directly (the tsx CLI wrapper would hide the child's signal) */
const TSX_ARGS = ["--import", "tsx"];
const RUNNER_MODULE = path.join(ROOT, "src", "lib", "migrations", "runner.ts");
const SENTINEL = "SENTINEL_ROW_VALUE_7f3a";
const BASE_SQL = MIGRATIONS[0].sql;
const ORG_ROW = (id: string, name = SENTINEL) =>
  `INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('${id}', '${name}', 'c', 'p', 'n', 'n');`;

function disposable() {
  const h = withTempEnv();
  return { dir: h.dir, db: path.join(h.dir, "t.db"), logs: path.join(h.dir, RUN_LOG_DIR_NAME), cleanup: h.cleanup };
}

/** sha (or absent) of the DB file and each sidecar. */
function dbFiles(db: string): string {
  return ["", "-wal", "-shm", "-journal"].map((s) => `${s || "main"}=${fs.existsSync(db + s) ? sha256File(db + s) : "absent"}`).join(" ");
}

function apply(db: string, extra: Partial<Parameters<typeof applyMigrations>[0]> = {}): ApplyResult {
  return applyMigrations({ dbPath: db, cwd: ROOT, ...extra });
}

function readDb<T>(db: string, fn: (d: Database.Database) => T): T {
  const d = new Database(db, { readonly: true, fileMustExist: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

const userVersion = (db: string) => readDb(db, (d) => Number(d.pragma("user_version", { simple: true })));
const historyRows = (db: string) => readDb(db, (d) => d.prepare("SELECT id, name, kind, checksum, fingerprint_after FROM schema_migrations ORDER BY id").all() as Array<{ id: number; name: string; kind: string; checksum: string; fingerprint_after: string }>);
const masterRows = (db: string) => readDb(db, (d) => d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>);
const tableExists = (db: string, name: string) => readDb(db, (d) => d.prepare("SELECT count(*) FROM sqlite_master WHERE name = ?").pluck().get(name) === 1);

/** Per-table content hash (test-side only; never printed). */
function tableData(db: string): Map<string, string> {
  return readDb(db, (d) => {
    const out = new Map<string, string>();
    const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").pluck().all() as string[];
    for (const n of names) out.set(n, crypto.createHash("sha256").update(JSON.stringify(d.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).raw().all())).digest("hex"));
    return out;
  });
}

/** Test registry: 0001 plus extra definitions; expected hashes computed by executing the SQL in memory. */
function testRegistry(extra: Array<Omit<MigrationDefinition, "expectedFingerprintAfter" | "expectedStructuralAfter"> & { expectedFingerprintAfter?: string; expectedStructuralAfter?: string }>): readonly RegistryEntry[] {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  mem.exec(BASE_SQL);
  const defs: MigrationDefinition[] = [{ ...MIGRATIONS[0] }];
  for (const e of extra) {
    let fp = e.expectedFingerprintAfter;
    let st = e.expectedStructuralAfter;
    try {
      mem.exec(e.sql);
      fp ??= fingerprintV1(mem).sha256;
      st ??= structuralV1(mem).sha256;
    } catch {
      fp ??= "0".repeat(64);
      st ??= "0".repeat(64);
    }
    defs.push({ ...e, expectedFingerprintAfter: fp, expectedStructuralAfter: st });
  }
  mem.close();
  return buildRegistry(defs);
}

const ADD_TABLE: Omit<MigrationDefinition, "expectedFingerprintAfter" | "expectedStructuralAfter"> = {
  id: 2,
  name: "0002_add_notes",
  sql: "CREATE TABLE a2_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);\nCREATE INDEX idx_a2_notes_body ON a2_notes(body);\n",
  requiresForeignKeysOff: false,
};

function runLogRecords(r: ApplyResult) {
  assert.ok(r.runLogFile, "run log file expected");
  return readRunLog(r.runLogFile);
}

function assertLogged(r: ApplyResult, exitCode: number) {
  const recs = runLogRecords(r);
  assert.equal(recs[0].event, "start");
  const end = recs.find((x) => x.event === "end");
  assert.ok(end, "end record");
  assert.equal(end.exitCode, exitCode);
  const text = fs.readFileSync(r.runLogFile!, "utf8");
  assert.ok(!text.includes(SENTINEL), "the run log must not contain row values");
}

// ---------------------------------------------------------------------------------------------
// child processes
// ---------------------------------------------------------------------------------------------

function childScript(dir: string): string {
  const file = path.join(dir, "child-apply.ts");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `import { applyMigrations } from ${JSON.stringify(RUNNER_MODULE)};\n` +
        `const r = applyMigrations({ dbPath: process.argv[2], cwd: ${JSON.stringify(ROOT)}, busyTimeoutMs: Number(process.argv[3] || 5000) });\n` +
        `process.stdout.write(JSON.stringify(r));\nprocess.exitCode = r.exitCode;\n`,
    );
  }
  return file;
}

function childEnv(testMode: boolean, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!testMode) {
    delete env.NODE_ENV;
    delete env.STWEG_TEST;
    delete env.STWEG_DB_PATH;
    delete env.STWEG_UPLOADS_DIR;
  }
  return env;
}

function runChildSync(dir: string, db: string, testMode: boolean, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [...TSX_ARGS, childScript(dir), db], { cwd: ROOT, env: childEnv(testMode, extra), encoding: "utf8", timeout: 60_000 });
  let parsed: ApplyResult | null = null;
  try {
    parsed = JSON.parse(r.stdout) as ApplyResult;
  } catch {
    parsed = null;
  }
  return { status: r.status, signal: r.signal, result: parsed, stderr: r.stderr };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${path.basename(file)}`);
    sleepSync(25);
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; stdout: string }> {
  let stdout = "";
  child.stdout?.on("data", (c) => (stdout += c));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout })));
}

// ---------------------------------------------------------------------------------------------

describe("A2-3 apply on EMPTY, adoption, repeat (T-MG01, T-MG03, T-MG04, T-MG09)", () => {
  it("T-MG01 fresh apply on an absent file: 0001 applied, user_version 1, fingerprint = pinned", () => {
    const d = disposable();
    try {
      const r = apply(d.db);
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(r.outcome, "applied");
      assert.equal(r.stateBefore, "EMPTY");
      assert.equal(r.stateAfter, "MANAGED_CURRENT");
      assert.deepEqual(r.applied.map((a) => [a.id, a.name, a.kind]), [[1, "0001_baseline", "applied"]]);
      assert.equal(userVersion(d.db), 1);
      const h = historyRows(d.db);
      assert.equal(h.length, 1);
      assert.equal(h[0].checksum, MIGRATIONS[0].checksum);
      assert.equal(h[0].fingerprint_after, PINNED_BASELINE_FINGERPRINT_V1);
      const s = snapshotStatus(d.db, registryView(), ROOT);
      assert.ok(s.ok);
      assert.equal(s.state, "MANAGED_CURRENT");
      assert.equal(s.report?.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(s.report?.structural, PINNED_BASELINE_STRUCTURAL_V1);
      assertLogged(r, 0);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG01 fresh apply on a zero-byte file keeps the inode", () => {
    const d = disposable();
    try {
      fs.writeFileSync(d.db, "");
      const ino = fs.statSync(d.db).ino;
      const r = apply(d.db);
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(fs.statSync(d.db).ino, ino);
      assert.equal(userVersion(d.db), 1);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG03 fresh vs adopted: identical fingerprint v1, structural v1, sqlite_master and user_version", () => {
    const a = disposable();
    const b = disposable();
    try {
      assert.equal(apply(a.db).exitCode, 0);
      createDbFile(b.db, SCHEMA_SQL);
      const r = apply(b.db);
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(r.applied[0].kind, "baselined");
      const sa = snapshotStatus(a.db, registryView(), ROOT);
      const sb = snapshotStatus(b.db, registryView(), ROOT);
      assert.ok(sa.ok && sb.ok);
      assert.equal(sa.report?.fingerprint, sb.report?.fingerprint);
      assert.equal(sa.report?.structural, sb.report?.structural);
      assert.deepEqual(masterRows(a.db), masterRows(b.db));
      assert.equal(userVersion(a.db), userVersion(b.db));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("T-MG04 legacy match → adopt: only schema_migrations is added; counts and table data unchanged", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL + ORG_ROW("o1") + ORG_ROW("o2", "second"));
      const dataBefore = tableData(d.db);
      const masterBefore = masterRows(d.db);
      const r = apply(d.db);
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(r.stateBefore, "LEGACY_BASELINE");
      assert.deepEqual(r.applied.map((a) => a.kind), ["baselined"]);
      assert.deepEqual(tableData(d.db), dataBefore);
      const added = masterRows(d.db).filter((m) => !masterBefore.some((b) => b.name === m.name && b.sql === m.sql));
      assert.deepEqual(added.map((m) => m.name).sort(), ["schema_migrations", "sqlite_autoindex_schema_migrations_1"]);
      assert.equal(masterRows(d.db).length, masterBefore.length + 2);
      assert.equal(historyRows(d.db)[0].kind, "baselined");
      assert.equal(userVersion(d.db), 1);
      assertLogged(r, 0);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG04 adoption never changes journal_mode (WAL database stays WAL; header bytes 18/19 = 2)", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL, { wal: true });
      const r = apply(d.db);
      assert.equal(r.exitCode, 0, r.message);
      const header = fs.readFileSync(d.db).subarray(18, 20);
      assert.deepEqual([...header], [2, 2]);
      assert.equal(readDb(d.db, (x) => String(x.pragma("journal_mode", { simple: true }))), "wal");
    } finally {
      d.cleanup();
    }
  });

  it("T-MG09 repeat apply is a no-op and leaves the file byte-identical (no read-write open)", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      const before = dbFiles(d.db);
      const st = fs.statSync(d.db, { bigint: true });
      const r = apply(d.db);
      assert.equal(r.exitCode, 0);
      assert.equal(r.outcome, "noop");
      assert.equal(dbFiles(d.db), before);
      assert.equal(fs.statSync(d.db, { bigint: true }).mtimeNs, st.mtimeNs);
      assertLogged(r, 0);
    } finally {
      d.cleanup();
    }
  });

  it("pending migrations: EMPTY applies 0001 and 0002; MANAGED_PENDING applies only 0002 (kind applied)", () => {
    const reg = testRegistry([ADD_TABLE]);
    const a = disposable();
    const b = disposable();
    try {
      const ra = apply(a.db, { registry: reg });
      assert.equal(ra.exitCode, 0, ra.message);
      assert.deepEqual(ra.applied.map((x) => x.name), ["0001_baseline", "0002_add_notes"]);
      assert.equal(userVersion(a.db), 2);
      assert.equal(apply(b.db).exitCode, 0);
      const rb = apply(b.db, { registry: reg });
      assert.equal(rb.exitCode, 0, rb.message);
      assert.equal(rb.stateBefore, "MANAGED_PENDING");
      assert.deepEqual(rb.applied.map((x) => [x.name, x.kind]), [["0002_add_notes", "applied"]]);
      assert.deepEqual(historyRows(a.db).map((h) => [h.id, h.name, h.kind]), historyRows(b.db).map((h) => [h.id, h.name, h.kind]).map((x, i) => (i === 0 ? [1, "0001_baseline", "applied"] : x)));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe("A2-3 refusals (T-MG10, guard, states)", () => {
  it("T-MG10 checksum mismatch: exit 2, nothing written, message lists the id", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      const before = dbFiles(d.db);
      const edited = buildRegistry([{ ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}-- edited after apply\n` }]);
      const r = apply(d.db, { registry: edited });
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /INCONSISTENT/);
      assert.match(r.message, /history id 1 \(0001_baseline\): stored checksum/);
      assert.equal(dbFiles(d.db), before);
      assertLogged(r, 2);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG10 name mismatch: exit 2, nothing written, message lists the id", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      const before = dbFiles(d.db);
      const renamed = buildRegistry([{ ...MIGRATIONS[0], name: "0001_initial" }]);
      const r = apply(d.db, { registry: renamed });
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /history id 1: stored name 0001_baseline differs from registry name 0001_initial/);
      assert.equal(dbFiles(d.db), before);
    } finally {
      d.cleanup();
    }
  });

  it("refuses LEGACY_UNKNOWN, INCONSISTENT and NEWER without writing", () => {
    const cases: Array<[string, (db: string) => void]> = [
      ["LEGACY_UNKNOWN", (db) => createDbFile(db, SCHEMA_SQL.replace("  email TEXT NOT NULL UNIQUE,", "  email TEXT NOT NULL,"))],
      ["INCONSISTENT", (db) => createDbFile(db, SCHEMA_SQL, { userVersion: 3 })],
      ["NEWER", (db) => {
        assert.equal(apply(db, { registry: testRegistry([ADD_TABLE]) }).exitCode, 0);
      }],
    ];
    for (const [state, make] of cases) {
      const d = disposable();
      try {
        make(d.db);
        const before = dbFiles(d.db);
        const r = apply(d.db);
        assert.equal(r.exitCode, 2, `${state}: ${r.message}`);
        assert.match(r.message, new RegExp(state));
        assert.equal(dbFiles(d.db), before, state);
      } finally {
        d.cleanup();
      }
    }
  });

  it("non-empty WAL: exit 6 (undeterminable), nothing opened read-write", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL, { wal: true });
      const holder = new Database(d.db);
      holder.pragma("wal_autocheckpoint = 0");
      holder.exec(ORG_ROW("w1"));
      const tmp = path.join(d.dir, "copy");
      fs.mkdirSync(tmp);
      for (const s of ["", "-wal"]) fs.copyFileSync(d.db + s, path.join(tmp, `c.db${s}`));
      holder.close();
      fs.writeFileSync(path.join(d.dir, "w.db"), fs.readFileSync(path.join(tmp, "c.db")));
      fs.writeFileSync(path.join(d.dir, "w.db-wal"), fs.readFileSync(path.join(tmp, "c.db-wal")));
      const w = path.join(d.dir, "w.db");
      assert.ok(fs.statSync(`${w}-wal`).size > 0);
      const before = dbFiles(w);
      const r = apply(w);
      assert.equal(r.exitCode, 6, r.message);
      assert.equal(r.outcome, "undeterminable");
      assert.equal(dbFiles(w), before);
      assertLogged(r, 6);
    } finally {
      d.cleanup();
    }
  });

  it("path guard: unmarked and protected paths are refused with exit 2 and nothing is written anywhere", () => {
    const s = makeScratchDir();
    try {
      const target = path.join(s.dir, "x.db");
      const before = dirState(s.dir);
      const r = apply(target);
      assert.equal(r.exitCode, 2);
      assert.equal(r.runLogFile, null);
      assert.equal(dirState(s.dir), before);
      const p = apply(path.join(ROOT, "data", "stweg.db"));
      assert.equal(p.exitCode, 2);
      assert.equal(p.runLogFile, null);
      assert.match(p.message, /default data location/);
    } finally {
      s.cleanup();
    }
  });
});

describe("A2-3 failures roll back (T-MG12, T-MG13)", () => {
  it("T-MG12 injected SQL failure: exit 3, at k-1, no partial objects", () => {
    const reg = testRegistry([{ id: 2, name: "0002_broken", sql: "CREATE TABLE a2_partial (x INTEGER);\nINSERT INTO a2_missing_table VALUES (1);\n", requiresForeignKeysOff: false }]);
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      const r = apply(d.db, { registry: reg });
      assert.equal(r.exitCode, 3, r.message);
      assert.equal(r.outcome, "rolled_back");
      assert.equal(userVersion(d.db), 1);
      assert.equal(historyRows(d.db).length, 1);
      assert.equal(tableExists(d.db, "a2_partial"), false);
      const s = snapshotStatus(d.db, registryView(), ROOT);
      assert.ok(s.ok);
      assert.equal(s.state, "MANAGED_CURRENT");
      assert.equal(s.report?.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assertLogged(r, 3);
      assert.ok(runLogRecords(r).some((x) => x.event === "rolled_back"));
    } finally {
      d.cleanup();
    }
  });

  it("T-MG12 failure during the first migration on EMPTY leaves no schema (test hook, test mode)", () => {
    const d = disposable();
    try {
      const r = apply(d.db, { env: { ...process.env, [TEST_ENV.failAt]: "before-commit" } });
      assert.equal(r.exitCode, 3, r.message);
      const s = snapshotStatus(d.db, registryView(), ROOT);
      assert.ok(s.ok);
      assert.equal(s.state, "EMPTY");
    } finally {
      d.cleanup();
    }
  });

  it("T-MG13 pre-commit verification failure (wrong expected fingerprint): exit 3, at k-1", () => {
    const reg = testRegistry([{ ...ADD_TABLE, expectedFingerprintAfter: "1".repeat(64) }]);
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      const r = apply(d.db, { registry: reg });
      assert.equal(r.exitCode, 3);
      assert.match(r.message, /pre-commit verification failed: fingerprint after 0002_add_notes/);
      assert.equal(userVersion(d.db), 1);
      assert.equal(tableExists(d.db, "a2_notes"), false);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG13 undeclared row-count change: exit 3, data unchanged", () => {
    const reg = testRegistry([{ id: 2, name: "0002_insert_row", sql: ORG_ROW("added"), requiresForeignKeysOff: false }]);
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL + ORG_ROW("o1"));
      assert.equal(apply(d.db).exitCode, 0);
      const data = tableData(d.db);
      const r = apply(d.db, { registry: reg });
      assert.equal(r.exitCode, 3);
      assert.match(r.message, /row count of organizations changed/);
      assert.deepEqual(tableData(d.db), data);
      assertLogged(r, 3);
    } finally {
      d.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// journal handling helpers (rev2 §F.3 / §F.3a; owner decision 24.10.2026: strict refusal)
// ---------------------------------------------------------------------------------------------

const HOT_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

type FileId = { sha256: string; size: string; mtimeNs: string; ctimeNs: string; ino: string; dev: string };
function fileId(file: string): FileId {
  const st = fs.statSync(file, { bigint: true });
  return { sha256: sha256File(file), size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), ino: String(st.ino), dev: String(st.dev) };
}

/** "zero-byte" | "zero-header" (first 8 bytes zero: not hot) | "hot" (valid journal magic) | "other" */
function journalKind(file: string): "zero-byte" | "zero-header" | "hot" | "other" {
  const b = fs.readFileSync(file);
  if (b.length === 0) return "zero-byte";
  const head = b.subarray(0, 8);
  if (head.every((x) => x === 0)) return "zero-header";
  if (head.equals(HOT_JOURNAL_MAGIC)) return "hot";
  return "other";
}

/**
 * Records fs-level opens/reads/writes/removals of the given paths while fn runs (spy on the node:fs
 * object used by snapshot-read, state, holders and runner). better-sqlite3 opens natively and is not
 * visible here; for that, the unchanged hot journal is the evidence (a SQLite open rolls it back).
 */
function withFsSpy<T>(paths: string[], fn: () => T): { result: T; touched: string[] } {
  const watch = new Set(paths.map((x) => path.resolve(x)));
  const touched: string[] = [];
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = ["openSync", "readFileSync", "createReadStream", "copyFileSync", "truncateSync", "unlinkSync", "rmSync", "renameSync", "writeFileSync", "appendFileSync"];
  const orig = new Map(names.map((n) => [n, f[n]]));
  for (const n of names) {
    const o = orig.get(n)!;
    f[n] = (...a: unknown[]) => {
      if (typeof a[0] === "string" && watch.has(path.resolve(a[0]))) touched.push(`${n}:${path.basename(a[0])}`);
      return o.apply(fs, a);
    };
  }
  try {
    return { result: fn(), touched };
  } finally {
    for (const n of names) f[n] = orig.get(n)!;
  }
}

/**
 * Status (both entry points) and apply must refuse with JOURNAL_PRESENT / exit 2, must not open,
 * read, rewrite or remove the journal or the main file, and must leave both byte-identical.
 */
function assertStrictJournalRefusal(db: string, rounds = 1) {
  const j = db + "-journal";
  const j0 = fileId(j);
  const m0 = fileId(db);
  for (let i = 0; i < rounds; i++) {
    const spy = withFsSpy([db, j], () => ({
      snap: snapshotStatus(db, registryView(), ROOT),
      st: statusWithRunLog(db, { cwd: ROOT }),
      r: apply(db),
    }));
    const { snap, st, r } = spy.result;
    assert.equal(snap.ok, false);
    if (!snap.ok) {
      assert.equal(snap.code, "JOURNAL_PRESENT");
      assert.equal(snap.exitCode, 2);
    }
    assert.equal(st.status.ok, false);
    if (!st.status.ok) {
      assert.equal(st.status.code, "JOURNAL_PRESENT");
      assert.equal(st.status.exitCode, 2);
    }
    assert.equal(r.exitCode, 2, r.message);
    assert.equal(r.outcome, "refused");
    assert.match(r.message, /^refused: JOURNAL_PRESENT:/);
    assert.equal(r.stateBefore, null);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(spy.touched, [], "status/apply must not open, read, write or remove the main file or the journal");
    assert.ok(fs.existsSync(j), "the journal must still be present");
    assert.deepEqual(fileId(j), j0, "journal byte-identical (sha256, size, mtime, ctime, inode)");
    assert.deepEqual(fileId(db), m0, "main file byte-identical (sha256, size, mtime, ctime, inode)");
  }
}

/**
 * Independent consistency check made by the TEST HARNESS (never by status/apply): copy only the
 * synthetic main file into a separate marked disposable dir and inspect the copy.
 */
function verifyMainFileCopy(db: string, expectState: "LEGACY_BASELINE" | "EMPTY", data?: Map<string, string>) {
  const v = disposable();
  try {
    fs.copyFileSync(db, v.db);
    assert.equal(fs.existsSync(v.db + "-journal"), false);
    readDb(v.db, (x) => {
      assert.equal(x.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(x.pragma("foreign_key_check"), []);
    });
    const s = snapshotStatus(v.db, registryView(), ROOT);
    assert.ok(s.ok, JSON.stringify(s));
    assert.equal(s.state, expectState);
    if (expectState === "LEGACY_BASELINE") {
      assert.equal(s.report?.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(s.report?.structural, PINNED_BASELINE_STRUCTURAL_V1);
      assert.equal(s.report?.userVersion, 0);
      assert.equal(tableExists(v.db, "schema_migrations"), false);
    }
    if (data) assert.deepEqual(tableData(v.db), data, "data rows unchanged vs the pre-crash snapshot");
  } finally {
    v.cleanup();
  }
}

/** TEST-ONLY OPERATOR ACTION (rev2 §F.3a): an explicit SQLite open of a synthetic fixture by the harness. */
function testOnlyOperatorOpen(db: string) {
  const x = new Database(db);
  x.prepare("SELECT count(*) FROM sqlite_master").get();
  x.close();
}

describe("A2-3 crash consistency (T-MG14, T-MG15, T-CR01) — child processes, test-gated hook", () => {
  it("T-MG14 SIGKILL mid-migration (EMPTY → 0001, before COMMIT): zero-header journal next to a 0-byte main file; status and apply refuse JOURNAL_PRESENT exit 2 and leave it untouched; after a TEST-ONLY operator open the DB is consistent EMPTY; re-run applies once", () => {
    const d = disposable();
    try {
      const c = runChildSync(d.dir, d.db, true, { [TEST_ENV.crashAt]: "before-commit" });
      assert.equal(c.signal, "SIGKILL", c.stderr);
      assert.ok(fs.existsSync(d.db + "-journal"));
      assert.equal(journalKind(d.db + "-journal"), "zero-header");
      assert.equal(fs.statSync(d.db).size, 0, "the crashed migration never wrote the (new, empty) main file");
      assertStrictJournalRefusal(d.db);
      const s1 = statusWithRunLog(d.db, { cwd: ROOT });
      assert.equal(s1.interrupted.length, 1, "only the crashed run is interrupted (refused runs have an end record)");
      assert.match(s1.interrupted[0].assessment, /cannot be determined/);
      // TEST-ONLY operator action on the synthetic fixture (never performed by status/apply): with a 0-byte main
      // file SQLite treats the zero-header journal as stale and deletes it on open
      testOnlyOperatorOpen(d.db);
      assert.equal(fs.existsSync(d.db + "-journal"), false, "SQLite removes a non-hot journal next to an empty main file on open");
      const s2 = statusWithRunLog(d.db, { cwd: ROOT });
      assert.ok(s2.status.ok, JSON.stringify(s2.status));
      assert.equal(s2.status.state, "EMPTY");
      assert.match(s2.interrupted[0].assessment, /interrupted during 0001_baseline \(rolled back\); database consistent at version 0/);
      const r = apply(d.db);
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(historyRows(d.db).length, 1);
      assert.equal(userVersion(d.db), 1);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG14 SIGKILL after the migration SQL of 0002: consistent at k-1; re-run applies 0002 once", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      // child uses the real registry (head 1) so use the after-sql point on a fresh EMPTY instead for k>1 coverage via in-process registry
      const reg = testRegistry([ADD_TABLE]);
      const restore = setRunnerHooksForTests({
        inTransaction: (_db, id) => {
          if (id === 2) throw new Error("simulated crash inside the transaction");
        },
      });
      let r: ApplyResult;
      try {
        r = apply(d.db, { registry: reg });
      } finally {
        restore();
      }
      assert.equal(r.exitCode, 3);
      assert.equal(userVersion(d.db), 1);
      assert.equal(tableExists(d.db, "a2_notes"), false);
      const again = apply(d.db, { registry: reg });
      assert.equal(again.exitCode, 0, again.message);
      assert.deepEqual(historyRows(d.db).map((h) => h.id), [1, 2]);
    } finally {
      d.cleanup();
    }
  });

  for (const point of ["before-commit", "after-sql"] as const) {
    it(`T-MG15 SIGKILL mid-adoption (${point}): zero-header journal persists; status and apply refuse JOURNAL_PRESENT exit 2 and leave journal and main file byte-identical; harness copy of the main file is LEGACY_BASELINE with data unchanged`, () => {
      const d = disposable();
      try {
        createDbFile(d.db, SCHEMA_SQL + ORG_ROW("o1") + ORG_ROW("o2", "second"));
        const preCrashMain = sha256File(d.db);
        const data = tableData(d.db);
        const c = runChildSync(d.dir, d.db, true, { [TEST_ENV.crashAt]: point });
        assert.equal(c.signal, "SIGKILL", c.stderr);
        assert.ok(fs.existsSync(d.db + "-journal"), "the crash leaves a journal");
        assert.equal(journalKind(d.db + "-journal"), "zero-header");
        assertStrictJournalRefusal(d.db, 2);
        const s = statusWithRunLog(d.db, { cwd: ROOT });
        assert.equal(s.interrupted.length, 1);
        assert.match(s.interrupted[0].assessment, /cannot be determined/);
        // independent verification by the test harness on a separate copy of the synthetic main file
        assert.equal(sha256File(d.db), preCrashMain, "the main file was never written (zero-header journal)");
        verifyMainFileCopy(d.db, "LEGACY_BASELINE", data);
        // the zero-header journal persists across a SQLite open (shown on a second harness copy with the journal)
        const v = disposable();
        try {
          fs.copyFileSync(d.db, v.db);
          fs.copyFileSync(d.db + "-journal", v.db + "-journal");
          testOnlyOperatorOpen(v.db);
          assert.ok(fs.existsSync(v.db + "-journal"), "a zero-header journal is not rolled back and persists");
        } finally {
          v.cleanup();
        }
        assert.ok(fs.existsSync(d.db + "-journal"), "nothing removed the original journal");
      } finally {
        d.cleanup();
      }
    });
  }

  it("T-CR01 SIGKILL between COMMIT and the run-log end: DB at k, status reports 'interrupted after commit'; re-run is a no-op", () => {
    const d = disposable();
    try {
      const c = runChildSync(d.dir, d.db, true, { [TEST_ENV.crashAt]: "after-commit" });
      assert.equal(c.signal, "SIGKILL", c.stderr);
      const s = statusWithRunLog(d.db, { cwd: ROOT });
      assert.ok(s.status.ok, "no journal remains after COMMIT");
      assert.equal(s.status.state, "MANAGED_CURRENT");
      assert.equal(s.interrupted.length, 1);
      assert.deepEqual(s.interrupted[0].openMigrations, [{ id: 1, name: "0001_baseline" }]);
      assert.match(s.interrupted[0].assessment, /interrupted after commit of 0001_baseline; database consistent at version 1/);
      const r = apply(d.db);
      assert.equal(r.exitCode, 0);
      assert.equal(r.outcome, "noop");
      assert.equal(historyRows(d.db).length, 1);
    } finally {
      d.cleanup();
    }
  });

  it("T-CR01 completed runs are not reported as interrupted", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      assert.equal(apply(d.db).exitCode, 0);
      assert.deepEqual(statusWithRunLog(d.db, { cwd: ROOT }).interrupted, []);
      assert.equal(listRunLogs(d.logs).length, 2);
      assert.deepEqual(interruptedRuns(d.logs), []);
    } finally {
      d.cleanup();
    }
  });
});

/**
 * Produces a REAL hot journal on a synthetic fixture: a child (plain better-sqlite3, not the runner) with a
 * 1-page cache writes enough rows to spill dirty pages into the main file, then SIGKILLs itself before COMMIT.
 */
function makeHotJournalFixture(dir: string, db: string) {
  const file = path.join(dir, "child-hot-journal.ts");
  fs.writeFileSync(
    file,
    `import Database from ${JSON.stringify(path.join(ROOT, "node_modules", "better-sqlite3"))};\n` +
      `const d = new Database(process.argv[2]);\n` +
      `d.pragma("cache_size = 1");\n` +
      `d.exec("BEGIN IMMEDIATE");\n` +
      `const ins = d.prepare("INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES (?, ?, 'c', 'p', 'n', 'n')");\n` +
      `for (let i = 0; i < 3000; i++) ins.run("hot-" + i, "x".repeat(200));\n` +
      `d.exec("UPDATE organizations SET name = 'changed' WHERE id = 'o1'");\n` +
      `process.kill(process.pid, "SIGKILL");\n`,
  );
  const r = spawnSync(process.execPath, [...TSX_ARGS, file, db], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.signal, "SIGKILL", r.stderr);
}

describe("A2-3 journal is never an implicit recovery action (T-JN01–T-JN05)", () => {
  function legacyFixture() {
    const d = disposable();
    createDbFile(d.db, SCHEMA_SQL + ORG_ROW("o1"));
    return d;
  }

  it("T-JN01 zero-header journal (synthetic, 8720 zero bytes) next to LEGACY_BASELINE: status and apply refuse exit 2 and leave journal and main file byte-identical (3 rounds)", () => {
    const d = legacyFixture();
    try {
      fs.writeFileSync(d.db + "-journal", Buffer.alloc(8720));
      assert.equal(journalKind(d.db + "-journal"), "zero-header");
      assertStrictJournalRefusal(d.db, 3);
    } finally {
      d.cleanup();
    }
  });

  it("T-JN02 hot journal (valid header, real cache-spill crash; main file partly written): status and apply refuse exit 2, never open it with SQLite and leave journal and main file byte-identical; a harness copy shows SQLite would roll it back to the pre-crash data", () => {
    const d = legacyFixture();
    try {
      const data = tableData(d.db);
      makeHotJournalFixture(d.dir, d.db);
      assert.equal(journalKind(d.db + "-journal"), "hot");
      assertStrictJournalRefusal(d.db, 3);
      assert.equal(journalKind(d.db + "-journal"), "hot", "still hot: no SQLite open happened (it would have rolled back and removed it)");
      // harness-only demonstration on copies of both files: a SQLite open rolls the hot journal back
      const v = disposable();
      try {
        fs.copyFileSync(d.db, v.db);
        fs.copyFileSync(d.db + "-journal", v.db + "-journal");
        testOnlyOperatorOpen(v.db);
        assert.equal(fs.existsSync(v.db + "-journal"), false, "hot journal rolled back and removed on the copy");
        assert.deepEqual(tableData(v.db), data, "pre-crash data restored on the copy");
        readDb(v.db, (x) => assert.equal(x.pragma("integrity_check", { simple: true }), "ok"));
      } finally {
        v.cleanup();
      }
      assert.equal(journalKind(d.db + "-journal"), "hot", "the original fixture journal is untouched");
    } finally {
      d.cleanup();
    }
  });

  it("T-JN03 zero-byte journal: status and apply refuse exit 2 and leave it present, zero bytes and byte-identical", () => {
    const d = legacyFixture();
    try {
      fs.writeFileSync(d.db + "-journal", Buffer.alloc(0));
      assertStrictJournalRefusal(d.db, 3);
      assert.equal(fs.statSync(d.db + "-journal").size, 0);
    } finally {
      d.cleanup();
    }
  });

  it("T-JN04 journal next to a MANAGED_CURRENT DB: refusal precedes the no-op path; nothing changes", () => {
    const d = disposable();
    try {
      assert.equal(apply(d.db).exitCode, 0);
      fs.writeFileSync(d.db + "-journal", Buffer.alloc(512));
      assertStrictJournalRefusal(d.db, 2);
    } finally {
      d.cleanup();
    }
  });

  it("T-JN05 spy control: without a journal, status does read the main file (the spy is effective)", () => {
    const d = legacyFixture();
    try {
      const spy = withFsSpy([d.db, d.db + "-journal"], () => snapshotStatus(d.db, registryView(), ROOT));
      assert.ok(spy.result.ok);
      assert.ok(spy.touched.includes("openSync:t.db"), JSON.stringify(spy.touched));
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-3 concurrency (T-MG20, T-MG21)", () => {
  it("T-MG20 two concurrent runners: the first applies, the second blocks on the lock, re-detects and is a no-op", async () => {
    const d = disposable();
    try {
      const marker = path.join(d.dir, "locked.marker");
      let child: ChildProcess | null = null;
      let done: Promise<{ code: number | null; stdout: string }> | null = null;
      const restore = setRunnerHooksForTests({
        afterStatus: () => {
          child = spawn(process.execPath, [...TSX_ARGS, childScript(d.dir), d.db], { cwd: ROOT, env: childEnv(true, { [TEST_ENV.pauseInTxMs]: "1500", [TEST_ENV.lockedMarker]: marker }), stdio: ["ignore", "pipe", "pipe"] });
          done = exited(child);
          waitForFile(marker);
        },
      });
      let r: ApplyResult;
      try {
        r = apply(d.db);
      } finally {
        restore();
      }
      const first = await done!;
      assert.equal(first.code, 0);
      const firstResult = JSON.parse(first.stdout) as ApplyResult;
      assert.equal(firstResult.outcome, "applied");
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(r.outcome, "noop");
      assert.deepEqual(r.applied, []);
      assert.equal(historyRows(d.db).length, 1);
      assertLogged(r, 0);
      assert.ok(runLogRecords(r).some((x) => x.event === "state_after"));
    } finally {
      d.cleanup();
    }
  });

  it("T-MG21 lock held longer than the busy timeout: exit 1 'database busy', nothing written by the second runner", async () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const marker = path.join(d.dir, "locked.marker");
      let done: Promise<{ code: number | null; stdout: string }> | null = null;
      const restore = setRunnerHooksForTests({
        afterStatus: () => {
          const child = spawn(process.execPath, [...TSX_ARGS, childScript(d.dir), d.db], { cwd: ROOT, env: childEnv(true, { [TEST_ENV.pauseInTxMs]: "3000", [TEST_ENV.lockedMarker]: marker }), stdio: ["ignore", "pipe", "pipe"] });
          done = exited(child);
          waitForFile(marker);
        },
      });
      let r: ApplyResult;
      const t0 = Date.now();
      try {
        r = apply(d.db, { busyTimeoutMs: 300 });
      } finally {
        restore();
      }
      assert.equal(r.exitCode, 1, r.message);
      assert.equal(r.outcome, "busy");
      assert.match(r.message, /database busy/);
      assert.ok(Date.now() - t0 < 2900, "the busy runner gave up before the holder released the lock");
      assertLogged(r, 1);
      assert.ok(!runLogRecords(r).some((x) => x.event === "migration_start"));
      const first = await done!;
      assert.equal(first.code, 0);
      assert.deepEqual(historyRows(d.db).map((h) => [h.id, h.kind]), [[1, "baselined"]]);
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-3 FK-off recipe (T-MG22)", () => {
  const PARENT_CHILD: Omit<MigrationDefinition, "expectedFingerprintAfter" | "expectedStructuralAfter"> = {
    id: 2,
    name: "0002_parent_child",
    sql: "CREATE TABLE a2_parent (id TEXT PRIMARY KEY, label TEXT NOT NULL);\nCREATE TABLE a2_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES a2_parent(id));\n",
    requiresForeignKeysOff: false,
  };
  const rebuild = (where: string) =>
    "CREATE TABLE a2_parent_new (id TEXT PRIMARY KEY, label TEXT NOT NULL, extra TEXT);\n" +
    `INSERT INTO a2_parent_new (id, label) SELECT id, label FROM a2_parent${where};\n` +
    "DROP TABLE a2_parent;\nALTER TABLE a2_parent_new RENAME TO a2_parent;\n";

  function prepared(reg: readonly RegistryEntry[]) {
    const d = disposable();
    assert.equal(apply(d.db, { registry: reg.slice(0, 2) }).exitCode, 0);
    const w = new Database(d.db);
    w.exec("INSERT INTO a2_parent VALUES ('p1', 'one'), ('p2', 'two'); INSERT INTO a2_child VALUES ('c1', 'p1'), ('c2', 'p2');");
    w.close();
    return d;
  }

  it("T-MG22 foreign_keys reads 0 during the FK-off migration and 1 afterwards on the same connection", () => {
    const reg = testRegistry([PARENT_CHILD, { id: 3, name: "0003_rebuild_parent", sql: rebuild(""), requiresForeignKeysOff: true }]);
    const d = prepared(reg);
    try {
      const seen: number[] = [];
      let conn: Database.Database | null = null;
      const restore = setRunnerHooksForTests({
        inTransaction: (db, id) => {
          if (id === 3) {
            conn = db;
            seen.push(Number(db.pragma("foreign_keys", { simple: true })));
          }
        },
      });
      let r: ApplyResult;
      try {
        r = apply(d.db, { registry: reg });
      } finally {
        restore();
      }
      assert.equal(r.exitCode, 0, r.message);
      assert.deepEqual(seen, [0]);
      assert.equal(conn !== null, true);
      assert.equal(userVersion(d.db), 3);
      assert.equal(readDb(d.db, (x) => (x.pragma("foreign_key_check") as unknown[]).length), 0);
      assert.ok(runLogRecords(r).some((x) => x.event === "migration_start" && x.id === 3 && x.fkOff === true));
    } finally {
      d.cleanup();
    }
  });

  it("T-MG22 foreign_keys is 1 again after the FK-off migration (checked through a following migration)", () => {
    const reg = testRegistry([PARENT_CHILD, { id: 3, name: "0003_rebuild_parent", sql: rebuild(""), requiresForeignKeysOff: true }, { id: 4, name: "0004_noop_table", sql: "CREATE TABLE a2_after (x INTEGER);\n", requiresForeignKeysOff: false }]);
    const d = prepared(reg);
    try {
      const seen: Array<[number, number]> = [];
      const restore = setRunnerHooksForTests({ inTransaction: (db, id) => seen.push([id, Number(db.pragma("foreign_keys", { simple: true }))]) });
      let r: ApplyResult;
      try {
        r = apply(d.db, { registry: reg });
      } finally {
        restore();
      }
      assert.equal(r.exitCode, 0, r.message);
      assert.deepEqual(seen, [[3, 0], [4, 1]]);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG22 the same rebuild without FK-off fails and rolls back (exit 3)", () => {
    const reg = testRegistry([PARENT_CHILD, { id: 3, name: "0003_rebuild_parent", sql: rebuild(""), requiresForeignKeysOff: false }]);
    const d = prepared(reg);
    try {
      const r = apply(d.db, { registry: reg });
      assert.equal(r.exitCode, 3, r.message);
      assert.equal(userVersion(d.db), 2);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG22 orphan created under FK-off → foreign_key_check fails → exit 3, at k-1", () => {
    const reg = testRegistry([PARENT_CHILD, { id: 3, name: "0003_rebuild_drop_p2", sql: rebuild(" WHERE id <> 'p2'"), requiresForeignKeysOff: true, declaredRowCountChanges: ["a2_parent"] }]);
    const d = prepared(reg);
    try {
      const data = tableData(d.db);
      const r = apply(d.db, { registry: reg });
      assert.equal(r.exitCode, 3, r.message);
      assert.match(r.message, /foreign_key_check reported 1 violation/);
      assert.equal(userVersion(d.db), 2);
      assert.deepEqual(tableData(d.db), data);
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-3 test hooks are gated (T-MG32)", () => {
  it("setRunnerHooksForTests refuses outside test mode", () => {
    assert.throws(() => setRunnerHooksForTests({}, {}), ConfigError);
  });

  it("the fail hook works in test mode and is ignored outside test mode (in-process)", () => {
    const a = disposable();
    const b = disposable();
    try {
      assert.equal(apply(a.db, { env: { ...process.env, [TEST_ENV.failAt]: "before-commit" } }).exitCode, 3);
      const outside = { PATH: process.env.PATH, [TEST_ENV.failAt]: "before-commit", [TEST_ENV.crashAt]: "before-commit", [TEST_ENV.pauseInTxMs]: "60000" };
      const r = apply(b.db, { env: outside });
      assert.equal(r.exitCode, 0, r.message);
      assert.equal(r.outcome, "applied");
      assert.equal(runLogRecords(r)[0].testMode, false);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("in-process hooks registered in test mode do not run when apply is called with a non-test environment", () => {
    const d = disposable();
    try {
      let calls = 0;
      const restore = setRunnerHooksForTests({ afterStatus: () => calls++, inTransaction: () => calls++ });
      try {
        assert.equal(apply(d.db, { env: { PATH: process.env.PATH } }).exitCode, 0);
      } finally {
        restore();
      }
      assert.equal(calls, 0);
    } finally {
      d.cleanup();
    }
  });

  it("the crash hook is ignored in a child process outside test mode", () => {
    const d = disposable();
    try {
      const c = runChildSync(d.dir, d.db, false, { [TEST_ENV.crashAt]: "before-commit", [TEST_ENV.failAt]: "after-sql" });
      assert.equal(c.signal, null, c.stderr);
      assert.equal(c.status, 0, c.stderr);
      assert.equal(c.result?.outcome, "applied");
      assert.equal(userVersion(d.db), 1);
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-3 run log (T-MG33)", () => {
  it("every exit path writes start and end (exit code, states, fingerprints) and no row values", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL + ORG_ROW("o1"));
      const adopted = apply(d.db);
      assertLogged(adopted, 0);
      const recs = runLogRecords(adopted);
      const events = recs.map((x) => x.event);
      assert.deepEqual(events, ["start", "holders", "state_before", "lock", "migration_start", "migration_end", "state_after", "end"]);
      const sb = recs.find((x) => x.event === "state_before")!;
      assert.equal(sb.state, "LEGACY_BASELINE");
      assert.equal(sb.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(recs.find((x) => x.event === "migration_end")!.fingerprintAfter, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(recs.find((x) => x.event === "state_after")!.state, "MANAGED_CURRENT");
      for (const line of fs.readFileSync(adopted.runLogFile!, "utf8").trim().split("\n")) JSON.parse(line);
      const noop = apply(d.db);
      assertLogged(noop, 0);
      const bad = apply(d.db, { registry: buildRegistry([{ ...MIGRATIONS[0], name: "0001_other" }]) });
      assertLogged(bad, 2);
      const failing = apply(d.db, { registry: testRegistry([{ id: 2, name: "0002_insert_row", sql: ORG_ROW("x2"), requiresForeignKeysOff: false }]) });
      assertLogged(failing, 3);
      assert.equal(fs.statSync(adopted.runLogFile!).mode & 0o777, 0o600);
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-3 holder check (T-HC01, §F.4)", () => {
  it("T-HC01 a child process holding the disposable DB open → apply exits 2, nothing written", async () => {
    const d = disposable();
    let child: ChildProcess | null = null;
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const before = dbFiles(d.db);
      const code = `const D = require(${JSON.stringify(path.join(ROOT, "node_modules", "better-sqlite3"))}); const db = new D(process.argv[1], { readonly: true }); db.prepare("SELECT count(*) FROM sqlite_master").get(); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
      child = spawn(process.execPath, ["-e", code, d.db], { stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.on("data", (c) => String(c).includes("ready") && resolve());
        child!.on("exit", () => reject(new Error("holder child exited early")));
      });
      const hc = findHolders(d.db);
      assert.ok(hc.ok);
      assert.ok(hc.ok && hc.holders.some((h) => h.pid === child!.pid));
      const r = apply(d.db);
      assert.equal(r.exitCode, 2, r.message);
      assert.match(r.message, new RegExp(`held by pid ${child.pid}`));
      assert.equal(dbFiles(d.db), before);
      assertLogged(r, 2);
    } finally {
      if (child && child.exitCode === null) {
        const gone = new Promise((resolve) => child!.on("exit", resolve));
        child.kill("SIGTERM");
        await gone;
      }
      d.cleanup();
    }
    // after the holder exits, apply proceeds
    const e = disposable();
    try {
      createDbFile(e.db, SCHEMA_SQL);
      assert.equal(apply(e.db).exitCode, 0);
    } finally {
      e.cleanup();
    }
  });

  it("an unreadable /proc fails closed (exit 2)", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const before = dbFiles(d.db);
      const r = apply(d.db, { procRoot: path.join(d.dir, "no-proc") });
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /PROC_UNREADABLE/);
      assert.equal(dbFiles(d.db), before);
      const empty = path.join(d.dir, "empty-proc");
      fs.mkdirSync(empty);
      assert.equal(findHolders(d.db, { procRoot: empty }).ok, false);
    } finally {
      d.cleanup();
    }
  });

  it("the holder check finds descriptors by device and inode (a renamed path still matches)", async () => {
    const d = disposable();
    let child: ChildProcess | null = null;
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const code = `const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
      child = spawn(process.execPath, ["-e", code, d.db], { stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve) => child!.stdout!.on("data", (c) => String(c).includes("ready") && resolve()));
      const alias = path.join(d.dir, "alias.db");
      fs.renameSync(d.db, alias);
      const hc = findHolders(alias);
      assert.ok(hc.ok && hc.holders.some((h) => h.pid === child!.pid));
    } finally {
      if (child && child.exitCode === null) {
        const gone = new Promise((resolve) => child!.on("exit", resolve));
        child.kill("SIGTERM");
        await gone;
      }
      d.cleanup();
    }
  });
});
