import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import Database from "better-sqlite3";
import {
  type IdentityProbe,
  type IdentityStat,
  checkDbFileIdentity,
  classifyDisposableDbPath,
  classifyDisposablePath,
  resolveDbPath,
  setIdentityProbeForTests,
} from "../lib/config";
import { SEED_CONFIRM_FLAG, checkSeedAllowed } from "../../scripts/seed-guard";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * N1 (3D review): hard links bypass the path-based protected-location rule.
 * Every "protected" file here lives in a FAKE checkout inside a scratch dir
 * (cwd for the classifier / the seed subprocess); nothing points at the real
 * repo's data/. The real checkout's data is fingerprinted before and after.
 * Hard links need the same filesystem: both the scratch dirs and the harness
 * dirs are created in the OS temp dir. If link() fails with EXDEV/EPERM the
 * test is skipped with that reason.
 */

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const SEED = path.join(REPO, "scripts", "seed.ts");
const TSCONFIG = path.join(REPO, "tsconfig.json");
const T = (extra: Record<string, string> = {}) => ({ STWEG_TEST: "1", ...extra }) as NodeJS.ProcessEnv;
const ALLOW = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;

function fileLine(file: string): string {
  const st = fs.statSync(file);
  return `${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")} ${st.size} ${st.mtimeMs}`;
}
/** DB, -wal, -shm, -journal and every file under uploads (hash, size, mtime). */
function fingerprint(dataDir: string): string {
  const lines: string[] = [];
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = path.join(dataDir, `stweg.db${suffix}`);
    lines.push(`${suffix || "db"}: ${fs.existsSync(f) ? fileLine(f) : "none"}`);
  }
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else lines.push(`${path.relative(dataDir, full)}: ${fileLine(full)}`);
    }
  };
  walk(path.join(dataDir, "uploads"));
  return lines.join("\n");
}
const REAL_DATA = path.join(REPO, "data");
const realBefore = fingerprint(REAL_DATA);
after(() => assert.equal(fingerprint(REAL_DATA), realBefore, "real checkout data must be unchanged by the hard-link tests"));

/** Fake checkout in a scratch dir: a real SQLite DB plus existing -wal/-shm/-journal sidecars and an upload. */
function fakeCheckout(scratch: string): { cwd: string; data: string; db: string } {
  const cwd = path.join(scratch, "checkout");
  const data = path.join(cwd, "data");
  fs.mkdirSync(path.join(data, "uploads", "org_demo"), { recursive: true });
  const db = path.join(data, "stweg.db");
  const conn = new Database(db);
  conn.exec("CREATE TABLE fake (v TEXT); INSERT INTO fake VALUES ('protected');");
  conn.close();
  fs.writeFileSync(`${db}-wal`, "fake-wal");
  fs.writeFileSync(`${db}-shm`, "fake-shm");
  fs.writeFileSync(`${db}-journal`, "fake-journal");
  fs.writeFileSync(path.join(data, "uploads", "org_demo", "keep.txt"), "keep");
  return { cwd, data, db };
}

/** fs.linkSync, or skip the test with the reason when the filesystem refuses hard links. */
function linkOrSkip(t: TestContext, target: string, link: string): boolean {
  try {
    fs.linkSync(target, link);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      t.skip(`hard link not possible here (${code}): ${link} -> ${target}`);
      return false;
    }
    throw error;
  }
}

function setup() {
  const s = makeScratchDir();
  const h = withTempEnv(); // marked disposable dir, separate from the fake checkout
  const repo = fakeCheckout(s.dir);
  return { s, h, repo, cleanup: () => { h.cleanup(); s.cleanup(); } };
}

const code = (c: { ok: boolean; code?: string } | { ok: true }) => ("code" in c ? c.code : "ok");

