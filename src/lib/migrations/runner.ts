import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigError, classifyDisposableDbPath, isTestMode } from "../config";
import { fingerprintV1, HISTORY_TABLE, structuralV1 } from "./fingerprint";
import { findHolders, formatHolders } from "./holders";
import { MIGRATIONS, registryView, type RegistryEntry } from "./registry";
import { RunLog, interruptedRuns, type InterruptedRun } from "./runlog";
import { EXIT, guardedSnapshotRead } from "./snapshot-read";
import { CHECKSUM_ALG_V1, HISTORY_TABLE_SQL, detectState, snapshotStatus, statusFromOutcome, type RegistryView, type SchemaState, type StatusResult } from "./state";

/**
 * Migration runner (`apply`), Workshop 5B §C.3 and §F. Disposable databases only in A2-impl.
 *
 * Order: path guard → holder check → snapshot-read status → read-write open
 * (foreign_keys=ON, busy_timeout) → per migration: [FK-off outside the
 * transaction] → BEGIN IMMEDIATE → re-detect state inside the lock →
 * migration SQL (or adoption) → pre-commit checks → history row and
 * user_version → COMMIT → [FK on, asserted] → post-commit snapshot-read status
 * (must be MANAGED_CURRENT). journal_mode is never changed. No resume, no
 * repair, no force.
 */

export const RUNNER_VERSION = "stweg-migrate-runner-1";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const RUN_LOG_DIR_NAME = "migrate-runlogs";

export type ApplyExitCode = 0 | 1 | 2 | 3 | 4 | 6;

export interface ApplyOptions {
  dbPath: string;
  cwd?: string;
  /** directory for the JSONL run log; default <dir of the database>/migrate-runlogs (inside the marked dir) */
  runLogDir?: string;
  /** test registries only; the CLI always uses MIGRATIONS */
  registry?: readonly RegistryEntry[];
  busyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  gitCommit?: string | null;
  /** holder-check /proc root; tests only */
  procRoot?: string;
}

export interface AppliedMigration {
  id: number;
  name: string;
  kind: "applied" | "baselined";
  durationMs: number;
}

export interface ApplyResult {
  exitCode: ApplyExitCode;
  outcome: "applied" | "noop" | "refused" | "busy" | "rolled_back" | "post_commit_failed" | "undeterminable" | "error";
  message: string;
  stateBefore: SchemaState | null;
  stateAfter: SchemaState | null;
  applied: AppliedMigration[];
  runLogFile: string | null;
}

// ---------------------------------------------------------------------------------------------
// Test hooks (all gated on test mode; ignored otherwise, T-MG32)
// ---------------------------------------------------------------------------------------------

export type HookPoint = "after-sql" | "before-commit" | "after-commit";
const HOOK_POINTS: ReadonlySet<string> = new Set(["after-sql", "before-commit", "after-commit"]);

/** Environment hooks used by child-process tests. Read only when isTestMode(env). */
export const TEST_ENV = {
  crashAt: "STWEG_MIGRATE_TEST_CRASH_AT",
  failAt: "STWEG_MIGRATE_TEST_FAIL_AT",
  pauseInTxMs: "STWEG_MIGRATE_TEST_PAUSE_IN_TX_MS",
  lockedMarker: "STWEG_MIGRATE_TEST_LOCKED_MARKER",
} as const;

export interface RunnerTestHooks {
  /** after the snapshot-read status, before the read-write open */
  afterStatus?: () => void;
  /** inside the transaction after the migration SQL (sees the runner's connection) */
  inTransaction?: (db: Database.Database, migrationId: number) => void;
}
let hooks: RunnerTestHooks = {};

