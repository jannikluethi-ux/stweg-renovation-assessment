import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  ConfigError,
  type IdentityProbe,
  canonicalPath,
  checkDbFileIdentity,
  checkDbFileLinks,
  classifyDisposableDbPath,
  classifyDisposablePath,
  resolveDbPath,
  setIdentityProbeForTests,
} from "../lib/config";
import { SEED_CONFIRM_FLAG, checkSeedAllowed, explicitModeIdentityWarning } from "../../scripts/seed-guard";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * Phase A hardening (A2-0; Workshop 5B O-5, approved 23.10.2026): R1, R3, R4, R5, F7.
 * Every "protected" file lives in a FAKE checkout inside a scratch dir. Seed
 * subprocesses run with cwd = that scratch checkout and a minimal env. The
 * checkout's own data/ is fingerprinted before and after the whole file.
 * No test here skips: a failing hard link is a test failure.
 */

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const SEED = path.join(REPO, "scripts", "seed.ts");
const TSCONFIG = path.join(REPO, "tsconfig.json");
const ALLOW = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function dirFingerprint(dir: string): string {
  if (!fs.existsSync(dir)) return "none";
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) lines.push(`${path.relative(dir, full)} ${sha(full)} ${fs.statSync(full).mtimeMs}`);
      else lines.push(`${path.relative(dir, full)} ${e.isSymbolicLink() ? "symlink" : "other"}`);
    }
  };
  walk(dir);
  return lines.join("\n");
}
const REAL_DATA = path.join(REPO, "data");
const realBefore = dirFingerprint(REAL_DATA);
after(() => assert.equal(dirFingerprint(REAL_DATA), realBefore, "checkout data/ must be unchanged by the hardening tests"));

function fakeCheckout(scratch: string): { cwd: string; data: string; db: string } {
  const cwd = path.join(scratch, "checkout");
  const data = path.join(cwd, "data");
  fs.mkdirSync(path.join(data, "uploads", "org_demo"), { recursive: true });
  const db = path.join(data, "stweg.db");
  const conn = new Database(db);
  conn.exec("CREATE TABLE fake (v TEXT); INSERT INTO fake VALUES ('protected');");
  conn.close();
  fs.writeFileSync(path.join(data, "uploads", "org_demo", "keep.txt"), "keep");
  return { cwd, data, db };
}
function setup() {
  const s = makeScratchDir();
  const h = withTempEnv();
  const repo = fakeCheckout(s.dir);
  return { s, h, repo, cleanup: () => { h.cleanup(); s.cleanup(); } };
}
const code = (c: { ok: boolean; code?: string } | { ok: true }) => ("code" in c ? c.code : "ok");

/** Captures console.error output of fn. */
function captureStderr<T>(fn: () => T): { value: T; text: string } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { value: fn(), text: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

function runSeed(cwd: string, home: string, extra: Record<string, string>, testMode: boolean, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), ...extra };
  if (testMode) Object.assign(env, { NODE_ENV: "test", STWEG_TEST: "1" });
  return spawnSync(TSX, ["--tsconfig", TSCONFIG, SEED, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
}
const hasStack = (s: string) => /^\s+at\s/m.test(s);

describe("R1 (3F L1): explicit seed mode runs the identity check and warns", () => {
  it("R1a hard link to the default DB with the explicit flag: decision unchanged (explicit), warning printed, no files touched", () => {
    const { h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      fs.linkSync(repo.db, hl);
      const before = dirFingerprint(repo.data);
      const r = captureStderr(() => checkSeedAllowed({ env: ALLOW, argv: [SEED_CONFIRM_FLAG], dbPath: hl, uploadsDir: h.uploadsDir, cwd: repo.cwd }));
      assert.deepEqual(r.value, { ok: true, mode: "explicit" });
      assert.match(r.text, /WARNING \(explicit mode\): the target DB has a database file with more than one hard link/);
      assert.equal(dirFingerprint(repo.data), before);
    } finally {
      cleanup();
    }
  });

  it("R1b symlink alias of the default DB (different configured path, same file): 'same file as data/stweg.db' warning", () => {
    const { h, repo, cleanup } = setup();
    try {
      const alias = path.join(h.dir, "alias.db");
      fs.symlinkSync(repo.db, alias);
      assert.match(explicitModeIdentityWarning(alias, repo.cwd) ?? "", /the target is the same file as data\/stweg\.db/);
    } finally {
      cleanup();
    }
  });

  it("R1c explicit mode on the default path itself: no warning when nlink is 1; warning when another name links to it", () => {
    const { h, repo, cleanup } = setup();
    try {
      assert.equal(explicitModeIdentityWarning(repo.db, repo.cwd), null);
      assert.equal(code(checkDbFileLinks(repo.db)), "ok");
      fs.linkSync(repo.db, path.join(h.dir, "other-name.db"));
      assert.equal(code(checkDbFileLinks(repo.db)), "hardlinked");
      assert.match(explicitModeIdentityWarning(repo.db, repo.cwd) ?? "", /more than one hard link/);
    } finally {
      cleanup();
    }
  });

  it("R1d explicit mode on a separate, unrelated DB file: no warning", () => {
    const { s, repo, cleanup } = setup();
    try {
      const other = path.join(s.dir, "other.db");
      fs.copyFileSync(repo.db, other);
      const r = captureStderr(() => checkSeedAllowed({ env: ALLOW, argv: [SEED_CONFIRM_FLAG], dbPath: other, uploadsDir: path.join(s.dir, "up"), cwd: repo.cwd }));
      assert.deepEqual(r.value, { ok: true, mode: "explicit" });
      assert.equal(r.text, "");
    } finally {
      cleanup();
    }
  });

  it("R1e seed subprocess (outside test mode, cwd = fake checkout) prints the warning before running", () => {
    const { s, h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      fs.linkSync(repo.db, hl);
      const r = runSeed(repo.cwd, s.dir, { STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: hl, STWEG_UPLOADS_DIR: h.uploadsDir }, false, [SEED_CONFIRM_FLAG]);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /WARNING \(explicit mode\)/);
      assert.match(r.stderr, /\[seed\] mode=explicit/);
      assert.equal(fs.readFileSync(path.join(repo.data, "uploads", "org_demo", "keep.txt"), "utf8"), "keep");
    } finally {
      cleanup();
    }
  });
});

