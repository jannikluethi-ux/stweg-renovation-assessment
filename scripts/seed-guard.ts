import path from "node:path";
import { canonicalPath, isInside, tempRoot } from "../src/lib/config";

/**
 * The seed deletes the demo organization (DB cascade) and its uploads folder.
 * It therefore only runs when STWEG_ALLOW_SEED=1 AND either
 *   - both the DB path and the uploads dir are inside the OS temp directory, or
 *   - the explicit confirmation flag is passed on the command line.
 * File deletion is confined to <uploadsDir>/<org>.
 */
export const SEED_CONFIRM_FLAG = "--i-understand-this-deletes-org_demo";

export type SeedDecision = { ok: true; mode: "temp" | "explicit" } | { ok: false; reason: string };

export function checkSeedAllowed(input: { env: NodeJS.ProcessEnv; argv: string[]; dbPath: string; uploadsDir: string }): SeedDecision {
  if (input.env.STWEG_ALLOW_SEED !== "1") {
    return { ok: false, reason: "Seed refused: set STWEG_ALLOW_SEED=1 to confirm that the demo organization may be deleted and recreated." };
  }
  const root = tempRoot();
  const db = canonicalPath(input.dbPath);
  const uploads = canonicalPath(input.uploadsDir);
  if (path.parse(uploads).root === uploads) return { ok: false, reason: "Seed refused: the uploads directory must not be a filesystem root." };
  if (isInside(db, root) && isInside(uploads, root)) return { ok: true, mode: "temp" };
  if (input.argv.includes(SEED_CONFIRM_FLAG)) return { ok: true, mode: "explicit" };
  return {
    ok: false,
    reason: `Seed refused: the DB or uploads path is outside the temp directory. Point STWEG_DB_PATH and STWEG_UPLOADS_DIR at a temp dir, or pass ${SEED_CONFIRM_FLAG} to reset the demo organization in this database.`,
  };
}

/** <uploadsDir>/<org>, verified to be strictly inside the configured uploads dir. */
export function seedOrgUploadDir(uploadsDir: string, org: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(org)) throw new Error("Seed refused: invalid organization id for an uploads folder.");
  const target = path.join(uploadsDir, org);
  if (!isInside(canonicalPath(target), canonicalPath(uploadsDir))) throw new Error("Seed refused: organization uploads folder escapes the uploads directory.");
  return target;
}