describe("T-A9 N1: hard links to protected DB files are refused in test mode", () => {
  it("T-A9a hard link to the protected DB inside a marked dir: path rule passes, identity rule refuses (test mode + seed temp mode)", (t) => {
    const { h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      if (!linkOrSkip(t, repo.db, hl)) return;
      assert.equal(classifyDisposablePath(hl, repo.cwd).ok, true, "path-only rule cannot see hard links (the 3D N1 gap)");
      assert.equal(code(classifyDisposableDbPath(hl, repo.cwd)), "hardlinked");
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: hl }), repo.cwd), /Test mode refused the database path: it has a database file with more than one hard link/);
      const d = checkSeedAllowed({ env: ALLOW, argv: [], dbPath: hl, uploadsDir: h.uploadsDir, cwd: repo.cwd });
      assert.equal(d.ok, false);
      assert.match(!d.ok ? d.reason : "", /Seed refused: the DB path has a database file with more than one hard link/);
      // identity comparison on its own (nlink hidden by the probe) also catches it
      const hideNlink: IdentityProbe = { platform: process.platform, stat: (f) => { try { const st = fs.statSync(f, { bigint: true }); return { dev: st.dev, ino: st.ino, nlink: BigInt(1) }; } catch { return null; } } };
      assert.equal(code(checkDbFileIdentity(hl, repo.cwd, hideNlink)), "same-file");
    } finally {
      cleanup();
    }
  });

  it("T-A9b hard links to existing sidecars (-wal, -shm, -journal) and cross-links are refused", (t) => {
    const { h, repo, cleanup } = setup();
    try {
      const cases: Array<[string, string]> = [
        [`${repo.db}-wal`, path.join(h.dir, "a.db-wal")], // candidate a.db itself does not exist
        [`${repo.db}-shm`, path.join(h.dir, "b.db-shm")],
        [`${repo.db}-journal`, path.join(h.dir, "c.db-journal")],
        [`${repo.db}-wal`, path.join(h.dir, "d.db")], // candidate DB is a link to the protected WAL
      ];
      for (const [target, link] of cases) {
        if (!linkOrSkip(t, target, link)) return;
        const candidate = link.replace(/-(wal|shm|journal)$/, "");
        assert.equal(code(classifyDisposableDbPath(candidate, repo.cwd)), "hardlinked", link);
        assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: candidate }), repo.cwd), /more than one hard link/, link);
        assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: candidate, uploadsDir: h.uploadsDir, cwd: repo.cwd }).ok, false, link);
        fs.unlinkSync(link);
      }
    } finally {
      cleanup();
    }
  });

  it("T-A9c a candidate DB whose own -wal sidecar is a hard link refuses the whole DB path, also when the main file is independent", (t) => {
    const { h, repo, cleanup } = setup();
    try {
      const cand = path.join(h.dir, "mixed.db");
      fs.writeFileSync(cand, "independent");
      if (!linkOrSkip(t, `${repo.db}-wal`, `${cand}-wal`)) return;
      assert.equal(fs.statSync(cand).nlink, 1);
      assert.equal(code(classifyDisposableDbPath(cand, repo.cwd)), "hardlinked");
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: cand }), repo.cwd), /more than one hard link/);
    } finally {
      cleanup();
    }
  });

  it("T-A9d an independent DB in a valid disposable dir is accepted: before creation, after the harness/SQLite creates it (nlink 1, own -wal/-shm), and a byte copy", () => {
    const { h, repo, cleanup } = setup();
    try {
      assert.equal(code(classifyDisposableDbPath(h.dbPath, repo.cwd)), "ok");
      const conn = new Database(h.dbPath);
      conn.pragma("journal_mode = WAL");
      conn.exec("CREATE TABLE t (v); INSERT INTO t VALUES (1);");
      for (const f of [h.dbPath, `${h.dbPath}-wal`, `${h.dbPath}-shm`]) assert.equal(fs.statSync(f).nlink, 1, f);
      assert.equal(code(classifyDisposableDbPath(h.dbPath, repo.cwd)), "ok");
      assert.equal(resolveDbPath(T({ STWEG_DB_PATH: h.dbPath }), repo.cwd), h.dbPath);
      conn.close();
      const copy = path.join(h.dir, "copy.db");
      fs.copyFileSync(repo.db, copy);
      assert.equal(code(classifyDisposableDbPath(copy, repo.cwd)), "ok");
      assert.deepEqual(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: copy, uploadsDir: h.uploadsDir, cwd: repo.cwd }), { ok: true, mode: "temp" });
      // also against the real cwd of this test process (a disposable copy's defaults)
      assert.equal(code(classifyDisposableDbPath(h.dbPath)), "ok");
    } finally {
      cleanup();
    }
  });

  it("T-A9e unreliable identity information fails closed in guarded modes (injected probe), and only for existing files", () => {
    const { h, repo, cleanup } = setup();
    try {
      const existing = path.join(h.dir, "own.db");
      fs.writeFileSync(existing, "x");
      const real = (f: string): IdentityStat | null => { try { return fs.statSync(f, { bigint: true }); } catch { return null; } };
      const variants: Array<[string, Partial<IdentityProbe>]> = [
        ["win32", { platform: "win32" }],
        ["ino 0", { stat: (f) => { const st = real(f); return st && { dev: st.dev, ino: BigInt(0), nlink: st.nlink }; } }],
        ["number fields (no bigint)", { stat: (f) => { const st = real(f); return st && ({ dev: Number(st.dev), ino: Number(st.ino), nlink: 1 } as unknown as IdentityStat); } }],
        ["stat error EACCES", { stat: (f) => { if (f.startsWith(h.dir)) { const e = new Error("denied") as NodeJS.ErrnoException; e.code = "EACCES"; throw e; } return real(f); } }],
        ["protected file ino 0", { stat: (f) => { const st = real(f); return st && (f.startsWith(repo.cwd) ? { dev: st.dev, ino: BigInt(0), nlink: st.nlink } : st); } }],
      ];
      for (const [label, probe] of variants) {
        const restore = setIdentityProbeForTests(probe);
        try {
          assert.equal(code(classifyDisposableDbPath(existing, repo.cwd)), "identity-unreliable", label);
          assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: existing }), repo.cwd), /cannot be verified as a separate file/, label);
          const d = checkSeedAllowed({ env: ALLOW, argv: [], dbPath: existing, uploadsDir: h.uploadsDir, cwd: repo.cwd });
          assert.equal(d.ok, false, label);
          // outside guarded modes nothing changes
          assert.equal(resolveDbPath({ STWEG_DB_PATH: existing } as NodeJS.ProcessEnv, repo.cwd), existing, label);
          // a DB that does not exist yet cannot be a hard link: accepted even on an unreliable platform
          if (label === "win32") assert.equal(code(classifyDisposableDbPath(path.join(h.dir, "new.db"), repo.cwd)), "ok");
        } finally {
          restore();
        }
      }
      assert.equal(code(classifyDisposableDbPath(existing, repo.cwd)), "ok", "restored probe");
    } finally {
      cleanup();
    }
  });

  it("T-A9f outside guarded modes path resolution is unchanged (hard link returned as configured; defaults unchanged)", (t) => {
    const { h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      if (!linkOrSkip(t, repo.db, hl)) return;
      assert.equal(resolveDbPath({ STWEG_DB_PATH: hl } as NodeJS.ProcessEnv, repo.cwd), hl);
      assert.equal(resolveDbPath({} as NodeJS.ProcessEnv, repo.cwd), repo.db);
    } finally {
      cleanup();
    }
  });
});

