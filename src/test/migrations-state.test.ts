import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ConfigError } from "../lib/config";
import {
  PINNED_BASELINE_FINGERPRINT_V1,
  PINNED_BASELINE_STRUCTURAL_V1,
  canonicalFingerprintDocument,
  fingerprintV1,
  includedInFingerprint,
  readSchemaRows,
  structuralDiff,
  structuralTables,
  structuralV1,
} from "../lib/migrations/fingerprint";
import { guardedSnapshotRead, setSnapshotHooksForTests, snapshotReadUnguarded, validateHeader } from "../lib/migrations/snapshot-read";
import { HISTORY_TABLE_SQL, detectState, formatStatus, snapshotStatus } from "../lib/migrations/state";
import { SCHEMA_SQL } from "../lib/schema";
import { FIXTURE_CHECKSUM, addHistory, createDbFile, dirState, fixtureChecksum, fixtureRegistry, memoryDb, sha256File, variantSql } from "./fixtures/schema-fixtures";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * A2-1: fingerprint v1, structural v1, byte-copy snapshot read (rev1 §C.4) and
 * state detection. Synthetic DBs only: in memory or in marked disposable dirs.
 */

const REAL_DATA = path.join(process.cwd(), "data");
const realBefore = fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none";
after(() => assert.equal(fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none", realBefore, "checkout data/ must be unchanged"));

const REG = fixtureRegistry();
const stateOf = (db: Database.Database) => detectState(db, REG);

function disposable() {
  const h = withTempEnv();
  return { dir: h.dir, db: path.join(h.dir, "t.db"), cleanup: h.cleanup };
}

/** Counts main-file reads during fn (test hook, test mode only). */
function countingReads<T>(fn: () => T): { value: T; reads: number } {
  let reads = 0;
  const restore = setSnapshotHooksForTests({ onMainRead: () => { reads += 1; } });
  try {
    return { value: fn(), reads };
  } finally {
    restore();
  }
}

describe("A2-1 pinned values (S-ALL 7)", () => {
  it("fresh in-memory init of HEAD SCHEMA_SQL equals the pinned fingerprint v1 and structural v1", () => {
    const db = memoryDb(SCHEMA_SQL);
    const fp = fingerprintV1(db);
    assert.equal(fp.sha256, PINNED_BASELINE_FINGERPRINT_V1);
    assert.equal(fp.rows, 55);
    assert.equal(fp.bytes, 16511);
    assert.equal(structuralV1(db).sha256, PINNED_BASELINE_STRUCTURAL_V1);
    assert.equal(stateOf(db).state, "LEGACY_BASELINE");
    db.close();
  });
  it("fresh file init in WAL mode, read by snapshot: same pinned values, LEGACY_BASELINE", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL, { wal: true });
      const r = snapshotStatus(d.db, REG);
      assert.equal(r.ok && r.report?.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(r.ok && r.report?.structural, PINNED_BASELINE_STRUCTURAL_V1);
      assert.equal(r.ok && r.state, "LEGACY_BASELINE");
      assert.equal(r.exitCode, 0);
    } finally {
      d.cleanup();
    }
  });
});

