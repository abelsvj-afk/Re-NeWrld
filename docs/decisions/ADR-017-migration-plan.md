# Migration Plan — ADR-017 Asset Lifecycle & Publication Integrity

**Status:** PROPOSAL — for product-owner review. Design Gate is OPEN for planning only; no migration has been written or run.
**Baseline:** ADR-017 rev 26 (approved 2026-10-18, commit `303ed528`), source: `hidden_audit/ADR-asset-lifecycle.md`.
**Change classification:** Level 3 (Architecture / Data / Contract) per `governance/AI_AGENT_RULES.md` §5 — schema migrations require impact analysis, architecture review, ADR (done), migration plan (this document), tests, full review.
**Repo:** `abelsvj-afk/Re-NeWrld`, migrations live in `db/migrations/`, runner `npm run migrate` (`scripts/migrate.ts`, advisory lock `987654321`, `schema_migrations` version table).

---

## 1. DDL inventory extracted from the ADR

Every DDL statement below is cited to its ADR section and line. Line numbers refer to `hidden_audit/ADR-asset-lifecycle.md` (rev 26).

### 1.1 `world_media_assets` (§4.1, line 100)

```sql
CREATE TABLE world_media_assets ( ... );          -- line 100, full column list incl.
                                                  -- roles TEXT[] CHECK (roles <@ ARRAY['cover','illustration']),
                                                  -- lifecycle CHECK, file_confirmed_present,
                                                  -- shared_with_worlds, backfill_run_id FK → backfill_runs
CREATE INDEX ON world_media_assets (world_id);                                    -- line 147
CREATE INDEX ON world_media_assets (world_id, lifecycle);                         -- line 148
CREATE INDEX ON world_media_assets (backfill_run_id) WHERE backfill_run_id IS NOT NULL; -- line 149
CREATE OR REPLACE FUNCTION check_roles_unique() RETURNS trigger AS $$ ... $$;     -- line 154
CREATE TRIGGER trg_world_media_assets_roles_unique
  BEFORE INSERT OR UPDATE OF roles ON world_media_assets
  FOR EACH ROW EXECUTE FUNCTION check_roles_unique();                             -- line 165
ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_filename UNIQUE (filename); -- line 240
ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_url UNIQUE (url);           -- line 241
```

### 1.2 `asset_snapshot_references` (§4.1, line 196)

```sql
CREATE TABLE asset_snapshot_references (      -- line 196; PK (filename, snapshot_id);
  filename TEXT NOT NULL,                     -- world_id NULLABLE (rev 19 — B5)
  snapshot_id UUID NOT NULL,                  -- no FKs by design (F1/F2/F3, §4.1)
  world_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (filename, snapshot_id)
);
CREATE INDEX ON asset_snapshot_references (snapshot_id);   -- line 216
CREATE INDEX ON asset_snapshot_references (world_id);      -- line 217
```

### 1.3 `system_maintenance` (§4.3d, line 703)

```sql
CREATE TABLE system_maintenance (              -- line 703; singleton, id=1
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active BOOLEAN NOT NULL DEFAULT false,
  reason TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  started_by TEXT,
  CONSTRAINT single_row CHECK (id = 1)
);
-- ADR: "Exactly one row always exists. INSERTed at migration time; only UPDATEs thereafter."
INSERT INTO system_maintenance (id, active, reason) VALUES (1, false, '')
  ON CONFLICT (id) DO NOTHING;                 -- idempotent seed (plan addition, not in ADR text)
```

### 1.4 `recovery_authorizations` (§4.3d, line 832)

```sql
CREATE TABLE recovery_authorizations ( ... );  -- line 832: authorization_id PK,
                                               -- scope CHECK IN ('repair','restore-reconcile'),
                                               -- authorized_by/at, reason, expires_at (+4h),
                                               -- revoked_at, revoke_reason CHECK
CREATE UNIQUE INDEX one_unrevoked_recovery_auth
  ON recovery_authorizations ((1))
  WHERE revoked_at IS NULL;                     -- line 855; time-independent predicate (rev 20 — B1)
```

### 1.5 `unattributed_media_files` (§4.7, line 1106)

