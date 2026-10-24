/**
 * db:verify-backup — re-verifies an existing backup: artifact hashes against manifest.json,
 * uploads tree, and integrity/schema/count checks on fresh copies (Workshop 5B §G.1).
 * Exit codes: 0 verified, 1 usage/unexpected, 2 refused (path guard), 5 not verified.
 *
 * usage: db-verify-backup --backup <backup-dir> [--json]
 */
import { verifyBackup } from "../src/lib/backup";

const USAGE = "usage: db-verify-backup --backup <backup-dir> [--json]";

function main(): number {
  const argv = process.argv.slice(2);
  let backup: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--backup" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) backup = argv[++i];
    else {
      console.error(USAGE);
      return 1;
    }
  }
  if (!backup) {
    console.error(USAGE);
    return 1;
  }
  const r = verifyBackup({ backupDir: backup });
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
