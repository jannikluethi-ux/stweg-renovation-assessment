import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { HARNESS_MARKER, canonicalPath, classifyDisposablePath, resolveDbPath, resolveUploadsDir } from "../lib/config";
import { closeDb, getDb } from "../lib/db";
import { checkSeedAllowed, SEED_CONFIRM_FLAG } from "../../scripts/seed-guard";
import { makeScratchDir, withTempEnv } from "./harness";

const REPO = process.cwd();
const T = (extra: Record<string, string>) => ({ STWEG_TEST: "1", ...extra }) as NodeJS.ProcessEnv;
const ALLOW = { STWEG_ALLOW_SEED: "1" } as NodeJS.ProcessEnv;

/** A fake checkout with data/stweg.db and data/uploads, located wherever we put it. */
function fakeCheckout(parent: string, name = "checkout"): { cwd: string; db: string; uploads: string } {
  const cwd = path.join(parent, name);
  fs.mkdirSync(path.join(cwd, "data", "uploads", "org_demo"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "stweg.db"), "fake");
  return { cwd, db: path.join(cwd, "data", "stweg.db"), uploads: path.join(cwd, "data", "uploads") };
}

describe("T-A7 F1/F4: temp/test mode is never granted by location alone", () => {
  it("checkout under a marked temp dir: defaults are protected, seed needs the explicit flag", () => {
    const t = withTempEnv();
    try {
      const repo = fakeCheckout(t.dir); // marked dir is an ancestor of this cwd
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: repo.db, uploadsDir: repo.uploads, cwd: repo.cwd }).ok, false);
      // even a sibling path inside the same marked dir does not qualify: the marked dir contains the cwd
      const sibling = classifyDisposablePath(path.join(t.dir, "other.db"), repo.cwd);
      assert.equal(sibling.ok, false);
      assert.equal(!sibling.ok && sibling.code, "marker-contains-cwd");
      assert.throws(() => resolveDbPath(T({}), repo.cwd), /real database/);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: path.join(t.dir, "other.db") }), repo.cwd), /contains the working directory/);
      // the documented explicit path still works (by design)
      assert.deepEqual(checkSeedAllowed({ env: ALLOW, argv: [SEED_CONFIRM_FLAG], dbPath: repo.db, uploadsDir: repo.uploads, cwd: repo.cwd }), { ok: true, mode: "explicit" });
    } finally {
      t.cleanup();
    }
  });
  it("checkout directly under the OS temp dir (unmarked scratch): defaults are not temp", () => {
    const s = makeScratchDir();
    try {
      const repo = fakeCheckout(s.dir);
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: repo.db, uploadsDir: repo.uploads, cwd: repo.cwd }).ok, false);
      assert.throws(() => resolveDbPath(T({}), repo.cwd), /real database/);
      assert.throws(() => resolveUploadsDir(T({}), repo.cwd), /real uploads/);
    } finally {
      s.cleanup();
    }
  });
  it("TMPDIR=/ grants nothing: arbitrary absolute paths refused in test mode and seed temp mode; harness refuses to start", () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = "/";
    try {
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: "/home/box/x.db" }), REPO), /disposable directory marked/);
      assert.throws(() => resolveUploadsDir(T({ STWEG_UPLOADS_DIR: "/home/box/up" }), REPO), /disposable directory marked/);
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: path.join(REPO, "data", "stweg.db"), uploadsDir: path.join(REPO, "data", "uploads"), cwd: REPO }).ok, false);
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: "/home/box/x.db", uploadsDir: "/home/box/up", cwd: REPO }).ok, false);
      assert.throws(() => withTempEnv(), /filesystem root/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
  it("TMPDIR pointing at the checkout grants nothing", () => {
    const s = makeScratchDir();
    const saved = process.env.TMPDIR;
    try {
      const repo = fakeCheckout(s.dir);
      process.env.TMPDIR = repo.cwd;
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: repo.db, uploadsDir: repo.uploads, cwd: repo.cwd }).ok, false);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: path.join(repo.cwd, "x.db") }), repo.cwd), /disposable directory marked/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      s.cleanup();
    }
  });
  it("paths resolving into the default data dir via '..' are protected (real repo paths, resolve only)", () => {
    const t = withTempEnv();
    try {
      const viaDots = path.join(t.dir, "..", "..", ...REPO.split(path.sep).filter(Boolean), "data", "x.db");
      assert.equal(path.resolve(viaDots), path.join(REPO, "data", "x.db"));
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: viaDots }), REPO), /real database/);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: `${REPO}/data/../data/stweg.db` }), REPO), /real database/);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: `${REPO}/data/stweg.db-wal` }), REPO), /real database/);
      assert.equal(classifyDisposablePath(`${REPO}/data/stweg.db-shm`, REPO).ok, false);
    } finally {
      t.cleanup();
    }
  });
  it("a marker that is a symlink, or a marker in a protected dir, does not qualify", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    try {
      const fake = path.join(s.dir, "fakemarked");
      fs.mkdirSync(fake);
      fs.symlinkSync(path.join(t.dir, HARNESS_MARKER), path.join(fake, HARNESS_MARKER));
      assert.equal(classifyDisposablePath(path.join(fake, "x.db"), REPO).ok, false);
      const repo = fakeCheckout(s.dir);
      fs.writeFileSync(path.join(repo.cwd, "data", HARNESS_MARKER), "x");
      const r = classifyDisposablePath(path.join(repo.cwd, "data", "y.db"), repo.cwd);
      assert.equal(r.ok, false);
    } finally {
      s.cleanup();
      t.cleanup();
    }
  });
});