describe("R3 (3F F2): setIdentityProbeForTests is gated on test mode", () => {
  it("R3a throws a ConfigError outside test mode and leaves the active probe unchanged", () => {
    const { h, repo, cleanup } = setup();
    try {
      const hl = path.join(h.dir, "hl.db");
      fs.linkSync(repo.db, hl);
      assert.throws(() => setIdentityProbeForTests({ stat: () => null }, {} as NodeJS.ProcessEnv), (e: unknown) => e instanceof ConfigError && /only available in test mode/.test((e as Error).message));
      assert.throws(() => setIdentityProbeForTests(null, { NODE_ENV: "production" } as NodeJS.ProcessEnv), ConfigError);
      assert.equal(code(classifyDisposableDbPath(hl, repo.cwd)), "hardlinked", "check still active");
    } finally {
      cleanup();
    }
  });
  it("R3b works in test mode (NODE_ENV=test or STWEG_TEST=1) and restores", () => {
    const restore = setIdentityProbeForTests({ platform: "win32" }, { NODE_ENV: "test" } as NodeJS.ProcessEnv);
    restore();
    const restore2 = setIdentityProbeForTests(null, { STWEG_TEST: "1" } as NodeJS.ProcessEnv);
    restore2();
  });
});

describe("R4 (3F T1): identity check compares dev AND ino, and checks the canonical base", () => {
  const fake = (map: Record<string, { dev: bigint; ino: bigint; nlink: bigint }>): IdentityProbe => ({ platform: "linux", stat: (f) => map[f] ?? null });
  it("R4a same ino on a different device is NOT the same file; same dev and ino is", () => {
    const cwd = "/fakecheckout";
    const cand = "/elsewhere/c.db";
    const def = path.join(cwd, "data", "stweg.db");
    const differentDev = fake({ [cand]: { dev: 1n, ino: 42n, nlink: 1n }, [def]: { dev: 2n, ino: 42n, nlink: 1n } });
    assert.equal(code(checkDbFileIdentity(cand, cwd, differentDev)), "ok");
    const sameDev = fake({ [cand]: { dev: 2n, ino: 42n, nlink: 1n }, [def]: { dev: 2n, ino: 42n, nlink: 1n } });
    assert.equal(code(checkDbFileIdentity(cand, cwd, sameDev)), "same-file");
    const differentIno = fake({ [cand]: { dev: 2n, ino: 43n, nlink: 1n }, [def]: { dev: 2n, ino: 42n, nlink: 1n } });
    assert.equal(code(checkDbFileIdentity(cand, cwd, differentIno)), "ok");
  });
  it("R4b symlinked candidate whose real file's -wal is a hard link of the protected -wal is refused", () => {
    const { h, repo, cleanup } = setup();
    const h2 = withTempEnv(); // second marked dir: the symlink's real target is also disposable by path
    try {
      fs.writeFileSync(`${repo.db}-wal`, "");
      const realDir = h2.dir;
      const real = path.join(realDir, "x.db");
      fs.writeFileSync(real, "");
      fs.linkSync(`${repo.db}-wal`, `${real}-wal`);
      const candidate = path.join(h.dir, "link.db");
      fs.symlinkSync(real, candidate);
      assert.equal(fs.existsSync(`${candidate}-wal`), false, "the lexical sidecar does not exist; only the canonical one does");
      assert.equal(canonicalPath(candidate), real);
      assert.equal(code(classifyDisposableDbPath(candidate, repo.cwd)), "hardlinked");
      assert.throws(() => resolveDbPath({ STWEG_TEST: "1", STWEG_DB_PATH: candidate } as NodeJS.ProcessEnv, repo.cwd), /more than one hard link/);
      // nlink hidden: the (dev, ino) comparison on the canonical sidecar still finds it
      const hideNlink: IdentityProbe = { platform: process.platform, stat: (f) => { try { const st = fs.statSync(f, { bigint: true }); return { dev: st.dev, ino: st.ino, nlink: 1n }; } catch { return null; } } };
      assert.equal(code(checkDbFileIdentity(candidate, repo.cwd, hideNlink)), "same-file");
    } finally {
      h2.cleanup();
      cleanup();
    }
  });
});

