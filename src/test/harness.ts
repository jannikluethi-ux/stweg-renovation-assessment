import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInside, tempRoot } from "../lib/config";
import { closeDb } from "../lib/db";

/**
 * Disposable storage for tests. Creates <os.tmpdir()>/stweg-test-XXXXXX with a
 * marker file, points STWEG_DB_PATH / STWEG_UPLOADS_DIR at it, sets STWEG_TEST=1
 * and resets the cached DB connection. cleanup() removes only that directory,
 * and only after re-checking that it is inside the temp root, has the harness
 * prefix and still carries the marker written at creation.
 */

const PREFIX = "stweg-test-";
const MARKER = ".stweg-harness";
const KEYS = ["STWEG_DB_PATH", "STWEG_UPLOADS_DIR", "STWEG_TEST"] as const;

export interface TempEnv {
  dir: string;
  dbPath: string;
  uploadsDir: string;
  cleanup: () => void;
}

export function withTempEnv(): TempEnv {
  const root = tempRoot();
  const dir = fs.mkdtempSync(path.join(root, PREFIX));
  const token = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, MARKER), token, { mode: 0o600 });
  const dbPath = path.join(dir, "stweg.db");
  const uploadsDir = path.join(dir, "uploads");
  fs.mkdirSync(uploadsDir, { mode: 0o700 });

  const previous: Record<string, string | undefined> = {};
  for (const key of KEYS) previous[key] = process.env[key];
  closeDb();
  process.env.STWEG_TEST = "1";
  process.env.STWEG_DB_PATH = dbPath;
  process.env.STWEG_UPLOADS_DIR = uploadsDir;

  let done = false;
  return {
    dir,
    dbPath,
    uploadsDir,
    cleanup() {
      if (done) return;
      done = true;
      closeDb();
      removeHarnessDir(dir, token);
      for (const key of KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    },
  };
}

/** Exported for tests of the guard itself. Throws instead of deleting anything unexpected. */
export function removeHarnessDir(dir: string, token: string): void {
  const root = tempRoot();
  const resolved = path.resolve(dir);
  if (!isInside(resolved, root) || path.dirname(resolved) !== root) {
    throw new Error("Refusing to remove a directory that is not directly inside the OS temp directory.");
  }
  if (!path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Refusing to remove a directory that was not created by the test harness.");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to remove a non-directory or symlink.");
  const markerPath = path.join(resolved, MARKER);
  if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, "utf8") !== token) {
    throw new Error("Refusing to remove a directory without this harness's marker.");
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}
