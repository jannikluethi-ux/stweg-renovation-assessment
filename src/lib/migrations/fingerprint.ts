import crypto from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Frozen schema fingerprint v1 and structural snapshot v1 (Workshop 5B §E).
 * Changing anything here changes the pinned values and breaks the freeze tests
 * on purpose. Only object names and DDL are read, never row data.
 */

export const FINGERPRINT_V1_HEADER = "stweg-schema-fp-v1\n";
export const STRUCTURAL_V1_HEADER = "stweg-schema-struct-v1\n";

/** Fresh init of the baseline schema (5B §E.6, [Probe] Q3/Q5). */
export const PINNED_BASELINE_FINGERPRINT_V1 = "ae794d4474752e266955c37d97b2eb4660262ba1661d43f9c872c0fe39b2a581";
export const PINNED_BASELINE_STRUCTURAL_V1 = "87b8feaed8a4ea2e11d43c42b558c02b1794dad7ef9189bcdefcddf4d286f321";

/** The migration history table; rule X1 keeps it (and its dependents) out of the fingerprint. */
export const HISTORY_TABLE = "schema_migrations";

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export function readSchemaRows(db: Database.Database): SchemaRow[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all() as SchemaRow[];
}

/** Rules X1–X4, applied in this order. */
export function includedInFingerprint(row: Pick<SchemaRow, "name" | "tbl_name">): boolean {
  if (row.tbl_name === HISTORY_TABLE) return false; // X1: checked separately
  if (row.name.startsWith("sqlite_autoindex_")) return true; // X2
  if (row.name.startsWith("sqlite_")) return false; // X3: sqlite_sequence, sqlite_stat*, other internals
  return true; // X4
}

/** Canonical document (5B §E.3): CRLF→LF only, byte-order sort by (type, name), one JSON row per line. */
export function canonicalFingerprintDocument(rows: SchemaRow[]): string {
  const canonical = rows
    .filter(includedInFingerprint)
    .map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql === null ? null : r.sql.replace(/\r\n/g, "\n") }));
  canonical.sort((a, b) => byteCompare(a.type, b.type) || byteCompare(a.name, b.name));
  return FINGERPRINT_V1_HEADER + canonical.map((r) => JSON.stringify([r.type, r.name, r.tbl_name, r.sql])).join("\n") + "\n";
}

export interface Fingerprint {
  sha256: string;
  rows: number;
  bytes: number;
}

export function fingerprintFromRows(rows: SchemaRow[]): Fingerprint {
  const doc = canonicalFingerprintDocument(rows);
  return { sha256: sha256Hex(Buffer.from(doc, "utf8")), rows: rows.filter(includedInFingerprint).length, bytes: Buffer.byteLength(doc, "utf8") };
}

export function fingerprintV1(db: Database.Database): Fingerprint {
  return fingerprintFromRows(readSchemaRows(db));
}

export interface StructuralTable {
  table: string;
  xinfo: unknown[][];
  fks: unknown[][];
  indexes: Array<{ name: string; unique: number; origin: string; partial: number; cols: unknown[][] }>;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function structuralTables(db: Database.Database): StructuralTable[] {
  const tables = readSchemaRows(db)
    .filter(includedInFingerprint)
    .filter((r) => r.type === "table")
    .map((r) => r.name)
    .sort(byteCompare);
  return tables.map((t) => ({
    table: t,
    xinfo: (db.pragma(`table_xinfo(${quoteIdent(t)})`) as Array<Record<string, unknown>>).map((c) => [c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk, c.hidden]),
    fks: (db.pragma(`foreign_key_list(${quoteIdent(t)})`) as Array<Record<string, unknown>>)
      .map((f) => [f.id, f.seq, f.table, f.from, f.to, f.on_update, f.on_delete, f.match])
      .sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number)),
    indexes: (db.pragma(`index_list(${quoteIdent(t)})`) as Array<Record<string, unknown>>)
      .map((i) => ({
        name: i.name as string,
        unique: i.unique as number,
        origin: i.origin as string,
        partial: i.partial as number,
        cols: (db.pragma(`index_xinfo(${quoteIdent(i.name as string)})`) as Array<Record<string, unknown>>).map((c) => [c.seqno, c.cid, c.name, c.desc, c.coll, c.key]),
      }))
      .sort((a, b) => byteCompare(a.name, b.name)),
  }));
}

export function structuralDocument(tables: StructuralTable[]): string {
  return STRUCTURAL_V1_HEADER + JSON.stringify(tables) + "\n";
}

export function structuralV1(db: Database.Database): { sha256: string; tables: StructuralTable[] } {
  const tables = structuralTables(db);
  return { sha256: sha256Hex(Buffer.from(structuralDocument(tables), "utf8")), tables };
}

/**
 * Structural diff: names of tables and properties only (columns, foreign keys,
 * indexes), never row data. Used for status output on a mismatch.
 */
export function structuralDiff(expected: StructuralTable[], actual: StructuralTable[]): string[] {
  const out: string[] = [];
  const exp = new Map(expected.map((t) => [t.table, t]));
  const act = new Map(actual.map((t) => [t.table, t]));
  for (const name of [...new Set([...exp.keys(), ...act.keys()])].sort(byteCompare)) {
    const e = exp.get(name);
    const a = act.get(name);
    if (!e) { out.push(`table ${name}: unexpected`); continue; }
    if (!a) { out.push(`table ${name}: missing`); continue; }
    const cols = (t: StructuralTable) => new Map(t.xinfo.map((c) => [String(c[1]), JSON.stringify(c)]));
    const ec = cols(e); const ac = cols(a);
    for (const c of [...new Set([...ec.keys(), ...ac.keys()])].sort(byteCompare)) {
      if (!ec.has(c)) out.push(`table ${name}: column ${c} unexpected`);
      else if (!ac.has(c)) out.push(`table ${name}: column ${c} missing`);
      else if (ec.get(c) !== ac.get(c)) out.push(`table ${name}: column ${c} definition differs`);
    }
    if (JSON.stringify(e.fks) !== JSON.stringify(a.fks)) out.push(`table ${name}: foreign keys differ`);
    const ei = new Map(e.indexes.map((i) => [i.name, JSON.stringify(i)]));
    const ai = new Map(a.indexes.map((i) => [i.name, JSON.stringify(i)]));
    for (const i of [...new Set([...ei.keys(), ...ai.keys()])].sort(byteCompare)) {
      if (!ei.has(i)) out.push(`table ${name}: index ${i} unexpected`);
      else if (!ai.has(i)) out.push(`table ${name}: index ${i} missing`);
      else if (ei.get(i) !== ai.get(i)) out.push(`table ${name}: index ${i} differs`);
    }
  }
  return out;
}

/** Object-level diff of the fingerprint rows: "type name" only. */
export function objectDiff(expected: SchemaRow[], actual: SchemaRow[]): string[] {
  const key = (r: SchemaRow) => `${r.type} ${r.name}`;
  const e = new Map(expected.filter(includedInFingerprint).map((r) => [key(r), JSON.stringify([r.tbl_name, r.sql])]));
  const a = new Map(actual.filter(includedInFingerprint).map((r) => [key(r), JSON.stringify([r.tbl_name, r.sql])]));
  const out: string[] = [];
  for (const k of [...new Set([...e.keys(), ...a.keys()])].sort(byteCompare)) {
    if (!e.has(k)) out.push(`${k}: unexpected`);
    else if (!a.has(k)) out.push(`${k}: missing`);
    else if (e.get(k) !== a.get(k)) out.push(`${k}: definition differs`);
  }
  return out;
}
