# A2 migrations: operator runbook

Status: written in A2-7 (Workshop 5B rev2, §C–§I).

**Read this first.** In this build, every tool described here works **only on marked disposable databases**. The following are **separately gated**: none of them is implemented, and none is authorized by this document.

- A2-apply-0 (the protected-path override, O-9)
- A2-apply: backup, `apply` or restore of the real database
- the read-only startup schema check
- feature migrations (`0002` or later; gate G-FM)
- deletion work (D-13, D-28)

Each needs its own recorded owner authorization. **Nothing in A2 has been verified against the real database.** All evidence comes from automated tests on synthetic fixtures and disposable copies.

Owner-scope decisions D-13, D-24, D-27, D-28 and D-29 are unchanged by A2.

## 1. Tools

| Command | What it does | Exit codes |
| --- | --- | --- |
| `npm run db:migrate -- status --db <file> [--json]` | Snapshot read: copies the DB bytes and inspects the copy. It never opens `<file>` with SQLite and writes nothing next to it. It also reports interrupted runs found in the run log. | 0, 1, 2, 6 |
| `npm run db:migrate -- apply --db <file> [--json]` | Runs, in order: path guard, holder check, `status`, then `BEGIN IMMEDIATE` (`busy_timeout` 5000). Adopts `LEGACY_BASELINE`, applies `EMPTY` or `MANAGED_PENDING`, and is a no-op on `MANAGED_CURRENT`. Each run writes a run log to `<db dir>/migrate-runlogs/migrate-<ts>-<pid>.jsonl`. | 0–3, 6 |
| `npm run db:backup -- --db <file> --uploads <dir> --out <dir> [--json]` | §G.1 cold backup with no checkpoint on the source, a logical `VACUUM INTO` copy, checks on disposable copies, the uploads copy, the upload reference verification (§G.3) and `manifest.json`. | 0, 1, 2, 5 |
| `npm run db:verify-backup -- --backup <dir> [--json]` | Re-verifies a backup: artifact hashes, uploads, and checks on fresh copies. | 0, 1, 2, 5 |
| `npm run db:restore -- --backup <dir> --db <file> [--json]` | Restores `cold/` into a marked disposable target. Existing target files move to `data-quarantine-<ts>/`. A target `-journal` is refused. Uploads are not restored. | 0, 1, 2, 4, 5 |

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | ok or no-op |
| 1 | usage, unexpected error, or "database busy" |
| 2 | refused |
| 3 | rolled back |
| 4 | post-commit verification failed |
| 5 | backup or verification failed |
| 6 | undeterminable (non-empty `-wal`) |

**Path guard (O-9).** The guard refuses with exit 2 **before reading anything**:

- the default `data/` location or anything inside it;
- any path not inside a directory marked `.stweg-harness`;
- hard links to, or identity matches with, the default database or its sidecars.

The backup tools also refuse `/home/box/stweg-backups/` (O-4) for every directory argument. There is no override flag.

## 2. Prerequisites (before any `apply`, backup or restore)

1. The target is a marked disposable copy. In this build, the tools enforce this themselves.
2. **The app is stopped.** Identify STWEG processes by **working directory = the checkout**, not by port: port 3456 may be used by an unrelated project, and must never be touched. Record `ps` and `ss -ltnp` output.
3. The holder check passes (it runs as part of `apply`, `db:backup` and `db:restore`). It does **not** replace step 2 (see L-HC below).
4. No `-journal` file exists next to the DB, and `-wal` is absent or 0 bytes.
5. `status` reports a state you expect, with the pinned fingerprint (`ae794d44…a581`) where relevant.
6. For `db:backup`: the `--out` directory is a marked disposable directory, and there is enough free space for at least two DB copies plus the uploads tree.
7. Git working tree: record `git rev-parse HEAD` (the tools record it in run logs and manifests, read with `GIT_OPTIONAL_LOCKS=0`).

## 3. Stop conditions

Stop and report; do not retry, work around or "fix" anything in these cases:

