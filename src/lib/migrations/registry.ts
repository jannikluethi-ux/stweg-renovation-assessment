import crypto from "node:crypto";
import Database from "better-sqlite3";
import { BASELINE_0001_SQL } from "./0001_baseline.sql";
import { PINNED_BASELINE_FINGERPRINT_V1, PINNED_BASELINE_STRUCTURAL_V1, readSchemaRows, structuralTables } from "./fingerprint";
import type { ExpectedSchema, RegistryView } from "./state";

/**
 * Ordered, frozen migration registry (5A §B.1/B.3, 5B §I A2-2). A2 ships only 0001_baseline.
 * IDs are positive, contiguous integers that are never reused or renumbered. Every migration is
 * SQL only and passes the statement linter at registry load. Its checksum and expected
 * fingerprints after application are pinned constants (T-MG11).
 */

export const CHECKSUM_PREFIX_V1 = "stweg-mig-v1";
export const PINNED_0001_CHECKSUM = "0526d432e15f14e4bb3464571959c18635249acf4ed3ac32b7be12d1d3588088";

export interface MigrationDefinition {
  id: number;
  name: string;
  sql: string;
  requiresForeignKeysOff: boolean;
  expectedFingerprintAfter: string;
  expectedStructuralAfter: string;
  /** tables whose row counts this migration may change (none for 0001) */
  declaredRowCountChanges?: readonly string[];
}

