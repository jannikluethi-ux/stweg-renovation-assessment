import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "../lib/schema";
import { compareUploadTrees, resolveReference, uploadsTree, verifyReferences } from "../lib/uploads-manifest";
import { dirState, memoryDb, sha256File } from "./fixtures/schema-fixtures";
import { makeScratchDir, withTempEnv } from "./harness";

/*
 * A2-4: uploads manifest and storage_reference verification (Workshop 5B §G.3, T-UP01–T-UP06).
 * Synthetic in-memory databases and disposable upload trees only. Read-only code under test:
 * orphans are listed, never deleted (D-13, D-28). The checkout's data/ must be unchanged.
 */

const ROOT = process.cwd();
const REAL_DATA = path.join(ROOT, "data");
const realBefore = fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none";
after(() => assert.equal(fs.existsSync(REAL_DATA) ? dirState(REAL_DATA) : "none", realBefore, "checkout data/ must be unchanged"));

function refsDb(docs: Array<[string, string]>, photos: Array<[string, string]> = []): Database.Database {
  const db = memoryDb(SCHEMA_SQL);
  db.pragma("foreign_keys = OFF");
  const d = db.prepare("INSERT INTO documents (id, organization_id, property_id, category, filename, original_name, upload_date, storage_reference, created_at) VALUES (?, 'o', 'p', 'c', 'f', 'f', 'n', ?, 'n')");
  for (const [id, ref] of docs) d.run(id, ref);
  const p = db.prepare("INSERT INTO photos (id, organization_id, property_id, filename, storage_reference, created_at) VALUES (?, 'o', 'p', 'f', ?, 'n')");
  for (const [id, ref] of photos) p.run(id, ref);
  return db;
}