- `status` or `apply` exits 2 with `JOURNAL_PRESENT`. Go to §5.
- `status` or `apply` exits 6 (`UNDETERMINABLE_WAL_PENDING`). The DB was not quiesced: stop the writer, then follow §5.3 on a **copy**.
- The state is `LEGACY_UNKNOWN`, `NEWER` or `INCONSISTENT`, or there is a checksum or name mismatch with the registry (exit 2).
- The fingerprint or structural hash differs from the pinned values on a database expected to be at the baseline.
- `apply` exits 3. The run was rolled back. Keep the run log and record `status` before deciding anything.
- `apply` exits 1 with "database busy". Something else holds the lock. Find it; do not raise the timeout.
- The holder check names another process (exit 2), or it reports `PROC_UNREADABLE`.
- `db:backup` or `db:verify-backup` exits 5, or a manifest shows `verified: false`.
- `db:restore` exits 4 or 5.
- The source sha256 changes during a backup, or uploads hashes differ between source, backup and post-apply.
- Any tool would need to touch the real `data/` directory, `/home/box/stweg-backups/`, or port 3456. That is out of scope for this build.
- Anything requires changing `src/lib/db.ts`, `src/lib/schema.ts`, dependencies or the lockfile.

## 4. Normal disposable procedure

```bash
D=$(mktemp -d) && touch "$D/.stweg-harness"           # marked disposable directory
# put a synthetic DB at $D/stweg.db (e.g. a temp-mode seed, see README)
npm run db:migrate -- status --db "$D/stweg.db"         # expect EMPTY or LEGACY_BASELINE
B=$(mktemp -d) && touch "$B/.stweg-harness"
npm run db:backup -- --db "$D/stweg.db" --uploads "$D/uploads" --out "$B"   # exit 0 = verified
npm run db:verify-backup -- --backup "$B/<backup-dir>"
npm run db:migrate -- apply --db "$D/stweg.db"          # adopt or apply; exit 0
npm run db:migrate -- status --db "$D/stweg.db"         # expect MANAGED_CURRENT
```

Restore rehearsal (§G.2): restore `cold/` into a **new** marked directory, check that `status` = `LEGACY_BASELINE`, then `apply`, then restore again into a second directory and confirm the sha is identical.

## 5. Recovery

None of the A2 tools perform recovery. They refuse, and they never delete, recover or rewrite a journal, a WAL or a database file. Every step below is an **operator action**, taken deliberately and recorded.

### 5.1 Journal present: identify the kind (inspect a copy only)

Copy the main file **and** the journal into a new marked disposable directory, then read the journal header from the **copy** (for example `xxd -l 32`).

- **0-byte journal:** an empty file. It carries no rollback data.
- **Zero-header journal:** the header bytes are zero, so SQLite does not treat it as hot and will not roll anything back. It was observed after SIGKILL mid-adoption (T-MG15), where the main file was unchanged from the pre-crash state (same sha256, `LEGACY_BASELINE`, `user_version` 0).
- **Hot journal:** a valid header and page records. A crashed writer left the main file partly written. The next ordinary SQLite open **rolls it back** (T-JN02 shows this on a copy).

### 5.2 Operator-directed recovery: disposable databases