export function setRunnerHooksForTests(next: RunnerTestHooks | null, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!isTestMode(env)) throw new ConfigError("setRunnerHooksForTests is only available in test mode.");
  const previous = hooks;
  hooks = next ?? {};
  return () => {
    hooks = previous;
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class InjectedFailure extends Error {}

function envHook(env: NodeJS.ProcessEnv, testMode: boolean, point: HookPoint): void {
  if (!testMode) return;
  if (env[TEST_ENV.failAt] === point) throw new InjectedFailure(`injected failure at ${point} (test hook)`);
  if (env[TEST_ENV.crashAt] === point) process.kill(process.pid, "SIGKILL");
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function tableCounts(db: Database.Database): Map<string, number> {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> ? ORDER BY name")
    .pluck()
    .all(HISTORY_TABLE) as string[];
  const out = new Map<string, number>();
  for (const n of names) out.set(n, Number(db.prepare(`SELECT count(*) FROM "${n.replace(/"/g, '""')}"`).pluck().get()));
  return out;
}

function rowCountProblems(before: Map<string, number>, after: Map<string, number>, declared: readonly string[]): string[] {
  const allowed = new Set(declared);
  const problems: string[] = [];
  for (const [t, n] of before) {
    if (allowed.has(t)) continue;
    if (!after.has(t)) problems.push(`table ${t} disappeared`);
    else if (after.get(t) !== n) problems.push(`row count of ${t} changed`);
  }
  for (const [t, n] of after) if (!before.has(t) && n !== 0 && !allowed.has(t)) problems.push(`new table ${t} has rows`);
  return problems;
}

function sameIdentity(file: string, dev: string, ino: string): boolean {
  try {
    const st = fs.statSync(file, { bigint: true });
    return String(st.dev) === dev && String(st.ino) === ino && st.isFile();
  } catch {
    return false;
  }
}

function stateSummary(r: StatusResult) {
  if (!r.ok) return { ok: false, code: r.code, exitCode: r.exitCode };
  return {
    ok: true,
    state: r.state,
    read: r.read,
    sha256: r.sha256,
    fingerprint: r.report?.fingerprint ?? null,
    structural: r.report?.structural ?? null,
    userVersion: r.report?.userVersion ?? 0,
    history: r.report?.history.map((h) => `${h.id}:${h.name}:${h.kind}`) ?? [],
    reasons: r.report?.reasons ?? [],
  };
}

const APPLY_STATES: ReadonlySet<SchemaState> = new Set(["EMPTY", "LEGACY_BASELINE", "MANAGED_PENDING", "MANAGED_CURRENT"]);

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

export function applyMigrations(options: ApplyOptions): ApplyResult {
  const env = options.env ?? process.env;
  const testMode = isTestMode(env);
  const cwd = options.cwd ?? process.cwd();
  const dbPath = path.resolve(cwd, options.dbPath);
  const entries = options.registry ?? MIGRATIONS;
  const view: RegistryView = registryView(entries);
  const head = entries.length;
  const result: ApplyResult = { exitCode: 1, outcome: "error", message: "", stateBefore: null, stateAfter: null, applied: [], runLogFile: null };

  // 1. path guard. Nothing is written anywhere when it refuses (no run log next to a refused path).
  const guard = classifyDisposableDbPath(dbPath, cwd);
  if (!guard.ok) {
    return { ...result, exitCode: EXIT.REFUSED, outcome: "refused", message: `refused: the database path ${guard.message}. Only marked disposable databases are allowed in A2-impl.` };
  }

  const log = RunLog.create(options.runLogDir ?? path.join(path.dirname(dbPath), RUN_LOG_DIR_NAME));
  result.runLogFile = log.file;
  const finish = (r: Partial<ApplyResult> & Pick<ApplyResult, "exitCode" | "outcome" | "message">): ApplyResult => {
    Object.assign(result, r);
    log.write("end", { exitCode: result.exitCode, outcome: result.outcome, message: result.message, applied: result.applied.map((a) => `${a.id}:${a.name}:${a.kind}`) });
    return result;
  };
  log.write("start", { dbPath, runnerVersion: RUNNER_VERSION, registryHead: head, pid: process.pid, testMode });

  try {
    // 2. holder check
    const holders = findHolders(dbPath, { procRoot: options.procRoot });
    log.write("holders", holders.ok ? { ok: true, holders: holders.holders.map((h) => ({ pid: h.pid, comm: h.comm, file: path.basename(h.target) })), scanned: holders.scanned, uninspectable: holders.uninspectable } : { ok: false, code: holders.code });
    if (!holders.ok || holders.holders.length > 0) {
      return finish({ exitCode: EXIT.REFUSED, outcome: "refused", message: `refused: ${formatHolders(holders)}` });
    }

    // 3. snapshot-read status (never opens the file with SQLite)
    const outcome = guardedSnapshotRead(dbPath, cwd);
    const before = statusFromOutcome(outcome, view);
    log.write("state_before", stateSummary(before));
    if (!before.ok) {
      return finish({ exitCode: before.exitCode, outcome: before.exitCode === EXIT.UNDETERMINABLE ? "undeterminable" : "refused", message: `refused: ${before.code}: ${before.message}` });
    }
    result.stateBefore = before.state;
    if (!APPLY_STATES.has(before.state)) {
      return finish({ exitCode: EXIT.REFUSED, outcome: "refused", message: `refused: state ${before.state}: ${(before.report?.reasons ?? []).join("; ")}` });
    }
    if (before.state === "MANAGED_CURRENT") {
      result.stateAfter = "MANAGED_CURRENT";
      return finish({ exitCode: EXIT.OK, outcome: "noop", message: "no-op: the database is already at the registry head" });
    }
    if (testMode) hooks.afterStatus?.();

    // 4. read-write open
    let db: Database.Database;
    try {
      db = new Database(dbPath, { fileMustExist: outcome.kind === "bytes" || (outcome.kind === "empty" && outcome.reason === "zero-bytes"), timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    } catch (error) {
      return finish({ exitCode: EXIT.USAGE, outcome: "error", message: `cannot open the database read-write: ${(error as Error).message}` });
    }
    let applyResult: ApplyResult | null = null;
    try {
      if (outcome.kind === "bytes" && !sameIdentity(dbPath, outcome.identity.dev, outcome.identity.ino)) {
        return finish({ exitCode: EXIT.REFUSED, outcome: "refused", message: "refused: the database file was replaced between the status read and the read-write open" });
      }
      db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
      db.pragma("foreign_keys = ON");
      if (Number(db.pragma("foreign_keys", { simple: true })) !== 1) {
        return finish({ exitCode: EXIT.USAGE, outcome: "error", message: "foreign_keys could not be enabled" });
      }
      applyResult = applyPending(db, { entries, view, head, env, testMode, log, options, result, finish });
    } finally {
      try {
        db.close();
      } catch {
        // already closed or never usable; the post-commit check below decides
      }
    }
    if (applyResult) return applyResult;

    // 8. post-commit snapshot-read status must be MANAGED_CURRENT
    const after = snapshotStatus(dbPath, view, cwd);
    log.write("state_after", stateSummary(after));
    result.stateAfter = after.ok ? after.state : null;
    if (!after.ok || after.state !== "MANAGED_CURRENT") {
      return finish({ exitCode: EXIT.POST_COMMIT_FAILED, outcome: "post_commit_failed", message: `post-commit verification failed: ${after.ok ? after.state : `${after.code}: ${after.message}`}. Restore from the verified backup.` });
    }
    const did = result.applied.length > 0;
    return finish({ exitCode: EXIT.OK, outcome: did ? "applied" : "noop", message: did ? `applied ${result.applied.map((a) => `${a.name} (${a.kind})`).join(", ")}` : "no-op: another runner brought the database to the registry head" });
  } catch (error) {
    return finish({ exitCode: EXIT.USAGE, outcome: "error", message: `unexpected error: ${(error as Error).message}` });
  }
}

interface PendingContext {
  entries: readonly RegistryEntry[];
  view: RegistryView;
  head: number;
  env: NodeJS.ProcessEnv;
  testMode: boolean;
  log: RunLog;
  options: ApplyOptions;
  result: ApplyResult;
  finish: (r: Partial<ApplyResult> & Pick<ApplyResult, "exitCode" | "outcome" | "message">) => ApplyResult;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  return code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code === "SQLITE_LOCKED";
}

/** Steps 5–7 for every pending migration. Returns a final result on failure or no-op, null when all committed. */
function applyPending(db: Database.Database, ctx: PendingContext): ApplyResult | null {
  const { entries, view, head, env, testMode, log, options, result, finish } = ctx;
  for (;;) {
    // Determine the next migration from a quick read; the authoritative check is inside the lock.
    const probe = detectState(db, view);
    if (probe.state === "MANAGED_CURRENT") return null;
    const next = probe.state === "MANAGED_PENDING" ? probe.history.length + 1 : 1;
    const adopt = probe.state === "LEGACY_BASELINE";
    if (!(probe.state === "EMPTY" || adopt || probe.state === "MANAGED_PENDING")) {
      return finish({ exitCode: EXIT.REFUSED, outcome: "refused", message: `refused: state ${probe.state}: ${probe.reasons.join("; ")}` });
    }
    const entry = entries[next - 1];
    if (!entry || next > head) return finish({ exitCode: EXIT.USAGE, outcome: "error", message: `no registry entry ${next}` });

    const fkOff = entry.requiresForeignKeysOff && !adopt;
    if (fkOff) {
      db.pragma("foreign_keys = OFF"); // outside the transaction: inside it is a silent no-op
      if (Number(db.pragma("foreign_keys", { simple: true })) !== 0) return finish({ exitCode: EXIT.USAGE, outcome: "error", message: "foreign_keys could not be disabled for an FK-off migration" });
    }
    const t0 = process.hrtime.bigint();
    let committed = false;
    let early: ApplyResult | null = null;
    try {
      // 5. lock
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusy(error)) {
          early = finish({ exitCode: EXIT.USAGE, outcome: "busy", message: "database busy: the write lock was not obtained within the busy timeout; nothing was written" });
          return early;
        }
        throw error;
      }
      log.write("lock", { id: entry.id });
      if (testMode) {
        const marker = env[TEST_ENV.lockedMarker];
        if (marker) fs.writeFileSync(marker, String(process.pid));
        const pause = Number(env[TEST_ENV.pauseInTxMs] ?? 0);
        if (pause > 0) sleepSync(pause);
      }
      try {
        // 6. re-detect inside the lock
        const inLock = detectState(db, view);
        if (inLock.state === "MANAGED_CURRENT") {
          db.exec("ROLLBACK");
          early = null;
          return null; // another runner finished; post-commit status confirms
        }
        const expectedState: SchemaState = adopt ? "LEGACY_BASELINE" : next === 1 ? "EMPTY" : "MANAGED_PENDING";
        if (inLock.state !== expectedState || (expectedState === "MANAGED_PENDING" && inLock.history.length !== next - 1)) {
          db.exec("ROLLBACK");
          early = finish({ exitCode: EXIT.REFUSED, outcome: "refused", message: `refused: state changed before the lock (expected ${expectedState} at ${next - 1}, found ${inLock.state})` });
          return early;
        }
        log.write("migration_start", { id: entry.id, name: entry.name, kind: adopt ? "baselined" : "applied", fkOff });
        const countsBefore = tableCounts(db);

        // 7. adopt or apply
        if (!adopt) db.exec(entry.sql);
        if (next === 1) db.exec(HISTORY_TABLE_SQL);
        envHook(env, testMode, "after-sql");
        if (testMode) hooks.inTransaction?.(db, entry.id);

        // pre-commit checks
        const problems: string[] = [];
        const fkRows = (db.pragma("foreign_key_check") as unknown[]).length;
        if (fkRows) problems.push(`foreign_key_check reported ${fkRows} violation(s)`);
        const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
        if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") problems.push("integrity_check is not ok");
        const fp = fingerprintV1(db).sha256;
        const st = structuralV1(db).sha256;
        const expected = view.expectedAfter(entry.id);
        if (fp !== expected.fingerprint) problems.push(`fingerprint after ${entry.name} differs from the expected value`);
        if (st !== expected.structural) problems.push(`structural snapshot after ${entry.name} differs from the expected value`);
        problems.push(...rowCountProblems(countsBefore, tableCounts(db), adopt ? [] : (entry.declaredRowCountChanges ?? [])));
        if (problems.length) throw new Error(`pre-commit verification failed: ${problems.join("; ")}`);

        const durationMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
        db.prepare(
          `INSERT INTO ${HISTORY_TABLE} (id, name, checksum, checksum_alg, kind, applied_at, app_version, git_commit, runner_version, sqlite_version, duration_ms, fingerprint_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.id,
          entry.name,
          entry.checksum,
          CHECKSUM_ALG_V1,
          adopt ? "baselined" : "applied",
          new Date().toISOString(),
          options.appVersion ?? env.npm_package_version ?? "unknown",
          options.gitCommit ?? env.STWEG_GIT_COMMIT ?? null,
          RUNNER_VERSION,
          String(db.prepare("SELECT sqlite_version()").pluck().get()),
          durationMs,
          fp,
        );
        db.pragma(`user_version = ${entry.id}`);
        const final = detectState(db, view);
        const ok = entry.id === head ? final.state === "MANAGED_CURRENT" : final.state === "MANAGED_PENDING" && final.history.length === entry.id;
        if (!ok) throw new Error(`pre-commit verification failed: state after recording would be ${final.state}`);
        envHook(env, testMode, "before-commit");
        db.exec("COMMIT");
        committed = true;
        envHook(env, testMode, "after-commit");
        result.applied.push({ id: entry.id, name: entry.name, kind: adopt ? "baselined" : "applied", durationMs });
        log.write("migration_end", { id: entry.id, name: entry.name, durationMs, fingerprintAfter: fp });
      } catch (error) {
        if (!committed) {
          try {
            if (db.inTransaction) db.exec("ROLLBACK");
          } catch {
            // the connection is closed by the caller; SQLite rolls back on close
          }
          log.write("rolled_back", { id: entry.id, name: entry.name, error: (error as Error).message });
          early = finish({ exitCode: EXIT.ROLLED_BACK, outcome: "rolled_back", message: `${entry.name} failed and was rolled back: ${(error as Error).message}` });
          return early;
        }
        throw error;
      }
    } finally {
      if (fkOff) {
        try {
          db.pragma("foreign_keys = ON");
        } catch {
          // checked below
        }
        let on = false;
        try {
          on = Number(db.pragma("foreign_keys", { simple: true })) === 1;
        } catch {
          on = false;
        }
        if (!on) {
          try {
            db.close();
          } catch {
            // ignore
          }
          if (!early) early = finish({ exitCode: EXIT.USAGE, outcome: "error", message: "foreign_keys could not be re-enabled after an FK-off migration; connection closed" });
          // eslint-disable-next-line no-unsafe-finally
          return early;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// status with run-log analysis (T-CR01)
// ---------------------------------------------------------------------------------------------

export interface StatusWithRunLog {
  status: StatusResult;
  interrupted: Array<InterruptedRun & { assessment: string }>;
}

/** Snapshot-read status plus interrupted runs from the run log (read-only). */
export function statusWithRunLog(dbPath: string, options: { cwd?: string; runLogDir?: string; registry?: readonly RegistryEntry[] } = {}): StatusWithRunLog {
  const cwd = options.cwd ?? process.cwd();
  const abs = path.resolve(cwd, dbPath);
  const view = registryView(options.registry ?? MIGRATIONS);
  const status = snapshotStatus(abs, view, cwd);
  if (!status.ok && status.code === "PATH_REFUSED") return { status, interrupted: [] };
  const dir = options.runLogDir ?? path.join(path.dirname(abs), RUN_LOG_DIR_NAME);
  const version = status.ok ? (status.report?.history.length ?? 0) : null;
  const interrupted = interruptedRuns(dir, abs).map((run) => {
    let assessment: string;
    const open = run.openMigrations[run.openMigrations.length - 1];
    if (version === null) assessment = "interrupted; the current version cannot be determined (see status)";
    else if (!open) assessment = `interrupted outside a migration; database consistent at version ${version}`;
    else if (version >= open.id) assessment = `interrupted after commit of ${open.name}; database consistent at version ${version}`;
    else assessment = `interrupted during ${open.name} (rolled back); database consistent at version ${version}`;
    return { ...run, assessment };
  });
  return { status, interrupted };
}