export interface RegistryEntry extends MigrationDefinition {
  checksum: string;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** sha256("stweg-mig-v1\n" + name + "\n" + sql with CRLF -> LF), hex. */
export function migrationChecksum(name: string, sql: string): string {
  return crypto.createHash("sha256").update(`${CHECKSUM_PREFIX_V1}\n${name}\n${sql.replace(/\r\n/g, "\n")}`).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Statement linter
// ---------------------------------------------------------------------------------------------

/** Statements the runner owns; migration SQL must never contain them (no PRAGMA allowlist in A2). */
export const FORBIDDEN_STATEMENTS = ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "VACUUM", "ATTACH", "DETACH", "PRAGMA"] as const;
export const PRAGMA_ALLOWLIST: readonly string[] = [];

type Token = { kind: "word"; value: string } | { kind: "semi" } | { kind: "other" };

/** Minimal SQLite tokenizer: skips whitespace, comments and quoted strings/identifiers. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new RegistryError("unterminated block comment");
      i = end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new RegistryError("unterminated quoted string or identifier");
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      tokens.push({ kind: "other" });
      i = j + 1;
    } else if (c === ";") {
      tokens.push({ kind: "semi" });
      i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      tokens.push({ kind: "word", value: sql.slice(i, j).toUpperCase() });
      i = j;
    } else {
      tokens.push({ kind: "other" });
      i += 1;
    }
  }
  return tokens;
}

/** Splits into statements (CREATE TRIGGER bodies BEGIN ... END stay inside their statement) and returns each statement's leading keyword(s). */
export function statementHeads(sql: string): string[][] {
  const statements: string[][] = [];
  let current: Token[] = [];
  let inTriggerBody = false;
  const words = () => current.filter((t): t is Extract<Token, { kind: "word" }> => t.kind === "word").map((t) => t.value);
  for (const t of tokenize(sql)) {
    if (t.kind === "semi") {
      if (inTriggerBody) {
        // a ';' inside the trigger body; the body ends at "END ;"
        const w = words();
        if (w[w.length - 1] === "END" && current[current.length - 1]?.kind === "word") {
          inTriggerBody = false;
          statements.push(w);
          current = [];
        } else {
          current.push(t);
        }
        continue;
      }
      if (current.length) statements.push(words());
      current = [];
      continue;
    }
    current.push(t);
    if (!inTriggerBody && t.kind === "word" && t.value === "BEGIN") {
      const w = words();
      const isTrigger = w[0] === "CREATE" && (w[1] === "TRIGGER" || ((w[1] === "TEMP" || w[1] === "TEMPORARY") && w[2] === "TRIGGER"));
      if (isTrigger) inTriggerBody = true;
    }
  }
  if (inTriggerBody) throw new RegistryError("unterminated CREATE TRIGGER body");
  if (current.length) statements.push(words());
  return statements.filter((w) => w.length > 0);
}

export interface LintFinding {
  statement: number;
  keyword: string;
}

/** Returns forbidden statements (by 1-based statement index); an empty array means the SQL is acceptable. */
export function lintMigrationSql(sql: string): LintFinding[] {
  const findings: LintFinding[] = [];
  statementHeads(sql).forEach((w, idx) => {
    let head = w[0];
    // EXPLAIN [QUERY PLAN] <stmt>: lint the wrapped statement too
    if (head === "EXPLAIN") head = w[1] === "QUERY" ? w[3] : w[1];
    if ((FORBIDDEN_STATEMENTS as readonly string[]).includes(head)) {
      if (head === "PRAGMA" && PRAGMA_ALLOWLIST.includes(w[1] ?? "")) return;
      findings.push({ statement: idx + 1, keyword: head === "PRAGMA" ? `PRAGMA ${w[1] ?? ""}`.trim() : head });
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const NAME_RE = /^(\d{4})_[a-z0-9_]+$/;

/** Validates and freezes a list of migration definitions (used for the real registry and for test registries). */
export function buildRegistry(definitions: readonly MigrationDefinition[]): readonly RegistryEntry[] {
  const seen = new Set<string>();
  const entries = definitions.map((d, index) => {
    if (!Number.isInteger(d.id) || d.id !== index + 1) throw new RegistryError(`migration ids must be contiguous from 1: position ${index + 1} has id ${d.id}`);
    const m = NAME_RE.exec(d.name);
    if (!m || Number(m[1]) !== d.id) throw new RegistryError(`migration ${d.id}: name ${d.name} must be NNNN_snake_case with NNNN = id`);
    if (seen.has(d.name)) throw new RegistryError(`duplicate migration name ${d.name}`);
    seen.add(d.name);
    const findings = lintMigrationSql(d.sql);
    if (findings.length) throw new RegistryError(`migration ${d.name}: forbidden statement(s): ${findings.map((f) => `#${f.statement} ${f.keyword}`).join(", ")}`);
    if (!/^[0-9a-f]{64}$/.test(d.expectedFingerprintAfter) || !/^[0-9a-f]{64}$/.test(d.expectedStructuralAfter)) throw new RegistryError(`migration ${d.name}: expected fingerprints must be sha256 hex`);
    return Object.freeze({ ...d, checksum: migrationChecksum(d.name, d.sql) });
  });
  return Object.freeze(entries);
}

export const MIGRATIONS: readonly RegistryEntry[] = buildRegistry([
  {
    id: 1,
    name: "0001_baseline",
    sql: BASELINE_0001_SQL,
    requiresForeignKeysOff: false,
    expectedFingerprintAfter: PINNED_BASELINE_FINGERPRINT_V1,
    expectedStructuralAfter: PINNED_BASELINE_STRUCTURAL_V1,
  },
]);

if (MIGRATIONS[0].checksum !== PINNED_0001_CHECKSUM) {
  throw new RegistryError(`0001_baseline checksum ${MIGRATIONS[0].checksum} differs from the pinned ${PINNED_0001_CHECKSUM}: applied migrations are immutable`);
}

/**
 * Reference rows/structure after migrations 1..k, computed in a private in-memory DB.
 * Used only for names-only diffs; the authoritative expectations are the pinned hashes.
 */
function referenceAfter(entries: readonly RegistryEntry[], k: number): Pick<ExpectedSchema, "rows" | "tables"> {
  const db = new Database(":memory:");
  try {
    for (const e of entries.slice(0, k)) db.exec(e.sql);
    return { rows: readSchemaRows(db), tables: structuralTables(db) };
  } finally {
    db.close();
  }
}

/** State-detection view of a registry (the legacy baseline is what 0001 adopts). */
export function registryView(entries: readonly RegistryEntry[] = MIGRATIONS): RegistryView {
  const cache = new Map<number, ExpectedSchema>();
  const expectedAfter = (k: number): ExpectedSchema => {
    const e = entries[k - 1];
    if (!e || e.id !== k) throw new RegistryError(`registry has no migration ${k}`);
    let v = cache.get(k);
    if (!v) {
      v = { fingerprint: e.expectedFingerprintAfter, structural: e.expectedStructuralAfter, ...referenceAfter(entries, k) };
      cache.set(k, v);
    }
    return v;
  };
  return {
    entries: entries.map((e) => ({ id: e.id, name: e.name, checksum: e.checksum })),
    expectedAfter,
    get legacyBaseline() {
      return expectedAfter(1);
    },
  };
}