1. Stop whatever used the DB. Run `status` and record `JOURNAL_PRESENT` and the run-log assessment, including any "interrupted" runs.
2. Copy the main file and the journal for inspection.
3. On the copy, inspect the header (§5.1) and run `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and `status`.
4. Decide one of:
   - **discard** the disposable DB and recreate it;
   - for a **hot journal**: let SQLite roll it back with an explicit open of the disposable DB (operator action);
   - for a **zero-header or 0-byte journal**, where the main file is verified unchanged (sha256 against a known-good record): remove the journal (operator action).
5. Re-run `status`. Only if it reports a consistent state, re-run `apply`.

In the automated tests, steps 2 to 4 are performed by the harness on synthetic fixtures and labelled "TEST-ONLY operator action". That is not runner behaviour.

### 5.3 Non-empty `-wal` (exit 6)

The main file alone cannot establish the schema. Stop the writer. On a **copy** of the main file plus the `-wal`, an ordinary open followed by a read (for example `SELECT count(*) FROM sqlite_master`) and a clean close folds the WAL. Then run `status` on that copy. For a disposable DB, the operator may do the same on the DB itself once nothing holds it. Opening a DB without reading it does not replay the WAL.

### 5.4 Non-disposable databases (A2-apply only; separately gated)

- **Do not attempt journal or WAL recovery** on the real database or its sidecars, and do not experiment on them.
- **Restore from the verified backup** (§G.4):
  1. stop the app and run the holder check;
  2. move the current DB, `-wal` and `-shm` into `data-quarantine-<ts>/`, without deleting anything (D-13);
  3. copy `cold/` into place, with no `-shm`;
  4. verify the sha against the manifest;
  5. run `status` on a copy and confirm `LEGACY_BASELINE`;
  6. revert the code (owner action: `git revert`, no force-push);
  7. restart.
- Any deviation needs an explicit owner decision. This build's tools refuse the real database, so this path becomes available only after A2-apply-0 is authorized.

### 5.5 Restoring a disposable DB from a verified backup

1. `npm run db:verify-backup -- --backup <dir>` must exit 0.
2. Run `npm run db:restore -- --backup <dir> --db <target>`. The existing target files are moved to `data-quarantine-<ts>/`. A target `-journal` is refused, so resolve it first (§5.2).
3. Run `status` on the target and check that the state matches the manifest.

Uploads are restored by hand from `<backup>/uploads/` if needed. Verify their hashes against `manifest.json`.

## 6. A2-apply checklist (reference only; separately gated)

The checklist from §I applies only after a recorded owner authorization and A2-apply-0:

1. authorization recorded
2. before-snapshot, including the uploads sha
3. app stopped and holder check
4. backup and verification
5. off-box copy
6. dry-run `status` on a disposable cold copy: must be `LEGACY_BASELINE` with `ae794d44…`, otherwise stop
7. restore rehearsal
8. owner go or no-go
9. `apply`
10. post-checks on a copy
11. after-snapshot
12. owner smoke test

**Backup retention is bound to D-13:** there is no indefinite retention, and A2 deletes nothing automatically.

## 7. Limitations (open)

- **L1 (open):** the explicit seed flag outside test mode can bypass the identity check through a hard link to the default DB. R1 was implemented as **warning-only**, so L1 remains open.
- **L2:** a time-of-check/time-of-use (TOCTOU) gap between the path check and SQLite's open. A hard link planted in between writes through to the protected DB.
- **L3:** native Windows is unsupported. Existing DB files are refused as identity-unreliable, and the holder check is Linux-only (`/proc`).
- **L-HC: the holder check is incomplete.** Processes whose `/proc/<pid>/fd` cannot be read are recorded as `uninspectable` and do **not** block. On the implementation box, 14 processes were uninspectable (root-owned processes, `orbitd`, and 3 non-dumpable `bash` processes). Such a process could hold the DB undetected. The check is an extra layer only. **It must not be used to authorize real-database operations** without a separate owner decision.
- **The tests' file-open spy cannot see SQLite's native `open()`.** The "no open" assertions cover Node `fs` calls only. The SQLite side is shown indirectly: journals stay hot and byte-identical, and sha, size, mtime, ctime and inode are unchanged.
- **`synchronous=NORMAL`** (the WAL build default, O-8) is unchanged. A power loss can lose the last committed transactions.
- **Unmanaged fresh DBs (RK-N1):** `getDb()` on a new path creates a `LEGACY_BASELINE` database without history. This is harmless while only `0001` exists; it must be adopted with `apply`.
- **Gate G-FM:** no feature migration until a startup check plus a `getDb()` change, or runner-delegated initialization, is authorized and accepted. Editing `schema.ts` would drift from `0001_baseline` (RK-N2); the freeze tests catch this.
- **No startup check:** the app opens any DB at the resolved path, including drifted, newer or inconsistent ones (RK-N4).
- `status` reports a state from a byte copy taken at one moment. It does not lock the source.
