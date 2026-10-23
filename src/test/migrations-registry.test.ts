import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { BASELINE_0001_SQL } from "../lib/migrations/0001_baseline.sql";
import { PINNED_BASELINE_FINGERPRINT_V1, PINNED_BASELINE_STRUCTURAL_V1, fingerprintV1, structuralV1 } from "../lib/migrations/fingerprint";
import {
  MIGRATIONS,
  PINNED_0001_CHECKSUM,
  RegistryError,
  buildRegistry,
  lintMigrationSql,
  migrationChecksum,
  registryView,
  statementHeads,
} from "../lib/migrations/registry";
import { detectState } from "../lib/migrations/state";
import { SCHEMA_SQL } from "../lib/schema";

/* A2-2: registry, frozen 0001_baseline, checksums, statement linter. In-memory DBs only. */

const PINNED_SCHEMA_SQL_SHA256 = "9c6173c0f10f144ffa2b1e28f63eb57e6cae3538e17ffe39316318f15bab4955";
const PINNED_0001_SQL_SHA256 = "c301af058b598dea31ce8671deab69fce5df71a50b4e2f851d7f1cd8c5239105";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function execFingerprints(sql: string) {
  const db = new Database(":memory:");
  try {
    db.exec(sql);
    return { fp: fingerprintV1(db).sha256, st: structuralV1(db).sha256 };
  } finally {
    db.close();
  }
}

describe("T-MG11 freeze", () => {
  it("HEAD SCHEMA_SQL sha256 is pinned (schema.ts unchanged)", () => {
    assert.equal(sha(SCHEMA_SQL), PINNED_SCHEMA_SQL_SHA256);
  });
  it("0001_baseline SQL is SCHEMA_SQL minus its PRAGMA line, byte for byte, and its sha is pinned", () => {
    assert.equal(BASELINE_0001_SQL, SCHEMA_SQL.replace("PRAGMA foreign_keys = ON;\n", ""));
    assert.equal(sha(BASELINE_0001_SQL), PINNED_0001_SQL_SHA256);
    assert.equal(/PRAGMA/i.test(BASELINE_0001_SQL), false);
  });
  it("0001 checksum = sha256('stweg-mig-v1\\n0001_baseline\\n' + sql) and is pinned", () => {
    assert.equal(migrationChecksum("0001_baseline", BASELINE_0001_SQL), PINNED_0001_CHECKSUM);
    assert.equal(MIGRATIONS[0].checksum, PINNED_0001_CHECKSUM);
    assert.equal(migrationChecksum("0001_baseline", BASELINE_0001_SQL.replace(/\n/g, "\r\n")), PINNED_0001_CHECKSUM, "CRLF -> LF");
    assert.notEqual(migrationChecksum("0001_baseline", BASELINE_0001_SQL + " "), PINNED_0001_CHECKSUM, "any other change alters the checksum");
  });
  it("HEAD SCHEMA_SQL exec = 0001 exec = pinned fingerprint v1 and structural v1 (A2-2 stop condition)", () => {
    const head = execFingerprints(SCHEMA_SQL);
    const m1 = execFingerprints(BASELINE_0001_SQL);
    assert.deepEqual(head, m1);
    assert.equal(m1.fp, PINNED_BASELINE_FINGERPRINT_V1);
    assert.equal(m1.st, PINNED_BASELINE_STRUCTURAL_V1);
    assert.equal(MIGRATIONS[0].expectedFingerprintAfter, PINNED_BASELINE_FINGERPRINT_V1);
    assert.equal(MIGRATIONS[0].expectedStructuralAfter, PINNED_BASELINE_STRUCTURAL_V1);
  });
  it("registry holds exactly 0001_baseline, frozen, FK-off not required", () => {
    assert.deepEqual(MIGRATIONS.map((m) => [m.id, m.name, m.requiresForeignKeysOff]), [[1, "0001_baseline", false]]);
    assert.ok(Object.isFrozen(MIGRATIONS) && Object.isFrozen(MIGRATIONS[0]));
  });
  it("registryView: HEAD SCHEMA_SQL DB is LEGACY_BASELINE; expectedAfter(1) is the pinned pair", () => {
    const view = registryView();
    assert.deepEqual(view.entries, [{ id: 1, name: "0001_baseline", checksum: PINNED_0001_CHECKSUM }]);
    assert.equal(view.expectedAfter(1).fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
    assert.throws(() => view.expectedAfter(2), RegistryError);
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    assert.equal(detectState(db, view).state, "LEGACY_BASELINE");
    db.close();
  });
  it("migration sources contain no file-system or network access (SQL-only, Code-inspection aid)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/migrations/0001_baseline.sql.ts"), "utf8");
    assert.equal(/\bimport\b|\brequire\(/.test(src), false);
  });
});

