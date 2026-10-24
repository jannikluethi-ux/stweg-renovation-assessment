import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { isInside } from "./config";

/**
 * Uploads tree manifest and upload-reference verification (Workshop 5B §G.3).
 *
 * Read-only: files are lstat-ed and read for hashing only. Nothing is ever
 * created, moved, rewritten or deleted here. Orphans (files with no
 * reference) are listed, never deleted (D-13, D-28).
 */

export interface UploadFileEntry {
  relpath: string;
  kind: "file";
  size: number;
  sha256: string;
  ino: string;
}
export interface UploadSymlinkEntry {
  relpath: string;
  kind: "symlink";
  target: string;
  flagged: true;
}
export interface UploadOtherEntry {
  relpath: string;
  kind: "other";
  flagged: true;
}
export type UploadEntry = UploadFileEntry | UploadSymlinkEntry | UploadOtherEntry;

export interface UploadsTree {
  root: string;
  exists: boolean;
  entries: UploadEntry[];
}

export function sha256OfFile(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Walks the uploads tree without following symlinks. Sorted by relpath. */
export function uploadsTree(root: string): UploadsTree {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root, exists: false, entries: [] };
    throw error;
  }
  if (!st.isDirectory()) throw new Error("the uploads path is not a directory (symlinks are not followed)");
  const entries: UploadEntry[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const e = fs.lstatSync(full, { bigint: true });
      if (e.isSymbolicLink()) entries.push({ relpath: rel, kind: "symlink", target: fs.readlinkSync(full), flagged: true });
      else if (e.isDirectory()) walk(full);
      else if (e.isFile()) entries.push({ relpath: rel, kind: "file", size: Number(e.size), sha256: sha256OfFile(full), ino: String(e.ino) });
      else entries.push({ relpath: rel, kind: "other", flagged: true });
    }
  };
  walk(root);
  entries.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  return { root, exists: true, entries };
}

/** Content comparison (relpath, kind, size, sha256 or link target). Inodes are not compared (copies have new inodes). */
export function compareUploadTrees(expected: UploadsTree, actual: UploadsTree): string[] {
  const problems: string[] = [];
  if (expected.exists !== actual.exists) problems.push(`uploads dir ${expected.exists ? "missing" : "unexpectedly present"}`);
  const key = (e: UploadEntry) => (e.kind === "file" ? `file ${e.size} ${e.sha256}` : e.kind === "symlink" ? `symlink -> ${e.target}` : "other");
  const a = new Map(expected.entries.map((e) => [e.relpath, key(e)]));
  const b = new Map(actual.entries.map((e) => [e.relpath, key(e)]));
  for (const [rel, k] of a) {
    if (!b.has(rel)) problems.push(`missing: ${rel}`);
    else if (b.get(rel) !== k) problems.push(`content differs: ${rel}`);
  }
  for (const rel of b.keys()) if (!a.has(rel)) problems.push(`unexpected: ${rel}`);
  return problems;
}

export interface ReferenceResult {
  table: "documents" | "photos";
  rowId: string;
  reference: string;
  resolvedRelpath: string | null;
  exists: boolean;
  sha256: string | null;
  size: number | null;
  ok: boolean;
  problem: string | null;
}

export interface ReferenceVerification {
  ok: boolean;
  references: ReferenceResult[];
  files: Array<{ relpath: string; sha256: string; size: number; referenceCount: number }>;
  orphans: string[];
  flagged: string[];
  problems: string[];
}

/**
 * Resolves one storage_reference against the uploads root:
 * absolute paths and lexical escapes fail (same lexical rule as
 * assertInsideUploads, repo.ts, plus: absolute references are rejected),
 * then realpath containment and lstat "regular file, not a symlink" (closes F14 for verification).
 */
export function resolveReference(root: string, reference: string): { ok: true; absolute: string; relpath: string } | { ok: false; problem: string } {
  if (typeof reference !== "string" || reference === "") return { ok: false, problem: "empty reference" };
  if (reference.includes("\0")) return { ok: false, problem: "reference contains NUL" };
  if (path.isAbsolute(reference)) return { ok: false, problem: "absolute reference" };
  const lexRoot = path.resolve(root);
  const target = path.resolve(lexRoot, reference);
  if (!isInside(target, lexRoot)) return { ok: false, problem: "reference escapes the uploads root (lexical)" };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return { ok: false, problem: "missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, problem: "reference is a symlink" };
  if (!st.isFile()) return { ok: false, problem: "reference is not a regular file" };
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(target);
    realRoot = fs.realpathSync(lexRoot);
  } catch {
    return { ok: false, problem: "realpath failed" };
  }
  if (!isInside(real, realRoot)) return { ok: false, problem: "reference escapes the uploads root (realpath)" };
  return { ok: true, absolute: target, relpath: path.relative(realRoot, real) };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(name) === 1;
}

/** Reads references from a (disposable copy) DB connection and verifies them against an uploads tree. */
export function verifyReferences(db: Database.Database, root: string, tree: UploadsTree = uploadsTree(root)): ReferenceVerification {
  const references: ReferenceResult[] = [];
  const counts = new Map<string, number>();
  for (const t of ["documents", "photos"] as const) {
    if (!tableExists(db, t)) continue;
    const rows = db.prepare(`SELECT id, storage_reference FROM ${t} ORDER BY id`).all() as Array<{ id: string; storage_reference: string }>;
    for (const row of rows) {
      const r = resolveReference(root, row.storage_reference);
      if (!r.ok) {
        references.push({ table: t, rowId: row.id, reference: row.storage_reference, resolvedRelpath: null, exists: r.problem !== "missing" && r.problem !== "empty reference", sha256: null, size: null, ok: false, problem: r.problem });
        continue;
      }
      const size = fs.lstatSync(r.absolute).size;
      references.push({ table: t, rowId: row.id, reference: row.storage_reference, resolvedRelpath: r.relpath, exists: true, sha256: sha256OfFile(r.absolute), size, ok: true, problem: null });
      counts.set(r.relpath, (counts.get(r.relpath) ?? 0) + 1);
    }
  }
  const files = tree.entries.filter((e): e is UploadFileEntry => e.kind === "file").map((e) => ({ relpath: e.relpath, sha256: e.sha256, size: e.size, referenceCount: counts.get(e.relpath) ?? 0 }));
  const orphans = files.filter((f) => f.referenceCount === 0).map((f) => f.relpath);
  const flagged = tree.entries.filter((e) => e.kind !== "file").map((e) => `${e.kind}: ${e.relpath}`);
  const problems = references.filter((r) => !r.ok).map((r) => `${r.table}/${r.rowId}: ${r.problem}`);
  // a reference whose content hash differs from the tree entry means the tree changed between the two reads
  for (const r of references) {
    if (!r.ok || !r.resolvedRelpath) continue;
    const entry = tree.entries.find((e) => e.relpath === r.resolvedRelpath);
    if (!entry || entry.kind !== "file" || entry.sha256 !== r.sha256) problems.push(`${r.table}/${r.rowId}: content differs from the uploads manifest`);
  }
  return { ok: problems.length === 0, references, files, orphans, flagged, problems };
}
