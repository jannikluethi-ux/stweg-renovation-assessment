import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Single source of runtime storage paths.
 *
 * Defaults are exactly the paths used before this module existed:
 *   <process.cwd()>/data/stweg.db and <process.cwd()>/data/uploads
 * Overrides: STWEG_DB_PATH and STWEG_UPLOADS_DIR (absolute paths only; an unset
 * or empty value means "use the default").
 * Values are read from the environment at call time, so tests can change them.
 *
 * Guarded modes (test mode and the seed's temp mode) use one classifier,
 * classifyDisposablePath(). A path qualifies only when ALL of these hold:
 *   1. Its canonical form (symlinks resolved component by component, including
 *      dangling links) is not the default <cwd>/data dir or anything inside it
 *      (covers the default DB, -wal, -shm and the default uploads dir).
 *   2. Its nearest ancestor directory containing the marker file
 *      `.stweg-harness` (a regular file, not a symlink) exists ...
 *   3. ... and that marked directory is not "/", is not the cwd or an ancestor
 *      of the cwd, and is not itself protected.
 * Being inside os.tmpdir() grants nothing, so TMPDIR=/ or a checkout located
 * under /tmp cannot turn real data into "temp" data.
 *
 * For DATABASE paths, guarded modes additionally apply a file-identity check
 * (classifyDisposableDbPath / checkDbFileIdentity), because a hard link has its
 * own path but shares the protected file's data. For the candidate DB and each
 * sidecar (-wal, -shm, -journal) that EXISTS:
 *   - refuse if it has more than one hard link (nlink > 1; conservative), and
 *   - refuse if its (dev, ino) equals that of an existing protected file
 *     (default DB, -wal, -shm, -journal), and
 *   - fail closed if identity data is unreliable (win32, ino 0, non-bigint
 *     fields, or a stat error other than "does not exist").
 * Files that do not exist yet cannot be hard links; SQLite creates them fresh.
 * None of this runs outside guarded modes.
 */

type Env = NodeJS.ProcessEnv;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultDbPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "data", "stweg.db");
}

export function defaultUploadsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "data", "uploads");
}

export function isTestMode(env: Env = process.env): boolean {
  return env.NODE_ENV === "test" || env.STWEG_TEST === "1";
}

function fromEnv(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw.includes("\0")) throw new ConfigError(`${name} must not contain a NUL character.`);
  if (!path.isAbsolute(raw)) throw new ConfigError(`${name} must be an absolute path.`);
  return path.resolve(raw);
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Canonical absolute path. Resolves every symlink component by component with
 * lstat/readlink, also when the link target (or anything after it) does not
 * exist yet, so a dangling link is resolved to where a write would land.
 * Components that do not exist are appended lexically.
 */
export function canonicalPath(target: string): string {
  let pending = path.resolve(target).split(path.sep).filter(Boolean);
  let resolved = path.parse(path.resolve(target)).root;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (stat?.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) throw new ConfigError("Too many symbolic links while resolving a storage path.");
      const link = fs.readlinkSync(next);
      if (path.isAbsolute(link)) resolved = path.parse(link).root;
      pending = [...link.split(path.sep).filter(Boolean), ...pending];
      continue;
    }
    resolved = next;
  }
  return resolved;
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function tempRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

/**
 * Temp root for creating disposable directories. Refuses "/" (e.g. TMPDIR=/).
 * Being inside this directory never grants test or temp mode by itself.
 */
export function usableTempRoot(): string {
  const root = tempRoot();
  if (path.parse(root).root === root) throw new ConfigError("The OS temp directory resolves to the filesystem root; refusing to create disposable directories there.");
  return root;
}

export const HARNESS_MARKER = ".stweg-harness";

export type DisposableCheck =
  | { ok: true; markedDir: string }
  | { ok: false; code: DisposableRefusal; message: string };

export type DisposableRefusal =
  | "protected"
  | "no-marker"
  | "marker-root"
  | "marker-contains-cwd"
  | "marker-protected"
  | "hardlinked"
  | "same-file"
  | "identity-unreliable";

/** Canonical default data dir, DB (+ -wal/-shm) and uploads dir for this cwd. */
export function protectedLocations(cwd: string = process.cwd()): string[] {
  const db = defaultDbPath(cwd);
  return [path.dirname(db), db, `${db}-wal`, `${db}-shm`, defaultUploadsDir(cwd)].map(canonicalPath);
}

/** True when the canonical path is a protected location or inside one. */
export function isProtectedPath(candidate: string, cwd: string = process.cwd()): boolean {
  const resolved = canonicalPath(candidate);
  return protectedLocations(cwd).some((p) => resolved === p || isInside(resolved, p));
}

