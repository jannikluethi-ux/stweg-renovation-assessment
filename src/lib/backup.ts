import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigError, HARNESS_MARKER, canonicalPath, classifyDisposableDbPath, classifyDisposablePath, isInside, isTestMode } from "./config";
import { findHolders, formatHolders } from "./migrations/holders";
import { MIGRATIONS, registryView } from "./migrations/registry";
import { RUNNER_VERSION } from "./migrations/runner";
import { EXIT } from "./migrations/snapshot-read";
import { STATUS_OK_STATES, detectState, snapshotStatus, type SchemaState } from "./migrations/state";
import { compareUploadTrees, sha256OfFile, uploadsTree, verifyReferences, type ReferenceVerification, type UploadsTree } from "./uploads-manifest";

/**
 * Backup, backup verification and restore (Workshop 5B §G.1–§G.4).
 * A2-impl: marked disposable sources, targets and backup roots only.
 *
 * Invariants:
 *   - The source is never written: no checkpoint, no SQLite open, no
 *     pragma. It is read with O_RDONLY (hash, copy) only.
 *   - Every SQLite open happens on a further copy inside <backup>/work or a
 *     check directory, never on an artifact or the source.
 *   - Nothing is ever deleted. A restore moves existing target files into
 *     data-quarantine-<ts>/ (D-13). A -journal at the source or target is
 *     refused (JOURNAL_PRESENT) and never moved, deleted or rewritten.
 *   - The O-4 real backup location is refused in A2-impl (A2-apply only).
 */

export const BACKUP_TOOL_VERSION = "stweg-backup-1";
export const MANIFEST_FORMAT = "stweg-backup-manifest-1";
/** O-4 real backup location; reserved for A2-apply (separately authorized). Refused here. */
export const O4_REAL_BACKUP_ROOT = "/home/box/stweg-backups";
export const COLD_DB = "stweg.db";

export type BackupExitCode = 0 | 1 | 2 | 5;

export interface FileState {
  exists: boolean;
  kind: "file" | "symlink" | "other" | "absent";
  sha256: string | null;
  size: string | null;
  mtimeNs: string | null;
  ctimeNs: string | null;
  ino: string | null;
  dev: string | null;
  nlink: string | null;
}

export interface DbChecks {
  integrity: string;
  foreignKeyViolations: number;
  state: string;
  fingerprint: string | null;
  structural: string | null;
  userVersion: number;
  applicationId: number;
  history: string[];
  counts: Record<string, number>;
  sqliteVersion: string;
}

export interface BackupManifest {
  format: string;
  tool: string;
  runner: string;
  verified: boolean;
  createdAtUtc: string;
  createdAtLocal: string;
  source: { dbPath: string; uploadsDir: string; pre: Record<string, FileState>; post: Record<string, FileState> };
  artifacts: { cold: Record<string, { sha256: string; size: number }>; shmEvidence: { sha256: string; size: number } | null; logical: { sha256: string; size: number } | null };
  versions: { sqlite: string | null; node: string; appCommit: string | null };
  checks: { coldDerived: DbChecks | null; logical: DbChecks | null; countsEqual: boolean; artifactsUnchanged: boolean };
  uploads: { source: UploadsTree; backupProblems: string[]; sourceAfterProblems: string[]; references: ReferenceVerification | null; referencesAgainstSource: { ok: boolean; problems: string[] } | null };
  durationsMs: Record<string, number>;
  problems: string[];
}

export interface BackupResult {
  exitCode: BackupExitCode;
  message: string;
  backupDir: string | null;
  manifest: BackupManifest | null;
}

// ---------------------------------------------------------------------------------------------
// Test hooks (test mode only)
// ---------------------------------------------------------------------------------------------

export interface BackupTestHooks {
  afterPreState?: () => void;
  afterColdCopy?: () => void;
}
let hooks: BackupTestHooks = {};
export function setBackupHooksForTests(next: BackupTestHooks | null, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!isTestMode(env)) throw new ConfigError("setBackupHooksForTests is only available in test mode.");
  const previous = hooks;
  hooks = next ?? {};
  return () => {
    hooks = previous;
  };
}
function hook(name: keyof BackupTestHooks): void {
  if (isTestMode()) hooks[name]?.();
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

export function fileState(file: string): FileState {
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, kind: "absent", sha256: null, size: null, mtimeNs: null, ctimeNs: null, ino: null, dev: null, nlink: null };
    throw error;
  }
  const kind = st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other";
  return {
    exists: true,
    kind,
    sha256: kind === "file" ? sha256OfFile(file) : null,
    size: String(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    ino: String(st.ino),
    dev: String(st.dev),
    nlink: String(st.nlink),
  };
}

