import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, defaultDbPath, defaultUploadsDir, resolveDbPath, resolveUploadsDir, tempRoot } from "../lib/config";
import { closeDb, databasePath, getDb } from "../lib/db";
import { uploadsRoot } from "../lib/repo";
import { makeScratchDir, removeHarnessDir, withTempEnv } from "./harness";

const REPO = process.cwd();
const REAL_DB = path.join(REPO, "data", "stweg.db");
const REAL_UPLOADS = path.join(REPO, "data", "uploads");

function sha(file: string): string | null {
  return fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
}
function realFingerprint() {
  return ["", "-wal", "-shm"].map((suffix) => `${suffix}:${sha(REAL_DB + suffix)}`).join("|");
}
const realBefore = realFingerprint();

describe("T-A1 defaults are unchanged", () => {
  it("resolves <cwd>/data/stweg.db and <cwd>/data/uploads when no env override is set (non-test env)", () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(resolveDbPath(env, REPO), path.join(REPO, "data", "stweg.db"));
    assert.equal(resolveUploadsDir(env, REPO), path.join(REPO, "data", "uploads"));
    assert.equal(defaultDbPath(REPO), REAL_DB);
    assert.equal(defaultUploadsDir(REPO), REAL_UPLOADS);
  });
  it("defaults follow the working directory exactly as before (path.join(cwd, 'data', ...))", () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(resolveDbPath(env, "/srv/app"), "/srv/app/data/stweg.db");
    assert.equal(resolveUploadsDir(env, "/srv/app"), "/srv/app/data/uploads");
  });
});

describe("T-A2 env overrides", () => {
  it("uses absolute STWEG_DB_PATH / STWEG_UPLOADS_DIR (normalized)", () => {
    const env = { STWEG_DB_PATH: "/var/lib/stweg/../stweg/x.db", STWEG_UPLOADS_DIR: "/var/lib/stweg/up/" } as NodeJS.ProcessEnv;
    assert.equal(resolveDbPath(env, REPO), "/var/lib/stweg/x.db");
    assert.equal(resolveUploadsDir(env, REPO), "/var/lib/stweg/up");
  });
  it("rejects relative and NUL-containing paths", () => {
    assert.throws(() => resolveDbPath({ STWEG_DB_PATH: "data/other.db" } as NodeJS.ProcessEnv, REPO), ConfigError);
    assert.throws(() => resolveUploadsDir({ STWEG_UPLOADS_DIR: "./up" } as NodeJS.ProcessEnv, REPO), ConfigError);
    assert.throws(() => resolveDbPath({ STWEG_DB_PATH: "/tmp/a\0b.db" } as NodeJS.ProcessEnv, REPO), ConfigError);
  });
  it("getDb() and uploadsRoot() follow the harness temp paths and create the DB there", () => {
    const t = withTempEnv();
    try {
      assert.equal(databasePath(), t.dbPath);
      assert.equal(uploadsRoot(), t.uploadsDir);
      const db = getDb();
      assert.equal(db.name, t.dbPath);
      assert.ok(fs.existsSync(t.dbPath));
      const tables = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get() as { n: number };
      assert.ok(tables.n >= 19, "schema created in the temp DB");
    } finally {
      t.cleanup();
    }
  });
});