function isMarkerFile(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, HARNESS_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** Shared classifier for test mode and the seed's temp mode (see header). */
export function classifyDisposablePath(candidate: string, cwd: string = process.cwd()): DisposableCheck {
  const resolved = canonicalPath(candidate);
  if (isProtectedPath(resolved, cwd)) {
    return { ok: false, code: "protected", message: "resolves to the default data location" };
  }
  let dir = resolved;
  let marked: string | null = null;
  for (;;) {
    if (isMarkerFile(dir)) {
      marked = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!marked) return { ok: false, code: "no-marker", message: `is not inside a disposable directory marked with ${HARNESS_MARKER}` };
  if (path.parse(marked).root === marked) return { ok: false, code: "marker-root", message: "is marked at the filesystem root" };
  const realCwd = canonicalPath(cwd);
  if (marked === realCwd || isInside(realCwd, marked)) {
    return { ok: false, code: "marker-contains-cwd", message: "is in a marked directory that contains the working directory" };
  }
  if (isProtectedPath(marked, cwd)) return { ok: false, code: "marker-protected", message: "is in a marked directory inside the default data location" };
  return { ok: true, markedDir: marked };
}

/** SQLite files that belong to a database path. */
export const DB_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/** Minimal stat result used for the identity check (fs.BigIntStats satisfies it). */
export interface IdentityStat {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
}

/**
 * How the identity check reads file identity. stat returns null when the path
 * does not exist and throws for anything else. Replaceable in tests only
 * (setIdentityProbeForTests) to simulate unreliable platforms.
 */
export interface IdentityProbe {
  platform: string;
  stat: (file: string) => IdentityStat | null;
}

function defaultIdentityStat(file: string): IdentityStat | null {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

const defaultIdentityProbe: IdentityProbe = { platform: process.platform, stat: defaultIdentityStat };
let activeIdentityProbe: IdentityProbe = defaultIdentityProbe;

/** Test-only hook. Replaces (parts of) the identity probe; returns a restore function. */
export function setIdentityProbeForTests(probe: Partial<IdentityProbe> | null): () => void {
  const previous = activeIdentityProbe;
  activeIdentityProbe = probe ? { ...defaultIdentityProbe, ...probe } : defaultIdentityProbe;
  return () => {
    activeIdentityProbe = previous;
  };
}

function isReliableIdentity(st: IdentityStat, platform: string): boolean {
  if (platform === "win32") return false; // st_ino/st_nlink are not trusted there; fail closed
  return typeof st.dev === "bigint" && typeof st.ino === "bigint" && typeof st.nlink === "bigint" && st.ino > BigInt(0);
}

type IdentityCheck = { ok: true } | { ok: false; code: "hardlinked" | "same-file" | "identity-unreliable"; message: string };

function dbFiles(dbPath: string): string[] {
  const bases = [...new Set([path.resolve(dbPath), canonicalPath(dbPath)])];
  return [...new Set(bases.flatMap((base) => DB_FILE_SUFFIXES.map((suffix) => `${base}${suffix}`)))];
}

/**
 * Guarded-mode identity check for a candidate DB path (see header). Compares
 * the existing candidate files with the existing protected DB files of this cwd.
 */
export function checkDbFileIdentity(candidate: string, cwd: string = process.cwd(), probe: IdentityProbe = activeIdentityProbe): IdentityCheck {
  const unreliable = (why: string): IdentityCheck => ({ ok: false, code: "identity-unreliable", message: `cannot be verified as a separate file (${why}); refusing in guarded mode` });
  try {
    const existing: IdentityStat[] = [];
    for (const file of dbFiles(candidate)) {
      const st = probe.stat(file);
      if (!st) continue;
      if (!isReliableIdentity(st, probe.platform)) return unreliable("file identity information is unreliable on this platform or filesystem");
      if (st.nlink > BigInt(1)) return { ok: false, code: "hardlinked", message: "has a database file with more than one hard link" };
      existing.push(st);
    }
    if (existing.length === 0) return { ok: true };
    for (const file of dbFiles(defaultDbPath(cwd))) {
      const st = probe.stat(file);
      if (!st) continue;
      if (!isReliableIdentity(st, probe.platform)) return unreliable("protected file identity information is unreliable");
      if (existing.some((c) => c.dev === st.dev && c.ino === st.ino)) {
        return { ok: false, code: "same-file", message: "is the same file as the default database (hard link or alias)" };
      }
    }
    return { ok: true };
  } catch (error) {
    return unreliable(`stat failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

/** classifyDisposablePath() plus the file-identity check, for database paths. */
export function classifyDisposableDbPath(candidate: string, cwd: string = process.cwd(), probe?: IdentityProbe): DisposableCheck {
  const check = classifyDisposablePath(candidate, cwd);
  if (!check.ok) return check;
  const identity = checkDbFileIdentity(candidate, cwd, probe);
  return identity.ok ? check : identity;
}

function assertTestSafe(kind: "database" | "uploads", target: string, cwd: string, env: Env): void {
  if (!isTestMode(env)) return;
  const check = kind === "database" ? classifyDisposableDbPath(target, cwd) : classifyDisposablePath(target, cwd);
  if (check.ok) return;
  if (check.code === "protected") {
    throw new ConfigError(`Test mode refused the real ${kind} location. Use a disposable directory (withTempEnv).`);
  }
  throw new ConfigError(`Test mode refused the ${kind} path: it ${check.message}. Use withTempEnv().`);
}

export function resolveDbPath(env: Env = process.env, cwd: string = process.cwd()): string {
  const fallback = defaultDbPath(cwd);
  const value = fromEnv(env, "STWEG_DB_PATH", fallback);
  assertTestSafe("database", value, cwd, env);
  return value;
}

export function resolveUploadsDir(env: Env = process.env, cwd: string = process.cwd()): string {
  const fallback = defaultUploadsDir(cwd);
  const value = fromEnv(env, "STWEG_UPLOADS_DIR", fallback);
  assertTestSafe("uploads", value, cwd, env);
  return value;
}

/** Paths only, never secrets. */
export function describeConfig(env: Env = process.env): string {
  return `db=${resolveDbPath(env)} uploads=${resolveUploadsDir(env)}`;
}
