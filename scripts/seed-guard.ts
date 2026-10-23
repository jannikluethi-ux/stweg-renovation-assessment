import path from "node:path";
import { canonicalPath, checkDbFileIdentity, checkDbFileLinks, classifyDisposableDbPath, classifyDisposablePath, defaultDbPath, isInside } from "../src/lib/config";

/**
 * The seed deletes the demo organization (DB cascade) and its uploads folder.
 * It therefore only runs when STWEG_ALLOW_SEED=1 AND either
 *   - temp mode: both the DB path and the uploads dir pass the shared classifier
 *     classifyDisposablePath() in src/lib/config.ts (not the default data dir,
 *     inside a directory marked with .stweg-harness that is not "/" and does not
 *     contain the cwd). Being under os.tmpdir() alone does NOT qualify. The DB
 *     path also passes the file-identity check (no hard link to / alias of the
 *     default DB or its sidecars, nlink 1, reliable inode data); or
 *   - the explicit confirmation flag is passed on the command line. This is the
 *     operator's explicit decision to reset org_demo in the configured DB; it
 *     does not apply the temp-mode location checks, and it still proceeds
 *     (documented limitation L1, asserted by T-A10b). R1 (3F, minimum variant):
 *     explicit mode runs the file-identity check and prints a WARNING to stderr
 *     when the target shares its data with another path:
 *       - configured path lexically equal to the default <cwd>/data/stweg.db:
 *         any existing DB file or sidecar with nlink > 1 or unreliable identity;
 *       - any other configured path: the full identity check (nlink > 1, or the
 *         same file as the default DB or one of its sidecars, e.g. a hard link).
 *     In test mode, resolveDbPath() still applies the test-mode guard first.
 * File deletion is confined to <uploadsDir>/<org>.
 */
export const SEED_CONFIRM_FLAG = "--i-understand-this-deletes-org_demo";

export type SeedDecision = { ok: true; mode: "temp" | "explicit" } | { ok: false; reason: string };

export function checkSeedAllowed(input: { env: NodeJS.ProcessEnv; argv: string[]; dbPath: string; uploadsDir: string; cwd?: string }): SeedDecision {
  if (input.env.STWEG_ALLOW_SEED !== "1") {
    return { ok: false, reason: "Seed refused: set STWEG_ALLOW_SEED=1 to confirm that the demo organization may be deleted and recreated." };
  }
  const cwd = input.cwd ?? process.cwd();
  const uploads = canonicalPath(input.uploadsDir);
  if (path.parse(uploads).root === uploads) return { ok: false, reason: "Seed refused: the uploads directory must not be a filesystem root." };
  const db = classifyDisposableDbPath(input.dbPath, cwd);
  const up = classifyDisposablePath(input.uploadsDir, cwd);
  if (db.ok && up.ok) return { ok: true, mode: "temp" };
  if (input.argv.includes(SEED_CONFIRM_FLAG)) {
    const warning = explicitModeIdentityWarning(input.dbPath, cwd);
    if (warning) console.error(warning);
    return { ok: true, mode: "explicit" };
  }
  const why = !db.ok ? `the DB path ${db.message}` : `the uploads path ${(up as { message: string }).message}`;
  return {
    ok: false,
    reason: `Seed refused: ${why}. Use a disposable directory marked with .stweg-harness for both paths, or pass ${SEED_CONFIRM_FLAG} to reset the demo organization in this database.`,
  };
}

/**
 * R1 (3F L1): identity check for explicit mode. Returns a one-line warning when
 * the target DB shares its data with another path, otherwise null. Never throws.
 */
export function explicitModeIdentityWarning(dbPath: string, cwd: string = process.cwd()): string | null {
  const isDefault = path.resolve(dbPath) === path.resolve(defaultDbPath(cwd));
  const identity = isDefault ? checkDbFileLinks(dbPath) : checkDbFileIdentity(dbPath, cwd);
  if (identity.ok) return null;
  const what = identity.code === "same-file" ? "the target is the same file as data/stweg.db" : `the target DB ${identity.message}`;
  return `[seed] WARNING (explicit mode): ${what}. Resetting org_demo here also changes every other path that shares this file (hard link or alias).`;
}

/** <uploadsDir>/<org>, verified to be strictly inside the configured uploads dir. */
export function seedOrgUploadDir(uploadsDir: string, org: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(org)) throw new Error("Seed refused: invalid organization id for an uploads folder.");
  const target = path.join(uploadsDir, org);
  if (!isInside(canonicalPath(target), canonicalPath(uploadsDir))) throw new Error("Seed refused: organization uploads folder escapes the uploads directory.");
  return target;
}