/** N-07 shape: 4 references (3 documents + 1 photo) → 3 files; photo_heat.png is referenced twice. */
function n07(up: string): Database.Database {
  const dir = path.join(up, "org_demo", "prop_demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "doc_plans.pdf"), "%PDF-1.1 synthetic plans\n");
  fs.writeFileSync(path.join(dir, "doc_reserve.pdf"), "%PDF-1.1 synthetic reserve\n");
  fs.writeFileSync(path.join(dir, "photo_heat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const rel = (f: string) => path.join("org_demo", "prop_demo", f);
  return refsDb(
    [["doc_plans", rel("doc_plans.pdf")], ["doc_reserve", rel("doc_reserve.pdf")], ["doc_photo", rel("photo_heat.png")]],
    [["photo_heat", rel("photo_heat.png")]],
  );
}

describe("A2-4 uploads manifest and reference verification (§G.3)", () => {
  it("T-UP01 N-07 fixture: 4 references → 3 files, reference counts, hashes, no orphans", () => {
    const t = withTempEnv();
    try {
      const db = n07(t.uploadsDir);
      const v = verifyReferences(db, t.uploadsDir);
      db.close();
      assert.equal(v.ok, true, v.problems.join("; "));
      assert.equal(v.references.length, 4);
      assert.equal(v.files.length, 3);
      assert.deepEqual(Object.fromEntries(v.files.map((f) => [path.basename(f.relpath), f.referenceCount])), { "doc_plans.pdf": 1, "doc_reserve.pdf": 1, "photo_heat.png": 2 });
      for (const r of v.references) {
        assert.equal(r.exists, true);
        assert.equal(r.sha256, sha256File(path.join(t.uploadsDir, r.resolvedRelpath!)));
        assert.ok(r.size! > 0);
      }
      assert.deepEqual(v.orphans, []);
      assert.deepEqual(v.flagged, []);
    } finally {
      t.cleanup();
    }
  });

  it("T-UP02 a missing referenced file → reference not ok (verification false)", () => {
    const t = withTempEnv();
    try {
      const db = n07(t.uploadsDir);
      fs.renameSync(path.join(t.uploadsDir, "org_demo", "prop_demo", "doc_reserve.pdf"), path.join(t.dir, "moved-away.pdf"));
      const v = verifyReferences(db, t.uploadsDir);
      db.close();
      assert.equal(v.ok, false);
      const r = v.references.find((x) => x.rowId === "doc_reserve")!;
      assert.equal(r.ok, false);
      assert.equal(r.exists, false);
      assert.equal(r.problem, "missing");
    } finally {
      t.cleanup();
    }
  });

  it("T-UP03 an orphan file is listed with reference count 0 and still exists afterwards", () => {
    const t = withTempEnv();
    try {
      const db = n07(t.uploadsDir);
      const orphan = path.join(t.uploadsDir, "org_demo", "orphan.txt");
      fs.writeFileSync(orphan, "orphan");
      const before = sha256File(orphan);
      const v = verifyReferences(db, t.uploadsDir);
      db.close();
      assert.equal(v.ok, true, "orphans are reported, not failures");
      assert.deepEqual(v.orphans, [path.join("org_demo", "orphan.txt")]);
      assert.equal(v.files.find((f) => f.relpath === path.join("org_demo", "orphan.txt"))!.referenceCount, 0);
      assert.equal(sha256File(orphan), before, "the orphan still exists, unchanged");
    } finally {
      t.cleanup();
    }
  });

  it("T-UP04 ../ and absolute references fail (lexical rule)", () => {
    const t = withTempEnv();
    try {
      fs.writeFileSync(path.join(t.dir, "outside.txt"), "outside");
      for (const ref of ["../outside.txt", "org/../../outside.txt", path.join(t.dir, "outside.txt"), "/etc/hostname", ""]) {
        const r = resolveReference(t.uploadsDir, ref);
        assert.equal(r.ok, false, `reference ${JSON.stringify(ref)} must fail`);
      }
      const db = refsDb([["d1", "../outside.txt"], ["d2", path.join(t.dir, "outside.txt")]]);
      const v = verifyReferences(db, t.uploadsDir);
      db.close();
      assert.equal(v.ok, false);
      assert.deepEqual(v.references.map((r) => r.ok), [false, false]);
    } finally {
      t.cleanup();
    }
  });

  it("T-UP05 a symlink inside the root pointing outside fails (realpath + lstat), and is flagged in the tree", () => {
    const t = withTempEnv();
    const s = makeScratchDir();
    try {
      fs.writeFileSync(path.join(s.dir, "secret.txt"), "outside");
      fs.symlinkSync(path.join(s.dir, "secret.txt"), path.join(t.uploadsDir, "link.txt"));
      fs.mkdirSync(path.join(t.uploadsDir, "d"));
      fs.symlinkSync(s.dir, path.join(t.uploadsDir, "d", "dirlink"));
      for (const ref of ["link.txt", path.join("d", "dirlink", "secret.txt")]) {
        const r = resolveReference(t.uploadsDir, ref);
        assert.equal(r.ok, false, ref);
      }
      const tree = uploadsTree(t.uploadsDir);
      assert.deepEqual(tree.entries.map((e) => `${e.kind}:${e.relpath}`), ["symlink:d/dirlink", "symlink:link.txt"]);
      const db = refsDb([["d1", "link.txt"]]);
      const v = verifyReferences(db, t.uploadsDir, tree);
      db.close();
      assert.equal(v.ok, false);
      assert.equal(v.flagged.length, 2);
    } finally {
      t.cleanup();
      s.cleanup();
    }
  });

  it("T-UP06 content changed between two manifests → mismatch reported", () => {
    const t = withTempEnv();
    try {
      const db = n07(t.uploadsDir);
      const before = uploadsTree(t.uploadsDir);
      assert.deepEqual(compareUploadTrees(before, uploadsTree(t.uploadsDir)), []);
      fs.appendFileSync(path.join(t.uploadsDir, "org_demo", "prop_demo", "doc_plans.pdf"), "changed");
      const afterTree = uploadsTree(t.uploadsDir);
      assert.deepEqual(compareUploadTrees(before, afterTree), [`content differs: ${path.join("org_demo", "prop_demo", "doc_plans.pdf")}`]);
      // a reference hash that differs from the manifest it is checked against is reported
      const v = verifyReferences(db, t.uploadsDir, before);
      db.close();
      assert.equal(v.ok, false);
      assert.ok(v.problems.some((p) => p.includes("doc_plans") && p.includes("differs from the uploads manifest")));
    } finally {
      t.cleanup();
    }
  });

  it("a missing uploads root is reported as absent; a non-directory root throws", () => {
    const t = withTempEnv();
    try {
      assert.deepEqual(uploadsTree(path.join(t.dir, "nope")), { root: path.join(t.dir, "nope"), exists: false, entries: [] });
      fs.writeFileSync(path.join(t.dir, "file"), "x");
      assert.throws(() => uploadsTree(path.join(t.dir, "file")));
    } finally {
      t.cleanup();
    }
  });
});
