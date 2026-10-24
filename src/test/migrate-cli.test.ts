import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../lib/db";
import { PINNED_BASELINE_FINGERPRINT_V1, PINNED_BASELINE_STRUCTURAL_V1 } from "../lib/migrations/fingerprint";
import { MIGRATIONS } from "../lib/migrations/registry";
import { statusWithRunLog } from "../lib/migrations/runner";
import { setSnapshotHooksForTests } from "../lib/migrations/snapshot-read";
import { SCHEMA_SQL } from "../lib/schema";
import { addHistory, createDbFile, dirState, sha256File } from "./fixtures/schema-fixtures";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * A2-5: the explicit `migrate status` / `migrate apply` CLI (scripts/migrate.ts) and the
 * package.json scripts (Workshop 5B §C, §F, §I A2-5): T-ST01–06 (CLI), T-MG29–31 (status and
 * apply), T-MG10, T-MG16–17 via CLI, T-MG18R, T-MG19R, T-MG35. Synthetic databases in marked
 * temp directories only; the checkout's data/ is never passed to the CLI (the default-path
 * refusal is exercised in a fake checkout) and must be unchanged afterwards.
 */

const ROOT = process.cwd();
const REAL_DATA = path.join(ROOT, "data");
const realBefore = fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none";
after(() => assert.equal(fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none", realBefore, "checkout data/ must be unchanged"));

const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const TSCONFIG = path.join(ROOT, "tsconfig.json");
const MIGRATE = path.join(ROOT, "scripts", "migrate.ts");
const SEED = path.join(ROOT, "scripts", "seed.ts");

function run(script: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(TSX, ["--tsconfig", TSCONFIG, script, ...args], { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, encoding: "utf8", timeout: 120_000 });
}
const migrate = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => run(MIGRATE, args, opts);

/** production-like environment for a child (no test mode, no STWEG_* paths) */
function plainEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp" };
}

interface StatusJson {
  exitCode: number;
  status: { ok: boolean; state?: string; code?: string; report: { fingerprint: string; structural: string; userVersion: number; history: Array<{ id: number; name: string; kind: string; checksum: string }>; reasons: string[] } | null };
  interrupted: unknown[];
}
function statusJson(db: string): StatusJson {
  const r = migrate(["status", "--db", db, "--json"]);
  const parsed = JSON.parse(r.stdout) as StatusJson;
  assert.equal(r.status, parsed.exitCode);
  return parsed;
}
function applyJson(db: string) {
  const r = migrate(["apply", "--db", db, "--json"]);
  const parsed = JSON.parse(r.stdout) as { exitCode: number; outcome: string; message: string; stateBefore: string | null; stateAfter: string | null; applied: Array<{ name: string; kind: string }> };
  assert.equal(r.status, parsed.exitCode, r.stderr);
  return parsed;
}

/** sha, size, mtime, inode of the DB and every sidecar */
const dbFiles = (db: string) =>
  ["", "-wal", "-shm", "-journal"]
    .map((s) => {
      const f = db + s;
      if (!fs.existsSync(f)) return `${s}:absent`;
      const st = fs.lstatSync(f, { bigint: true });
      return `${s}:${sha256File(f)}:${st.size}:${st.mtimeNs}:${st.ino}`;
    })
    .join("|");

function countingReads<T>(fn: () => T): { value: T; reads: number } {
  let reads = 0;
  const restore = setSnapshotHooksForTests({ onMainRead: () => { reads += 1; } });
  try {
    return { value: fn(), reads };
  } finally {
    restore();
  }
}

/** TEST-ONLY harness edit of a synthetic fixture (never runner behaviour). */
function harnessEdit(db: string, fn: (d: Database.Database) => void) {
  const d = new Database(db, { fileMustExist: true });
  try {
    fn(d);
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------------------------

describe("A2-5 CLI basics and package.json scripts", () => {
  it("package.json: db:migrate, db:backup, db:verify-backup, db:restore point at the scripts; dependencies unchanged", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    assert.equal(pkg.scripts["db:migrate"], "tsx scripts/migrate.ts");
    assert.equal(pkg.scripts["db:backup"], "tsx scripts/db-backup.ts");
    assert.equal(pkg.scripts["db:verify-backup"], "tsx scripts/db-verify-backup.ts");
    assert.equal(pkg.scripts["db:restore"], "tsx scripts/db-restore.ts");
    for (const s of ["migrate.ts", "db-backup.ts", "db-verify-backup.ts", "db-restore.ts"]) assert.ok(fs.existsSync(path.join(ROOT, "scripts", s)), s);
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["better-sqlite3", "next", "react", "react-dom"]);
    assert.equal(Object.keys(pkg.devDependencies).length, 9);
    assert.equal(pkg.scripts.dev.includes("migrate"), false, "the app scripts never run migrations");
    assert.equal(pkg.scripts.start.includes("migrate"), false);
  });

  it("npm run db:migrate -- status/apply with an explicit disposable --db works; usage errors exit 1", () => {
    const t = withTempEnv();
    try {
      const st = spawnSync("npm", ["run", "--silent", "db:migrate", "--", "status", "--db", t.dbPath], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(st.status, 0, st.stderr);
      assert.match(st.stdout, /state: EMPTY/);
      assert.equal(fs.existsSync(t.dbPath), false, "status on a missing file creates nothing");
      const ap = spawnSync("npm", ["run", "--silent", "db:migrate", "--", "apply", "--db", t.dbPath], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(ap.status, 0, ap.stderr);
      assert.match(ap.stdout, /EMPTY -> MANAGED_CURRENT/);
      for (const args of [[], ["bogus"], ["status", "--db"], ["status", "--bogus"], ["apply", "--db", t.dbPath, "--db", t.dbPath]]) {
        assert.equal(migrate(args).status, 1, args.join(" "));
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("A2-5 T-ST01–06 via the CLI", () => {
  it("T-ST01 WAL DB with a 0-byte -wal: status determines the state; no new files; sha/size/mtime/inode unchanged", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL, { wal: true });
      fs.writeFileSync(`${t.dbPath}-wal`, "");
      const before = dirState(t.dir);
      const s = statusJson(t.dbPath);
      assert.equal(s.exitCode, 0);
      assert.equal(s.status.state, "LEGACY_BASELINE");
      assert.equal(s.status.report!.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(dirState(t.dir), before, "no new files, nothing changed (status writes no run log)");
    } finally {
      t.cleanup();
    }
  });

  it("T-ST02 (as superseded by rev1 §C.4) non-empty -wal: status and apply exit 6 UNDETERMINABLE_WAL_PENDING; nothing changed", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL);
      fs.writeFileSync(`${t.dbPath}-wal`, Buffer.alloc(4096, 7));
      const before = dbFiles(t.dbPath);
      const s = migrate(["status", "--db", t.dbPath]);
      assert.equal(s.status, 6);
      assert.match(s.stdout, /state: UNDETERMINABLE_WAL_PENDING/);
      const a = applyJson(t.dbPath);
      assert.equal(a.exitCode, 6);
      assert.equal(a.outcome, "undeterminable");
      assert.equal(dbFiles(t.dbPath), before);
    } finally {
      t.cleanup();
    }
  });

  it("T-ST03 file modified between the reads → exit 2 CHANGED_DURING_READ (hook is in-process only: exercised through statusWithRunLog, the CLI's status entry point)", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL);
      const restore = setSnapshotHooksForTests({ betweenReads: (p) => { const b = fs.readFileSync(p); b[200] ^= 0xff; fs.writeFileSync(p, b); } });
      try {
        const { status } = statusWithRunLog(t.dbPath);
        assert.equal(!status.ok && status.code, "CHANGED_DURING_READ");
        assert.equal(status.exitCode, 2);
      } finally {
        restore();
      }
    } finally {
      t.cleanup();
    }
  });

  it("T-ST04 DELETE-mode and WAL-header files: status works; header patch only in memory (file sha unchanged)", () => {
    const t = withTempEnv();
    try {
      for (const wal of [false, true]) {
        const file = path.join(t.dir, `m${wal}.db`);
        createDbFile(file, SCHEMA_SQL, { wal });
        const sha = sha256File(file);
        const s = statusJson(file);
        assert.equal(s.exitCode, 0);
        assert.equal(s.status.state, "LEGACY_BASELINE");
        assert.equal(sha256File(file), sha);
        assert.deepEqual([...fs.readFileSync(file).subarray(18, 20)], wal ? [2, 2] : [1, 1]);
      }
    } finally {
      t.cleanup();
    }
  });

  it("T-ST05 status output (text and --json) contains no row values", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL + "INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('SENTINEL_ID_1', 'SENTINEL_NAME_2', 'SENTINEL_C', 'SENTINEL_P', 'n', 'n');");
      const text = migrate(["status", "--db", t.dbPath]);
      const json = migrate(["status", "--db", t.dbPath, "--json"]);
      assert.equal(text.status, 0);
      assert.equal(/SENTINEL/.test(text.stdout + text.stderr + json.stdout + json.stderr), false);
      const a = migrate(["apply", "--db", t.dbPath, "--json"]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(/SENTINEL/.test(a.stdout + a.stderr), false);
    } finally {
      t.cleanup();
    }
  });

  it("T-ST06 -journal present (0 bytes and non-empty): status and apply refuse JOURNAL_PRESENT, exit 2; journal and main byte-identical", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL);
      for (const content of ["", "x".repeat(512)]) {
        fs.writeFileSync(`${t.dbPath}-journal`, content);
        const before = dbFiles(t.dbPath);
        for (let round = 0; round < 2; round++) {
          const s = migrate(["status", "--db", t.dbPath]);
          assert.equal(s.status, 2);
          assert.match(s.stdout, /JOURNAL_PRESENT/);
          const a = applyJson(t.dbPath);
          assert.equal(a.exitCode, 2);
          assert.match(a.message, /JOURNAL_PRESENT/);
        }
        assert.equal(dbFiles(t.dbPath), before, "the CLI never recovers, deletes or rewrites a journal");
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("A2-5 T-MG29 corrupt and orphan-FK fixtures", () => {
  it("corrupt file and orphan foreign key: status reports (exit 2), apply exit 2; files unchanged", () => {
    const t = withTempEnv();
    try {
      const corrupt = path.join(t.dir, "corrupt.db");
      createDbFile(corrupt, SCHEMA_SQL + "INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('o', 'n', 'c', 'p', 'n', 'n');");
      const b = fs.readFileSync(corrupt);
      b.fill(0xa5, 4096 + 8, 4096 + 200); // garbage inside page 2 (not the header)
      fs.writeFileSync(corrupt, b);
      const orphan = path.join(t.dir, "orphan.db");
      createDbFile(orphan, SCHEMA_SQL);
      harnessEdit(orphan, (d) => {
        d.pragma("foreign_keys = OFF");
        d.exec("INSERT INTO users (id, organization_id, name, email, password_hash, role, created_at, updated_at) VALUES ('u', 'missing-org', 'n', 'e', 'h', 'admin', 'n', 'n')");
      });
      for (const [db, pattern] of [[corrupt, /INTEGRITY_FAILED|DESERIALIZE_FAILED|REFUSED/], [orphan, /foreign_key_check reported 1/]] as const) {
        const before = dbFiles(db);
        const s = migrate(["status", "--db", db]);
        assert.equal(s.status, 2, s.stdout + s.stderr);
        assert.match(s.stdout, pattern);
        const a = applyJson(db);
        assert.equal(a.exitCode, 2);
        assert.equal(dbFiles(db), before);
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("A2-5 T-MG30–31 path guards for status and apply", () => {
  it("T-MG30 fake checkout with data/stweg.db: default and explicit data/ paths → exit 2; files byte-identical; status reads nothing", () => {
    const s = makeScratchDir();
    try {
      const cwd = path.join(s.dir, "checkout");
      fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
      const fake = path.join(cwd, "data", "stweg.db");
      createDbFile(fake, SCHEMA_SQL);
      const before = dirState(path.join(cwd, "data"));
      const env = plainEnv(s.dir);
      const runs = [
        migrate(["status"], { cwd, env }),
        migrate(["apply"], { cwd, env }),
        migrate(["status", "--db", "data/stweg.db"], { cwd, env }),
        migrate(["apply", "--db", "data/stweg.db", "--json"], { cwd, env }),
        migrate(["apply", "--db", fake], { cwd, env }),
        migrate(["status"], { cwd, env: { ...env, STWEG_TEST: "1" } }),
        migrate(["apply"], { cwd, env: { ...env, STWEG_TEST: "1" } }),
        migrate(["status", "--db", "./data/../data/stweg.db"], { cwd, env }),
      ];
      runs.forEach((r, i) => assert.equal(r.status, 2, `run ${i}: ${r.stdout}${r.stderr}`));
      assert.equal(dirState(path.join(cwd, "data")), before, "fake data/ byte-identical");
      assert.deepEqual(fs.readdirSync(path.join(cwd, "data")), ["stweg.db"], "no run log, no sidecars");
      const { value, reads } = countingReads(() => statusWithRunLog("data/stweg.db", { cwd }));
      assert.equal(value.status.exitCode, 2);
      assert.equal(!value.status.ok && value.status.code, "PATH_REFUSED");
      assert.equal(reads, 0, "status reads nothing on a refused path");
    } finally {
      s.cleanup();
    }
  });

  it("T-MG31 unmarked dir, hard link and symlink chain → status and apply exit 2; nothing changed", () => {
    const s = makeScratchDir();
    const t = withTempEnv();
    try {
      const unmarked = path.join(s.dir, "u.db");
      createDbFile(unmarked, SCHEMA_SQL);
      const hard = path.join(t.dir, "hard.db");
      fs.linkSync(unmarked, hard);
      const chain1 = path.join(t.dir, "chain1.db");
      fs.symlinkSync(path.join(t.dir, "chain2.db"), chain1);
      fs.symlinkSync(unmarked, path.join(t.dir, "chain2.db"));
      const beforeS = dirState(s.dir);
      const beforeT = dirState(t.dir);
      for (const db of [unmarked, hard, chain1, path.join(s.dir, "new.db")]) {
        assert.equal(migrate(["status", "--db", db]).status, 2, `status ${db}`);
        assert.equal(migrate(["apply", "--db", db]).status, 2, `apply ${db}`);
        const { reads } = countingReads(() => statusWithRunLog(db));
        assert.equal(reads, 0);
      }
      assert.equal(dirState(s.dir), beforeS);
      assert.equal(dirState(t.dir), beforeT, "no run log next to a refused path");
    } finally {
      t.cleanup();
      s.cleanup();
    }
  });
});

describe("A2-5 T-MG10, T-MG16–17 via the CLI", () => {
  it("T-MG10 checksum and name mismatch in history: status exit 2 INCONSISTENT naming id 1; apply exit 2, nothing written", () => {
    for (const [label, sql, pattern] of [
      ["checksum", `UPDATE schema_migrations SET checksum = '${"e".repeat(64)}' WHERE id = 1`, /history id 1 \(0001_baseline\): stored checksum e{64} differs from registry checksum/],
      ["name", "UPDATE schema_migrations SET name = '0001_initial' WHERE id = 1", /history id 1: stored name 0001_initial differs from registry name 0001_baseline/],
    ] as const) {
      const t = withTempEnv();
      try {
        assert.equal(applyJson(t.dbPath).exitCode, 0);
        harnessEdit(t.dbPath, (d) => d.exec(sql));
        const before = dbFiles(t.dbPath);
        const s = statusJson(t.dbPath);
        assert.equal(s.exitCode, 2, label);
        assert.equal(s.status.state, "INCONSISTENT");
        assert.match(s.status.report!.reasons.join("\n"), pattern);
        const a = applyJson(t.dbPath);
        assert.equal(a.exitCode, 2, label);
        assert.match(a.message, pattern);
        assert.equal(dbFiles(t.dbPath), before, `${label}: nothing written`);
      } finally {
        t.cleanup();
      }
    }
  });

  it("T-MG16 NEWER and T-MG17 INCONSISTENT variants: status and apply exit 2; nothing written", () => {
    const cases: Array<[string, string, (db: string) => void]> = [
      ["NEWER", "NEWER", (db) => {
        createDbFile(db, SCHEMA_SQL);
        harnessEdit(db, (d) => addHistory(d, [{ id: 1, name: "0001_baseline", checksum: MIGRATIONS[0].checksum }, { id: 2, name: "0002_future", checksum: "f".repeat(64) }]));
      }],
      ["user_version without history", "INCONSISTENT", (db) => createDbFile(db, SCHEMA_SQL, { userVersion: 3 })],
      ["drift after adoption", "INCONSISTENT", (db) => {
        createDbFile(db, SCHEMA_SQL);
        assert.equal(applyJson(db).exitCode, 0);
        harnessEdit(db, (d) => d.exec("DROP INDEX idx_audit_org"));
      }],
      ["user_version != history max", "INCONSISTENT", (db) => {
        createDbFile(db, SCHEMA_SQL);
        assert.equal(applyJson(db).exitCode, 0);
        harnessEdit(db, (d) => d.pragma("user_version = 0"));
      }],
    ];
    for (const [label, state, make] of cases) {
      const t = withTempEnv();
      try {
        make(t.dbPath);
        const before = dbFiles(t.dbPath);
        const s = statusJson(t.dbPath);
        assert.equal(s.status.state, state, label);
        assert.equal(s.exitCode, 2, label);
        const a = applyJson(t.dbPath);
        assert.equal(a.exitCode, 2, label);
        assert.equal(a.stateBefore, state, label);
        assert.equal(dbFiles(t.dbPath), before, `${label}: nothing written`);
      } finally {
        t.cleanup();
      }
    }
  });
});

describe("A2-5 app and seed compatibility (T-MG18R, T-MG19R, T-MG35)", () => {
  const managedView = (s: StatusJson) => ({
    state: s.status.state,
    fp: s.status.report!.fingerprint,
    structural: s.status.report!.structural,
    userVersion: s.status.report!.userVersion,
    history: s.status.report!.history.map((h) => `${h.id}:${h.name}:${h.kind}:${h.checksum}`),
  });

  it("T-MG18R unchanged getDb() on an adopted harness DB: no error; history, user_version and fingerprint unchanged", () => {
    const t = withTempEnv();
    try {
      createDbFile(t.dbPath, SCHEMA_SQL);
      const a = applyJson(t.dbPath);
      assert.equal(a.exitCode, 0, a.message);
      assert.deepEqual(a.applied.map((x) => `${x.name}:${x.kind}`), ["0001_baseline:baselined"]);
      const before = managedView(statusJson(t.dbPath));
      assert.equal(before.state, "MANAGED_CURRENT");
      closeDb();
      const db = getDb(); // the app's own open path (db.ts unchanged): runs SCHEMA_SQL (IF NOT EXISTS), sets WAL
      assert.ok((db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n > 0);
      closeDb();
      const afterApp = statusJson(t.dbPath);
      assert.equal(afterApp.exitCode, 0, JSON.stringify(afterApp.status));
      assert.deepEqual(managedView(afterApp), before);
      assert.equal(afterApp.status.report!.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      const again = applyJson(t.dbPath);
      assert.equal(again.exitCode, 0);
      assert.equal(again.outcome, "noop");
    } finally {
      t.cleanup();
    }
  });

  it("T-MG19R unchanged getDb() creates a harness DB → status LEGACY_BASELINE → apply adopts → MANAGED_CURRENT", () => {
    const t = withTempEnv();
    try {
      closeDb();
      getDb();
      closeDb();
      const s = statusJson(t.dbPath);
      assert.equal(s.exitCode, 0, JSON.stringify(s.status));
      assert.equal(s.status.state, "LEGACY_BASELINE");
      assert.equal(s.status.report!.fingerprint, PINNED_BASELINE_FINGERPRINT_V1);
      assert.equal(s.status.report!.structural, PINNED_BASELINE_STRUCTURAL_V1);
      const a = applyJson(t.dbPath);
      assert.equal(a.exitCode, 0, a.message);
      assert.equal(a.stateBefore, "LEGACY_BASELINE");
      assert.equal(a.stateAfter, "MANAGED_CURRENT");
      assert.deepEqual(a.applied.map((x) => x.kind), ["baselined"]);
    } finally {
      t.cleanup();
    }
  });

  it("T-MG35 temp-mode seed on EMPTY (→ unmanaged LEGACY_BASELINE via getDb, RK-N1; apply adopts) and on MANAGED (succeeds; history, user_version, fingerprint unchanged)", () => {
    const seedInto = (t: ReturnType<typeof withTempEnv>) => {
      const s = makeScratchDir();
      try {
        const env = { ...plainEnv(s.dir), NODE_ENV: "test", STWEG_TEST: "1", STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir };
        const r = run(SEED, [], { cwd: s.dir, env });
        assert.equal(r.status, 0, `temp-mode seed failed: ${r.stderr.split("\n").filter((l) => !/login|password/i.test(l)).join("\n")}`);
      } finally {
        s.cleanup();
      }
      // the seed leaves the app's WAL connection unclosed; a non-empty -wal makes status undeterminable (exit 6)
      const walSize = fs.existsSync(`${t.dbPath}-wal`) ? fs.statSync(`${t.dbPath}-wal`).size : 0;
      if (walSize > 0) {
        assert.equal(statusJson(t.dbPath).exitCode, 6, "non-empty -wal → UNDETERMINABLE");
        // TEST-ONLY harness fold of the synthetic fixture's -wal (operator action, never runner behaviour)
        harnessEdit(t.dbPath, (d) => d.prepare("SELECT count(*) FROM sqlite_master").get());
      }
    };

    const empty = withTempEnv();
    try {
      seedInto(empty);
      const s = statusJson(empty.dbPath);
      assert.equal(s.exitCode, 0);
      assert.equal(s.status.state, "LEGACY_BASELINE", "seed on EMPTY creates an unmanaged baseline DB through the unchanged getDb (RK-N1)");
      const a = applyJson(empty.dbPath);
      assert.equal(a.exitCode, 0, a.message);
      assert.deepEqual(a.applied.map((x) => x.kind), ["baselined"]);
    } finally {
      empty.cleanup();
    }

    const managed = withTempEnv();
    try {
      const a = applyJson(managed.dbPath);
      assert.equal(a.exitCode, 0, a.message);
      assert.deepEqual(a.applied.map((x) => x.kind), ["applied"]);
      const before = managedView(statusJson(managed.dbPath));
      seedInto(managed);
      const after = statusJson(managed.dbPath);
      assert.equal(after.exitCode, 0);
      assert.deepEqual(managedView(after), before, "seed on MANAGED leaves history, user_version and fingerprint unchanged");
      const counts = new Database(managed.dbPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal((counts.prepare("SELECT count(*) AS n FROM documents").get() as { n: number }).n, 3);
      } finally {
        counts.close();
      }
    } finally {
      managed.cleanup();
    }
  });
});
