/**
 * db:restore — restores a verified backup's cold database into a marked disposable target
 * (Workshop 5B §G.2 rehearsal / §G.4). Existing target files are moved into
 * data-quarantine-<ts>/ (never deleted); a target -journal is refused (exit 2) and never
 * touched. Uploads are not restored. Exit codes: 0 restored and verified, 1 usage/unexpected,
 * 2 refused, 5 backup not verified or restore verification failed.
 *
 * usage: db-restore --backup <backup-dir> --db <target-file> [--json]
 */
import { restoreBackup } from "../src/lib/backup";
import { ConfigError, resolveDbPath } from "../src/lib/config";

const USAGE = "usage: db-restore --backup <backup-dir> --db <target-file> [--json]";

function main(): number {
  const argv = process.argv.slice(2);
  let backup: string | undefined;
  let db: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--json") json = true;
    else if ((a === "--backup" || a === "--db") && v !== undefined && !v.startsWith("--")) {
      if (a === "--backup") backup = v;
      else db = v;
      i++;
    } else {
      console.error(USAGE);
      return 1;
    }
  }
  if (!backup) {
    console.error(USAGE);
    return 1;
  }
  try {
    db = db ?? resolveDbPath();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const r = restoreBackup({ backupDir: backup, targetDbPath: db });
  if (json) console.log(JSON.stringify(r, null, 2));
  else (r.exitCode === 0 ? console.log : console.error)(r.message);
  return r.exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
