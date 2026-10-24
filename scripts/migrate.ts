/**
 * db:migrate — explicit schema migration commands (Workshop 5B §C, §F; O-1).
 *
 *   migrate status [--db <file>] [--json]   snapshot-read status (never opens the file with SQLite)
 *   migrate apply  [--db <file>] [--json]   guarded apply of pending migrations (adopts LEGACY_BASELINE)
 *
 * A2-impl: only marked disposable databases are accepted. The default location (data/stweg.db),
 * protected paths, unmarked directories, hard links and symlinks are refused with exit 2 before
 * anything is read. Both commands refuse with JOURNAL_PRESENT (exit 2) whenever a -journal exists;
 * this tool never recovers, deletes or rewrites a journal. The application never runs migrations.
 *
 * Exit codes (§F.5): 0 ok/no-op; 1 usage, busy or unexpected; 2 refused; 3 rolled back;
 * 4 post-commit verification failed; 6 undeterminable (non-empty WAL).
 */
import { execFileSync } from "node:child_process";
import { ConfigError, resolveDbPath } from "../src/lib/config";
import { applyMigrations, statusWithRunLog } from "../src/lib/migrations/runner";
import { formatStatus } from "../src/lib/migrations/state";

const USAGE = "usage: migrate <status|apply> [--db <file>] [--json]";

type Command = "status" | "apply";

function parse(argv: string[]): { command: Command; db?: string; json: boolean } | null {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "apply") return null;
  const out: { command: Command; db?: string; json: boolean } = { command, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") out.json = true;
    else if (a === "--db") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--") || out.db !== undefined) return null;
      out.db = v;
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
  try {
    db = args.db ?? resolveDbPath();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (args.command === "status") {
    const { status, interrupted } = statusWithRunLog(db);
    if (args.json) {
      console.log(JSON.stringify({ command: "status", exitCode: status.exitCode, status, interrupted }, null, 2));
    } else {
      console.log(formatStatus(status));
      for (const run of interrupted) console.log(`interrupted run: ${run.file}: ${run.assessment}`);
    }
    return status.exitCode;
  }

  const r = applyMigrations({ dbPath: db, gitCommit: appCommit() });
  if (args.json) {
    console.log(JSON.stringify({ command: "apply", ...r }, null, 2));
  } else {
    (r.exitCode === 0 ? console.log : console.error)(r.message);
    console.log(`state: ${r.stateBefore ?? "?"} -> ${r.stateAfter ?? "?"}`);
    for (const a of r.applied) console.log(`  ${a.kind} ${a.name} (${a.durationMs} ms)`);
    if (r.runLogFile) console.log(`run log: ${r.runLogFile}`);
    console.log(`exit: ${r.exitCode}`);
  }
  return r.exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