```sql
CREATE TABLE unattributed_media_files ( ... ); -- line 1106: file_id PK, filename UNIQUE,
                                               -- url, size_bytes, discovered_at,
                                               -- matched_world_id FK → worlds, referencing_worlds UUID[],
                                               -- protected, classification_status CHECK,
                                               -- notes, backfill_run_id FK → backfill_runs
CREATE INDEX ON unattributed_media_files (backfill_run_id) WHERE backfill_run_id IS NOT NULL; -- line 1124
```

### 1.6 `backfill_runs` (§4.7, line 1175)

```sql
CREATE TABLE backfill_runs (                    -- line 1175
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','complete','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failure_reason TEXT,                          -- rev 19 — B4
  final_inventory_count INT,
  final_inventory_checksum TEXT,
  files_classified INT NOT NULL DEFAULT 0,
  files_pending INT NOT NULL DEFAULT 0,
  attribution_input_hash TEXT                   -- rev 13; fold into CREATE (see §3.2)
);
CREATE UNIQUE INDEX ON backfill_runs ((1)) WHERE state = 'in_progress';  -- §4.7b line 1386 (prose-specified)
```

Note: the ADR's `ALTER TABLE backfill_runs ADD COLUMN attribution_input_hash` / `DROP COLUMN metadata_version_hash` (lines 1390–1393) describe the rev-12→13 design transition, not a migration against an existing table — `backfill_runs` does not exist yet, so the migration creates it in final form. `metadata_version_hash` never exists.

### 1.7 `backfill_inventory_files` (§4.7, line 1191)

```sql
CREATE TABLE backfill_inventory_files (         -- line 1191
  run_id UUID NOT NULL REFERENCES backfill_runs(run_id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  size_bytes BIGINT,
  sha256 TEXT,
  PRIMARY KEY (run_id, filename)
);
CREATE INDEX ON backfill_inventory_files (run_id);  -- line 1198
```

### 1.8 `backfill_conflicts` (§4.7, line 1258; rev 25/26)

```sql
CREATE TABLE backfill_conflicts (               -- line 1258, full column list:
  conflict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES backfill_runs(run_id), -- NULLABLE (rev 24 — B2)
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  existing_world_id UUID,
  recomputed_world_id UUID,
  existing_roles TEXT[],
  recomputed_roles TEXT[],
  reason TEXT NOT NULL,
  subtype TEXT,                                 -- rev 25
  expected_snapshot_ids UUID[],                 -- rev 25
  actual_snapshot_ids UUID[],                   -- rev 25
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  CONSTRAINT backfill_conflicts_drift_fields_ck CHECK (
    (reason = 'snapshot_ref_drift'
       AND subtype IS NOT NULL                  -- rev 26: explicit (NULL IN (...) = NULL trap)
       AND subtype IN ('missing_row', 'stale_row')
       AND expected_snapshot_ids IS NOT NULL
       AND actual_snapshot_ids IS NOT NULL)
    OR
    (reason <> 'snapshot_ref_drift'
       AND subtype IS NULL
       AND expected_snapshot_ids IS NULL
       AND actual_snapshot_ids IS NULL)
  )
);
```

### 1.9 `world_deletion_jobs` (§4.9, line 1602)

```sql
CREATE TABLE world_deletion_jobs (              -- line 1602
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'assets_pending'
    CHECK (state IN ('assets_pending','files_removing','rows_removing')),
  files_total INT NOT NULL DEFAULT 0,
  files_removed INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id)
);
```

### 1.10 `storage_reservations` (§5.5, line 1865)

```sql
CREATE TABLE storage_reservations ( ... );      -- line 1865: reservation_id PK, world_id,
                                               -- size_bytes, temp_filename, state CHECK
                                               -- (6 states), epoch, created_at, expires_at,
                                               -- released_at, last_heartbeat_at,
                                               -- claim_epoch, claim_finalized_at,
                                               -- + 2 multi-column CHECKs (state/timestamp
                                               -- consistency; claim-column co-nullity),
                                               -- CHECK (size_bytes > 0), CHECK (epoch >= 0)
CREATE INDEX ON storage_reservations (expires_at) WHERE released_at IS NULL;  -- line 1905
```