const sameState = (a: FileState, b: FileState) => JSON.stringify(a) === JSON.stringify(b);

function isO4Location(p: string): boolean {
  const lexical = path.resolve(p);
  const o4 = path.resolve(O4_REAL_BACKUP_ROOT);
  if (lexical === o4 || isInside(lexical, o4)) return true;
  const canon = canonicalPath(p);
  return canon === o4 || isInside(canon, o4);
}

type Guard = { ok: true } | { ok: false; message: string };

/** Guard for directories used by backup/verify/restore: marked disposable, not protected, not the O-4 location. */
export function guardDir(label: string, p: string, cwd: string): Guard {
  if (isO4Location(p)) return { ok: false, message: `refused: the ${label} is the O-4 real backup location, which is reserved for A2-apply (separately authorized)` };
  const c = classifyDisposablePath(p, cwd);
  return c.ok ? { ok: true } : { ok: false, message: `refused: the ${label} ${c.message}. Only marked disposable paths are allowed in A2-impl.` };
}

export function guardDb(label: string, p: string, cwd: string): Guard {
  if (isO4Location(p)) return { ok: false, message: `refused: the ${label} is inside the O-4 real backup location` };
  const c = classifyDisposableDbPath(p, cwd);
  return c.ok ? { ok: true } : { ok: false, message: `refused: the ${label} ${c.message}. Only marked disposable databases are allowed in A2-impl.` };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function tableCounts(db: Database.Database): Record<string, number> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").pluck().all() as string[];
  const out: Record<string, number> = {};
  for (const n of names) out[n] = Number(db.prepare(`SELECT count(*) FROM "${n.replace(/"/g, '""')}"`).pluck().get());
  return out;
}

/** Checks on an open connection to a disposable copy. Names, hashes and counts only. */
export function runDbChecks(db: Database.Database): DbChecks {
  const integrityRows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  const integrity = integrityRows.length === 1 ? integrityRows[0].integrity_check : `${integrityRows.length} problems`;
  const fk = db.pragma("foreign_key_check") as unknown[];
  const report = detectState(db, registryView(MIGRATIONS));
  return {
    integrity,
    foreignKeyViolations: fk.length,
    state: report.state,
    fingerprint: report.fingerprint ?? null,
    structural: report.structural ?? null,
    userVersion: report.userVersion,
    applicationId: report.applicationId,
    history: report.history.map((h) => `${h.id}:${h.name}:${h.kind}:${h.checksum}`),
    counts: tableCounts(db),
    sqliteVersion: String(db.prepare("SELECT sqlite_version()").pluck().get()),
  };
}

function checkProblems(label: string, c: DbChecks): string[] {
  const p: string[] = [];
  if (c.integrity !== "ok") p.push(`${label}: integrity_check is not ok`);
  if (c.foreignKeyViolations !== 0) p.push(`${label}: foreign_key_check reports ${c.foreignKeyViolations} violation(s)`);
  if (!STATUS_OK_STATES.has(c.state as SchemaState)) p.push(`${label}: schema state ${c.state}`);
  return p;
}

function makeMarkedDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(dir, HARNESS_MARKER), "stweg-backup-work", { mode: 0o600, flag: "wx" });
}