describe("T-A3 test guard refuses the real DB and real uploads (fail closed)", () => {
  const testEnv = (extra: Record<string, string>) => ({ STWEG_TEST: "1", ...extra }) as NodeJS.ProcessEnv;
  it("refuses the default DB path and default uploads dir when no override is set", () => {
    assert.throws(() => resolveDbPath(testEnv({}), REPO), /real database/);
    assert.throws(() => resolveUploadsDir(testEnv({}), REPO), /real uploads/);
  });
  it("refuses the real paths when given explicitly, and NODE_ENV=test alone also triggers the guard", () => {
    assert.throws(() => resolveDbPath(testEnv({ STWEG_DB_PATH: REAL_DB }), REPO), ConfigError);
    assert.throws(() => resolveUploadsDir(testEnv({ STWEG_UPLOADS_DIR: REAL_UPLOADS }), REPO), ConfigError);
    assert.throws(() => resolveDbPath({ NODE_ENV: "test", STWEG_DB_PATH: REAL_DB } as NodeJS.ProcessEnv, REPO), ConfigError);
    assert.throws(() => resolveUploadsDir(testEnv({ STWEG_UPLOADS_DIR: path.join(REAL_UPLOADS, "org_demo") }), REPO), ConfigError);
  });
  it("refuses paths that are not inside a harness-marked disposable directory", () => {
    assert.throws(() => resolveDbPath(testEnv({ STWEG_DB_PATH: "/workspace/not-temp.db" }), REPO), /disposable directory marked/);
    assert.throws(() => resolveUploadsDir(testEnv({ STWEG_UPLOADS_DIR: "/workspace/not-temp-uploads" }), REPO), /disposable directory marked/);
    // being inside os.tmpdir() alone is not enough
    assert.throws(() => resolveDbPath(testEnv({ STWEG_DB_PATH: path.join(tempRoot(), "stweg-unmarked-check", "x.db") }), REPO), /disposable directory marked/);
  });
  it("refuses a symlink in tmp that points at the real DB", { skip: !fs.existsSync(REAL_DB) && "real DB not present" }, () => {
    const t = withTempEnv();
    try {
      const link = path.join(t.dir, "sneaky.db");
      fs.symlinkSync(REAL_DB, link);
      assert.throws(() => resolveDbPath(testEnv({ STWEG_DB_PATH: link }), REPO), /real database/);
    } finally {
      t.cleanup();
    }
  });
  it("getDb() throws before opening anything when the env points at the default DB (fake checkout as cwd)", () => {
    // The cwd is a scratch "checkout", so even a broken guard could only touch the scratch dir.
    const scratch = makeScratchDir();
    const fakeDb = path.join(scratch.dir, "data", "stweg.db");
    fs.mkdirSync(path.dirname(fakeDb));
    fs.writeFileSync(fakeDb, "not a database");
    const saved = process.env.STWEG_DB_PATH;
    const savedCwd = process.cwd();
    closeDb();
    try {
      process.chdir(scratch.dir);
      process.env.STWEG_DB_PATH = fakeDb;
      assert.throws(() => getDb(), /real database/);
      delete process.env.STWEG_DB_PATH;
      assert.throws(() => getDb(), /real database/);
      assert.equal(fs.readFileSync(fakeDb, "utf8"), "not a database");
      assert.deepEqual(fs.readdirSync(path.dirname(fakeDb)), ["stweg.db"]);
    } finally {
      process.chdir(savedCwd);
      process.env.STWEG_DB_PATH = saved;
      closeDb();
      scratch.cleanup();
    }
    assert.equal(realFingerprint(), realBefore);
  });
  it("uploadsRoot() throws when the env points at the real uploads dir", () => {
    const saved = process.env.STWEG_UPLOADS_DIR;
    process.env.STWEG_UPLOADS_DIR = REAL_UPLOADS;
    try {
      assert.throws(() => uploadsRoot(), ConfigError);
    } finally {
      process.env.STWEG_UPLOADS_DIR = saved;
    }
  });
  it("accepts paths inside a harness-marked temp dir", () => {
    const t = withTempEnv();
    try {
      const db = path.join(t.dir, "nested", "x.db");
      assert.equal(resolveDbPath(testEnv({ STWEG_DB_PATH: db }), REPO), db);
    } finally {
      t.cleanup();
    }
  });
});

describe("T-A4 harness creates and removes only its own temp dir; real data unchanged", () => {
  it("creates a marked dir under os.tmpdir() and cleanup removes it", () => {
    const t = withTempEnv();
    assert.ok(t.dir.startsWith(tempRoot() + path.sep));
    assert.ok(path.basename(t.dir).startsWith("stweg-test-"));
    getDb();
    fs.writeFileSync(path.join(t.uploadsDir, "a.bin"), "x");
    t.cleanup();
    assert.equal(fs.existsSync(t.dir), false);
  });
  it("restores the previous env after cleanup", () => {
    const before = process.env.STWEG_DB_PATH;
    const t = withTempEnv();
    assert.notEqual(process.env.STWEG_DB_PATH, before);
    t.cleanup();
    assert.equal(process.env.STWEG_DB_PATH, before);
  });
  it("refuses to remove dirs it did not create (no marker, wrong prefix, outside tmp) and leaves siblings intact", () => {
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "stweg-test-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "not-harness-"));
    const keep = path.join(sibling, "keep.txt");
    fs.writeFileSync(keep, "keep");
    try {
      assert.throws(() => removeHarnessDir(sibling, "wrong-token"), /marker/);
      assert.throws(() => removeHarnessDir(other, "x"), /not created by the test harness/);
      // works wherever the checkout lives (also under the temp dir): every variant must refuse
      assert.throws(() => removeHarnessDir(REPO, "x"), /Refusing to remove/);
      assert.throws(() => removeHarnessDir(path.join(REPO, "data"), "x"), /Refusing to remove/);
      assert.ok(fs.existsSync(keep));
      assert.ok(fs.existsSync(other));
    } finally {
      fs.rmSync(sibling, { recursive: true });
      fs.rmSync(other, { recursive: true });
    }
  });
});

after(() => {
  assert.equal(realFingerprint(), realBefore, "real DB files must be byte-identical after the tests");
});