describe("T-FP fingerprint rules", () => {
  it("T-FP01 sqlite_stat1 present (ANALYZE): fingerprint and structural unchanged", () => {
    const db = memoryDb(SCHEMA_SQL);
    db.exec("INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('o1', 'x', 'c', 'p', 'n', 'n'); ANALYZE;");
    assert.ok(readSchemaRows(db).some((r) => r.name === "sqlite_stat1"));
    assert.equal(fingerprintV1(db).sha256, PINNED_BASELINE_FINGERPRINT_V1);
    assert.equal(structuralV1(db).sha256, PINNED_BASELINE_STRUCTURAL_V1);
    db.close();
  });
  it("T-FP02 includedInFingerprint rules X1–X4 on synthetic rows", () => {
    const r = (name: string, tbl_name = name) => ({ name, tbl_name });
    assert.equal(includedInFingerprint(r("schema_migrations")), false);
    assert.equal(includedInFingerprint(r("sqlite_autoindex_schema_migrations_1", "schema_migrations")), false);
    assert.equal(includedInFingerprint(r("idx_history", "schema_migrations")), false);
    assert.equal(includedInFingerprint(r("trg_history", "schema_migrations")), false);
    assert.equal(includedInFingerprint(r("sqlite_autoindex_users_1", "users")), true);
    assert.equal(includedInFingerprint(r("sqlite_sequence")), false);
    assert.equal(includedInFingerprint(r("sqlite_stat1")), false);
    assert.equal(includedInFingerprint(r("sqlite_stat4")), false);
    assert.equal(includedInFingerprint(r("users")), true);
    assert.equal(includedInFingerprint(r("idx_audit_org", "audit_logs")), true);
  });
  it("T-FP03 extra index or trigger on schema_migrations, or altered history DDL: INCONSISTENT", () => {
    const variants: Array<[string, (db: Database.Database) => void]> = [
      ["extra index", (db) => { addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }]); db.exec("CREATE INDEX idx_hist_kind ON schema_migrations(kind)"); }],
      ["extra trigger", (db) => { addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }]); db.exec("CREATE TRIGGER trg_hist AFTER INSERT ON schema_migrations BEGIN SELECT 1; END"); }],
      ["altered DDL", (db) => addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }], 1, HISTORY_TABLE_SQL.replace("runner_version TEXT NOT NULL", "runner_version TEXT"))],
    ];
    for (const [label, mutate] of variants) {
      const db = memoryDb(SCHEMA_SQL);
      mutate(db);
      assert.equal(fingerprintV1(db).sha256, PINNED_BASELINE_FINGERPRINT_V1, `${label}: excluded from the fingerprint (X1)`);
      const s = stateOf(db);
      assert.equal(s.state, "INCONSISTENT", label);
      db.close();
    }
    const ok = memoryDb(SCHEMA_SQL);
    addHistory(ok, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }]);
    assert.equal(stateOf(ok).state, "MANAGED_CURRENT");
    ok.close();
  });
  it("T-FP04 UNIQUE removed from users.email: fingerprint and structural differ", () => {
    const db = memoryDb(variantSql("  email TEXT NOT NULL UNIQUE,", "  email TEXT NOT NULL,"));
    assert.notEqual(fingerprintV1(db).sha256, PINNED_BASELINE_FINGERPRINT_V1);
    assert.notEqual(structuralV1(db).sha256, PINNED_BASELINE_STRUCTURAL_V1);
    assert.equal(stateOf(db).state, "LEGACY_UNKNOWN");
    db.close();
  });
  it("T-FP05 whitespace-only change differs; CRLF-only change equal; IF NOT EXISTS variant equal", () => {
    const ws = memoryDb(variantSql("  name TEXT NOT NULL,\n  email", "  name  TEXT NOT NULL,\n  email"));
    assert.notEqual(fingerprintV1(ws).sha256, PINNED_BASELINE_FINGERPRINT_V1);
    ws.close();
    const crlf = memoryDb(SCHEMA_SQL.replace(/\n/g, "\r\n"));
    assert.ok(readSchemaRows(crlf).some((r) => r.sql?.includes("\r\n")), "fixture really stores CRLF");
    assert.equal(fingerprintV1(crlf).sha256, PINNED_BASELINE_FINGERPRINT_V1);
    crlf.close();
    const plain = memoryDb(SCHEMA_SQL.replace(/ IF NOT EXISTS/g, ""));
    assert.equal(fingerprintV1(plain).sha256, PINNED_BASELINE_FINGERPRINT_V1);
    plain.close();
  });
  it("T-FP06 user_version, application_id, page_size, journal_mode differ: fingerprint equal; state reacts per §E.4", () => {
    const d = disposable();
    try {
      const cases: Array<[string, Parameters<typeof createDbFile>[2], string]> = [
        ["uv", { userVersion: 3 }, "INCONSISTENT"],
        ["appid", { applicationId: 1234 }, "INCONSISTENT"],
        ["page", { pageSize: 8192 }, "LEGACY_BASELINE"],
        ["delete-mode", { wal: false }, "LEGACY_BASELINE"],
        ["wal-mode", { wal: true }, "LEGACY_BASELINE"],
      ];
      for (const [label, opts, expected] of cases) {
        const file = path.join(d.dir, `${label}.db`);
        createDbFile(file, SCHEMA_SQL, opts);
        const r = snapshotStatus(file, REG);
        assert.ok(r.ok && r.report, label);
        assert.equal(r.report.fingerprint, PINNED_BASELINE_FINGERPRINT_V1, label);
        assert.equal(r.state, expected, label);
        if (label === "page") assert.equal(r.report.pageSize, 8192);
      }
    } finally {
      d.cleanup();
    }
  });
  it("T-FP07 added view or trigger: fingerprint differs, LEGACY_UNKNOWN", () => {
    for (const extra of ["CREATE VIEW v_orgs AS SELECT id FROM organizations;", "CREATE TRIGGER trg_orgs AFTER INSERT ON organizations BEGIN SELECT 1; END;"]) {
      const db = memoryDb(SCHEMA_SQL + extra);
      assert.notEqual(fingerprintV1(db).sha256, PINNED_BASELINE_FINGERPRINT_V1, extra);
      const s = stateOf(db);
      assert.equal(s.state, "LEGACY_UNKNOWN");
      assert.ok(s.diff.some((l) => /unexpected/.test(l)), s.diff.join("\n"));
      db.close();
    }
  });
  it("T-FP08 structural diff names table and property; never data", () => {
    const base = memoryDb(SCHEMA_SQL);
    const changed = memoryDb(variantSql("  email TEXT NOT NULL UNIQUE,", "  email TEXT NOT NULL,"));
    changed.exec("INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('o1', 'SENTINEL_ROW_VALUE', 'c', 'p', 'n', 'n')");
    const diff = structuralDiff(structuralTables(base), structuralTables(changed));
    assert.ok(diff.some((l) => /^table users: index sqlite_autoindex_users_\d missing$/.test(l)), diff.join("\n"));
    assert.equal(diff.join("\n").includes("SENTINEL"), false);
    base.close();
    changed.close();
  });
  it("canonical document: header, one JSON row per line, trailing newline, byte-order sort", () => {
    const db = memoryDb(SCHEMA_SQL);
    const doc = canonicalFingerprintDocument(readSchemaRows(db));
    assert.ok(doc.startsWith("stweg-schema-fp-v1\n["));
    assert.ok(doc.endsWith("]\n"));
    const lines = doc.split("\n").slice(1, -1);
    const keys = lines.map((l) => JSON.parse(l) as string[]).map((r) => `${r[0]}\u0000${r[1]}`);
    assert.deepEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))), keys);
    db.close();
  });
});