function copyExclusive(from: string, to: string): void {
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

/** Copies a cold set into dir and opens it normally there (a non-empty -wal is replayed inside the copy only). */
function openColdCopy(coldDir: string, dir: string, hasWal: boolean): Database.Database {
  fs.mkdirSync(dir, { mode: 0o700 });
  copyExclusive(path.join(coldDir, COLD_DB), path.join(dir, COLD_DB));
  if (hasWal) copyExclusive(path.join(coldDir, `${COLD_DB}-wal`), path.join(dir, `${COLD_DB}-wal`));
  return new Database(path.join(dir, COLD_DB), { fileMustExist: true });
}

function openPlainCopy(file: string, dir: string): Database.Database {
  fs.mkdirSync(dir, { mode: 0o700 });
  copyExclusive(file, path.join(dir, COLD_DB));
  return new Database(path.join(dir, COLD_DB), { fileMustExist: true, readonly: true });
}

function writeJsonExclusive(file: string, data: unknown): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sourceStates(dbPath: string): Record<string, FileState> {
  return { main: fileState(dbPath), wal: fileState(`${dbPath}-wal`), shm: fileState(`${dbPath}-shm`), journal: fileState(`${dbPath}-journal`) };
}

// ---------------------------------------------------------------------------------------------
// backup (§G.1, §G.3)
// ---------------------------------------------------------------------------------------------

export interface BackupOptions {
  dbPath: string;
  uploadsDir: string;
  backupRoot: string;
  cwd?: string;
  procRoot?: string;
  appCommit?: string | null;
  now?: Date;
}

export function createBackup(options: BackupOptions): BackupResult {
  const cwd = options.cwd ?? process.cwd();
  const dbPath = path.resolve(cwd, options.dbPath);
  const uploadsDir = path.resolve(cwd, options.uploadsDir);
  const backupRoot = path.resolve(cwd, options.backupRoot);
  const refused = (message: string): BackupResult => ({ exitCode: EXIT.REFUSED, message, backupDir: null, manifest: null });

  // 1. guards: nothing is read before every path passes
  for (const g of [guardDb("source database", dbPath, cwd), guardDir("uploads directory", uploadsDir, cwd), guardDir("backup root", backupRoot, cwd)]) if (!g.ok) return refused(g.message);
  const canonRoot = canonicalPath(backupRoot);
  const canonUploads = canonicalPath(uploadsDir);
  if (canonRoot === canonUploads || isInside(canonRoot, canonUploads) || isInside(canonUploads, canonRoot)) return refused("refused: the backup root and the uploads directory must not contain each other");

  // 2. holder check (app stopped)
  const holders = findHolders(dbPath, { procRoot: options.procRoot });
  if (!holders.ok || holders.holders.length > 0) return refused(`refused: ${formatHolders(holders)}`);

  // 3. pre-state manifest of the source (no checkpoint, no SQLite open)
  const t0 = Date.now();
  const durations: Record<string, number> = {};
  const journal = fileState(`${dbPath}-journal`);
  if (journal.exists) return refused("refused: JOURNAL_PRESENT: a -journal exists next to the source database; it is never opened, moved or deleted. Operator-directed recovery is required (§F.3a)");
  const pre = sourceStates(dbPath);
  if (!pre.main.exists) return refused("refused: the source database does not exist");
  for (const [k, s] of Object.entries(pre)) if (s.exists && s.kind !== "file") return refused(`refused: the source ${k} file is not a regular file`);
  let sourceTree: UploadsTree;
  try {
    sourceTree = uploadsTree(uploadsDir);
  } catch (error) {
    return refused(`refused: the uploads directory cannot be read: ${(error as Error).message}`);
  }
  durations.preState = Date.now() - t0;
  hook("afterPreState");

  // 4. backup directory
  const now = options.now ?? new Date();
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupDir = path.join(backupRoot, stamp(now));
  try {
    fs.mkdirSync(backupDir, { mode: 0o700 });
  } catch (error) {
    return { exitCode: EXIT.USAGE, message: `error: cannot create the backup directory: ${(error as NodeJS.ErrnoException).code ?? "error"}`, backupDir: null, manifest: null };
  }

  const problems: string[] = [];
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    tool: BACKUP_TOOL_VERSION,
    runner: RUNNER_VERSION,
    verified: false,
    createdAtUtc: now.toISOString(),
    createdAtLocal: now.toString(),
    source: { dbPath, uploadsDir, pre, post: {} },
    artifacts: { cold: {}, shmEvidence: null, logical: null },
    versions: { sqlite: null, node: process.version, appCommit: options.appCommit ?? null },
    checks: { coldDerived: null, logical: null, countsEqual: false, artifactsUnchanged: false },
    uploads: { source: sourceTree, backupProblems: [], sourceAfterProblems: [], references: null, referencesAgainstSource: null },
    durationsMs: durations,
    problems,
  };

  try {
    // 4. cold copy (restore artifact)
    let t = Date.now();
    const coldDir = path.join(backupDir, "cold");
    fs.mkdirSync(coldDir, { mode: 0o700 });
    const hasWal = pre.wal.exists;
    copyExclusive(dbPath, path.join(coldDir, COLD_DB));
    if (hasWal) copyExclusive(`${dbPath}-wal`, path.join(coldDir, `${COLD_DB}-wal`));
    if (pre.shm.exists) {
      fs.mkdirSync(path.join(backupDir, "shm-evidence"), { mode: 0o700 });
      copyExclusive(`${dbPath}-shm`, path.join(backupDir, "shm-evidence", `${COLD_DB}-shm`));
      const s = fileState(path.join(backupDir, "shm-evidence", `${COLD_DB}-shm`));
      manifest.artifacts.shmEvidence = { sha256: s.sha256!, size: Number(s.size) };
    }
    hook("afterColdCopy");
    for (const [name, src] of [[COLD_DB, pre.main], ...(hasWal ? [[`${COLD_DB}-wal`, pre.wal] as const] : [])] as Array<[string, FileState]>) {
      const c = fileState(path.join(coldDir, name));
      manifest.artifacts.cold[name] = { sha256: c.sha256!, size: Number(c.size) };
      if (c.sha256 !== src.sha256) problems.push(`cold copy ${name} differs from the source pre-state`);
    }
    const post = sourceStates(dbPath);
    manifest.source.post = post;
    for (const k of ["main", "wal", "shm", "journal"]) if (!sameState(pre[k], post[k])) problems.push(`source ${k} changed during the backup`);
    durations.coldCopy = Date.now() - t;

    // 5./6. verification copies (work/ is a marked disposable dir inside the backup)
    t = Date.now();
    const work = path.join(backupDir, "work");
    makeMarkedDir(work);
    const logicalDir = path.join(backupDir, "logical");
    fs.mkdirSync(logicalDir, { mode: 0o700 });
    const logicalFile = path.join(logicalDir, COLD_DB);
    const coldDb = openColdCopy(coldDir, path.join(work, "cold-derived"), hasWal);
    try {
      manifest.checks.coldDerived = runDbChecks(coldDb);
      coldDb.prepare("VACUUM INTO ?").run(logicalFile);
    } finally {
      coldDb.close();
    }
    const ls = fileState(logicalFile);
    manifest.artifacts.logical = { sha256: ls.sha256!, size: Number(ls.size) };
    const logicalDb = openPlainCopy(logicalFile, path.join(work, "logical-check"));
    try {
      manifest.checks.logical = runDbChecks(logicalDb);
      manifest.versions.sqlite = manifest.checks.logical.sqliteVersion;
      // 7. uploads copy, then reference verification (§G.3) against the backup copy and the source
      if (sourceTree.exists) {
        fs.cpSync(uploadsDir, path.join(backupDir, "uploads"), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      }
      const backupTree = sourceTree.exists ? uploadsTree(path.join(backupDir, "uploads")) : { root: path.join(backupDir, "uploads"), exists: false, entries: [] };
      manifest.uploads.backupProblems = compareUploadTrees(sourceTree, backupTree);
      manifest.uploads.sourceAfterProblems = compareUploadTrees(sourceTree, uploadsTree(uploadsDir));
      manifest.uploads.references = verifyReferences(logicalDb, path.join(backupDir, "uploads"), backupTree);
      const againstSource = verifyReferences(logicalDb, uploadsDir, sourceTree);
      manifest.uploads.referencesAgainstSource = { ok: againstSource.ok, problems: againstSource.problems };
    } finally {
      logicalDb.close();
    }
    durations.verification = Date.now() - t;

    problems.push(...checkProblems("cold-derived copy", manifest.checks.coldDerived!), ...checkProblems("logical copy", manifest.checks.logical!));
    const a = manifest.checks.coldDerived!;
    const b = manifest.checks.logical!;
    manifest.checks.countsEqual = JSON.stringify(a.counts) === JSON.stringify(b.counts);
    if (!manifest.checks.countsEqual) problems.push("row counts differ between the cold-derived and the logical copy");
    if (a.fingerprint !== b.fingerprint || a.structural !== b.structural || a.state !== b.state || a.userVersion !== b.userVersion) problems.push("schema differs between the cold-derived and the logical copy");
    for (const p of manifest.uploads.backupProblems) problems.push(`uploads backup: ${p}`);
    for (const p of manifest.uploads.sourceAfterProblems) problems.push(`source uploads changed: ${p}`);
    for (const e of sourceTree.entries) if (e.kind === "other") problems.push(`uploads: unsupported file type: ${e.relpath}`);
    for (const p of manifest.uploads.references?.problems ?? []) problems.push(`reference: ${p}`);
    for (const p of manifest.uploads.referencesAgainstSource?.problems ?? []) problems.push(`reference (source): ${p}`);

    // artifacts unchanged by verification
    let unchanged = true;
    for (const [name, rec] of Object.entries(manifest.artifacts.cold)) if (fileState(path.join(coldDir, name)).sha256 !== rec.sha256) unchanged = false;
    if (fileState(logicalFile).sha256 !== manifest.artifacts.logical.sha256) unchanged = false;
    if (fs.existsSync(path.join(coldDir, `${COLD_DB}-shm`)) || fs.existsSync(path.join(coldDir, `${COLD_DB}-journal`))) unchanged = false;
    manifest.checks.artifactsUnchanged = unchanged;
    if (!unchanged) problems.push("an artifact changed during verification");
  } catch (error) {
    problems.push(`backup step failed: ${(error as Error).message}`);
  }

  manifest.verified = problems.length === 0;
  durations.total = Date.now() - t0;
  writeJsonExclusive(path.join(backupDir, "manifest.json"), manifest);
  return manifest.verified
    ? { exitCode: EXIT.OK, message: `backup verified: ${backupDir}`, backupDir, manifest }
    : { exitCode: EXIT.BACKUP_FAILED, message: `backup NOT verified (${problems.length} problem(s)): ${problems.join("; ")}`, backupDir, manifest };
}

// ---------------------------------------------------------------------------------------------
// verify an existing backup
// ---------------------------------------------------------------------------------------------

export interface VerifyResult {
  exitCode: BackupExitCode;
  message: string;
  problems: string[];
  reportFile: string | null;
}

export function readManifest(backupDir: string): BackupManifest | string {
  const file = path.join(backupDir, "manifest.json");
  const st = fileState(file);
  if (!st.exists) return "manifest.json is missing";
  if (st.kind !== "file") return "manifest.json is not a regular file";
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as BackupManifest;
    if (m.format !== MANIFEST_FORMAT) return "unknown manifest format";
    return m;
  } catch {
    return "manifest.json cannot be parsed";
  }
}

