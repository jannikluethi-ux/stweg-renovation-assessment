import fs from "node:fs";
import path from "node:path";

/**
 * Holder check (Workshop 5B §F.4). Linux only.
 *
 * Scans /proc/<pid>/fd/* of every process except this one and reports any
 * descriptor that refers (by device and inode, so renames and alternative
 * paths are covered) to the database file or its -wal, -shm or -journal
 * sidecar. Read-only: it only lists directories, reads links and stats them.
 *
 * Fail-closed rules (plan: "/proc unreadable → exit 2"):
 * - /proc itself not listable, or no other process's fd table readable at all
 *   → unusable (callers exit 2).
 * - individual processes whose fd tables cannot be read without privileges
 *   (EACCES/EPERM: other users' processes, or processes of this user that are
 *   not dumpable) cannot be inspected by an unprivileged runner. They are
 *   reported in `uninspectable` (pid, uid, comm) and recorded in the run log,
 *   but do not block. This is a documented limitation; the owner checklist
 *   (stop the app, record ss/ps by cwd) remains the primary control.
 */

export interface HolderTarget {
  path: string;
  dev: bigint;
  ino: bigint;
}

export interface Holder {
  pid: number;
  fd: string;
  target: string;
  comm: string;
}

export type HolderCheck =
  | { ok: true; holders: Holder[]; uninspectable: Array<{ pid: number; uid: number; comm: string }>; scanned: number }
  | { ok: false; code: "PROC_UNREADABLE"; message: string };

function statOrNull(file: string): fs.BigIntStats | null {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** The existing files among the database path and its sidecars. */
export function holderTargets(dbPath: string): HolderTarget[] {
  const out: HolderTarget[] = [];
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${dbPath}${suffix}`;
    const st = statOrNull(p);
    if (st) out.push({ path: p, dev: st.dev, ino: st.ino });
  }
  return out;
}

function readComm(procRoot: string, pid: number): string {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), "comm"), "utf8").trim();
  } catch {
    return "?";
  }
}

function ownerUid(procRoot: string, pid: number): number | null {
  try {
    return Number(fs.statSync(path.join(procRoot, String(pid))).uid);
  } catch {
    return null;
  }
}

/**
 * @param procRoot only overridable so tests can simulate an unreadable /proc;
 *        the CLIs never pass it.
 */
export function findHolders(dbPath: string, options: { procRoot?: string; selfPid?: number } = {}): HolderCheck {
  const procRoot = options.procRoot ?? "/proc";
  const selfPid = options.selfPid ?? process.pid;
  const targets = holderTargets(dbPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch (error) {
    return { ok: false, code: "PROC_UNREADABLE", message: `cannot list ${procRoot} (${(error as NodeJS.ErrnoException).code ?? "error"}); refusing (fail closed)` };
  }
  const pids = entries.filter((e) => /^[0-9]+$/.test(e)).map(Number);
  if (pids.length === 0) return { ok: false, code: "PROC_UNREADABLE", message: `${procRoot} lists no processes; refusing (fail closed)` };
  const holders: Holder[] = [];
  const uninspectable: Array<{ pid: number; uid: number; comm: string }> = [];
  let scanned = 0;
  for (const pid of pids) {
    if (pid === selfPid) continue;
    const fdDir = path.join(procRoot, String(pid), "fd");
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue; // exited during the scan
      const uid = ownerUid(procRoot, pid);
      if (uid === null) continue; // exited
      if (code !== "EACCES" && code !== "EPERM") {
        return { ok: false, code: "PROC_UNREADABLE", message: `cannot read the descriptors of process ${pid} (${code ?? "error"}); refusing (fail closed)` };
      }
      uninspectable.push({ pid, uid, comm: readComm(procRoot, pid) });
      continue;
    }
    scanned++;
    if (targets.length === 0) continue;
    for (const fd of fds) {
      const link = path.join(fdDir, fd);
      let dest: string;
      try {
        dest = fs.readlinkSync(link);
      } catch {
        continue; // closed during the scan
      }
      if (!dest.startsWith("/")) continue; // socket:, pipe:, anon_inode:
      let st: fs.BigIntStats;
      try {
        st = fs.statSync(link, { bigint: true });
      } catch {
        continue;
      }
      const hit = targets.find((t) => t.dev === st.dev && t.ino === st.ino);
      if (hit) holders.push({ pid, fd, target: hit.path, comm: readComm(procRoot, pid) });
    }
  }
  if (scanned === 0) return { ok: false, code: "PROC_UNREADABLE", message: `no process descriptors under ${procRoot} were readable; refusing (fail closed)` };
  return { ok: true, holders, uninspectable, scanned };
}

export function formatHolders(check: HolderCheck): string {
  if (!check.ok) return `holder check: ${check.code}: ${check.message}`;
  if (check.holders.length === 0) return `holder check: no other process holds the database (${check.scanned} processes scanned, ${check.uninspectable.length} not inspectable without privileges)`;
  return `holder check: held by ${check.holders.map((h) => `pid ${h.pid} (${h.comm}) fd ${h.fd} -> ${path.basename(h.target)}`).join("; ")}`;
}
