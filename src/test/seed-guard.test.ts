import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import { SEED_CONFIRM_FLAG, checkSeedAllowed, seedOrgUploadDir } from "../../scripts/seed-guard";
import { withTempEnv } from "./harness";

const REPO = process.cwd();
const REAL_DB = path.join(REPO, "data", "stweg.db");
const TSX = path.join(REPO, "node_modules", ".bin", "tsx");

function fingerprint(): string {
  return ["", "-wal", "-shm"]
    .map((s) => (fs.existsSync(REAL_DB + s) ? crypto.createHash("sha256").update(fs.readFileSync(REAL_DB + s)).digest("hex") : "none"))
    .join("|");
}
const realBefore = fingerprint();

function runSeed(env: NodeJS.ProcessEnv, args: string[] = []) {
  // stdout is captured and never printed (the seed prints demo login hints).
  return spawnSync(TSX, ["scripts/seed.ts", ...args], { cwd: REPO, env, encoding: "utf8", timeout: 120_000 });
}

describe("T-A6 seed guard", () => {
  const tmpDb = "/tmp/stweg-x/stweg.db";
  const tmpUp = "/tmp/stweg-x/uploads";
  it("refuses without STWEG_ALLOW_SEED=1 (even for temp paths)", () => {
    const d = checkSeedAllowed({ env: {} as NodeJS.ProcessEnv, argv: [], dbPath: tmpDb, uploadsDir: tmpUp });
    assert.equal(d.ok, false);
  });
  it("refuses non-temp paths (including the real default DB) without the explicit flag", () => {
    const env = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;
    assert.equal(checkSeedAllowed({ env, argv: [], dbPath: REAL_DB, uploadsDir: path.join(REPO, "data", "uploads") }).ok, false);
    assert.equal(checkSeedAllowed({ env, argv: [], dbPath: tmpDb, uploadsDir: path.join(REPO, "data", "uploads") }).ok, false);
    assert.equal(checkSeedAllowed({ env, argv: [], dbPath: REAL_DB, uploadsDir: tmpUp }).ok, false);
  });
  it("allows temp paths with STWEG_ALLOW_SEED=1, and non-temp only with the explicit flag", () => {
    const env = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;
    assert.deepEqual(checkSeedAllowed({ env, argv: [], dbPath: tmpDb, uploadsDir: tmpUp }), { ok: true, mode: "temp" });
    assert.deepEqual(checkSeedAllowed({ env, argv: [SEED_CONFIRM_FLAG], dbPath: REAL_DB, uploadsDir: path.join(REPO, "data", "uploads") }), { ok: true, mode: "explicit" });
    assert.equal(checkSeedAllowed({ env, argv: [SEED_CONFIRM_FLAG], dbPath: tmpDb, uploadsDir: "/" }).ok, false);
  });
  it("confines the deletion target to <uploadsDir>/<org>", () => {
    assert.equal(seedOrgUploadDir(tmpUp, "org_demo"), path.join(tmpUp, "org_demo"));
    assert.throws(() => seedOrgUploadDir(tmpUp, "../escape"));
    assert.throws(() => seedOrgUploadDir(tmpUp, ""));
  });

  it("subprocess: seed without STWEG_ALLOW_SEED exits non-zero and creates nothing", () => {
    const t = withTempEnv();
    try {
      const env = { ...process.env, STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir, STWEG_TEST: "1" };
      delete env.STWEG_ALLOW_SEED;
      const r = runSeed(env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Seed refused: set STWEG_ALLOW_SEED=1/);
      assert.equal(fs.existsSync(t.dbPath), false);
      assert.deepEqual(fs.readdirSync(t.uploadsDir), []);
    } finally {
      t.cleanup();
    }
  });

  it("subprocess: in test mode with no path override the seed cannot reach the real DB", () => {
    const env = { ...process.env, STWEG_ALLOW_SEED: "1", STWEG_TEST: "1" };
    delete env.STWEG_DB_PATH;
    delete env.STWEG_UPLOADS_DIR;
    const r = runSeed(env, [SEED_CONFIRM_FLAG]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /real database/);
    assert.equal(fingerprint(), realBefore);
  });

  it("subprocess: seed with STWEG_ALLOW_SEED=1 on temp paths succeeds and only touches <uploads>/org_demo", () => {
    const t = withTempEnv();
    try {
      const outside = path.join(t.dir, "sentinel-outside-uploads.txt");
      const otherOrg = path.join(t.uploadsDir, "org_other", "keep.txt");
      fs.writeFileSync(outside, "keep");
      fs.mkdirSync(path.dirname(otherOrg), { recursive: true });
      fs.writeFileSync(otherOrg, "keep");
      const env = { ...process.env, STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir, STWEG_TEST: "1", STWEG_ALLOW_SEED: "1" };
      for (let run = 0; run < 2; run++) {
        const r = runSeed(env);
        assert.equal(r.status, 0, `seed run ${run + 1} failed: ${r.stderr.split("\n").filter((l) => !/login/i.test(l)).join("\n")}`);
        assert.match(r.stderr, /\[seed\] mode=temp/);
      }
      const db = new Database(t.dbPath, { readonly: true });
      try {
        const org = db.prepare(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'org_demo'`).get() as { n: number };
        assert.equal(org.n, 1);
      } finally {
        db.close();
      }
      const demoFiles = fs.readdirSync(path.join(t.uploadsDir, "org_demo", "prop_sonnenhof")).sort();
      assert.deepEqual(demoFiles, ["doc_plans.pdf", "doc_reserve.pdf", "photo_heat.png"]);
      assert.equal(fs.readFileSync(outside, "utf8"), "keep");
      assert.equal(fs.readFileSync(otherOrg, "utf8"), "keep");
    } finally {
      t.cleanup();
    }
  });
});

after(() => {
  assert.equal(fingerprint(), realBefore, "real DB files must be byte-identical after the seed tests");
});
