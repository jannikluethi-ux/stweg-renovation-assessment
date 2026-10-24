import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  COLD_DB,
  O4_REAL_BACKUP_ROOT,
  createBackup,
  fileState,
  guardDb,
  guardDir,
  readManifest,
  restoreBackup,
  setBackupHooksForTests,
  verifyBackup,
  type BackupManifest,
} from "../lib/backup";
import { applyMigrations } from "../lib/migrations/runner";
import { snapshotStatus } from "../lib/migrations/state";
import { MIGRATIONS, registryView } from "../lib/migrations/registry";
import { compareUploadTrees, uploadsTree } from "../lib/uploads-manifest";
import { SCHEMA_SQL } from "../lib/schema";
import { createDbFile, dirState, sha256File } from "./fixtures/schema-fixtures";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * A2-4: backup, verification and restore (Workshop 5B §G.1–§G.4; T-MG24–28, T-MG30–31 for
 * the backup CLIs, T-MG34, T-HC01, journal refusal, O-4 refusal). Synthetic databases and
 * disposable uploads in marked temp directories only. The O-4 real backup location
 * (/home/box/stweg-backups) is only ever passed as a path string; it must not be created.
 * The checkout's data/ must be unchanged.
 */

const ROOT = process.cwd();
const REAL_DATA = path.join(ROOT, "data");
const realBefore = fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none";
const o4State = () => {
  try {
    const st = fs.lstatSync(O4_REAL_BACKUP_ROOT);
    return `exists ino=${st.ino} mtime=${st.mtimeMs}`;
  } catch {
    return "absent";
  }
};
const o4Before = o4State();
after(() => {
  assert.equal(fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none", realBefore, "checkout data/ must be unchanged");
  assert.equal(o4State(), o4Before, "the O-4 real backup location must not be created or changed");
});

const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const TSCONFIG = path.join(ROOT, "tsconfig.json");
const SEED = path.join(ROOT, "scripts", "seed.ts");
const BACKUP_CLI = path.join(ROOT, "scripts", "db-backup.ts");
const VERIFY_CLI = path.join(ROOT, "scripts", "db-verify-backup.ts");
const RESTORE_CLI = path.join(ROOT, "scripts", "db-restore.ts");

/** sha/size/mtime/ctime/inode of the DB and every sidecar (unchanged-source assertions). */
const dbFiles = (db: string) => JSON.stringify(["", "-wal", "-shm", "-journal"].map((s) => fileState(db + s)));

function cli(script: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(TSX, ["--tsconfig", TSCONFIG, script, ...args], { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, encoding: "utf8", timeout: 120_000 });
}

/** production-like environment for a child (no test mode, no STWEG_* paths) */
function plainEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp" };
}

// ---------------------------------------------------------------------------------------------
// seeded template (temp-mode seed into a marked disposable dir, once)
// ---------------------------------------------------------------------------------------------

let template: { dir: string; db: string; uploads: string; cleanup: () => void } | null = null;
after(() => template?.cleanup());

function seededTemplate() {
  if (template) return template;
  const t = withTempEnv();
  const s = makeScratchDir();
  try {
    const env = { ...plainEnv(s.dir), NODE_ENV: "test", STWEG_TEST: "1", STWEG_ALLOW_SEED: "1", STWEG_DB_PATH: t.dbPath, STWEG_UPLOADS_DIR: t.uploadsDir };
    const r = cli(SEED, [], { cwd: s.dir, env });
    assert.equal(r.status, 0, `temp-mode seed failed: ${r.stderr.split("\n").filter((l) => !/login|password/i.test(l)).join("\n")}`);
    // fold the seed's -wal into the template (template only)
    const fold = new Database(t.dbPath, { fileMustExist: true });
    fold.prepare("SELECT count(*) FROM sqlite_master").get();
    fold.close();
    assert.equal(fs.existsSync(`${t.dbPath}-wal`), false);
  } finally {
    s.cleanup();
  }
  template = { dir: t.dir, db: t.dbPath, uploads: t.uploadsDir, cleanup: t.cleanup };
  return template;
}