/** Seed subprocess: cwd = scratch fake checkout, explicit minimal env, stdout captured and never printed. */
function runSeed(cwd: string, home: string, extra: Record<string, string>, testMode: boolean, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), ...extra };
  if (testMode) Object.assign(env, { NODE_ENV: "test", STWEG_TEST: "1" });
  const before = fingerprint(REAL_DATA);
  const r = spawnSync(TSX, ["--tsconfig", TSCONFIG, SEED, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(fingerprint(REAL_DATA), before, "real checkout data changed during a seed subprocess");
  return r;
}
const cleanStderr = (s: string) => s.split("\n").filter((l) => !/login|password/i.test(l)).join("\n");

describe("T-A10 N1: seed with a hard-linked DB", () => {
  it("T-A10a without the explicit flag: refused in seed temp mode and in test mode; protected db/wal/shm/journal/uploads byte-identical incl. mtime", (t) => {
    const { s, h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      if (!linkOrSkip(t, repo.db, hl)) return;
      const protBefore = fingerprint(repo.data);
      const upBefore = fs.readdirSync(h.uploadsDir);
      const extra = { STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: hl, STWEG_UPLOADS_DIR: h.uploadsDir };
      const plain = runSeed(repo.cwd, s.dir, extra, false);
      assert.notEqual(plain.status, 0);
      assert.match(plain.stderr, /Seed refused: the DB path has a database file with more than one hard link/);
      const test = runSeed(repo.cwd, s.dir, extra, true);
      assert.notEqual(test.status, 0);
      assert.match(test.stderr, /Test mode refused the database path: it has a database file with more than one hard link/);
      assert.equal(fingerprint(repo.data), protBefore, "protected DB, sidecars and uploads must be byte-identical incl. mtime");
      assert.equal(fs.statSync(repo.db).nlink, 2);
      assert.deepEqual(fs.readdirSync(h.uploadsDir), upBefore);
    } finally {
      cleanup();
    }
  });

  it("T-A10b with the explicit flag: test mode still refuses; outside test mode the documented explicit-operator path runs and writes through the link (no identity check)", (t) => {
    const { s, h, repo, cleanup } = setup();
    try {
      // The explicit path opens the DB with SQLite, so remove the fake sidecars first.
      for (const sfx of ["-wal", "-shm", "-journal"]) fs.rmSync(`${repo.db}${sfx}`);
      const hl = path.join(h.dir, "hl.db");
      if (!linkOrSkip(t, repo.db, hl)) return;
      const extra = { STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: hl, STWEG_UPLOADS_DIR: h.uploadsDir };
      assert.deepEqual(checkSeedAllowed({ env: ALLOW, argv: [SEED_CONFIRM_FLAG], dbPath: hl, uploadsDir: h.uploadsDir, cwd: repo.cwd }), { ok: true, mode: "explicit" });
      const before = fingerprint(repo.data);
      const test = runSeed(repo.cwd, s.dir, extra, true, [SEED_CONFIRM_FLAG]);
      assert.notEqual(test.status, 0);
      assert.match(test.stderr, /Test mode refused the database path/);
      assert.equal(fingerprint(repo.data), before);
      const plain = runSeed(repo.cwd, s.dir, extra, false, [SEED_CONFIRM_FLAG]);
      assert.equal(plain.status, 0, cleanStderr(plain.stderr));
      assert.match(plain.stderr, /\[seed\] mode=explicit/);
      // Documented behaviour: the operator's flag resets org_demo in the configured file, which IS the
      // (fake, scratch) protected inode here. The fake checkout's uploads are not touched.
      assert.notEqual(fingerprint(repo.data), before);
      assert.equal(fs.readFileSync(path.join(repo.data, "uploads", "org_demo", "keep.txt"), "utf8"), "keep");
    } finally {
      cleanup();
    }
  });
});
