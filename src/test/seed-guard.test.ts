import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { SEED_CONFIRM_FLAG, checkSeedAllowed, seedOrgUploadDir } from "../../scripts/seed-guard";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * Safety design (F2): seed SUBPROCESSES never run with the real checkout as cwd.
 * Each one runs with cwd = a fresh scratch "workspace" (not harness-marked), so
 * the cwd-based defaults point into that scratch dir even if every guard were
 * disabled. The child gets an explicit minimal env (no inherited variables).
 * Refusal logic is tested in-process through checkSeedAllowed().
 * Real-checkout DB/WAL/SHM and an uploads manifest (hash, size, mtime) are
 * compared before and after every subprocess.
 */

const REPO = process.cwd();
const REAL_DATA = path.join(REPO, "data");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");
const SEED = path.join(REPO, "scripts", "seed.ts");
const TSCONFIG = path.join(REPO, "tsconfig.json");

function fileLine(file: string): string {
  const st = fs.statSync(file);
  return `${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")} ${st.size} ${st.mtimeMs}`;
}
/** DB + WAL + SHM + every file under data/uploads (hash, size, mtime) of a checkout. */
function dataFingerprint(dataDir: string): string {
  const lines: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path.join(dataDir, `stweg.db${suffix}`);
    lines.push(`${suffix || "db"}: ${fs.existsSync(f) ? fileLine(f) : "none"}`);
  }
  const uploads = path.join(dataDir, "uploads");
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path.relative(uploads, full)}: ${fileLine(full)}`);
    }
  };
  walk(uploads);
  return lines.join("\n");
}
const realBefore = dataFingerprint(REAL_DATA);

function minimalEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), NODE_ENV: "test", STWEG_TEST: "1", ...extra };
}

/** Runs the seed with cwd = workspace. stdout (login hints) is captured and never printed. */
function runSeed(workspace: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const before = dataFingerprint(REAL_DATA);
  const r = spawnSync(TSX, ["--tsconfig", TSCONFIG, SEED, ...args], { cwd: workspace, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(dataFingerprint(REAL_DATA), before, "real checkout data changed during a seed subprocess");
  return r;
}
const cleanStderr = (s: string) => s.split("\n").filter((l) => !/login|password/i.test(l)).join("\n");

describe("T-A6 seed guard", () => {
  it("refuses without STWEG_ALLOW_SEED=1 (even for marked disposable paths)", () => {
    const t = withTempEnv();
    try {
      assert.equal(checkSeedAllowed({ env: {} as NodeJS.ProcessEnv, argv: [], dbPath: t.dbPath, uploadsDir: t.uploadsDir, cwd: REPO }).ok, false);
      assert.equal(checkSeedAllowed({ env: {} as NodeJS.ProcessEnv, argv: [SEED_CONFIRM_FLAG], dbPath: t.dbPath, uploadsDir: t.uploadsDir, cwd: REPO }).ok, false);
    } finally {
      t.cleanup();
    }
  });
  it("refuses default and unmarked paths without the explicit flag", () => {
    const env = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;
    const s = makeScratchDir();
    try {
      assert.equal(checkSeedAllowed({ env, argv: [], dbPath: path.join(REAL_DATA, "stweg.db"), uploadsDir: path.join(REAL_DATA, "uploads"), cwd: REPO }).ok, false);
      assert.equal(checkSeedAllowed({ env, argv: [], dbPath: path.join(s.dir, "x.db"), uploadsDir: path.join(s.dir, "up"), cwd: REPO }).ok, false);
    } finally {
      s.cleanup();
    }
  });
  it("allows marked disposable paths with STWEG_ALLOW_SEED=1, and other paths only with the explicit flag", () => {
    const env = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;
    const t = withTempEnv();
    try {
      assert.deepEqual(checkSeedAllowed({ env, argv: [], dbPath: t.dbPath, uploadsDir: t.uploadsDir, cwd: REPO }), { ok: true, mode: "temp" });
      assert.deepEqual(checkSeedAllowed({ env, argv: [SEED_CONFIRM_FLAG], dbPath: path.join(REAL_DATA, "stweg.db"), uploadsDir: path.join(REAL_DATA, "uploads"), cwd: REPO }), { ok: true, mode: "explicit" });
      assert.equal(checkSeedAllowed({ env, argv: [SEED_CONFIRM_FLAG], dbPath: t.dbPath, uploadsDir: "/" }).ok, false);
      assert.equal(checkSeedAllowed({ env, argv: [`${SEED_CONFIRM_FLAG}=1`], dbPath: path.join(REAL_DATA, "stweg.db"), uploadsDir: path.join(REAL_DATA, "uploads"), cwd: REPO }).ok, false);
    } finally {
      t.cleanup();
    }
  });
  it("confines the deletion target to <uploadsDir>/<org>", () => {
    const up = "/tmp/stweg-x/uploads";
    assert.equal(seedOrgUploadDir(up, "org_demo"), path.join(up, "org_demo"));
    assert.throws(() => seedOrgUploadDir(up, "../escape"));
    assert.throws(() => seedOrgUploadDir(up, ""));
  });

  it("subprocess (cwd = scratch workspace): no STWEG_ALLOW_SEED -> exit non-zero, nothing created", () => {
    const ws = makeScratchDir();
    const t = withTempEnv();
    try {
      const r = runSeed(ws.dir, minimalEnv(ws.dir, { STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir }));
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Seed refused: set STWEG_ALLOW_SEED=1/);
      assert.equal(fs.existsSync(t.dbPath), false);
      assert.deepEqual(fs.readdirSync(t.uploadsDir), []);
      assert.equal(fs.existsSync(path.join(ws.dir, "data")), false);
    } finally {
      t.cleanup();
      ws.cleanup();
    }
  });

  it("subprocess (cwd = scratch workspace): ALLOW + flag + test mode with no overrides is refused; workspace defaults untouched", () => {
    const ws = makeScratchDir();
    try {
      // The workspace has its own default data, so a broken guard could only damage this scratch copy.
      const data = path.join(ws.dir, "data");
      fs.mkdirSync(path.join(data, "uploads", "org_demo"), { recursive: true });
      fs.writeFileSync(path.join(data, "stweg.db"), "scratch-default");
      fs.writeFileSync(path.join(data, "uploads", "org_demo", "keep.txt"), "keep");
      const wsBefore = dataFingerprint(data);
      const r = runSeed(ws.dir, minimalEnv(ws.dir, { STWEG_ALLOW_SEED: "1" }), [SEED_CONFIRM_FLAG]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /real database/);
      assert.equal(dataFingerprint(data), wsBefore);
    } finally {
      ws.cleanup();
    }
  });

  it("subprocess (cwd = scratch workspace): ALLOW + marked temp paths succeeds and only touches <uploads>/org_demo", () => {
    const ws = makeScratchDir();
    const t = withTempEnv();
    try {
      const outside = path.join(t.dir, "sentinel-outside-uploads.txt");
      const otherOrg = path.join(t.uploadsDir, "org_other", "keep.txt");
      fs.writeFileSync(outside, "keep");
      fs.mkdirSync(path.dirname(otherOrg), { recursive: true });
      fs.writeFileSync(otherOrg, "keep");
      const env = minimalEnv(ws.dir, { STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir, STWEG_ALLOW_SEED: "1" });
      for (let run = 0; run < 2; run++) {
        const r = runSeed(ws.dir, env);
        assert.equal(r.status, 0, `seed run ${run + 1} failed: ${cleanStderr(r.stderr)}`);
        assert.match(r.stderr, /\[seed\] mode=temp/);
      }
      const db = new Database(t.dbPath, { readonly: true });
      try {
        const org = db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'org_demo'`).get() as { n: number };
        assert.equal(org.n, 1);
      } finally {
        db.close();
      }
      assert.deepEqual(fs.readdirSync(path.join(t.uploadsDir, "org_demo", "prop_sonnenhof")).sort(), ["doc_plans.pdf", "doc_reserve.pdf", "photo_heat.png"]);
      assert.equal(fs.readFileSync(outside, "utf8"), "keep");
      assert.equal(fs.readFileSync(otherOrg, "utf8"), "keep");
      assert.equal(fs.existsSync(path.join(ws.dir, "data")), false, "workspace defaults must stay untouched");
    } finally {
      t.cleanup();
      ws.cleanup();
    }
  });
});

after(() => {
  assert.equal(dataFingerprint(REAL_DATA), realBefore, "real checkout data (DB/WAL/SHM + uploads manifest) must be identical after the seed tests");
});