describe("T-ST byte-copy snapshot read (library level; rev1 §C.4)", () => {
  it("T-ST01 / T-ST08 WAL DB with a 0-byte -wal: state determined; no new files; sha, size, mtime, inode unchanged", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL, { wal: true });
      fs.writeFileSync(`${d.db}-wal`, "");
      const before = dirState(d.dir);
      const { value: r, reads } = countingReads(() => snapshotStatus(d.db, REG));
      assert.equal(r.ok && r.state, "LEGACY_BASELINE");
      assert.equal(reads, 2, "main file read twice (double read), nothing else");
      assert.equal(dirState(d.dir), before);
      assert.equal(fs.statSync(`${d.db}-wal`).size, 0);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST02 (superseded by rev1) / T-ST09 non-empty -wal held by a writer: UNDETERMINABLE_WAL_PENDING, exit 6, main file not read, nothing changed", () => {
    const d = disposable();
    const writer = new Database(path.join(d.dir, "t.db"));
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.exec(SCHEMA_SQL);
      writer.exec("CREATE TABLE only_in_wal (x)");
      assert.ok(fs.statSync(`${d.db}-wal`).size > 0, "fixture has WAL frames");
      const before = dirState(d.dir);
      const { value: r, reads } = countingReads(() => snapshotStatus(d.db, REG));
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.code, "UNDETERMINABLE_WAL_PENDING");
      assert.equal(r.exitCode, 6);
      assert.equal(reads, 0, "main file must not be read");
      assert.equal(dirState(d.dir), before);
      assert.match(formatStatus(r), /state: UNDETERMINABLE_WAL_PENDING[\s\S]*exit: 6/);
    } finally {
      writer.close();
      d.cleanup();
    }
  });
  it("T-ST09b non-empty -wal next to a main file that alone looks like LEGACY_BASELINE (copied WAL): still exit 6", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      fs.writeFileSync(`${d.db}-wal`, Buffer.alloc(4096, 7));
      const r = snapshotStatus(d.db, REG);
      assert.equal(r.exitCode, 6);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST03 / T-ST11 main file modified between the reads (hook): CHANGED_DURING_READ, exit 2", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const restore = setSnapshotHooksForTests({ betweenReads: (p) => { const b = fs.readFileSync(p); b[200] ^= 0xff; fs.writeFileSync(p, b); } });
      try {
        const r = snapshotStatus(d.db, REG);
        assert.equal(!r.ok && r.code, "CHANGED_DURING_READ");
        assert.equal(r.exitCode, 2);
      } finally {
        restore();
      }
      // same size, content changed, times restored: the second hash catches it
      const restore2 = setSnapshotHooksForTests({
        betweenReads: (p) => {
          const st = fs.statSync(p);
          const b = fs.readFileSync(p);
          b[300] ^= 0xff;
          fs.writeFileSync(p, b);
          fs.utimesSync(p, st.atime, st.mtime);
        },
      });
      try {
        const r = snapshotStatus(d.db, REG);
        assert.equal(!r.ok && r.code, "CHANGED_DURING_READ");
      } finally {
        restore2();
      }
    } finally {
      d.cleanup();
    }
  });
  it("T-ST04 DELETE-mode file and WAL-header file both work; header patch only in memory (file sha unchanged)", () => {
    const d = disposable();
    try {
      for (const wal of [false, true]) {
        const file = path.join(d.dir, `m${wal}.db`);
        createDbFile(file, SCHEMA_SQL, { wal });
        const raw = fs.readFileSync(file);
        assert.deepEqual([raw[18], raw[19]], wal ? [2, 2] : [1, 1]);
        const sha = sha256File(file);
        const outcome = snapshotReadUnguarded(file);
        assert.equal(outcome.kind, "bytes");
        if (outcome.kind === "bytes") {
          assert.deepEqual([outcome.buffer[18], outcome.buffer[19]], [1, 1]);
          assert.equal(outcome.header.journalModeFromHeader, wal ? "wal" : "rollback");
          assert.equal(outcome.sha256, sha, "reported sha is of the unpatched file");
        }
        assert.equal(snapshotStatus(file, REG).exitCode, 0);
        assert.equal(sha256File(file), sha);
        assert.deepEqual([fs.readFileSync(file)[18], fs.readFileSync(file)[19]], wal ? [2, 2] : [1, 1]);
      }
    } finally {
      d.cleanup();
    }
  });
  it("T-ST05 status output contains no row values", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL + "INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('SENTINEL_ID_1', 'SENTINEL_NAME_2', 'SENTINEL_C', 'SENTINEL_P', 'n', 'n');");
      const r = snapshotStatus(d.db, REG);
      const text = formatStatus(r) + JSON.stringify(r);
      assert.equal(r.ok && r.state, "LEGACY_BASELINE");
      assert.equal(/SENTINEL/.test(text), false);
      const drift = path.join(d.dir, "drift.db");
      createDbFile(drift, variantSql("  email TEXT NOT NULL UNIQUE,", "  email TEXT NOT NULL,") + "INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('SENTINEL_ID_3', 'SENTINEL_NAME_4', 'SENTINEL_C', 'SENTINEL_P', 'n', 'n');");
      const r2 = snapshotStatus(drift, REG);
      assert.equal(/SENTINEL/.test(formatStatus(r2) + JSON.stringify(r2)), false);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST06 / T-ST10 -journal present (0 bytes and non-empty): JOURNAL_PRESENT, exit 2, main not read", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      for (const content of ["", "x".repeat(512)]) {
        fs.writeFileSync(`${d.db}-journal`, content);
        const { value: r, reads } = countingReads(() => snapshotStatus(d.db, REG));
        assert.equal(!r.ok && r.code, "JOURNAL_PRESENT");
        assert.equal(r.exitCode, 2);
        assert.equal(reads, 0);
      }
    } finally {
      d.cleanup();
    }
  });
  it("T-ST07 -wal absent: state determined; file sha and mtime unchanged; no new files", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL, { wal: true });
      assert.equal(fs.existsSync(`${d.db}-wal`), false);
      const before = dirState(d.dir);
      const r = snapshotStatus(d.db, REG);
      assert.equal(r.ok && r.state, "LEGACY_BASELINE");
      assert.equal(dirState(d.dir), before);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST12 -wal appears, or a 0-byte -wal changes, during the read (hook): CHANGED_DURING_READ", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      let restore = setSnapshotHooksForTests({ betweenReads: (p) => fs.writeFileSync(`${p}-wal`, "") });
      try {
        assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "CHANGED_DURING_READ");
      } finally {
        restore();
      }
      // now present and 0 bytes; grows during the read
      restore = setSnapshotHooksForTests({ betweenReads: (p) => fs.writeFileSync(`${p}-wal`, "abc") });
      try {
        assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "CHANGED_DURING_READ");
      } finally {
        restore();
      }
      fs.writeFileSync(`${d.db}-wal`, "");
      // replaced by a new 0-byte file (new inode)
      restore = setSnapshotHooksForTests({ betweenReads: (p) => { fs.renameSync(`${p}-wal`, `${p}-old-wal`); fs.writeFileSync(`${p}-wal`, ""); } });
      try {
        assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "CHANGED_DURING_READ");
      } finally {
        restore();
      }
      // disappears during the read
      restore = setSnapshotHooksForTests({ betweenReads: (p) => fs.renameSync(`${p}-wal`, `${p}-gone-wal`) });
      try {
        assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "CHANGED_DURING_READ");
      } finally {
        restore();
      }
    } finally {
      d.cleanup();
    }
  });
  it("BAD_SIDECAR: -wal is a symlink or a directory", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      fs.mkdirSync(`${d.db}-wal`);
      // the path guard already refuses a non-regular sidecar; the snapshot layer refuses it independently
      assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "PATH_REFUSED");
      assert.equal((snapshotReadUnguarded(d.db) as { code?: string }).code, "BAD_SIDECAR");
      fs.rmdirSync(`${d.db}-wal`);
      fs.symlinkSync(path.join(d.dir, "nowhere"), `${d.db}-wal`);
      // a dangling symlinked sidecar passes the path guard; the snapshot layer refuses it
      assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "BAD_SIDECAR");
      const r = snapshotReadUnguarded(d.db);
      assert.equal(r.kind === "refused" && r.code, "BAD_SIDECAR");
      assert.equal(r.kind === "refused" && r.exitCode, 2);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST13 non-SQLite file; header shorter than 100 bytes", () => {
    const d = disposable();
    try {
      fs.writeFileSync(d.db, Buffer.alloc(4096, 0x41));
      assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "NOT_SQLITE");
      fs.writeFileSync(d.db, Buffer.from("SQLite format 3\0short"));
      assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "HEADER_INVALID");
    } finally {
      d.cleanup();
    }
  });
  it("T-ST14 bytes 18/19 = 3; page size 1000; page size 256", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const good = fs.readFileSync(d.db);
      const cases: Array<[(b: Buffer) => void, string]> = [
        [(b) => { b[18] = 3; }, "FORMAT_VERSION_INVALID"],
        [(b) => { b[19] = 3; }, "FORMAT_VERSION_INVALID"],
        [(b) => b.writeUInt16BE(1000, 16), "PAGE_SIZE_INVALID"],
        [(b) => b.writeUInt16BE(256, 16), "PAGE_SIZE_INVALID"],
      ];
      for (const [mutate, code] of cases) {
        const b = Buffer.from(good);
        mutate(b);
        fs.writeFileSync(d.db, b);
        assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, code);
      }
      const v = validateHeader(good);
      assert.equal("pageSize" in v && v.pageSize, 4096);
      const b64k = Buffer.from(good);
      b64k.writeUInt16BE(1, 16);
      assert.equal("code" in validateHeader(b64k) && (validateHeader(b64k) as { code: string }).code, "SIZE_NOT_PAGE_MULTIPLE", "1 means 65536");
    } finally {
      d.cleanup();
    }
  });
  it("T-ST15 file truncated by half a page", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      const b = fs.readFileSync(d.db);
      fs.writeFileSync(d.db, b.subarray(0, b.length - 2048));
      assert.equal((snapshotStatus(d.db, REG) as { code?: string }).code, "SIZE_NOT_PAGE_MULTIPLE");
    } finally {
      d.cleanup();
    }
  });
  it("T-ST16 corrupted b-tree page with a valid header: DESERIALIZE_FAILED or INTEGRITY_FAILED, exit 2", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL + "INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('o1', 'x', 'c', 'p', 'n', 'n');");
      const b = fs.readFileSync(d.db);
      const page = 4096;
      for (let i = page; i < page * 3; i++) b[i] = (i * 31) & 0xff;
      fs.writeFileSync(d.db, b);
      const r = snapshotStatus(d.db, REG);
      assert.ok(!r.ok && ["DESERIALIZE_FAILED", "INTEGRITY_FAILED"].includes(r.code), JSON.stringify(r));
      assert.equal(r.exitCode, 2);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST17 -shm present: ignored for content, recorded, never opened or changed", () => {
    const d = disposable();
    try {
      createDbFile(d.db, SCHEMA_SQL);
      fs.writeFileSync(`${d.db}-shm`, Buffer.alloc(32768, 9));
      const before = dirState(d.dir);
      const r = snapshotStatus(d.db, REG);
      assert.equal(r.ok && r.state, "LEGACY_BASELINE");
      assert.equal(r.sidecars?.shm?.size, "32768");
      assert.match(formatStatus(r), /-shm present \(32768 bytes, ignored for content\)/);
      assert.equal(dirState(d.dir), before);
    } finally {
      d.cleanup();
    }
  });
  it("T-ST18 DB path is a symlink or a directory: NOT_REGULAR_FILE (unguarded read; the guard is tested separately)", () => {
    const d = disposable();
    try {
      const target = path.join(d.dir, "real.db");
      createDbFile(target, SCHEMA_SQL);
      fs.symlinkSync(target, d.db);
      assert.equal((snapshotReadUnguarded(d.db) as { code?: string }).code, "NOT_REGULAR_FILE");
      const dir = path.join(d.dir, "dir.db");
      fs.mkdirSync(dir);
      assert.equal((snapshotReadUnguarded(dir) as { code?: string }).code, "NOT_REGULAR_FILE");
      // guarded entry point: a symlink whose target is in the same marked dir passes the guard and is refused by the snapshot layer;
      // a directory is refused by the guard itself. Both exit 2 and read nothing.
      const sym = countingReads(() => snapshotStatus(d.db, REG));
      assert.equal((sym.value as { code?: string }).code, "NOT_REGULAR_FILE");
      assert.equal(sym.value.exitCode, 2);
      assert.equal(sym.reads, 0);
      const dr = snapshotStatus(dir, REG);
      assert.equal((dr as { code?: string }).code, "PATH_REFUSED");
      assert.equal(dr.exitCode, 2);
    } finally {
      d.cleanup();
    }
  });
  it("absent and 0-byte main file: EMPTY without deserializing", () => {
    const d = disposable();
    try {
      const before = dirState(d.dir);
      const { value: r1, reads: n1 } = countingReads(() => snapshotStatus(d.db, REG));
      assert.equal(r1.ok && r1.state, "EMPTY");
      assert.equal(r1.ok && r1.read, "absent");
      assert.equal(n1, 0);
      fs.writeFileSync(d.db, "");
      const { value: r2, reads: n2 } = countingReads(() => snapshotStatus(d.db, REG));
      assert.equal(r2.ok && r2.read, "zero-bytes");
      assert.equal(n2, 0);
      assert.equal(fs.existsSync(`${d.db}-wal`) || fs.existsSync(`${d.db}-shm`) || fs.existsSync(`${d.db}-journal`), false);
      assert.notEqual(before, dirState(d.dir), "only the 0-byte file written by the test itself");
      fs.rmSync(d.db);
      assert.equal(dirState(d.dir), before, "no files created by the reads");
    } finally {
      d.cleanup();
    }
  });
  it("path guard first: default location of a fake checkout, unmarked dir, hard link: PATH_REFUSED, nothing read", () => {
    const s = makeScratchDir();
    const h = withTempEnv();
    try {
      const cwd = path.join(s.dir, "checkout");
      fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
      const protectedDb = path.join(cwd, "data", "stweg.db");
      createDbFile(protectedDb, SCHEMA_SQL);
      const unmarked = path.join(s.dir, "unmarked.db");
      createDbFile(unmarked, SCHEMA_SQL);
      const hl = path.join(h.dir, "hl.db");
      fs.linkSync(protectedDb, hl);
      const before = dirState(path.join(cwd, "data"));
      for (const target of [protectedDb, unmarked, hl]) {
        const { value: r, reads } = countingReads(() => guardedSnapshotRead(target, cwd));
        assert.equal(r.kind === "refused" && r.code, "PATH_REFUSED", target);
        assert.equal(reads, 0, target);
      }
      assert.equal(dirState(path.join(cwd, "data")), before);
    } finally {
      h.cleanup();
      s.cleanup();
    }
  });
  it("setSnapshotHooksForTests is gated on test mode", () => {
    assert.throws(() => setSnapshotHooksForTests({}, {} as NodeJS.ProcessEnv), ConfigError);
  });
});