**Prerequisite (already satisfied):** `gen_random_uuid()` requires `pgcrypto`, enabled in migration 001 (per `db/migrations/002_auth_session_token_hash.sql` header comment). No new extension needed.

---

## 2. Migration file proposal

**Recommendation: two migration files.** Justification:

- **Reviewability:** 10 tables + trigger + 10 indexes + constraints is ~450 lines of DDL. The repo convention (001–013) is one focused concern per file; a single 450-line file breaks that convention and is harder to review.
- **Dependency order is clean:** `world_media_assets.backfill_run_id`, `unattributed_media_files.backfill_run_id`, `backfill_inventory_files.run_id`, and `backfill_conflicts.run_id` all FK-reference `backfill_runs(run_id)`. The FK targets must exist first — a natural split point.
- **Atomicity preserved:** each file runs in its own transaction (per S57's requirement — see §5); a failure in either file rolls back that file entirely. Cross-file partial application is safe because nothing reads these tables until application code ships (enforcement is derived from `backfill_runs` state + app code, both absent).
- **Alternative considered (single 014):** simpler numbering, one transaction for everything. Rejected: poorer reviewability, and a single failure would roll back unrelated table groups that were already fine.

### File 1: `db/migrations/014_media_durable_ops.sql`
Durable operations machinery — no FK dependencies on the registry.

1. `system_maintenance` (§1.3) + idempotent singleton seed row.
2. `recovery_authorizations` (§1.4) + `one_unrevoked_recovery_auth` partial unique index.
3. `backfill_runs` (§1.6, final form incl. `attribution_input_hash`) + single-active-run partial unique index.
4. `backfill_inventory_files` (§1.7) + index.
5. `backfill_conflicts` (§1.8, rev-26 CHECK).

### File 2: `db/migrations/015_media_registry.sql`
Asset registry, reservations, deletion jobs — FKs into 014's tables.

1. `world_media_assets` (§1.1) + 3 indexes + `check_roles_unique()` + trigger + 2 UNIQUE constraints.
2. `asset_snapshot_references` (§1.2) + 2 indexes.
3. `unattributed_media_files` (§1.5) + partial index.
4. `world_deletion_jobs` (§1.9).
5. `storage_reservations` (§1.10) + partial index.

**Ordering inside each file:** tables before indexes on them; function before trigger; `backfill_runs` before its dependents (014); `world_media_assets`/`unattributed_media_files` have no interdependency (single-owner invariant is application-enforced, §4.1).

---

## 3. Idempotency requirements (repo convention)

Per the 94a5303 fix, every migration must be safely re-runnable. Patterns from `db/migrations/002_auth_session_token_hash.sql` (DO-block guards) and `013_fk_indexes.sql` (`IF NOT EXISTS`):

- `CREATE TABLE IF NOT EXISTS` for all 10 tables.
- `CREATE INDEX IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` for all 10 indexes.
- `CREATE OR REPLACE FUNCTION check_roles_unique()` (already OR REPLACE in the ADR).
- Trigger (PostgreSQL has no `CREATE OR REPLACE TRIGGER`): `DROP TRIGGER IF EXISTS trg_world_media_assets_roles_unique ON world_media_assets;` then `CREATE TRIGGER ...`.
- `ALTER TABLE ... ADD CONSTRAINT`: guard with a `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...') THEN ALTER TABLE ... END IF; END $$;` block (2 constraints: `uq_world_media_assets_filename`, `uq_world_media_assets_url`).
- Singleton seed: `INSERT ... ON CONFLICT (id) DO NOTHING`.
- **Do NOT use the 002-style column-state guards** — these are greenfield tables; `IF NOT EXISTS` suffices. The DO-block guards are reserved for the two ADD CONSTRAINT statements.

---

## 4. DDL validation plan

Two layers, both required before any production migration (the final review explicitly flagged that DB tests were never executed):

### 4.1 Static validation (authoring time)
- Every DDL block parsed with **pglast** (as was done for rev-25/26 fixes). Must parse clean.
- Manual checklist against the ADR: every table/column/constraint/index in §1 appears; no column invented; CHECK predicates copied verbatim (especially `backfill_conflicts_drift_fields_ck` with the rev-26 `subtype IS NOT NULL` conjunct, and the `storage_reservations` state/timestamp CHECKs).

### 4.2 Runtime verification (real PostgreSQL — Testcontainers)
Per `AGENTS.md` §5 and `tests/integration/migration.test.ts` conventions (`PostgreSqlContainer`, `SKIP_DB_TESTS`/`SKIP_DOCKER` skip, `TEST_DATABASE_URL` fallback):

1. **Fresh-database migration run:** new test file `tests/integration/migration-014-015.test.ts` (name TBD by implementer): run `runMigrations()` from `scripts/migrate.js` against a fresh container; assert all 10 tables exist with expected columns (query `information_schema`); assert all 10 indexes exist (`pg_indexes`); assert the trigger exists and is enabled; assert the singleton row exists in `system_maintenance`.
2. **Idempotency:** run `runMigrations()` a second time against the same database; assert zero errors and unchanged schema (mirrors the existing `migration.test.ts` idempotency test).
3. **DDL-level conformance probes** (runnable without application code):
   - **S46 step 17 (rev 26):** the six CHECK-conformance INSERTs against `backfill_conflicts` — NULL-subtype drift rejected; valid `missing_row`/`stale_row` accepted; non-drift with drift fields rejected; bad subtype rejected; NULL arrays on drift rows rejected. (Needs a `backfill_runs` row for the FK on valid inserts; use `run_id` from an inserted run row, plus a NULL-`run_id` variant.)
   - **Roles enforcement split (rev 20, §4.1):** the six trigger/CHECK tests — duplicate roles rejected with `check_violation`; invalid role value rejected by CHECK; empty array accepted; update introducing duplicates rejected; reorder accepted; NULL rejected by NOT NULL.
   - **S57 (rev 19 — B1):** migration atomicity — apply a deliberately broken variant in a scratch database; assert the transaction rolls back fully (no partial tables). (Test-only; never ships.)
   - **Single-active-run index:** two concurrent `in_progress` inserts → second violates the partial unique index.
   - **`one_unrevoked_recovery_auth`:** two unrevoked rows → unique violation; revoked + unrevoked → allowed.
4. **Protocol-level probes (S61–S67, S5, S43, etc.)** require application code and belong to the implementation slices (`implementation-breakdown-ADR-017.md`), NOT to the migration. The migration test file must not attempt them.

**Environment note:** per `AGENTS.md` §5, integration tests need Docker; the repo supports `TEST_DATABASE_URL` as a fallback (used 2026-10-13 for the 31/31 PostgreSQL verification). If neither is available, tests stay **UNVERIFIED** per the repo's evidence standards — never claimed as passing.

---

## 5. Rollout sequence

```
Phase A — DDL migration (this plan)
  1. Review + approve this plan (product owner).
  2. Author 014/015 per §2–3; pglast validation (§4.1).
  3. Integration tests per §4.2 (fresh DB + idempotency + conformance probes).
  4. Deploy: `npm run migrate` runs on Fly release (existing release command).
     Safe while app is live: all tables are NEW; zero changes to existing
     tables/columns; existing worlds/scenes/metadata untouched.

Phase B — Volume provisioning (ADR §2.1, operator procedure — NOT in migration files)
  5. Execute the §2.1 staged volume migration (inventory → provision →
     staging machine → transfer → freeze → verify → cutover → verify).
     Prerequisite for backfill; see §7.

Phase C — Backfill (application code from implementation slices BF-1/DRIFT-1)
  6. Backfill job classifies /data/media per §4.7; enforcement gate derived
     from backfill_runs state (§4.7).

Phase D — Enforcement (derived, not deployed)
  7. Enforcement activates automatically when a backfill_runs row reaches
     state='complete' AND no in_progress run exists AND fence inactive (§4.7).
```

**Production reality:** the live Fly database has worlds/scenes with `world.metadata.coverArtUrl` / `scene.metadata.illustrationUrl`. The migration does not touch `worlds`, `scenes`, or any JSONB metadata — §4.2 explicitly requires no schema change there. Existing uploads keep serving via the legacy grace period (§4.5) until backfill completes.

---

## 6. Rollback considerations

| Scope | Reversible? | Path |
|---|---|---|
| 014/015 applied, tables empty, no app code deployed | **Yes** | `DROP TABLE` in reverse dependency order (014: conflicts → inventory_files → runs → recovery_authorizations → system_maintenance; 015: reservations → deletion_jobs → unattributed → snapshot_refs → world_media_assets). Manual operator SQL; no down-migration ships (repo convention is up-only, per 013's header). |
| 014/015 applied, backfill has run (rows exist) | **Effectively no** | Dropping tables destroys the registry; recovery = re-run backfill from the volume. Do not roll back DDL after backfill without a re-backfill plan. |
| Volume cutover (§2.1) before 9e verification | **Yes** | `fly machine start <orig-machine-id>` — original machine untouched until 9f decision. |
| Volume cutover after 9f (original destroyed) | **No** | Volume snapshots (`fly volumes snapshot`, §9.2) are the recovery path. |

---

## 7. Prerequisites & open owner decisions

### 7.1 Volume prerequisite (blocking for backfill, not for DDL)
ADR §2 establishes that `/data/media` is **not** on a persistent Fly volume today — deploys wipe uploaded images. The ADR's durability guarantees (retention, reference protection, quota accounting) **assume durable storage** (Option A: `media_data` volume, §2).

- The DDL migration (Phase A) is safe without the volume: new tables, no filesystem interaction.
- **Backfill (Phase C) MUST NOT run before the §2.1 volume procedure completes.** Classifying ephemeral files would build a registry over bytes that the next deploy deletes — worse than no registry, because enforcement would then 404 files it believes are permanent.
- If the owner defers the volume: DDL ships, backfill waits, enforcement stays disabled (`"media_lifecycle": "backfill_incomplete"`), uploads keep working as today (ephemeral). This is a supported degraded state, not a failure — but it must be an explicit decision, recorded.

### 7.2 Open decisions (owner must confirm before migration planning is finalized)

1. **Per-world quota value:** `MEDIA_WORLD_QUOTA_MB` default 50 (§5.2) was **never owner-confirmed** (open since 2026-10-16). The DDL does not hardcode it (config value), but quota enforcement behavior (507 `QUOTA_EXCEEDED`) depends on it. **Decision needed:** confirm 50 MB or set another value before enforcement goes live. (Not blocking for the DDL migration itself.)
2. **Volume sizing:** §2.1 proposes `media_data` 1–2 GB. Confirm size and region with the app's region.
3. **File size limit:** 10 MB/file (§5.2) — matches the existing UI hint; confirm it stays.
4. **`STORAGE_CAPACITY_BYTES`:** operator-set usable capacity, must be ≤ volume size (§5.5). Confirm value at volume provisioning time.
5. **Original-machine retention window** (§2.1 step 9f): destroy immediately after verified cutover vs retain N days. Record the decision and deadline in the runbook.

---

## 8. Explicitly out of scope for the migration

- **No application code changes.** No routes, no repositories, no use cases, no background jobs.
- **No backfill execution.** The backfill job is application code (slice BF-1); the migration only creates its tables.
- **No enforcement enablement.** Enforcement is derived from `backfill_runs` state (§4.7); with no `complete` row, it stays off.
- **No volume provisioning.** The §2.1 procedure is a separate operator runbook (slice OPS-0).
- **No changes to existing tables, columns, or data.** `worlds`, `scenes`, `canon_snapshots`, metadata JSONB: untouched.
- **No seed data** beyond the `system_maintenance` singleton row (required by the fail-closed contract, §4.3d).

---

## 9. Acceptance criteria for the migration work

- [ ] 014/015 authored per §2, idempotent per §3, pglast-clean per §4.1.
- [ ] Integration tests per §4.2 pass against real PostgreSQL (or are explicitly marked UNVERIFIED with the reason).
- [ ] S57 atomicity demonstrated (broken-variant rollback test).
- [ ] S46-step-17 and roles-trigger conformance probes pass.
- [ ] Owner decisions in §7.2 recorded.
- [ ] `CHANGELOG.md` entry under `[Unreleased]` via `scripts/changelog-entry.sh` (per `AGENTS.md` §2).
- [ ] `PROJECT_STATE.md` updated (per `AGENTS.md` §2 and `AI_AGENT_RULES.md` §10).
- [ ] Full review before merge (Level 3 change).
