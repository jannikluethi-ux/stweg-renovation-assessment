import fs from "node:fs";
import Database from "better-sqlite3";
import { ConfigError, classifyDisposableDbPath, isTestMode } from "../config";
import { sha256Hex } from "./fingerprint";

/**
 * Byte-copy snapshot read (Workshop 5B §C.2 and rev1 §C.4).
 *
 * SQLite never opens the database path: the main file is read through a
 * read-only descriptor into memory and deserialized there. The WAL is never
 * read, merged, replayed or checkpointed; -shm is never opened. A non-empty
 * WAL means the main file alone cannot establish the current schema, so the
 * result is UNDETERMINABLE_WAL_PENDING (exit 6) without reading the main file.
 */

export type ReadRefusalCode =
  | "PATH_REFUSED"
  | "UNDETERMINABLE_WAL_PENDING"
  | "CHANGED_DURING_READ"
  | "BAD_SIDECAR"
  | "JOURNAL_PRESENT"
  | "NOT_REGULAR_FILE"
  | "HEADER_INVALID"
  | "NOT_SQLITE"
  | "PAGE_SIZE_INVALID"
  | "SIZE_NOT_PAGE_MULTIPLE"
  | "FORMAT_VERSION_INVALID"
  | "DESERIALIZE_FAILED"
  | "INTEGRITY_FAILED";

/** 5B §F.5 exit codes. */
export const EXIT = { OK: 0, USAGE: 1, REFUSED: 2, ROLLED_BACK: 3, POST_COMMIT_FAILED: 4, BACKUP_FAILED: 5, UNDETERMINABLE: 6 } as const;

export interface FileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
  kind: "file" | "symlink" | "directory" | "other";
}

export interface SidecarRecord {
  wal: FileIdentity | null;
  shm: FileIdentity | null;
  journal: FileIdentity | null;
}

export type SnapshotOutcome =
  | { kind: "empty"; reason: "absent" | "zero-bytes"; sidecars: SidecarRecord }
  | { kind: "bytes"; buffer: Buffer; sha256: string; identity: FileIdentity; header: HeaderInfo; sidecars: SidecarRecord }
  | { kind: "refused"; code: ReadRefusalCode; exitCode: 2 | 6; message: string; sidecars: SidecarRecord | null };

export interface HeaderInfo {
  pageSize: number;
  writeVersion: number;
  readVersion: number;
  journalModeFromHeader: "wal" | "rollback";
}

/** Test-only hooks (gated on test mode). */
export interface SnapshotTestHooks {
  /** called each time the main file is opened for reading */
  onMainRead?: (path: string) => void;
  /** called after the first read and hash, before the post-read checks */
  betweenReads?: (path: string) => void;
}
let hooks: SnapshotTestHooks = {};

export function setSnapshotHooksForTests(next: SnapshotTestHooks | null, env: NodeJS.ProcessEnv = process.env): () => void {
  if (!isTestMode(env)) throw new ConfigError("setSnapshotHooksForTests is only available in test mode.");
  const previous = hooks;
  hooks = next ?? {};
  return () => {
    hooks = previous;
  };
}

function kindOf(st: fs.BigIntStats): FileIdentity["kind"] {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  return "other";
}

function identityOf(st: fs.BigIntStats): FileIdentity {
  return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), nlink: String(st.nlink), kind: kindOf(st) };
}