function disposable(withData = true) {
  const tpl = withData ? seededTemplate() : null;
  const h = withTempEnv();
  if (tpl) {
    fs.copyFileSync(tpl.db, h.dbPath);
    fs.cpSync(tpl.uploads, h.uploadsDir, { recursive: true });
  }
  return { ...h, backups: path.join(h.dir, "backups") };
}

function backupOf(d: ReturnType<typeof disposable>) {
  const r = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: d.backups, cwd: ROOT });
  assert.equal(r.exitCode, 0, r.message);
  return { ...r, backupDir: r.backupDir!, manifest: r.manifest! };
}

const dirEntries = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

async function holdOpen(db: string): Promise<ChildProcess> {
  const code = `const D = require(${JSON.stringify(path.join(ROOT, "node_modules", "better-sqlite3"))}); const db = new D(process.argv[1], { readonly: true }); db.prepare("SELECT count(*) FROM sqlite_master").get(); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", code, db], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (c) => String(c).includes("ready") && resolve());
    child.on("exit", () => reject(new Error("holder child exited early")));
  });
  return child;
}
async function stop(child: ChildProcess | null) {
  if (child && child.exitCode === null) {
    const gone = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await gone;
  }
}

// ---------------------------------------------------------------------------------------------

describe("A2-4 backup (§G.1, §G.3)", () => {
  it("T-MG24 seeded temp DB: cold sha = source, logical copy checks ok, counts equal, verified:true, source unchanged", () => {
    const d = disposable();
    try {
      const srcBefore = dbFiles(d.dbPath);
      const upBefore = uploadsTree(d.uploadsDir);
      const r = backupOf(d);
      const m = r.manifest;
      assert.equal(dbFiles(d.dbPath), srcBefore, "source DB and sidecars unchanged (sha, size, mtime, ctime, inode)");
      assert.deepEqual(compareUploadTrees(upBefore, uploadsTree(d.uploadsDir)), [], "source uploads unchanged");
      assert.equal(m.verified, true, m.problems.join("; "));
      assert.equal(sha256File(path.join(r.backupDir, "cold", COLD_DB)), sha256File(d.dbPath));
      assert.equal(m.artifacts.cold[COLD_DB].sha256, m.source.pre.main.sha256);
      assert.deepEqual(dirEntries(path.join(r.backupDir, "cold")), [COLD_DB], "no sidecars in cold/ for a checkpointed source");
      assert.equal(m.checks.logical!.integrity, "ok");
      assert.equal(m.checks.logical!.foreignKeyViolations, 0);
      assert.equal(m.checks.logical!.state, "LEGACY_BASELINE");
      assert.equal(m.checks.countsEqual, true);
      assert.deepEqual(m.checks.coldDerived!.counts, m.checks.logical!.counts);
      assert.ok(m.checks.logical!.counts.documents === 3 && m.checks.logical!.counts.photos === 1);
      assert.equal(m.checks.artifactsUnchanged, true);
      assert.equal(m.source.pre.journal.exists, false);
      assert.ok(m.createdAtUtc.endsWith("Z") && m.createdAtLocal.length > 0);
      assert.ok(m.versions.sqlite && m.versions.node && m.runner);
      // uploads (T-UP01 through the backup): 4 references → 3 files, copied and equal
      assert.equal(m.uploads.references!.references.length, 4);
      assert.equal(m.uploads.references!.files.length, 3);
      assert.deepEqual(m.uploads.backupProblems, []);
      assert.deepEqual(compareUploadTrees(upBefore, uploadsTree(path.join(r.backupDir, "uploads"))), []);
      // manifest on disk equals the returned manifest
      assert.deepEqual(readManifest(r.backupDir), JSON.parse(JSON.stringify(m)));
      // verification does not change any artifact
      const artifacts = [path.join(r.backupDir, "cold", COLD_DB), path.join(r.backupDir, "logical", COLD_DB)].map(sha256File);
      const v = verifyBackup({ backupDir: r.backupDir, cwd: ROOT });
      assert.equal(v.exitCode, 0, v.message);
      assert.deepEqual([path.join(r.backupDir, "cold", COLD_DB), path.join(r.backupDir, "logical", COLD_DB)].map(sha256File), artifacts);
      assert.equal(dbFiles(d.dbPath), srcBefore);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG25 truncated byte, flipped page byte, removed upload, altered manifest hash → verified:false, exit 5 (lib and CLI)", () => {
    const corruptions: Array<[string, (dir: string) => void]> = [
      ["truncate one byte of the cold DB", (dir) => {
        const f = path.join(dir, "cold", COLD_DB);
        const b = fs.readFileSync(f);
        fs.writeFileSync(f, b.subarray(0, b.length - 1));
      }],
      ["flip one byte in a page of the cold DB", (dir) => {
        const f = path.join(dir, "cold", COLD_DB);
        const b = fs.readFileSync(f);
        b[4096 + 100] ^= 0xff;
        fs.writeFileSync(f, b);
      }],
      ["remove an upload file from the backup", (dir) => {
        const up = path.join(dir, "uploads");
        const file = uploadsTree(up).entries.find((e) => e.kind === "file")!;
        fs.renameSync(path.join(up, file.relpath), path.join(dir, "removed-upload"));
      }],
      ["alter a hash in the manifest", (dir) => {
        const f = path.join(dir, "manifest.json");
        const m = JSON.parse(fs.readFileSync(f, "utf8")) as BackupManifest;
        m.artifacts.cold[COLD_DB].sha256 = "0".repeat(64);
        fs.writeFileSync(f, JSON.stringify(m));
      }],
    ];
    for (const [label, corrupt] of corruptions) {
      const d = disposable();
      try {
        const r = backupOf(d);
        corrupt(r.backupDir);
        const v = verifyBackup({ backupDir: r.backupDir, cwd: ROOT });
        assert.equal(v.exitCode, 5, `${label}: ${v.message}`);
        const c = cli(VERIFY_CLI, ["--backup", r.backupDir]);
        assert.equal(c.status, 5, `${label} (CLI): ${c.stderr}`);
        if (label !== "remove an upload file from the backup") {
          // restore refuses a backup whose artifacts do not match, before touching the target
          const target = path.join(d.dir, "restore-target.db");
          const rr = restoreBackup({ backupDir: r.backupDir, targetDbPath: target, cwd: ROOT });
          assert.equal(rr.exitCode, 5, `${label} restore: ${rr.message}`);
          assert.equal(fs.existsSync(target), false);
        }
      } finally {
        d.cleanup();
      }
    }
  });

  it("T-MG26 non-empty WAL: -wal copied into cold/, source not checkpointed (sha, size, mtime unchanged), WAL rows counted", () => {
    const d = disposable(false);
    try {
      // build a WAL-mode DB whose -wal holds committed rows, then copy db+wal with no holder
      const writerFile = path.join(d.dir, "writer.db");
      const w = new Database(writerFile);
      w.pragma("journal_mode = WAL");
      w.pragma("wal_autocheckpoint = 0");
      w.exec(SCHEMA_SQL);
      w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      for (let i = 0; i < 5; i++) w.prepare("INSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES (?, 'n', 'c', 'p', 'n', 'n')").run(`org_wal_${i}`);
      fs.copyFileSync(writerFile, d.dbPath);
      fs.copyFileSync(`${writerFile}-wal`, `${d.dbPath}-wal`);
      w.close();
      assert.ok(fs.statSync(`${d.dbPath}-wal`).size > 0, "fixture -wal is non-empty");
      const before = dbFiles(d.dbPath);
      const r = backupOf(d);
      assert.equal(dbFiles(d.dbPath), before, "source DB and -wal unchanged: no checkpoint on the source");
      assert.deepEqual(dirEntries(path.join(r.backupDir, "cold")), [COLD_DB, `${COLD_DB}-wal`]);
      assert.equal(sha256File(path.join(r.backupDir, "cold", `${COLD_DB}-wal`)), sha256File(`${d.dbPath}-wal`));
      assert.equal(r.manifest.checks.coldDerived!.counts.organizations, 5, "rows only in the -wal are present in the cold-derived copy");
      assert.equal(r.manifest.checks.logical!.counts.organizations, 5);
      // restore of a WAL backup: db + -wal restored, no -shm, state as recorded
      const target = path.join(d.dir, "restored", "t.db");
      fs.mkdirSync(path.dirname(target));
      const rr = restoreBackup({ backupDir: r.backupDir, targetDbPath: target, cwd: ROOT });
      assert.equal(rr.exitCode, 0, rr.message);
      assert.equal(sha256File(`${target}-wal`), sha256File(`${d.dbPath}-wal`));
      assert.equal(fs.existsSync(`${target}-shm`), false);
      assert.equal(rr.restoredState, r.manifest.checks.logical!.state);
    } finally {
      d.cleanup();
    }
  });

  it("T-UP06 / source change detection: an upload or the source DB changing during the backup → verified:false, exit 5", () => {
    const d = disposable();
    let restore: (() => void) | null = null;
    try {
      const file = path.join(d.uploadsDir, uploadsTree(d.uploadsDir).entries.find((e) => e.kind === "file")!.relpath);
      restore = setBackupHooksForTests({ afterPreState: () => fs.appendFileSync(file, "changed after the pre-state manifest") });
      const r = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: d.backups, cwd: ROOT });
      restore();
      restore = null;
      assert.equal(r.exitCode, 5, r.message);
      assert.equal(r.manifest!.verified, false);
      assert.ok(r.manifest!.problems.some((p) => p.startsWith("source uploads changed")), r.message);
      assert.equal(readManifest(r.backupDir!) && (readManifest(r.backupDir!) as BackupManifest).verified, false);
      assert.equal(verifyBackup({ backupDir: r.backupDir!, cwd: ROOT }).exitCode, 5);

      restore = setBackupHooksForTests({ afterColdCopy: () => fs.utimesSync(d.dbPath, new Date(1), new Date(1)) }); // metadata-only change of the source
      const r2 = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: path.join(d.dir, "backups2"), cwd: ROOT });
      restore();
      restore = null;
      assert.equal(r2.exitCode, 5, r2.message);
      assert.ok(r2.manifest!.problems.includes("source main changed during the backup"), r2.message);
    } finally {
      restore?.();
      d.cleanup();
    }
  });

  it("T-HC01 a child process holding the source → backup exit 2; holding the restore target → restore exit 2", async () => {
    const d = disposable();
    let child: ChildProcess | null = null;
    try {
      const good = backupOf(d);
      child = await holdOpen(d.dbPath);
      const before = dbFiles(d.dbPath);
      const r = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: path.join(d.dir, "held"), cwd: ROOT });
      assert.equal(r.exitCode, 2, r.message);
      assert.match(r.message, new RegExp(`held by pid ${child.pid}`));
      assert.equal(fs.existsSync(path.join(d.dir, "held")), false, "nothing is created on refusal");
      const rr = restoreBackup({ backupDir: good.backupDir, targetDbPath: d.dbPath, cwd: ROOT });
      assert.equal(rr.exitCode, 2, rr.message);
      assert.equal(rr.quarantineDir, null);
      await stop(child);
      child = null;
      assert.equal(dbFiles(d.dbPath), before, "source/target unchanged by the refused backup and restore");
      assert.deepEqual(dirEntries(d.dir).filter((n) => n.startsWith("data-quarantine")), []);
    } finally {
      await stop(child);
      d.cleanup();
    }
  });

  it("JOURNAL_PRESENT: a -journal at the source or the restore target is refused (exit 2) and never touched", () => {
    const d = disposable();
    try {
      const good = backupOf(d);
      fs.writeFileSync(`${d.dbPath}-journal`, Buffer.alloc(512, 7));
      const before = dbFiles(d.dbPath);
      const r = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: path.join(d.dir, "jb"), cwd: ROOT });
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /JOURNAL_PRESENT/);
      assert.equal(fs.existsSync(path.join(d.dir, "jb")), false);
      const rr = restoreBackup({ backupDir: good.backupDir, targetDbPath: d.dbPath, cwd: ROOT });
      assert.equal(rr.exitCode, 2);
      assert.match(rr.message, /JOURNAL_PRESENT/);
      assert.equal(dbFiles(d.dbPath), before, "DB and -journal unchanged (not moved, deleted or rewritten)");
      const c = cli(RESTORE_CLI, ["--backup", good.backupDir, "--db", d.dbPath]);
      assert.equal(c.status, 2, c.stderr);
      assert.equal(dbFiles(d.dbPath), before);
    } finally {
      d.cleanup();
    }
  });

  it("refuses a missing source, a symlinked source and a non-regular -wal (exit 2)", () => {
    const d = disposable(false);
    try {
      assert.equal(createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: d.backups, cwd: ROOT }).exitCode, 2);
      createDbFile(path.join(d.dir, "real.db"), SCHEMA_SQL);
      fs.symlinkSync(path.join(d.dir, "real.db"), d.dbPath);
      assert.equal(createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: d.backups, cwd: ROOT }).exitCode, 2);
      const other = path.join(d.dir, "o.db");
      createDbFile(other, SCHEMA_SQL);
      fs.mkdirSync(`${other}-wal`);
      assert.equal(createBackup({ dbPath: other, uploadsDir: d.uploadsDir, backupRoot: d.backups, cwd: ROOT }).exitCode, 2);
      assert.equal(fs.existsSync(d.backups), false);
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-4 restore (§G.2, §G.4 on disposable targets)", () => {
  it("T-MG27 restore into a temp target: sha = manifest, no -shm, old db/-wal/-shm moved to quarantine (not deleted)", () => {
    const d = disposable();
    try {
      const r = backupOf(d);
      const target = path.join(d.dir, "target", "stweg.db");
      fs.mkdirSync(path.dirname(target));
      createDbFile(target, SCHEMA_SQL + "\nINSERT INTO organizations (id, name, company_name, product_name, created_at, updated_at) VALUES ('old', 'n', 'c', 'p', 'n', 'n');");
      fs.writeFileSync(`${target}-wal`, "old wal bytes");
      fs.writeFileSync(`${target}-shm`, "old shm bytes");
      const old = ["", "-wal", "-shm"].map((s) => sha256File(target + s));
      const rr = restoreBackup({ backupDir: r.backupDir, targetDbPath: target, cwd: ROOT });
      assert.equal(rr.exitCode, 0, rr.message);
      assert.equal(sha256File(target), r.manifest.artifacts.cold[COLD_DB].sha256);
      assert.equal(fs.existsSync(`${target}-shm`), false);
      assert.equal(fs.existsSync(`${target}-wal`), false);
      assert.ok(rr.quarantineDir && path.basename(rr.quarantineDir).startsWith("data-quarantine-"));
      assert.deepEqual(["", "-wal", "-shm"].map((s) => sha256File(path.join(rr.quarantineDir!, `stweg.db${s}`))), old, "quarantined files are byte-identical");
      assert.equal(rr.restoredState, "LEGACY_BASELINE");
    } finally {
      d.cleanup();
    }
  });

  it("T-MG28 + §G.2 rehearsal: backup → apply (MANAGED_CURRENT) → restore → LEGACY_BASELINE, sha = cold; second restore identical", () => {
    const d = disposable();
    try {
      const t0 = Date.now();
      const r = backupOf(d);
      const tBackup = Date.now() - t0;
      const applied = applyMigrations({ dbPath: d.dbPath, cwd: ROOT });
      assert.equal(applied.exitCode, 0, applied.message);
      assert.equal(statusState(d.dbPath), "MANAGED_CURRENT");
      const t1 = Date.now();
      const rr = restoreBackup({ backupDir: r.backupDir, targetDbPath: d.dbPath, cwd: ROOT });
      const tRestore = Date.now() - t1;
      assert.equal(rr.exitCode, 0, rr.message);
      assert.equal(sha256File(d.dbPath), r.manifest.artifacts.cold[COLD_DB].sha256);
      assert.equal(statusState(d.dbPath), "LEGACY_BASELINE");
      // the applied DB is preserved in quarantine
      assert.ok(rr.quarantineDir && fs.existsSync(path.join(rr.quarantineDir, "stweg.db")));
      // second restore into a fresh dir: identical
      const second = path.join(d.dir, "second", "stweg.db");
      fs.mkdirSync(path.dirname(second));
      const rr2 = restoreBackup({ backupDir: r.backupDir, targetDbPath: second, cwd: ROOT });
      assert.equal(rr2.exitCode, 0, rr2.message);
      assert.equal(sha256File(second), sha256File(d.dbPath));
      assert.equal(statusState(second), "LEGACY_BASELINE");
      console.log(`# G.2 rehearsal durations (synthetic seeded DB): backup ${tBackup} ms, restore ${tRestore} ms`);
    } finally {
      d.cleanup();
    }
  });

  it("restore refuses an unverified backup (exit 5) and a target inside the backup dir (exit 2)", () => {
    const d = disposable();
    let undo: (() => void) | null = null;
    try {
      const good = backupOf(d);
      const file = path.join(d.uploadsDir, uploadsTree(d.uploadsDir).entries.find((e) => e.kind === "file")!.relpath);
      undo = setBackupHooksForTests({ afterPreState: () => fs.appendFileSync(file, "x") });
      const bad = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: path.join(d.dir, "bad"), cwd: ROOT });
      undo();
      undo = null;
      assert.equal(bad.exitCode, 5);
      const target = path.join(d.dir, "t2.db");
      assert.equal(restoreBackup({ backupDir: bad.backupDir!, targetDbPath: target, cwd: ROOT }).exitCode, 5);
      assert.equal(fs.existsSync(target), false);
      assert.equal(restoreBackup({ backupDir: good.backupDir, targetDbPath: path.join(good.backupDir, "x.db"), cwd: ROOT }).exitCode, 2);
    } finally {
      undo?.();
      d.cleanup();
    }
  });
});