describe("T-A8 F3: symlinks, including dangling ones, are resolved before classification", () => {
  it("canonicalPath resolves a dangling symlink to its target", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    try {
      const target = path.join(s.dir, "no-such-dir", "x.db");
      const link = path.join(t.dir, "dangling.db");
      fs.symlinkSync(target, link);
      assert.equal(canonicalPath(link), canonicalPath(target));
      const rel = path.join(t.dir, "rel.db");
      fs.symlinkSync("./sub/../inner.db", rel);
      assert.equal(canonicalPath(rel), path.join(canonicalPath(t.dir), "inner.db"));
      const loopA = path.join(t.dir, "loopA");
      fs.symlinkSync(path.join(t.dir, "loopB"), loopA);
      fs.symlinkSync(loopA, path.join(t.dir, "loopB"));
      assert.throws(() => canonicalPath(loopA), /Too many symbolic links/);
    } finally {
      s.cleanup();
      t.cleanup();
    }
  });
  it("dangling DB symlink targeting the default DB of a fresh checkout is refused, and getDb() creates nothing", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    const savedCwd = process.cwd();
    const saved = process.env.STWEG_DB_PATH;
    try {
      const fresh = path.join(s.dir, "fresh"); // no data/ yet
      fs.mkdirSync(fresh);
      const link = path.join(t.dir, "dangling.db");
      fs.symlinkSync(path.join(fresh, "data", "stweg.db"), link);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: link }), fresh), /real database/);
      closeDb();
      process.chdir(fresh);
      process.env.STWEG_DB_PATH = link;
      assert.throws(() => getDb(), /real database/);
      assert.equal(fs.existsSync(path.join(fresh, "data")), false);
    } finally {
      process.chdir(savedCwd);
      process.env.STWEG_DB_PATH = saved;
      closeDb();
      s.cleanup();
      t.cleanup();
    }
  });
  it("dangling symlinks to the real repo's default DB name / uploads dir are refused (resolve only)", () => {
    const t = withTempEnv();
    try {
      const dbLink = path.join(t.dir, "to-real.db");
      fs.symlinkSync(path.join(REPO, "data", "created-through-link-should-never-exist.db"), dbLink);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: dbLink }), REPO), /real database/);
      const upLink = path.join(t.dir, "to-real-uploads");
      fs.symlinkSync(path.join(REPO, "data", "uploads", "never-created"), upLink);
      assert.throws(() => resolveUploadsDir(T({ STWEG_UPLOADS_DIR: upLink }), REPO), /real uploads/);
      assert.equal(fs.existsSync(path.join(REPO, "data", "created-through-link-should-never-exist.db")), false);
    } finally {
      t.cleanup();
    }
  });
  it("dangling uploads symlink targeting a fresh checkout's uploads dir is refused", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    try {
      const fresh = path.join(s.dir, "fresh");
      fs.mkdirSync(fresh);
      const link = path.join(t.dir, "up");
      fs.symlinkSync(path.join(fresh, "data", "uploads"), link);
      assert.throws(() => resolveUploadsDir(T({ STWEG_UPLOADS_DIR: link }), fresh), /real uploads/);
    } finally {
      s.cleanup();
      t.cleanup();
    }
  });
  it("existing symlinks (file, dir, intermediate dir) to protected locations are refused", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    try {
      const repo = fakeCheckout(s.dir);
      fs.symlinkSync(repo.db, path.join(t.dir, "file.db"));
      fs.symlinkSync(path.join(repo.cwd, "data"), path.join(t.dir, "datadir"));
      fs.symlinkSync(repo.cwd, path.join(t.dir, "repo"));
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: path.join(t.dir, "file.db") }), repo.cwd), /real database/);
      assert.throws(() => resolveDbPath(T({ STWEG_DB_PATH: path.join(t.dir, "datadir", "new.db") }), repo.cwd), /real database/);
      assert.throws(() => resolveUploadsDir(T({ STWEG_UPLOADS_DIR: path.join(t.dir, "repo", "data", "uploads", "a", "b") }), repo.cwd), /real uploads/);
      assert.equal(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: path.join(t.dir, "file.db"), uploadsDir: t.uploadsDir, cwd: repo.cwd }).ok, false);
    } finally {
      s.cleanup();
      t.cleanup();
    }
  });
  it("legitimate ordinary paths and internal symlinks inside a valid disposable dir pass", () => {
    const t = withTempEnv();
    try {
      fs.mkdirSync(path.join(t.dir, "real-sub"));
      fs.symlinkSync(path.join(t.dir, "real-sub"), path.join(t.dir, "alias"));
      assert.equal(resolveDbPath(T({ STWEG_DB_PATH: t.dbPath }), REPO), t.dbPath);
      assert.equal(resolveDbPath(T({ STWEG_DB_PATH: path.join(t.dir, "a", "b", "x.db") }), REPO), path.join(t.dir, "a", "b", "x.db"));
      assert.equal(resolveDbPath(T({ STWEG_DB_PATH: path.join(t.dir, "alias", "x.db") }), REPO), path.join(t.dir, "alias", "x.db"));
      assert.equal(resolveUploadsDir(T({ STWEG_UPLOADS_DIR: t.uploadsDir }), REPO), t.uploadsDir);
      assert.deepEqual(checkSeedAllowed({ env: ALLOW, argv: [], dbPath: t.dbPath, uploadsDir: t.uploadsDir, cwd: REPO }), { ok: true, mode: "temp" });
    } finally {
      t.cleanup();
    }
  });
  it("default-path behaviour outside guarded modes is unchanged", () => {
    assert.equal(resolveDbPath({} as NodeJS.ProcessEnv, "/srv/app"), "/srv/app/data/stweg.db");
    assert.equal(resolveUploadsDir({ STWEG_UPLOADS_DIR: "" } as NodeJS.ProcessEnv, "/srv/app"), "/srv/app/data/uploads");
    assert.equal(resolveDbPath({ STWEG_DB_PATH: "/var/x/../y.db" } as NodeJS.ProcessEnv, "/srv/app"), "/var/y.db");
  });
});