function lstatOrNull(file: string): FileIdentity | null {
  try {
    return identityOf(fs.lstatSync(file, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function sidecars(dbPath: string): SidecarRecord {
  return { wal: lstatOrNull(`${dbPath}-wal`), shm: lstatOrNull(`${dbPath}-shm`), journal: lstatOrNull(`${dbPath}-journal`) };
}

const sameMainIdentity = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.kind === b.kind;

/** WAL presence, size, inode, device and mtime must not change; journal must stay absent. -shm is ignored. */
function sidecarsChanged(before: SidecarRecord, after: SidecarRecord): string | null {
  const w0 = before.wal;
  const w1 = after.wal;
  if ((w0 === null) !== (w1 === null)) return w0 ? "-wal disappeared during the read" : "-wal appeared during the read";
  if (w0 && w1 && (w0.size !== w1.size || w0.ino !== w1.ino || w0.dev !== w1.dev || w0.mtimeNs !== w1.mtimeNs || w0.kind !== w1.kind)) return "-wal changed during the read";
  if (after.journal) return "-journal appeared during the read";
  return null;
}

const refused = (code: ReadRefusalCode, message: string, side: SidecarRecord | null, exitCode: 2 | 6 = 2): SnapshotOutcome => ({ kind: "refused", code, exitCode, message, sidecars: side });

function readWholeFile(dbPath: string, expected: FileIdentity): Buffer | string {
  hooks.onMainRead?.(dbPath);
  const fd = fs.openSync(dbPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || String(st.dev) !== expected.dev || String(st.ino) !== expected.ino) return "the file was replaced while opening it";
    const size = Number(expected.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buffer, offset, size - offset, offset);
      if (n === 0) return "the file shrank during the read";
      offset += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) return "the file grew during the read";
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/** Header validation (rev1 §C.4.2 step 3): a refusal, or the parsed header when valid. */
export function validateHeader(buffer: Buffer): { code: ReadRefusalCode; message: string } | HeaderInfo {
  if (buffer.length < 100) return { code: "HEADER_INVALID", message: `file is ${buffer.length} bytes, shorter than the 100-byte SQLite header` };
  if (!buffer.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"))) return { code: "NOT_SQLITE", message: "missing the SQLite format 3 magic string" };
  const raw = buffer.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return { code: "PAGE_SIZE_INVALID", message: `page size ${pageSize} is not a power of two between 512 and 65536` };
  if (buffer.length % pageSize !== 0) return { code: "SIZE_NOT_PAGE_MULTIPLE", message: `file size ${buffer.length} is not a multiple of the page size ${pageSize}` };
  const w = buffer[18];
  const r = buffer[19];
  if (![1, 2].includes(w) || ![1, 2].includes(r)) return { code: "FORMAT_VERSION_INVALID", message: `file format bytes 18/19 are ${w}/${r}, expected 1 or 2` };
  return { pageSize, writeVersion: w, readVersion: r, journalModeFromHeader: w === 2 && r === 2 ? "wal" : "rollback" };
}

/**
 * Reads the main file per rev1 §C.4 without a path guard. Library callers must
 * apply the guard first (guardedSnapshotRead does).
 */
export function snapshotReadUnguarded(dbPath: string): SnapshotOutcome {
  const before = sidecars(dbPath);
  if (before.journal) return refused("JOURNAL_PRESENT", "a -journal file is present; the main file may be mid-transaction. Not read.", before);
  if (before.wal && before.wal.kind !== "file") return refused("BAD_SIDECAR", `-wal is a ${before.wal.kind}, not a regular file. Not read.`, before);
  if (before.wal && before.wal.size !== "0") {
    return refused(
      "UNDETERMINABLE_WAL_PENDING",
      "the -wal file is not empty: committed changes may exist only in the WAL, so the main file cannot establish the current schema. Nothing was read. Stop the application; a checkpoint happens only inside the separately authorized apply/backup procedure, never ad hoc.",
      before,
      6,
    );
  }
  const main = lstatOrNull(dbPath);
  if (main === null || main.kind === "file" && main.size === "0") {
    const after = sidecars(dbPath);
    const mainAfter = lstatOrNull(dbPath);
    const changed = sidecarsChanged(before, after) ?? (JSON.stringify(main) !== JSON.stringify(mainAfter) ? "the main file changed during the check" : null);
    if (changed) return refused("CHANGED_DURING_READ", changed, after);
    return { kind: "empty", reason: main === null ? "absent" : "zero-bytes", sidecars: after };
  }
  if (main.kind !== "file") return refused("NOT_REGULAR_FILE", `the database path is a ${main.kind}, not a regular file. Not read.`, before);

  const first = readWholeFile(dbPath, main);
  if (typeof first === "string") return refused("CHANGED_DURING_READ", first, before);
  const sha1 = sha256Hex(first);
  const header = validateHeader(first);
  if ("code" in header) return refused(header.code, header.message, before);

  hooks.betweenReads?.(dbPath);

  const mainAfter = lstatOrNull(dbPath);
  const after = sidecars(dbPath);
  if (!mainAfter || !sameMainIdentity(main, mainAfter)) return refused("CHANGED_DURING_READ", "the main file's size, times or identity changed during the read", after);
  const sideChange = sidecarsChanged(before, after);
  if (sideChange) return refused("CHANGED_DURING_READ", sideChange, after);
  const second = readWholeFile(dbPath, main);
  if (typeof second === "string" || sha256Hex(second) !== sha1) return refused("CHANGED_DURING_READ", "the main file's content changed between two reads", after);

  // In-memory preparation on a COPY: WAL-mode header bytes (2,2) → legacy (1,1).
  const prepared = Buffer.from(first);
  if (prepared[18] === 2) prepared[18] = 1;
  if (prepared[19] === 2) prepared[19] = 1;
  return { kind: "bytes", buffer: prepared, sha256: sha1, identity: main, header, sidecars: after };
}

/** O-9 path guard first (exit 2 before any read), then the snapshot read. */
export function guardedSnapshotRead(dbPath: string, cwd: string = process.cwd()): SnapshotOutcome {
  const guard = classifyDisposableDbPath(dbPath, cwd);
  if (!guard.ok) return refused("PATH_REFUSED", `refused: the database path ${guard.message}. Only marked disposable databases are allowed in A2-impl.`, null);
  return snapshotReadUnguarded(dbPath);
}

/**
 * Deserializes the prepared bytes into a read-only in-memory connection and
 * requires integrity_check = ok. The caller must close the returned connection.
 */
export function openSnapshot(buffer: Buffer): { db: Database.Database } | { code: "DESERIALIZE_FAILED" | "INTEGRITY_FAILED"; message: string } {
  let db: Database.Database;
  try {
    db = new Database(buffer, { readonly: true });
  } catch (error) {
    return { code: "DESERIALIZE_FAILED", message: `deserialization failed: ${(error as Error).message}` };
  }
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      db.close();
      return { code: "INTEGRITY_FAILED", message: `integrity_check reported ${rows.length} problem line(s)` };
    }
  } catch (error) {
    db.close();
    return { code: "INTEGRITY_FAILED", message: `integrity_check failed: ${(error as Error).message}` };
  }
  return { db };
}