function artifactProblems(backupDir: string, m: BackupManifest): string[] {
  const problems: string[] = [];
  const coldDir = path.join(backupDir, "cold");
  if (!m.artifacts.cold[COLD_DB]) problems.push("manifest has no cold database artifact");
  for (const [name, rec] of Object.entries(m.artifacts.cold)) {
    const s = fileState(path.join(coldDir, name));
    if (s.kind !== "file") problems.push(`cold artifact ${name} is missing or not a regular file`);
    else if (s.sha256 !== rec.sha256 || Number(s.size) !== rec.size) problems.push(`cold artifact ${name} does not match the manifest`);
  }
  for (const extra of fs.existsSync(coldDir) ? fs.readdirSync(coldDir) : []) if (!(extra in m.artifacts.cold)) problems.push(`unexpected file in cold/: ${extra}`);
  if (m.artifacts.logical) {
    const s = fileState(path.join(backupDir, "logical", COLD_DB));
    if (s.kind !== "file" || s.sha256 !== m.artifacts.logical.sha256) problems.push("logical artifact does not match the manifest");
  } else problems.push("manifest has no logical artifact");
  return problems;
}

export function verifyBackup(options: { backupDir: string; cwd?: string; now?: Date }): VerifyResult {
  const cwd = options.cwd ?? process.cwd();
  const backupDir = path.resolve(cwd, options.backupDir);
  const g = guardDir("backup directory", backupDir, cwd);
  if (!g.ok) return { exitCode: EXIT.REFUSED, message: g.message, problems: [], reportFile: null };
  const m = readManifest(backupDir);
  if (typeof m === "string") return { exitCode: EXIT.BACKUP_FAILED, message: `backup NOT verified: ${m}`, problems: [m], reportFile: null };
  const problems: string[] = [];
  if (m.verified !== true) problems.push("the manifest records verified=false");
  problems.push(...artifactProblems(backupDir, m));
  const backupUploads = path.join(backupDir, "uploads");
  let tree: UploadsTree | null = null;
  try {
    tree = m.uploads.source.exists ? uploadsTree(backupUploads) : { root: backupUploads, exists: false, entries: [] };
    for (const p of compareUploadTrees(m.uploads.source, tree)) problems.push(`uploads backup: ${p}`);
  } catch (error) {
    problems.push(`uploads backup cannot be read: ${(error as Error).message}`);
  }
  if (problems.length === 0) {
    const work = path.join(backupDir, `reverify-${stamp(options.now ?? new Date())}`);
    try {
      makeMarkedDir(work);
      const hasWal = `${COLD_DB}-wal` in m.artifacts.cold;
      const cold = openColdCopy(path.join(backupDir, "cold"), path.join(work, "cold-derived"), hasWal);
      let a: DbChecks;
      try {
        a = runDbChecks(cold);
      } finally {
        cold.close();
      }
      const logical = openPlainCopy(path.join(backupDir, "logical", COLD_DB), path.join(work, "logical-check"));
      let b: DbChecks;
      try {
        b = runDbChecks(logical);
        const refs = verifyReferences(logical, backupUploads, tree!);
        for (const p of refs.problems) problems.push(`reference: ${p}`);
      } finally {
        logical.close();
      }
      problems.push(...checkProblems("cold-derived copy", a), ...checkProblems("logical copy", b));
      const rec = m.checks.logical;
      for (const [label, c] of [["cold-derived", a], ["logical", b]] as const) {
        if (!rec || c.fingerprint !== rec.fingerprint || c.structural !== rec.structural || c.state !== rec.state || c.userVersion !== rec.userVersion || JSON.stringify(c.counts) !== JSON.stringify(rec.counts)) {
          problems.push(`${label} copy does not match the manifest checks`);
        }
      }
      problems.push(...artifactProblems(backupDir, m).map((p) => `after verification: ${p}`));
    } catch (error) {
      problems.push(`verification step failed: ${(error as Error).message}`);
    }
  }
  const reportFile = path.join(backupDir, `verify-${stamp(options.now ?? new Date())}.json`);
  try {
    writeJsonExclusive(reportFile, { verifiedAt: new Date().toISOString(), ok: problems.length === 0, problems });
  } catch {
    // the result is still returned; the report file is evidence only
  }
  return problems.length === 0
    ? { exitCode: EXIT.OK, message: `backup verified: ${backupDir}`, problems, reportFile }
    : { exitCode: EXIT.BACKUP_FAILED, message: `backup NOT verified (${problems.length} problem(s)): ${problems.join("; ")}`, problems, reportFile };
}

