/**
 * db:backup — cold backup + verification of a marked disposable database and uploads tree
 * (Workshop 5B §G.1, §G.3). A2-impl: the default data/ location, protected paths and the
 * O-4 real backup location are refused (exit 2). Exit codes: 0 verified, 1 usage/unexpected,
 * 2 refused, 5 backup or verification failed.
 *
 * usage: db-backup --db <file> --uploads <dir> --out <backup-root> [--json]
 */
import { execFileSync } from "node:child_process";
import { createBackup, O4_REAL_BACKUP_ROOT } from "../src/lib/backup";
import { ConfigError, resolveDbPath, resolveUploadsDir } from "../src/lib/config";

const USAGE = "usage: db-backup --db <file> --uploads <dir> --out <backup-root> [--json]";

function parse(argv: string[]): { db?: string; uploads?: string; out?: string; json: boolean } | null {
  const out: { db?: string; uploads?: string; out?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--db" || a === "--uploads" || a === "--out") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return null;
      out[a.slice(2) as "db" | "uploads" | "out"] = v;
    } else return null;
  }
  return out;
}

function appCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function main(): number {
  const args = parse(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 1;
  }
  let db: string;
  let uploads: string;
  try {
    db = args.db ?? resolveDbPath();
    uploads = args.uploads ?? resolveUploadsDir();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const r = createBackup({ dbPath: db, uploadsDir: uploads, backupRoot: args.out ?? O4_REAL_BACKUP_ROOT, appCommit: appCommit() });
  if (args.json) console.log(JSON.stringify({ exitCode: r.exitCode, message: r.message, backupDir: r.backupDir, verified: r.manifest?.verified ?? false, problems: r.manifest?.problems ?? [] }, null, 2));
  else {
    (r.exitCode === 0 ? console.log : console.error)(r.message);
    if (r.backupDir) console.log(`manifest: ${r.backupDir}/manifest.json`);
  }
  return r.exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