describe("R5 (3F F1): stat errors while resolving a path become ConfigError", () => {
  it("R5a EACCES on a parent directory: canonicalPath, classifier and resolveDbPath throw ConfigError (fail closed)", () => {
    assert.notEqual(process.getuid?.(), 0, "must not run as root (permission test)");
    const h = withTempEnv();
    const locked = path.join(h.dir, "locked");
    fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, "inner", "x.db");
      const isCfg = (e: unknown) => e instanceof ConfigError && /could not be inspected \(EACCES\)/.test((e as Error).message);
      assert.throws(() => canonicalPath(target), isCfg);
      assert.throws(() => classifyDisposablePath(target), isCfg);
      assert.throws(() => resolveDbPath({ STWEG_TEST: "1", STWEG_DB_PATH: target } as NodeJS.ProcessEnv), isCfg);
    } finally {
      fs.chmodSync(locked, 0o700);
      h.cleanup();
    }
  });
  it("R5b ELOOP and ENOENT behaviour unchanged", () => {
    const h = withTempEnv();
    try {
      const a = path.join(h.dir, "a");
      const b = path.join(h.dir, "b");
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
      assert.throws(() => canonicalPath(path.join(a, "x.db")), /Too many symbolic links/);
      assert.equal(canonicalPath(path.join(h.dir, "missing", "x.db")), path.join(fs.realpathSync(h.dir), "missing", "x.db"));
    } finally {
      h.cleanup();
    }
  });
});

describe("F7 (3B): seed refusals exit 1 with a message and no stack trace", () => {
  it("F7a containment refusal (temp mode, org_demo upload dir is a symlink out of the uploads dir)", () => {
    const s = makeScratchDir();
    const h = withTempEnv();
    try {
      const outside = path.join(s.dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "sentinel.txt"), "sentinel");
      fs.symlinkSync(outside, path.join(h.uploadsDir, "org_demo"));
      const workspace = path.join(s.dir, "ws");
      fs.mkdirSync(workspace);
      const r = runSeed(workspace, s.dir, { STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: h.dbPath, STWEG_UPLOADS_DIR: h.uploadsDir }, true);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Seed refused: organization uploads folder escapes the uploads directory/);
      assert.equal(hasStack(r.stderr), false, r.stderr);
      assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "sentinel");
      assert.equal(fs.existsSync(h.dbPath), false, "no DB created");
    } finally {
      h.cleanup();
      s.cleanup();
    }
  });
  it("F7b test-mode guard refusal (unmarked DB path) exits 1 without a stack trace", () => {
    const s = makeScratchDir();
    try {
      const workspace = path.join(s.dir, "ws");
      fs.mkdirSync(workspace);
      const r = runSeed(workspace, s.dir, { STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: path.join(s.dir, "unmarked.db"), STWEG_UPLOADS_DIR: path.join(s.dir, "up") }, true);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Test mode refused the database path/);
      assert.equal(hasStack(r.stderr), false, r.stderr);
      assert.equal(fs.existsSync(path.join(s.dir, "unmarked.db")), false);
    } finally {
      s.cleanup();
    }
  });
  it("F7c test-mode refusal of the default location (no env paths) still exits 1 with the existing message", () => {
    const s = makeScratchDir();
    try {
      const r = runSeed(s.dir, s.dir, {}, true);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Test mode refused the real database location/);
      assert.equal(hasStack(r.stderr), false);
    } finally {
      s.cleanup();
    }
  });
});