// ---------------------------------------------------------------------------------------------
// restore (§G.2 rehearsal / §G.4 procedure; disposable targets only in A2-impl)
// ---------------------------------------------------------------------------------------------

export interface RestoreResult {
  exitCode: BackupExitCode;
  message: string;
  quarantineDir: string | null;
  restoredState: string | null;
  reportFile: string | null;
}

export function restoreBackup(options: { backupDir: string; targetDbPath: string; cwd?: string; procRoot?: string; now?: Date }): RestoreResult {
  const cwd = options.cwd ?? process.cwd();
  const backupDir = path.resolve(cwd, options.backupDir);
  const target = path.resolve(cwd, options.targetDbPath);
  const result = (exitCode: BackupExitCode, message: string, extra: Partial<RestoreResult> = {}): RestoreResult => ({ exitCode, message, quarantineDir: null, restoredState: null, reportFile: null, ...extra });

  // 1. guards
  for (const g of [guardDir("backup directory", backupDir, cwd), guardDb("restore target", target, cwd)]) if (!g.ok) return result(EXIT.REFUSED, g.message);
  const targetDir = path.dirname(target);
  if (canonicalPath(targetDir) === canonicalPath(backupDir) || isInside(canonicalPath(target), canonicalPath(backupDir))) return result(EXIT.REFUSED, "refused: the restore target must not be inside the backup directory");
  const td = fileState(targetDir);
  if (td.kind !== "other") return result(EXIT.REFUSED, "refused: the target directory does not exist or is not a directory");

  // 2. the backup must be verified and its cold artifacts must match the manifest (before the target is touched)
  const m = readManifest(backupDir);
  if (typeof m === "string") return result(EXIT.BACKUP_FAILED, `refused: ${m}`);
  if (m.verified !== true) return result(EXIT.BACKUP_FAILED, "refused: the backup is not verified (manifest verified=false)");
  const ap = artifactProblems(backupDir, m);
  if (ap.length) return result(EXIT.BACKUP_FAILED, `refused: ${ap.join("; ")}`);

  // 3. holder check on the target
  const holders = findHolders(target, { procRoot: options.procRoot });
  if (!holders.ok || holders.holders.length > 0) return result(EXIT.REFUSED, `refused: ${formatHolders(holders)}`);

  // 4. target sidecars: a -journal is never moved, deleted or rewritten
  const ts = sourceStates(target);
  if (ts.journal.exists) return result(EXIT.REFUSED, "refused: JOURNAL_PRESENT: a -journal exists next to the restore target; it is never moved, deleted or rewritten. Operator-directed recovery is required (§F.3a)");
  for (const [k, s] of Object.entries(ts)) if (s.exists && s.kind !== "file") return result(EXIT.REFUSED, `refused: the target ${k} file is not a regular file`);

  // 5. quarantine (move, never delete; D-13)
  const now = options.now ?? new Date();
  let quarantineDir: string | null = null;
  const moved: string[] = [];
  if (ts.main.exists || ts.wal.exists || ts.shm.exists) {
    quarantineDir = path.join(targetDir, `data-quarantine-${stamp(now)}`);
    fs.mkdirSync(quarantineDir, { mode: 0o700 });
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${target}${suffix}`;
      if (fs.existsSync(f)) {
        fs.renameSync(f, path.join(quarantineDir, path.basename(f)));
        moved.push(path.basename(f));
      }
    }
  }

  // 6. copy cold/ into place (no -shm) and verify against the manifest
  const coldDir = path.join(backupDir, "cold");
  const hasWal = `${COLD_DB}-wal` in m.artifacts.cold;
  copyExclusive(path.join(coldDir, COLD_DB), target);
  if (hasWal) copyExclusive(path.join(coldDir, `${COLD_DB}-wal`), `${target}-wal`);
  const problems: string[] = [];
  if (fileState(target).sha256 !== m.artifacts.cold[COLD_DB].sha256) problems.push("restored database does not match the manifest");
  if (hasWal && fileState(`${target}-wal`).sha256 !== m.artifacts.cold[`${COLD_DB}-wal`].sha256) problems.push("restored -wal does not match the manifest");
  if (fs.existsSync(`${target}-shm`)) problems.push("a -shm exists next to the restored database");

  // 7. status on a copy (never on the restored file itself)
  let restoredState: string | null = null;
  const checkDir = path.join(targetDir, `restore-check-${stamp(now)}`);
  try {
    makeMarkedDir(checkDir);
    const copy = path.join(checkDir, COLD_DB);
    copyExclusive(target, copy);
    if (hasWal) {
      copyExclusive(`${target}-wal`, `${copy}-wal`);
      const d = new Database(copy, { fileMustExist: true });
      d.prepare("SELECT count(*) FROM sqlite_master").get(); // first read replays the -wal
      d.close(); // last close checkpoints the -wal inside the check copy only
    }
    const s = snapshotStatus(copy, registryView(MIGRATIONS), cwd);
    if (!s.ok) problems.push(`status on the restored copy refused: ${s.code}`);
    else if (s.exitCode !== 0) problems.push(`status on the restored copy reports ${s.state}`);
    else {
      restoredState = s.state;
      const rec = m.checks.logical;
      if (!rec || s.state !== rec.state) problems.push(`restored state ${s.state} differs from the manifest`);
      if (rec && s.report && s.report.fingerprint !== rec.fingerprint) problems.push("restored fingerprint differs from the manifest");
    }
  } catch (error) {
    problems.push(`post-restore check failed: ${(error as Error).message}`);
  }
  const reportFile = path.join(targetDir, `restore-${stamp(now)}.json`);
  try {
    writeJsonExclusive(reportFile, { restoredAt: now.toISOString(), backupDir, target, quarantineDir, moved, restoredState, problems, ok: problems.length === 0 });
  } catch {
    // evidence only
  }
  return problems.length === 0
    ? result(EXIT.OK, `restored ${target} from ${backupDir} (state ${restoredState})${quarantineDir ? `; previous files moved to ${quarantineDir}` : ""}`, { quarantineDir, restoredState, reportFile })
    : result(EXIT.BACKUP_FAILED, `restore NOT verified: ${problems.join("; ")}`, { quarantineDir, restoredState, reportFile });
}
