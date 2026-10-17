import path from "node:path";
import { canonicalPath, classifyDisposableDbPath, classifyDisposablePath, isInside } from "../src/lib/config";

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
 *     does not apply the temp-mode location or identity checks (unchanged).
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
  if (input.argv.includes(SEED_CONFIRM_FLAG)) return { ok: true, mode: "explicit" };
  const why = !db.ok ? `the DB path ${db.message}` : `the uploads path ${(up as { message: string }).message}`;
  return {
    ok: false,
    reason: `Seed refused: ${why}. Use a disposable directory marked with .stweg-harness for both paths, or pass ${SEED_CONFIRM_FLAG} to reset the demo organization in this database.`,
  };
}

/** <uploadsDir>/<org>, verified to be strictly inside the configured uploads dir. */
export function seedOrgUploadDir(uploadsDir: string, org: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(org)) throw new Error("Seed refused: invalid organization id for an uploads folder.");
  const target = path.join(uploadsDir, org);
  if (!isInside(canonicalPath(target), canonicalPath(uploadsDir))) throw new Error("Seed refused: organization uploads folder escapes the uploads directory.");
  return target;
}
