import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Single source of runtime storage paths.
 *
 * Defaults are exactly the paths used before this module existed:
 *   <process.cwd()>/data/stweg.db and <process.cwd()>/data/uploads
 * Overrides: STWEG_DB_PATH and STWEG_UPLOADS_DIR (absolute paths only).
 * Values are read from the environment at call time, so tests can change them.
 *
 * Test guard (fail closed): when NODE_ENV=test or STWEG_TEST=1, both paths must
 * resolve under the OS temp directory and must not be (or be inside) the real
 * default data locations. Otherwise resolving throws before anything is opened.
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

/** Resolve symlinks of the longest existing ancestor, then re-append the rest. */
export function canonicalPath(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.join(real, ...rest);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function tempRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

function assertTestSafe(kind: "database" | "uploads", target: string, realDefault: string, env: Env): void {
  if (!isTestMode(env)) return;
  const resolved = canonicalPath(target);
  const real = canonicalPath(realDefault);
  const realData = canonicalPath(path.dirname(realDefault));
  if (resolved === real || isInside(resolved, real) || resolved === realData || isInside(resolved, realData)) {
    throw new ConfigError(`Test mode refused the real ${kind} location. Use a temporary directory (withTempEnv).`);
  }
  if (!isInside(resolved, tempRoot())) {
    throw new ConfigError(`Test mode requires the ${kind} path to be inside the OS temp directory.`);
  }
}

export function resolveDbPath(env: Env = process.env, cwd: string = process.cwd()): string {
  const fallback = defaultDbPath(cwd);
  const value = fromEnv(env, "STWEG_DB_PATH", fallback);
  assertTestSafe("database", value, fallback, env);
  return value;
}

export function resolveUploadsDir(env: Env = process.env, cwd: string = process.cwd()): string {
  const fallback = defaultUploadsDir(cwd);
  const value = fromEnv(env, "STWEG_UPLOADS_DIR", fallback);
  assertTestSafe("uploads", value, fallback, env);
  return value;
}

/** Paths only, never secrets. */
export function describeConfig(env: Env = process.env): string {
  return `db=${resolveDbPath(env)} uploads=${resolveUploadsDir(env)}`;
}