describe("T-MG23 statement linter", () => {
  const forbidden: Array<[string, string]> = [
    ["BEGIN;", "BEGIN"],
    ["begin immediate;", "BEGIN"],
    ["CREATE TABLE a (x); COMMIT;", "COMMIT"],
    ["END TRANSACTION;", "END"],
    ["ROLLBACK;", "ROLLBACK"],
    ["SAVEPOINT s1;", "SAVEPOINT"],
    ["RELEASE s1;", "RELEASE"],
    ["VACUUM;", "VACUUM"],
    ["vacuum into '/tmp/x.db';", "VACUUM"],
    ["ATTACH DATABASE 'x.db' AS x;", "ATTACH"],
    ["DETACH x;", "DETACH"],
    ["PRAGMA journal_mode = DELETE;", "PRAGMA JOURNAL_MODE"],
    ["PRAGMA foreign_keys = OFF;", "PRAGMA FOREIGN_KEYS"],
    ["/* c */ -- c\n  PRAGMA user_version = 9", "PRAGMA USER_VERSION"],
    ["EXPLAIN VACUUM;", "VACUUM"],
    ["CREATE TABLE a (x);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;\nPRAGMA writable_schema = 1;", "PRAGMA WRITABLE_SCHEMA"],
  ];
  for (const [sql, keyword] of forbidden) {
    it(`rejects ${JSON.stringify(sql)}`, () => {
      const f = lintMigrationSql(sql);
      assert.equal(f.length, 1, JSON.stringify(f));
      assert.equal(f[0].keyword, keyword);
    });
  }
  it("accepts DDL, trigger bodies with BEGIN … END, keywords inside strings, identifiers and comments", () => {
    const ok = [
      BASELINE_0001_SQL,
      "CREATE TABLE a (x TEXT DEFAULT 'BEGIN; PRAGMA x; VACUUM');",
      'CREATE TABLE "pragma" (x);',
      "CREATE TABLE b (y); -- VACUUM;\n/* COMMIT; */",
      "CREATE TABLE a (x); CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO a VALUES (1); UPDATE a SET x = 2; END; CREATE INDEX i ON a(x);",
      "CREATE TEMP TRIGGER t2 AFTER DELETE ON a BEGIN SELECT 1; END;",
    ];
    for (const sql of ok) assert.deepEqual(lintMigrationSql(sql), [], sql.slice(0, 60));
    assert.deepEqual(
      statementHeads("CREATE TABLE a (x); CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; SELECT 2; END; CREATE INDEX i ON a(x);").map((w) => w.slice(0, 2)),
      [["CREATE", "TABLE"], ["CREATE", "TRIGGER"], ["CREATE", "INDEX"]],
    );
  });
  it("rejected at registry load (buildRegistry throws; nothing is executed)", () => {
    const def = (sql: string) => [{ id: 1, name: "0001_x", sql, requiresForeignKeysOff: false, expectedFingerprintAfter: "a".repeat(64), expectedStructuralAfter: "b".repeat(64) }];
    assert.throws(() => buildRegistry(def("CREATE TABLE a (x); BEGIN;")), /forbidden statement\(s\): #2 BEGIN/);
    assert.throws(() => buildRegistry(def("PRAGMA journal_mode = WAL;")), /PRAGMA JOURNAL_MODE/);
    assert.throws(() => buildRegistry(def("VACUUM")), /VACUUM/);
    assert.throws(() => buildRegistry(def("CREATE TABLE a (x 'unterminated);")), RegistryError);
    assert.equal(buildRegistry(def("CREATE TABLE a (x);")).length, 1);
  });
  it("registry structure rules: contiguous ids from 1, NNNN_name matching the id, unique names, sha256 expectations", () => {
    const base = { sql: "CREATE TABLE a (x);", requiresForeignKeysOff: false, expectedFingerprintAfter: "a".repeat(64), expectedStructuralAfter: "b".repeat(64) };
    assert.throws(() => buildRegistry([{ ...base, id: 2, name: "0002_a" }]), /contiguous/);
    assert.throws(() => buildRegistry([{ ...base, id: 1, name: "0001_a" }, { ...base, id: 3, name: "0003_b" }]), /contiguous/);
    assert.throws(() => buildRegistry([{ ...base, id: 1, name: "0002_a" }]), /NNNN = id/);
    assert.throws(() => buildRegistry([{ ...base, id: 1, name: "1_A" }]), /NNNN_snake_case/);
    assert.throws(() => buildRegistry([{ ...base, id: 1, name: "0001_a", expectedFingerprintAfter: "x" }]), /sha256 hex/);
  });
});