function statusState(db: string): string {
  // status runs on a copy (the snapshot read refuses live sidecars); fold a -wal in the copy only
  const s = makeScratchDir();
  const h = withTempEnv();
  try {
    const copy = path.join(h.dir, "copy.db");
    fs.copyFileSync(db, copy);
    if (fs.existsSync(`${db}-wal`)) {
      fs.copyFileSync(`${db}-wal`, `${copy}-wal`);
      const c = new Database(copy);
      c.prepare("SELECT count(*) FROM sqlite_master").get();
      c.close();
    }
    const r = snapshotStatus(copy, registryView(MIGRATIONS), ROOT);
    assert.ok(r.ok, JSON.stringify(r));
    return r.state;
  } finally {
    h.cleanup();
    s.cleanup();
  }
}

describe("A2-4 T-MG34 uploads unchanged by apply", () => {
  it("T-MG34 the uploads manifest is identical before and after apply", () => {
    const d = disposable();
    try {
      const before = uploadsTree(d.uploadsDir);
      const r = applyMigrations({ dbPath: d.dbPath, cwd: ROOT });
      assert.equal(r.exitCode, 0, r.message);
      const afterTree = uploadsTree(d.uploadsDir);
      assert.deepEqual(compareUploadTrees(before, afterTree), []);
      assert.deepEqual(afterTree.entries.map((e) => e.kind === "file" && e.ino), before.entries.map((e) => e.kind === "file" && e.ino), "same inodes: nothing rewritten");
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-4 path guards for the backup tools (T-MG30, T-MG31 backup CLIs, O-4)", () => {
  it("O-4: the real backup location is refused by path string alone and is never created", () => {
    assert.equal(guardDir("backup root", O4_REAL_BACKUP_ROOT, ROOT).ok, false);
    assert.equal(guardDir("backup root", path.join(O4_REAL_BACKUP_ROOT, "sub"), ROOT).ok, false);
    assert.equal(guardDb("db", path.join(O4_REAL_BACKUP_ROOT, "x", "cold", "stweg.db"), ROOT).ok, false);
    const d = disposable();
    try {
      const r = createBackup({ dbPath: d.dbPath, uploadsDir: d.uploadsDir, backupRoot: O4_REAL_BACKUP_ROOT, cwd: ROOT });
      assert.equal(r.exitCode, 2);
      assert.match(r.message, /O-4/);
      const c = cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir, "--out", O4_REAL_BACKUP_ROOT]);
      assert.equal(c.status, 2, c.stderr);
      const c2 = cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir]); // default --out is O-4
      assert.equal(c2.status, 2, c2.stderr);
      assert.equal(cli(VERIFY_CLI, ["--backup", path.join(O4_REAL_BACKUP_ROOT, "x")]).status, 2);
      assert.equal(cli(RESTORE_CLI, ["--backup", path.join(O4_REAL_BACKUP_ROOT, "x"), "--db", path.join(d.dir, "t.db")]).status, 2);
      assert.equal(o4State(), o4Before);
    } finally {
      d.cleanup();
    }
  });

  it("T-MG30 fake checkout with data/stweg.db: backup/verify/restore CLIs on the default or explicit data/ paths exit 2; files byte-identical", () => {
    const s = makeScratchDir();
    const d = disposable();
    try {
      const good = backupOf(d);
      const cwd = path.join(s.dir, "checkout");
      fs.mkdirSync(path.join(cwd, "data", "uploads", "org_demo"), { recursive: true });
      createDbFile(path.join(cwd, "data", "stweg.db"), SCHEMA_SQL);
      fs.writeFileSync(path.join(cwd, "data", "uploads", "org_demo", "f.pdf"), "fake upload");
      const before = dirState(path.join(cwd, "data"));
      const env = plainEnv(s.dir);
      const runs = [
        cli(BACKUP_CLI, [], { cwd, env }),
        cli(BACKUP_CLI, ["--db", "data/stweg.db", "--uploads", "data/uploads", "--out", d.backups], { cwd, env }),
        cli(BACKUP_CLI, ["--db", path.join(d.dir, "nope.db"), "--uploads", "data/uploads", "--out", d.backups], { cwd, env }),
        cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir, "--out", path.join(cwd, "data", "backups")], { cwd, env }),
        cli(VERIFY_CLI, ["--backup", "data"], { cwd, env }),
        cli(RESTORE_CLI, ["--backup", good.backupDir], { cwd, env }),
        cli(RESTORE_CLI, ["--backup", good.backupDir, "--db", "data/stweg.db"], { cwd, env }),
        cli(BACKUP_CLI, [], { cwd, env: { ...env, STWEG_TEST: "1" } }),
      ];
      runs.forEach((r, i) => assert.equal(r.status, 2, `run ${i}: ${r.stderr}`));
      assert.equal(dirState(path.join(cwd, "data")), before, "fake checkout data/ byte-identical");
      assert.deepEqual(fs.readdirSync(path.join(cwd, "data")).sort(), ["stweg.db", "uploads"]);
    } finally {
      d.cleanup();
      s.cleanup();
    }
  });

  it("T-MG31 unmarked dir, hard link and symlink chain → exit 2 (backup and restore CLIs)", () => {
    const s = makeScratchDir();
    const d = disposable();
    try {
      const good = backupOf(d);
      const unmarked = path.join(s.dir, "u.db");
      createDbFile(unmarked, SCHEMA_SQL);
      const hard = path.join(d.dir, "hard.db");
      fs.linkSync(unmarked, hard);
      const chain1 = path.join(d.dir, "chain1.db");
      fs.symlinkSync(path.join(d.dir, "chain2.db"), chain1);
      fs.symlinkSync(unmarked, path.join(d.dir, "chain2.db"));
      const before = dirState(s.dir);
      for (const db of [unmarked, hard, chain1]) {
        const b = cli(BACKUP_CLI, ["--db", db, "--uploads", d.uploadsDir, "--out", path.join(d.dir, "bk")]);
        assert.equal(b.status, 2, `backup ${db}: ${b.stderr}`);
        const r = cli(RESTORE_CLI, ["--backup", good.backupDir, "--db", db]);
        assert.equal(r.status, 2, `restore ${db}: ${r.stderr}`);
      }
      assert.equal(cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", path.join(s.dir), "--out", path.join(d.dir, "bk")]).status, 2, "unmarked uploads dir");
      assert.equal(cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir, "--out", path.join(s.dir, "bk")]).status, 2, "unmarked backup root");
      assert.equal(cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir, "--out", path.join(d.uploadsDir, "bk")]).status, 2, "backup root inside uploads");
      assert.equal(cli(VERIFY_CLI, ["--backup", s.dir]).status, 2, "unmarked backup dir");
      assert.equal(dirState(s.dir), before);
      assert.equal(fs.existsSync(path.join(d.dir, "bk")), false);
    } finally {
      d.cleanup();
      s.cleanup();
    }
  });

  it("CLIs: backup → verify → restore succeed on disposable paths; usage errors exit 1", () => {
    const d = disposable();
    try {
      const b = cli(BACKUP_CLI, ["--db", d.dbPath, "--uploads", d.uploadsDir, "--out", d.backups, "--json"]);
      assert.equal(b.status, 0, b.stderr);
      const out = JSON.parse(b.stdout) as { backupDir: string; verified: boolean };
      assert.equal(out.verified, true);
      assert.equal(cli(VERIFY_CLI, ["--backup", out.backupDir]).status, 0);
      const target = path.join(d.dir, "r", "stweg.db");
      fs.mkdirSync(path.dirname(target));
      const r = cli(RESTORE_CLI, ["--backup", out.backupDir, "--db", target]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(sha256File(target), sha256File(d.dbPath));
      for (const [script, args] of [[BACKUP_CLI, ["--bogus"]], [VERIFY_CLI, []], [RESTORE_CLI, ["--db", target]], [BACKUP_CLI, ["--db"]]] as const) {
        assert.equal(cli(script, [...args]).status, 1, `${path.basename(script)} ${args.join(" ")}`);
      }
    } finally {
      d.cleanup();
    }
  });
});

describe("A2-4 static: no deletion code path in the backup tools", () => {
  it("backup.ts, uploads-manifest.ts and the backup CLIs contain no unlink/rm/rmdir/truncate calls and no SQL deletes", () => {
    const files = ["src/lib/backup.ts", "src/lib/uploads-manifest.ts", "scripts/db-backup.ts", "scripts/db-verify-backup.ts", "scripts/db-restore.ts"];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.doesNotMatch(text, /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(/, f);
      assert.doesNotMatch(text, /\b(DELETE\s+FROM|DROP\s+TABLE|wal_checkpoint)\b/i, f);
    }
  });
});
