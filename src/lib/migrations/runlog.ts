import fs from "node:fs";
import path from "node:path";

/**
 * Run log (Workshop 5B §F.3): one JSON object per line, each line written and
 * fsync'ed before the runner continues. Records names, ids, states, hashes,
 * counts and exit codes only; never row values.
 *
 * A run is "interrupted" when its log has a "start" record but no "end" record.
 */

export const RUN_LOG_PREFIX = "migrate-";
export const RUN_LOG_SUFFIX = ".jsonl";

export type RunLogEvent =
  | "start"
  | "guard"
  | "holders"
  | "state_before"
  | "lock"
  | "migration_start"
  | "migration_end"
  | "rolled_back"
  | "state_after"
  | "end";

export interface RunLogRecord {
  ts: string;
  event: RunLogEvent;
  [key: string]: unknown;
}

export class RunLog {
  readonly file: string;
  private readonly now: () => Date;

  private constructor(file: string, now: () => Date) {
    this.file = file;
    this.now = now;
  }

  /** Creates a new log file (exclusive create) in an existing directory. */
  static create(dir: string, now: () => Date = () => new Date()): RunLog {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    for (let i = 0; ; i++) {
      const file = path.join(dir, `${RUN_LOG_PREFIX}${stamp}-${process.pid}${i ? `-${i}` : ""}${RUN_LOG_SUFFIX}`);
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        return new RunLog(file, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || i > 100) throw error;
      }
    }
  }

  write(event: RunLogEvent, data: Record<string, unknown> = {}): void {
    const record: RunLogRecord = { ts: this.now().toISOString(), event, ...data };
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readRunLog(file: string): RunLogRecord[] {
  const text = fs.readFileSync(file, "utf8");
  const out: RunLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunLogRecord);
    } catch {
      out.push({ ts: "", event: "end", unparseable: true });
    }
  }
  return out;
}

export function listRunLogs(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((n) => n.startsWith(RUN_LOG_PREFIX) && n.endsWith(RUN_LOG_SUFFIX))
    .sort()
    .map((n) => path.join(dir, n));
}

export interface InterruptedRun {
  file: string;
  dbPath: string | null;
  startedAt: string;
  /** migrations whose "migration_start" has no matching "migration_end" */
  openMigrations: Array<{ id: number; name: string }>;
  lastEvent: RunLogEvent;
}

/** Runs for `dbPath` (absolute, as recorded) with "start" but no "end". */
export function interruptedRuns(dir: string, dbPath?: string): InterruptedRun[] {
  const out: InterruptedRun[] = [];
  for (const file of listRunLogs(dir)) {
    const records = readRunLog(file);
    const start = records.find((r) => r.event === "start");
    if (!start) continue;
    const recordedDb = typeof start.dbPath === "string" ? start.dbPath : null;
    if (dbPath && recordedDb !== path.resolve(dbPath)) continue;
    if (records.some((r) => r.event === "end")) continue;
    const ended = new Set(records.filter((r) => r.event === "migration_end").map((r) => Number(r.id)));
    const openMigrations = records
      .filter((r) => r.event === "migration_start" && !ended.has(Number(r.id)))
      .map((r) => ({ id: Number(r.id), name: String(r.name) }));
    out.push({ file, dbPath: recordedDb, startedAt: start.ts, openMigrations, lastEvent: records[records.length - 1].event });
  }
  return out;
}
