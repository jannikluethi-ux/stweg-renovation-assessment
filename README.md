# STWEG Renovation Assessment

Working product for a Swiss STWEG (condominium) renovation project office. It records a property, scores building components A–M, calculates a transparent priority, builds indicative cost ranges, a 15-year roadmap, three scenarios, and a reserve-fund projection, then prints a professional report.

Branding is stored on the organization, not hard-coded through the screens. The seeded names are **STWEG Renovation Assessment** and **STWEG & Property Project Office**.

This is a planning tool. It does not certify engineering, safety, or prices.

## Requirements

- Node.js 20+
- npm

SQLite is used via `better-sqlite3` because PostgreSQL and Docker are not available in this environment. The schema is relational: core assessment fields are columns. JSON is limited to labels and flexible metadata.

## Install, seed, test, run

```bash
cd /workspace/stweg-assessment
npm install
npm test
npm run build
npm run start
```

`npm run dev` and `npm run start` listen on `127.0.0.1:3456` only, with Next.js telemetry disabled (`NEXT_TELEMETRY_DISABLED=1`). The scripts use a plain POSIX environment prefix, so they work on Linux and macOS; on Windows use WSL or set the variable yourself. If port 3456 is already taken, stop and check what holds it (`ss -ltnp`) before choosing another port by hand.

### Storage paths

| Variable | Default | Purpose |
| --- | --- | --- |
| `STWEG_DB_PATH` | `<working dir>/data/stweg.db` | SQLite database file |
| `STWEG_UPLOADS_DIR` | `<working dir>/data/uploads` | Uploaded documents and photos |

Overrides must be absolute paths. An unset **or empty** variable (for example `STWEG_DB_PATH=` or an unset `$VAR` expansion) falls back to the default, i.e. the real `data/` location; test mode refuses that default. All paths are resolved in `src/lib/config.ts`.

### Tests

`npm test` runs with `NODE_ENV=test STWEG_TEST=1` and loads `src/test/setup.ts`, which points every test process at a disposable database and uploads directory created by `withTempEnv()` (`src/test/harness.ts`). In test mode, `src/lib/config.ts` accepts a DB or uploads path only if, after resolving every symlink (including dangling ones), it is not the default `data/` directory or anything inside it, and it lies inside a directory carrying the harness marker file `.stweg-harness` that is not `/` and does not contain the working directory. Otherwise path resolution throws before the database is opened. Living under `/tmp` (or under `TMPDIR`) does not make a path acceptable by itself, and the harness refuses to run when the OS temp directory is `/`.

### Seeding the demo organization

`npm run seed` deletes and recreates the demo organization and its uploads folder. It refuses to run unless `STWEG_ALLOW_SEED=1` is set **and** either both paths are inside a disposable directory marked with `.stweg-harness` (same rules as test mode above; a directory merely named or located under `tmp` does not count, and the default `data/` location never counts) or the explicit confirmation flag is passed:

```bash
# Disposable copy (recommended)
D=$(mktemp -d) && touch "$D/.stweg-harness"
STWEG_ALLOW_SEED=1 STWEG_DB_PATH="$D/stweg.db" STWEG_UPLOADS_DIR="$D/uploads" npm run seed

# Reset the demo organization in the database at the configured path (default data/stweg.db)
STWEG_ALLOW_SEED=1 npm run seed -- --i-understand-this-deletes-org_demo
```

It only deletes files under `<uploads dir>/org_demo`. It does not touch other organizations in the same database file.

Do not expose this app on a public host from this build.

## Demo logins

Both users belong to the single seeded organization.

| Role | Email | Password |
| --- | --- | --- |
| Project manager | demo@stweg.local | Demo-Sonnenhof-2026 |
| Administrator | admin@stweg.local | Admin-Sonnenhof-2026 |

The project manager cannot edit global cost assumptions, scoring weights, thresholds, the organization contingency default, the disclaimer, or branding. They can set the contingency on an individual assessment and enter manual cost ranges.

## Demo property

**STWEG Sonnenhof**, Seestrasse 48, 8702 Zollikon, canton ZH. Built 2004, 24 apartments, 3 buildings, 4 floors, underground parking. Every figure is labelled **DEMO / synthetic**. It is not market data and not an inspection.

Heating, as the application calculates it:

- Quantity 24 apartments × CHF 8'000–12'000
- Base estimate **CHF 192'000 – CHF 288'000**
- Contingency 15% shown separately: **CHF 28'800 – CHF 43'200**
- Planning budget range: **CHF 220'800 – CHF 331'200**

The reserve opens at CHF 85'000 with an annual contribution of CHF 18'000. Planned expenditure uses the high end of the moderate base estimates, so a **Projected funding gap** appears from 2028 and remains while the balance stays negative. No financing product is recommended.

Ventilation cost-escalation risk is explicitly unknown. It is not scored as 1, and the priority is left uncalculated with “Further technical verification recommended.”

## What v1 does

Dashboard, properties (search by name, municipality, canton, status), property wizard, building profile, documents, component assessment A–M, priority, cost ranges, interventions, scenarios, roadmap year edits, reserve projection, quality errors versus warnings, print-ready report plus HTML download, leads, admin settings, audit log, assessment versions.

Uploads are stored under `data/uploads` and are not publicly served. Allowed types: PDF, JPG, JPEG, PNG, DOCX, XLSX.

The internal assistant only drafts from stored fields. It is not a live model and it does not claim to be an engineer.

## Intentionally not in v1

- Contractor marketplace and public contractor profiles
- Payments, invoices, and accounting
- Tender automation
- Native mobile app
- Live AI, photo diagnosis, or document extraction
- Engineering, safety, or legal certification
- Bank integration
- User invitations (the two seeded users are listed; inviting more is not built)
- Company logo file upload (name, address, and footer are editable)
- A binary PDF library (use the browser print dialog, or download the HTML extract)

## Calculations

All formulas live in `src/domain/calculations.ts` and are covered by `npm test` (`node:test` via `tsx`).

Priority = Condition×0.30 + Urgency×0.30 + Consequence×0.25 + Cost Escalation Risk×0.15, normalized to 0–100.

Bands: 80–100 Critical, 60–79 High, 40–59 Medium, 20–39 Low, 0–19 Monitor.

Reserve: Opening + Contributions + Other funding − Planned expenditure = Closing.