describe("T-MG detection (library level)", () => {
  const legacyNonMatch: Array<[string, string]> = [
    ["T-MG05 missing table", SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS audit_logs \([\s\S]*?\n\);\n/, "").replace(/CREATE INDEX IF NOT EXISTS idx_audit_org[^\n]*\n/, "")],
    ["T-MG06 drift (column type changed)", variantSql("  password_hash TEXT NOT NULL,", "  password_hash BLOB NOT NULL,")],
    ["T-MG07 missing index", variantSql("CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, timestamp);", "")],
    ["T-MG07b whitespace change", variantSql("CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, timestamp);", "CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id,  timestamp);")],
    ["T-MG08 extra object", SCHEMA_SQL + "CREATE TABLE extra_thing (id TEXT);"],
  ];
  for (const [label, sql] of legacyNonMatch) {
    it(`${label}: LEGACY_UNKNOWN, status exit 2, file sha unchanged`, () => {
      assert.notEqual(sql, SCHEMA_SQL);
      const d = disposable();
      try {
        createDbFile(d.db, sql);
        const sha = sha256File(d.db);
        const r = snapshotStatus(d.db, REG);
        assert.equal(r.ok && r.state, "LEGACY_UNKNOWN");
        assert.equal(r.exitCode, 2);
        assert.ok(r.ok && r.report && r.report.diff.length > 0);
        assert.equal(sha256File(d.db), sha);
      } finally {
        d.cleanup();
      }
    });
  }
  it("T-MG16 NEWER: history has id 2, registry knows only 1", () => {
    const db = memoryDb(SCHEMA_SQL);
    addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }, { id: 2, name: "0002_future", checksum: fixtureChecksum("c2") }]);
    const s = stateOf(db);
    assert.equal(s.state, "NEWER");
    db.close();
  });
  it("T-MG17 INCONSISTENT variants (and T-MG10 checksum/name mismatch detection)", () => {
    const variants: Array<[string, (db: Database.Database) => void, RegExp]> = [
      ["user_version != history max", (db) => addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }], 0), /user_version 0/],
      ["user_version without history", (db) => db.pragma("user_version = 1"), /no schema_migrations table/],
      ["empty history", (db) => addHistory(db, [], 0), /is empty/],
      ["checksum mismatch", (db) => addHistory(db, [{ id: 1, name: "0001_baseline", checksum: fixtureChecksum("edited") }]), new RegExp(`history id 1 \\(0001_baseline\\): stored checksum ${fixtureChecksum("edited")} differs from registry checksum ${FIXTURE_CHECKSUM}`)],
      ["name mismatch", (db) => addHistory(db, [{ id: 1, name: "0001_other", checksum: FIXTURE_CHECKSUM }]), /stored name 0001_other differs/],
      ["non-contiguous ids", (db) => addHistory(db, [{ id: 2, name: "0002_x", checksum: fixtureChecksum("x"), kind: "applied" }], 2), /not contiguous/],
      ["bad kind", (db) => { db.pragma("ignore_check_constraints = ON"); addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM, kind: "forced" }]); }, /kind forced/],
      ["drift after adoption", (db) => { addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }]); db.exec("DROP INDEX idx_audit_org"); }, /drift/],
      ["checksum_alg unknown", (db) => addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM, checksumAlg: "other-alg" }]), /checksum_alg other-alg/],
      ["recorded fingerprint_after differs", (db) => addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM, fingerprintAfter: "0".repeat(64) }]), /recorded fingerprint_after differs/],
      ["orphan foreign key", (db) => { db.pragma("foreign_keys = OFF"); db.exec("INSERT INTO users (id, organization_id, name, email, password_hash, role, created_at, updated_at) VALUES ('u', 'missing-org', 'n', 'e', 'h', 'admin', 'n', 'n')"); }, /foreign_key_check reported 1/],
    ];
    for (const [label, mutate, reason] of variants) {
      const db = memoryDb(SCHEMA_SQL);
      mutate(db);
      const s = stateOf(db);
      assert.equal(s.state, "INCONSISTENT", label);
      assert.match(s.reasons.join("\n"), reason, label);
      db.close();
    }
  });
  it("MANAGED_PENDING when the registry is ahead; EMPTY for a schema-less DB", () => {
    const db = memoryDb(SCHEMA_SQL);
    addHistory(db, [{ id: 1, name: "0001_baseline", checksum: FIXTURE_CHECKSUM }]);
    const ahead = { ...REG, entries: [...REG.entries, { id: 2, name: "0002_future", checksum: fixtureChecksum("c2") }] };
    assert.equal(detectState(db, ahead).state, "MANAGED_PENDING");
    db.close();
    const empty = new Database(":memory:");
    assert.equal(stateOf(empty).state, "EMPTY");
    empty.close();
  });
});
