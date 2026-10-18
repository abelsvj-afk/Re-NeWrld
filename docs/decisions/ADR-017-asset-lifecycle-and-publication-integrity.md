# ADR Draft: Asset Lifecycle & Publication Integrity

**Status:** DRAFT — architect assessment for product-owner review. Not approved. No implementation.
**Date:** 2026-10-18
**Revision:** 2026-10-18 (rev 22) — Single-issue consistency pass per the rev-21 full-document review (1 critical finding: absolute post-expiry commit claims contradicted the defined boundary). Three sites rewritten to the exact boundary — *"Authorization must be valid at the moment the pre-COMMIT gate executes (evaluated with `clock_timestamp()`); the gate is the final statement before `COMMIT`"* — and the stronger "commit lands before expiry" remains explicitly declined: (1) pre-COMMIT SQL comment, (2) the "does NOT claim" bullet ("No DB mutation commits after expiry" WITHDRAWN), (3) the B2 invariant proof ("after expiry the session can commit nothing" WITHDRAWN). 63 acceptance scenarios (S1–S63) unchanged. Design Gate REMAINS CLOSED. No implementation authorized.
**Author:** Muse (architect role)
**Context:** WP-02 — Asset lifecycle and publication integrity
**Supersedes:** The "live images" decision in `hidden_audit/spec-script-assets-tabs.md` §2.7 (revised per owner decision 2026-10-16)

---

## 1. Context

Re:NeWrld lets creators upload image assets (cover art, scene illustrations) via `POST /worlds/:id/media`. The current implementation:

- Stores files as `{uuid}.{ext}` under `MEDIA_STORAGE_PATH` (default `/data/media`), served at `/media/{filename}` (`src/modules/world/http/world.routes.ts:546-582`).
- Records the URL in `scene.metadata.illustrationUrl` (frontend) or world metadata (cover art).
- Has **no** asset registry, **no** versioning, **no** reference tracking, **no** delete endpoint, **no** quota enforcement (backend), and **no** retention policy.

The product owner has decided:
1. Published stories use **immutable** asset versions (not live references).
2. Deletion is **blocked** while any retained draft or published content references the asset.

## 2. Critical Finding: Media Storage Is Ephemeral

`fly.toml` mounts a persistent volume only for narration audio (`/data/narrations`). `MEDIA_STORAGE_PATH` defaults to `/data/media`, which is **not** on a persistent volume — it lives on the container's ephemeral filesystem.

**Consequence:** Every `fly deploy` (or container restart) wipes all uploaded images. Published snapshots retain the URLs, but the files are gone → broken images for readers.

This must be fixed as part of this work, independent of the versioning design. Options:
- **A (recommended):** Add a second Fly volume mount for `/data/media` (e.g. `media_data`, 1–2 GB).
- **B:** Move media to object storage (S3-compatible). More work; defers the problem to credential management.

The rest of this ADR assumes Option A (local persistent volume), consistent with the existing narration approach.

### 2.1 Volume migration deployment sequence

Mounting a volume at `/data/media` does **not** transfer existing files. On Linux, mounting a filesystem over a non-empty directory **hides** the underlying files — they become invisible to every process, including the backfill job (§4.7). The backfill cannot recover files it can no longer see. Therefore the transfer must happen **before** the mount is enabled, in this exact sequence.

**Fly-specific constraint:** Fly volumes attach to specific machines, not to the app as a whole. A new volume cannot be "temporarily mounted" on the same running machine without a deployment, and a deployment that changes the mount for `/data/media` will hide the ephemeral files on the new machine before they can be copied. The procedure below keeps the original machine alive as the transfer source until cutover is verified.

**Procedure:**

1. **Preliminary inventory** (on the current production machine, before any change): `fly ssh console -a re-newrld` → list every file under the current `/data/media/` (ephemeral). Record filename, size, and SHA-256 checksum. Store the inventory on the operator's machine (not in the container). This inventory is for **planning and sizing only** — it is NOT the verification baseline, because files uploaded after this step would not appear in it.
2. **Provision the volume:** `fly volumes create media_data --size 2 --region <same-region-as-app>` (match the app's region — Fly volumes are region-local).
3. **Attach to a NEW machine:** Scale or clone so a second machine exists with the new volume attached at a **staging path** (e.g. `/data/media_new`), while the original machine keeps running with its ephemeral `/data/media` intact. Do not change the original machine's mount yet.
4. **Staging isolation:** The staging machine MUST NOT serve production traffic. Set `MIGRATION_STAGING=true` in its environment; the application checks this flag at startup and either does not bind the HTTP server at all or binds to `127.0.0.1` only. This preserves the §9.2 single-serving-machine constraint throughout the migration — there is exactly one machine serving production traffic at every step.
5. **Transfer:** From the operator's machine, copy files from the ORIGINAL machine to the new volume. Options: `fly ssh sftp get` per file from the original machine, then `fly ssh sftp put` to the staging machine's `/data/media_new/`; or `fly proxy` + rsync over the WireGuard tunnel. Preserve filenames exactly.
6. **Freeze writes:** Before the final sync, put the app in maintenance mode — uploads (`POST /worlds/:id/media`) return **503** `{code: "MIGRATION_IN_PROGRESS"}`. Run one final incremental copy to catch any files uploaded between step 5 and the freeze.
7. **Final authoritative inventory:** With writes frozen, take a **new** inventory from the ORIGINAL machine's `/data/media/` — filename, size, SHA-256, and total file count. This is the verification baseline. The preliminary inventory from step 1 is superseded and must not be used for verification: any file uploaded between step 1 and the freeze appears here but not there, and comparing the destination against the stale inventory would either fail spuriously or force the operator to ignore a real discrepancy.
8. **Verify:** On the staging machine, recompute SHA-256 for every file at `/data/media_new/`. Compare file count and checksums against the **final** inventory from step 7. **All must match.** Any mismatch → stop, investigate, re-copy. Do not proceed with a partial or unverified transfer.
9. **Cutover — exact machine transition.** The staging machine becomes the production machine. There is no separate "deploy a fresh machine and copy again" — the data is already on the staging machine's volume; the transition is a configuration change on that machine:
   a. **Verify staging first:** on the staging machine, recompute SHA-256 for every file at `/data/media_new/` and compare against the **final** inventory (step 7). Count must match, checksums must match. Do not proceed on any mismatch.
   b. **Stop (do not destroy) the original production machine:** `fly machine stop <orig-machine-id>`. The machine, its config, and its ephemeral filesystem are preserved — this is the rollback path. Verify it shows as `stopped`, not `destroyed`.
   c. **Reconfigure the staging machine:** update its machine config to (i) remove the `MIGRATION_STAGING=true` environment variable, and (ii) change the volume mount from `/data/media_new` to `/data/media`. **Fly requires a machine restart for mount changes** — this is done via `fly machine update` with the new config, which restarts the machine. The volume (with the transferred files) is the same volume object; only the mount path changes, so no data moves.
   d. **Start the reconfigured machine** as the new production machine. It is now the sole machine serving traffic (single-serving-machine constraint, §9.2, preserved).
   e. **Verify in production:** health check passes (`/health` 200, `"media_storage"` not `degraded`); `GET /media/{known-filename}` returns 200 for a spot-check of files from the final inventory; file count on `/data/media/` matches the final inventory count.
   f. **Decide the original machine's fate only after (e) passes:** once the new production machine is verified, the original machine may be destroyed (`fly machine destroy <orig-machine-id>`) — or retained for a defined period (e.g. 7 days) as an extended rollback window. The decision and its deadline must be recorded in the migration runbook; "destroy it now, we'll figure it out" is not a plan.
10. **Backfill:** Run the §4.7 backfill job against the now-persistent `/data/media/`.
11. **Enable enforcement:** Only after backfill completes AND the durable enforcement gate (§4.7: a `backfill_runs` row with `state='complete'`) passes do the new lifecycle endpoints (`DELETE`, registry-gated serving per §4.5) go live. Until then, `DELETE` returns **503** `{code: "BACKFILL_IN_PROGRESS"}`.

**Downtime:** Steps 9b–9d involve a stop/start window during which no machine serves traffic. **Brief downtime (expected: 1–3 minutes for the machine restart) is accepted and documented.** The alternative — maintenance-mode 503s with a blue/green traffic shift — adds a second serving machine, which violates the §9.2 single-machine constraint during the transition and complicates the volume-attachment model. The chosen trade-off is: accept minutes of downtime during a planned maintenance window (announced to creators in advance) in exchange for a deterministic, single-machine cutover. The migration must be scheduled, not performed ad hoc.

**Rollback:** If verification fails at step 9e: `fly machine start <orig-machine-id>`. The original machine's config is unchanged (it was only stopped), its ephemeral `/data/media/` is intact, and it resumes serving as if nothing happened. Then: investigate the staging machine's failure, fix, and re-attempt from step 9a. **The original machine is never destroyed before step 9e passes** — its continued existence *is* the rollback path (no `fly machine destroy`, no scale-to-zero) until cutover is verified and the fate decision in step 9f is recorded.

**Machine inventory during migration (which machine serves at each step):**

| Step | Serving production traffic | Staging / stopped |
|---|---|---|
| 1–5 | Original machine (ephemeral `/data/media`) | Staging machine exists, `MIGRATION_STAGING=true`, volume at `/data/media_new`, serves nothing |
| 6–8 | Original machine (maintenance mode: uploads 503) | Staging machine, still isolated |
| 9b | **None (downtime window begins)** | Original stopped; staging stopped (being reconfigured) |
| 9d–9e | **Staging machine** (now production, volume at `/data/media`) | Original stopped (rollback available) |
| 9f | Staging machine (production) | Original destroyed or retained per recorded decision |

**What must never happen:** Do not mount the volume directly at `/data/media` on the existing machine and assume the backfill will "find" the old files. The old files are hidden by the mount, not deleted — but hidden is equivalent to lost for every operational purpose. The staged transfer (steps 3–6) is what makes the migration safe, not the backfill.

## 3. What Already Exists (Do Not Rebuild)

The canon snapshot model **already provides immutable URL references** for published versions:

| Mechanism | Evidence | Implication |
|---|---|---|
| `buildCanonData` serializes `scene.getMetadata()` | `src/modules/world/application/publish-world.use-case.ts:44-68` | `illustrationUrl` is captured in the snapshot at publish time |
| `buildCanonData` serializes `world.getMetadata()` | Same, lines 51-56 | Cover art URL is captured at publish time |
| Readers read from the pinned snapshot | `src/modules/session/application/submit-choice.use-case.ts:260-266` | Readers never see draft metadata; they see the publish-time URLs |
| Narration uses version-keyed records | `postgres-narration.repository.ts:64` — keyed by `(world_id, canon_version, scene_id, prose_hash)` | Template pattern for asset versioning |

**Therefore:** AS-01 (published version identifies exact image version) is **satisfied by the existing snapshot model**, provided the underlying files are retained. The work is retention and reference tracking, not a new snapshotting mechanism.

Replacement "works by accident" today (new upload → new UUID filename; old file orphaned but present), but there is no guarantee — no reference tracking means a future cleanup could break published versions.

## 4. Decision

### 4.1 Asset registry table (new)

Add a `world_media_assets` table:

```sql
CREATE TABLE world_media_assets (
  asset_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,              -- storage filename ({uuid}.{ext})
  url           TEXT NOT NULL,              -- /media/{filename}
  mimetype      TEXT NOT NULL,              -- validated at upload
  size_bytes    BIGINT NOT NULL,
  -- One row per physical file. A file may serve multiple roles (e.g. the same
  -- image used as both cover art and a scene illustration). Roles are tracked
  -- as an array so the identity stays one-to-one with the file: deletion of
  -- one role's reference never orphans or double-frees the file. Quota counts
  -- the file exactly once regardless of role count.
  -- `roles` reflects the roles CURRENTLY held in DRAFT metadata — not intended
  -- use. Upload creates the row with roles='{}' (holds nothing yet); the
  -- metadata-switch transaction assigns/removes roles (§4.2, §4.3a). Snapshot
  -- references are found by the scanner (§4.2), never tracked in `roles`.
  -- Empty array = no draft references; the file may still be protected by
  -- retained snapshots. `roles` is a UI/API convenience — the URL reference
  -- scan is the SOLE authority for deletion safety (§4.3b).
  roles         TEXT[] NOT NULL DEFAULT '{}'
                CHECK (roles <@ ARRAY['cover','illustration']),
  -- Uniqueness within the array is enforced by a trigger, not CHECK (rev 19 — B1):
  -- PostgreSQL forbids subqueries in CHECK constraints, so the rev-9 formulation
  -- `cardinality(roles) = (SELECT count(DISTINCT r) FROM unnest(roles) AS r)`
  -- cannot be applied as DDL — the CREATE TABLE would fail. The value domain
  -- (`<@`, an immutable built-in operator) stays in CHECK; intra-array uniqueness
  -- (which requires unnest + aggregation) moves to a BEFORE trigger. Both fire
  -- atomically in the inserting/updating transaction.
  -- Lifecycle state: active → pending_deletion → (row deleted)
  -- pending_deletion means: proven unreferenced, file removal in progress or failed
  lifecycle     TEXT NOT NULL DEFAULT 'active'
                CHECK (lifecycle IN ('active','pending_deletion')),
  -- Whether the file has been confirmed present on disk by the last reconciliation.
  -- Set true at upload; reconciliation may set false (triggers data-loss alert, §9.2).
  file_confirmed_present BOOLEAN NOT NULL DEFAULT true,
  -- Worlds (other than world_id) whose draft metadata also references this URL.
  -- Populated by backfill/re-verification when a URL is found in multiple worlds'
  -- drafts. The owner (world_id) is the lexicographically smallest world_id
  -- among referencing worlds (rev 14, §4.7c B4a). Empty array = not shared.
  shared_with_worlds UUID[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which backfill run created this row (rev 19 — B4). NULL for all normal-path
  -- rows (uploads, attributions). Set ONLY by backfill classification inserts.
  -- Lets the completion gate prove set equality against the run's inventory.
  backfill_run_id UUID REFERENCES backfill_runs(run_id)
);
CREATE INDEX ON world_media_assets (world_id);
CREATE INDEX ON world_media_assets (world_id, lifecycle);
CREATE INDEX ON world_media_assets (backfill_run_id) WHERE backfill_run_id IS NOT NULL;

-- Intra-array uniqueness for `roles` (rev 19 — B1). Fires BEFORE the row is
-- written, in the same transaction — a duplicate aborts the INSERT/UPDATE,
-- never a partially written row.
CREATE OR REPLACE FUNCTION check_roles_unique() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM unnest(NEW.roles) AS r)
     <> (SELECT count(DISTINCT r) FROM unnest(NEW.roles) AS r) THEN
    RAISE EXCEPTION 'world_media_assets.roles contains duplicates: %', NEW.roles
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_world_media_assets_roles_unique
  BEFORE INSERT OR UPDATE OF roles ON world_media_assets
  FOR EACH ROW EXECUTE FUNCTION check_roles_unique();

-- Migration failure behavior (rev 19 — B1, see S57): all DDL above runs inside
-- the migration transaction. If any statement fails (syntax, existing
-- violating rows on a backfill, permission), PostgreSQL rolls back the ENTIRE
-- migration — the schema is unchanged, no partial trigger without its table.
-- The migrate step exits non-zero, the Fly release fails, health reports
-- `degraded`, and a critical alert fires with the migration name and error.
-- The operator fixes the cause and re-runs; there is no "half-migrated" state.

-- Conformance tests for the roles enforcement split (rev 20 — retained direction):
-- the trigger (uniqueness) and the CHECK (domain) are tested independently:
-- 1. INSERT with roles = '{"cover","cover"}' → rejected, SQLSTATE 23514 (check_violation),
--    message names the duplicates. 2. INSERT with roles = '{"banner"}' → rejected by
--    the CHECK (not the trigger) — the domain and uniqueness failures are
--    distinguishable. 3. INSERT with roles = '{}' → accepted (empty array is valid:
--    "holds nothing yet"). 4. UPDATE that introduces a duplicate
--    ('{"cover"}' → '{"cover","illustration","cover"}') → rejected by the trigger;
--    the row is unchanged. 5. UPDATE that only reorders ('{"cover","illustration"}' →
--    '{"illustration","cover"}') → accepted (no duplicates). 6. NULL roles →
--    rejected by NOT NULL (the DEFAULT '{}' applies only when the column is omitted).
-- The trigger MUST be created in the same migration transaction as the table —
-- a table without its trigger would silently accept duplicates.

**Snapshot-reference tracking (rev 16 — B4.2):** Draft references are mutable (metadata edits); snapshot references are immutable (snapshots never change, only get created or garbage-collected per the retention rule). Mixing the two lifecycles in one array would create write contention on the asset row at publish time and conflate "currently referenced" with "historically retained." They are therefore tracked separately.

**Stable identity (rev 16):** the rev-15 table keyed on `asset_id REFERENCES world_media_assets(asset_id) ON DELETE CASCADE` — which is incompatible with the §4.9 T1 transfer contract (moving the registry row to `unattributed_media_files` while the file stays protected): CASCADE would delete the protection rows; RESTRICT would block the transfer. The table is therefore keyed on the file's **stable identity: `filename`** — immutable by construction (URL scheme `/media/{uuid}.{ext}`, never-overwrite §4.6), globally unique across both registry tables (`UNIQUE(filename)` on each + the rev-13 single-owner invariant = one natural key spanning both tables), and the exact key snapshot content references (URL = `/media/` + `filename` deterministically). Inter-table ownership transfer never creates, moves, or deletes protection rows.

```sql
CREATE TABLE asset_snapshot_references (
  filename    TEXT NOT NULL,  -- STABLE FILE IDENTITY: storage filename ({uuid}.{ext}).
                             -- Invariant across world_media_assets <-> unattributed_media_files
                             -- moves: globally unique by UNIQUE(filename) on both tables +
                             -- the single-owner invariant (rev 13).
  snapshot_id UUID NOT NULL,  -- references canon_snapshots(snapshot_id). No DB-level FK:
                             -- snapshot rows outlive world rows (retention, §5.4) and the
                             -- cleanup contract below deletes ref rows in the same
                             -- transaction as the snapshot row.
  world_id    UUID,  -- the world that owns the snapshot (denormalized for the scanner).
                   -- NULLABLE (rev 19 — B5): orphan snapshots (world_id NULL in
                   -- canon_snapshots, or world row gone) still get protection rows.
                   -- Protection is filename-keyed and never depends on world_id;
                   -- NULL means "no owner to attribute," not "no protection."
                   -- A NOT NULL constraint here would make the §4.2 orphan-snapshot
                   -- promise unimplementable: backfill could not insert the
                   -- (filename, snapshot_id, NULL) triple the scanner requires.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (filename, snapshot_id)
);
CREATE INDEX ON asset_snapshot_references (snapshot_id);
CREATE INDEX ON asset_snapshot_references (world_id);
```

**Replacing the broken `ON DELETE CASCADE`:** there is deliberately no FK to either registry table. The cascade semantic is replaced by three explicit mechanisms: (F1) **blocking, not cascading** — every destructive path checks `asset_snapshot_references` by filename before deleting a registry row or unlinking a file, so a protected row can never be reached by a delete; (F2) **same-transaction cleanup on snapshot GC** — `DELETE FROM asset_snapshot_references WHERE snapshot_id = ?` commits in the same transaction as the snapshot-row delete, so orphan ref rows are impossible inside the contract; (F3) **drift audit** — the re-verification cross-check (§4.7c) detects out-of-contract divergence and blocks deletes fail-closed until resolved.

**Conforming guards (rev 16):**
- G1: `world_media_assets.filename` and `unattributed_media_files.filename` are annotated as the STABLE FILE IDENTITY in their table comments.
- G2: the rev-13 level-1-serialized pre-insert check ("filename absent from the other table") is unchanged — the single-owner invariant is what makes `filename` a safe cross-table key.
- G3 (anti-resurrection, rev 17 — A1): the pre-insert check queries `asset_snapshot_references` for the filename — **but ONLY for new-physical-file registrations.** If a row exists → abort the insert, return 500, critical alert `STALE_SNAPSHOT_REF_RESURRECTION` with `filename`. Filenames are never reused; a collision between a *new* file and a live protection row means UUID-RNG failure or a bug, and reusing the name would attach stale snapshot protection to a different physical file.
  - **Scope:** G3 applies to: upload Phase-2 commit INSERTs, backfill classification INSERTs for never-registered files, and repair-orphan INSERTs into `unattributed_media_files`. These are the paths where a filename is minted for a NEW physical file.
  - **Explicit exemption — identity-preserving transfers:** G3 does NOT apply to the world-deletion T1 snapshot-protected transfer (§4.9 step 2c: `INSERT INTO unattributed_media_files` for a file whose ref rows are the *reason* for the transfer) or the operator attribution transaction (§4.7: `INSERT INTO world_media_assets` moving a snapshot-protected file). These move the SAME physical file (filename is the stable identity, §4.1) — the protection rows are live and correct, not stale. Applying G3 to them would make world deletion and attribution impossible for snapshot-protected assets.
  - **How the check distinguishes:** the inserting transaction's specified SQL sequence determines applicability. Transfer sequences (§4.9 T1 step 2, §4.7 attribution) are specified WITHOUT the G3 query — the exemption is in the transaction spec, not a runtime flag. Any NEW insert path added in the future MUST state in its spec whether it is a new-file registration (G3 required) or an identity-preserving transfer (G3 exempt, with justification). An insert path whose spec is silent on G3 is a spec bug.
  - **Invariant protected:** a live snapshot-protection row is never attached to a different physical file than the one it was created for. **Proving scenario:** S49 (new G3 scenario — new-file collision aborts with 500 + alert; T1 transfer and attribution with live ref rows succeed).

- **Populated** at publish time AND during backfill (rev 17 — A2): the snapshot-creation transaction inserts one row per asset URL found in the snapshot's `canon_data` (via the §4.2 query contract), in the same transaction as the snapshot row. (Lock order: 1 → 3 → 6 → 8 → 9 per §4.3c.) The backfill classification transaction inserts one row per legacy snapshot reference discovered in its step-2 scan, in the same transaction as the file's registry/unattributed row insert (lock order 1 → 3 → 8). Both paths populate the table; there is no unpopulated state the re-verification cross-check can mistake for drift.
- **Cleaned** when a snapshot is deleted per the retention rule (§5.4): `DELETE FROM asset_snapshot_references WHERE snapshot_id = ?` in the same transaction as the snapshot deletion (GC transaction: locks 1 → 8; the snapshot row's own locking follows the snapshot system's contract).
- **Read** by every reference scanner (deletion T1/T2, backfill re-verification, world deletion): a row in this table is a retained reference — it blocks deletion exactly like a draft reference. The scanner checks BOTH `shared_with_worlds` (draft refs, other worlds) AND this table (snapshot refs, any world), resolving the table **by filename**.
- **Why a separate table (not extending `shared_with_worlds`):** (1) different lifecycle — snapshot refs are write-once at publish, deleted only at snapshot GC; draft refs change on every metadata edit; (2) no asset-row write contention at publish time (inserts go to the new table, not an array UPDATE on the hot asset row); (3) the scanner JOINs efficiently; (4) snapshot refs never participate in the lowest-`world_id` ownership election — they are pure protection, not ownership claims.
```

**Identity constraints:** The registry relies on URL-to-row resolution for deletion blocking and serving. Random UUID filenames make collisions astronomically unlikely, but the database must enforce identity, not probability:

```sql
ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_filename UNIQUE (filename);
ALTER TABLE world_media_assets ADD CONSTRAINT uq_world_media_assets_url UNIQUE (url);
```

- **Duplicate `filename` insert:** Return **500**, log at critical with `asset_id`/`filename` (indicates UUID-RNG failure or a code bug — this should never happen). Do not create the row.
- **Duplicate `url` insert:** Return **409** `{code: "ASSET_URL_EXISTS"}`. The URL is the identity used by reference resolution (§4.2); a second row for the same URL would make the scanner ambiguous. Do not create the row.

**Single-owner invariant across tables (rev 13):** Every *registered* physical filename has exactly one owner at any time: either a row in `world_media_assets` OR a row in `unattributed_media_files` — never both. This invariant is what makes capacity accounting sound (each file counted once) and serving deterministic.

**Scope clarification (rev 13 — B3):** The invariant applies to *registered* files (filenames with a row in either table). Physical files on disk with NO row in either table are *unregistered* — an explicitly detected, accounted (`unregistered_bytes`), and enforcement-blocking exception (§4.3d, §5.5), NOT an invariant violation. "Never neither" means: after backfill completes, every file the system *knows about* has exactly one owner; files the system *hasn't classified yet* are unregistered, counted, and block deletion enforcement until reconciled. The distinction is: invariant violation = two owners (a bug); unregistered = zero owners (a known state requiring reconciliation).

- **Why not a database constraint:** PostgreSQL cannot enforce UNIQUE across two tables. The invariant is enforced by a **mandatory serialization protocol** (rev 13 — B3):
  1. **Mandatory level-1 lock for check-and-write:** EVERY operation that inserts a filename into either table, or moves a filename between tables, MUST hold the level-1 global advisory lock (`pg_advisory_xact_lock`, §4.3c) covering the ENTIRE check-then-insert sequence in a single transaction. No exceptions. This applies to:
     - Uploads (already hold level 1 per §4.4)
     - Backfill classification inserts (backfill worker acquires level 1 per insert batch; rev 16 — R7: each insert transaction locks the world row `FOR UPDATE` first, so the FK1 `FOR KEY SHARE` is self-held)
     - Attribution transaction (unattributed → registry move)
     - Repair orphan handling (`unattributed_media_files` inserts)
     - Recovery paths that create rows
     
     The pre-insert cross-table check (`SELECT 1 FROM <other_table> WHERE filename = ?`) and the subsequent `INSERT` execute in the same level-1-holding transaction. Because level 1 is exclusive, two concurrent transactions CANNOT both observe "absent from other table" and then both insert. The check-and-write is serialized — this is what makes the application-layer invariant sound under concurrency. A pre-insert check WITHOUT the lock is insufficient (TOCTOU race); the lock is the mechanism, the check is the validation.
     
  2. **Pre-insert check (mandatory, inside the locked section):** Before inserting a filename into either table, the inserting transaction MUST query the other table for the same filename (`SELECT 1 FROM <other_table> WHERE filename = ?`). If found → abort, log at critical with `filename` and both table names, alert operator (`DUPLICATE_FILE_REGISTRATION`). Do not create the row.
  3. **Attribution transaction (atomic move, rev 16 — R5):** Moving a file from `unattributed_media_files` to `world_media_assets` is a single transaction holding level 1:
     ```sql
     BEGIN;
     SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1, first
     SELECT * FROM worlds WHERE world_id = ? FOR UPDATE;       -- position 3, FIRST (R5):
     -- the INSERT's FK1 validation takes FOR KEY SHARE on this row; holding it
     -- FOR UPDATE makes the implicit lock self-held (E2) — without this, the
     -- actual sequence contained a downward 7→3 wait edge.
     SELECT * FROM unattributed_media_files WHERE filename = ? FOR UPDATE;  -- position 7
     -- Cross-table check (inside the locked section):
     PERFORM 1 FROM world_media_assets WHERE filename = ?;
     -- If found: ROLLBACK, critical alert (invariant violation)
     INSERT INTO world_media_assets (...) VALUES (...);  -- FK1 FOR KEY SHARE = self-held
     DELETE FROM unattributed_media_files WHERE filename = ?;
     COMMIT;  -- level 1 released; INSERT+DELETE atomically visible
     ```
     The INSERT and DELETE commit atomically — there is no instant where the file has zero owners or two owners.
  4. **Serving on violation (fail-safe, rev 13 — B3):** If a read path finds a filename in BOTH tables (invariant violated by a bug or manual SQL):
     - Log at critical with `filename`, both rows' `world_id` values.
     - **Authorization check first:** if the two rows name DIFFERENT worlds (or one row's world differs from the requesting world's context) → **fail closed**: return 404 for this request, emit `DUPLICATE_FILE_REGISTRATION` with `auth_boundary_crossed=true`. Do NOT serve from either row — a duplicate registration may indicate incorrect ownership, and serving the wrong world's file is a confidentiality violation.
     - If both rows name the SAME world (or the file is world-agnostic) → serve from the `world_media_assets` row (authoritative table), emit `DUPLICATE_FILE_REGISTRATION` alert. Never return 500 on a read path due to a bookkeeping error — but never cross an authorization boundary on ambiguous data.
  5. **Detection:** The periodic capacity job (§5.5) cross-checks: any filename appearing in both tables → critical alert. Any file on disk with no row in either table → counted in `unregistered_bytes` (not silently ignored).
- **Capacity accounting:** Each physical file is counted exactly once, by the first matching rule in order: (a) in `world_media_assets` → `registry_bytes`; (b) else in `unattributed_media_files` → `unattributed_bytes`; (c) else → `unregistered_bytes`. Double-registration does not double-count — the job logs the violation and counts the file once under rule (a).

**Asset endpoint error contracts:**

| Situation | Status | Code | Notes |
|---|---|---|---|
| Asset ID does not exist (no row) | **404** | `ASSET_NOT_FOUND` | — |
| Asset ID exists but belongs to a different world than the URL path's `:id` | **403** | `ASSET_WRONG_WORLD` | Return 403, not 404: the caller is authenticated and authorized for *their* world path — confirming "this asset exists elsewhere" leaks only that UUIDs are guessable, which they are not (random v4). More importantly, 404 would be indistinguishable from "deleted," inviting retry loops. Document the trade-off: existence is not meaningfully leaked because asset IDs are unguessable. |
| `DELETE` on an already-deleted asset (row gone) | **404** | `ASSET_NOT_FOUND` | Idempotent-safe: for the client's purposes this is success-equivalent (the desired end state — no such asset — holds). Clients MUST NOT treat this as an error requiring intervention. Document as such in the API reference. |
| `DELETE` on a `pending_deletion` asset (row exists, T2 incomplete) | resumes T2 | — | Not an error: the endpoint re-enters the state machine at T2 (§4.3b step 3). |

**Why a table (not just files):** We need to answer "what references this file?" for deletion blocking (AS-04) and cleanup eligibility (AS-05). The filesystem cannot answer that.

**Why `lifecycle` instead of `deleted_at`:** Rev 3 used `deleted_at` for two different meanings (soft-deleted-awaiting-cleanup vs failed-scan-fallback), which caused contradictions. Rev 4 uses a single explicit state: an asset is either `active` or `pending_deletion` (proven unreferenced, file removal not yet confirmed). There is no ambiguous third state.

### 4.2 Reference model (no schema change to scenes/worlds)

**Canonical metadata paths** (verified against codebase 2026-10-16):

| Concept | Canonical path | Evidence |
|---|---|---|
| Cover art | `world.metadata.coverArtUrl` | `src/web/src/lib/api.ts:147`, `CreatorDashboard.tsx:66,111,236` |
| Scene illustration | `scene.metadata.illustrationUrl` | `SceneEditorPage.tsx:95,108,680`, `ReaderPage.tsx:216` |

The reference scanner MUST inspect exactly these two paths — no others. Any future asset-bearing metadata field must be added to this table (and the scanner) in the same change that introduces it. Do not scan arbitrary metadata keys: that would couple lifecycle operations to unvalidated author data.

References remain as URL strings at these paths. **Rationale:** The snapshot model already captures these URLs immutably. Changing the reference mechanism (e.g. to asset IDs) would require migrating the canon schema — unnecessary. The registry resolves URL → asset record for lifecycle operations.

**Reference computation** (for deletion blocking):
- **Draft references:** Scan current `scenes.metadata.illustrationUrl` and `world.metadata.coverArtUrl` for URLs matching this world's assets.
- **Published references:** Scan `canon_snapshots.canon_data` (JSONB) for URLs matching this world's assets, across all retained versions — per the query contract below.

Both are computable with JSONB queries. No new foreign keys needed.

**Snapshot scan query contract (rev 11):** the reference scanner must be able to *find* every snapshot reference, including from snapshots whose owning world record is missing or inconsistent (legacy deletions, partial restores). The authoritative source is the `canon_snapshots` table; the contract has three parts:

1. **Snapshot enumeration (which rows are scanned):**
   ```sql
   -- (a) All retained snapshots of the target world (the normal case)
   SELECT snapshot_id, world_id, canon_version, canon_data
     FROM canon_snapshots WHERE world_id = :world_id;
   -- (b) Orphan snapshots: world_id NULL, or referencing a world that no longer exists
   SELECT snapshot_id, world_id, canon_version, canon_data
     FROM canon_snapshots
    WHERE world_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM worlds w WHERE w.world_id = canon_snapshots.world_id);
   ```
   Query (b) is defensive: world deletion is blocked while published versions exist (§4.9), so orphans should not occur going forward — but legacy data and partial restores can produce them, and a URL match in an orphan snapshot still blocks deletion. The scanner runs both queries under the §4.3c locks (world row → asset row → scene rows held), so the snapshot set cannot change mid-scan.

2. **URL extraction (how references are found within a snapshot):** for each snapshot row, extract candidate URLs by (i) JSONB path queries on the canonical paths inside `canon_data` (`world.metadata.coverArtUrl`, each scene's `metadata.illustrationUrl` — the same two paths as §4.2's table, as they appear within the snapshot JSON), AND (ii) a defensive full-`canon_data` text containment check for the asset URL string (`canon_data::text LIKE '%<url>%'`). The path queries are the primary mechanism (precise, indexed); the text check is the safety net (catches snapshots whose internal structure drifted from the canonical paths — a match here is treated as a reference, never ignored as "probably a false positive," because the cost of a false negative is broken canon and the cost of a false positive is a blocked delete the operator can review).

3. **Fail-closed rules (what happens when the scan cannot be conclusive):** the scan authorizes deletion or quarantine *only* on a conclusive zero-reference result. Any of the following makes the scan **inconclusive**, with the specified behavior — there is no path from "couldn't verify" to "safe to delete":
   - `canon_snapshots` table unreachable (connection error, lock timeout) → deletion T1/T2 returns **503** `{code: "SCAN_UNAVAILABLE", retryable: true}` (§4.3b step 5); `repair` leaves the row/file untouched and retries next run (§9.4).
   - A snapshot row has `canon_data IS NULL` or unparseable JSONB → log at error with `snapshot_id`; treat the scan as inconclusive (the row might contain a reference the scanner cannot see). Same 503 / no-finalize behavior.
   - Query (b) itself fails → the whole scan is inconclusive (an unscanned orphan could hide a reference). Same behavior.
   - Snapshot count mismatch (rows enumerated ≠ `SELECT count(*)` re-check under the same locks — defensive against a snapshot committed between enumeration and extraction despite the locks) → re-run the enumeration; if it still mismatches, inconclusive.

   The principle is uniform with §4.3b step 5 and §9.4's repair rules: **inconclusive evidence never authorizes a destructive action.** A scan that cannot prove "zero references" proves nothing.

**Reference rejection:** Every path that sets an asset reference MUST reject:
- URLs belonging to assets with `lifecycle = 'pending_deletion'` → 422 `{code: "ASSET_DELETED"}`
- URLs with no matching asset row (unknown/legacy URL not yet backfilled) → 422 `{code: "ASSET_UNKNOWN"}` (after backfill completes, §4.7)

This applies to: scene metadata update, world metadata update, and the publish flow (draft referencing a non-active asset → blocking validation error).

**Role semantics:** Reference scans resolve by URL to a single row; the row's `roles` array records which **draft** reference paths currently point at it. Snapshot references are not tracked in `roles` — the scanner (§4.2) finds them by URL.

**`roles` means "currently held in draft metadata" — never "intended use."** The distinction matters because upload and metadata-switch are separate transactions (§4.3a):

- **Upload (T1):** creates the row with `roles = '{}'`. The new file holds no draft role yet — this is truthful, not a placeholder. A row with empty roles is a candidate for synchronous deletion (zero draft references) but is still protected by the snapshot scan.
- **Metadata switch (T2):** in the SAME transaction that writes the new URL into draft metadata, the new row gains the role and the old row loses it (e.g. setting `coverArtUrl` to new-URL: `new.roles := new.roles ∪ {'cover'}`, `old.roles := old.roles − {'cover'}`). If T2 fails or rolls back, the new row keeps `roles='{}'` (truthful — it was never referenced) and the old row keeps its role. No lying state is possible.
- **Idempotent retries:** setting the same URL at the same role path twice is idempotent — the role-add is a set union, and the reference write is a no-op if the URL is already there. Retrying T2 after a lost response cannot corrupt `roles`.
- **Multi-path URLs:** if the same URL occupies multiple draft paths (e.g. both cover and an illustration), the row's `roles` contains both. Removing one path removes only that role.
- Deletion is blocked while the URL appears in **any** draft metadata path **or** any retained snapshot — roles do not gate deletion; the URL scan does. A row with `roles = '{}'` (no draft references) is still protected while snapshots reference its URL.
- Replacing one role of a dual-role file: upload new file (new row, `roles='{}'`), then the metadata-switch transaction sets `coverArtUrl` to the new URL — new row gains `{'cover'}`, old row's `roles` becomes `{'illustration'}` and it remains `active`. The old file is never unlinked while any reference (draft or snapshot) exists.
- Quota counts the file's `size_bytes` exactly once, regardless of role count.
- **Source of truth:** draft metadata is authoritative for role membership. `roles` is a cached convenience for the UI/API (e.g. "which assets are currently used as covers"). After any partial failure, the `repair` reconciliation mode recomputes `roles` from actual draft references (§9.4). **The URL reference scan is the sole authority for deletion safety — `roles` is never consulted for safety decisions.**

### 4.2b Reference-validation transaction contract (mandatory)

§4.2 defines *what* must be rejected. This section defines the *transaction* in which that validation happens. Every operation that creates or changes an asset reference MUST execute this contract — there is no path that writes a URL into metadata or a snapshot without it.

**Operations covered:** scene metadata update (`illustrationUrl`), world metadata update (`coverArtUrl`), publish (snapshot creation), replacement step 2 / metadata switch (§4.3a).

**Contract steps:**

1. `BEGIN`. Use the default `READ COMMITTED` isolation level — **do not** use `REPEATABLE READ` here. (Why not: a `REPEATABLE READ` transaction establishes its snapshot at its *first* statement. If that first statement runs before the transaction finishes waiting for the world-row lock, the snapshot predates lock acquisition — a metadata writer can commit a new reference while deletion waits, and the scan then reads the stale snapshot and misses the reference. That is exactly backwards for a scan-then-act pattern: the snapshot must postdate lock acquisition, not predate it.)

   **Locks-first, scan-second protocol (mandatory):** Acquire ALL locks (step 2) *before* running any reference scan. In `READ COMMITTED`, every statement sees a fresh snapshot — so a scan executed *after* lock acquisition sees every change committed before the locks were acquired. Combined with the invariant that every reference writer holds the world-row lock while committing (enforced by this contract), no writer can commit a new reference after the scanner holds the lock. The scan's snapshot therefore postdates every possible concurrent commit: the race is closed by (a) locks acquired first, (b) `READ COMMITTED` giving a post-lock snapshot, and (c) writers unable to commit without the world-row lock.
2. Acquire locks per the global ordering (§4.3c):
   - Scene metadata update: world row → asset row(s) → scene row.
   - World metadata update: world row → asset row(s).
   - Publish: world row → all asset rows referenced by the draft → all scene rows.
3. For each asset URL being set:
   a. Resolve URL → registry row in `world_media_assets`. No row → abort with **422** `{code: "ASSET_UNKNOWN"}`. (Unattributed legacy files live in `unattributed_media_files`, §4.7 — they are not valid reference targets.)
   b. Require `lifecycle = 'active'`. Otherwise → abort with **422** `{code: "ASSET_DELETED"}`.
   c. Require `file_confirmed_present = true`. Otherwise → abort with **422** `{code: "ASSET_FILE_MISSING"}`.
   d. Require no active world-deletion job for this world (§4.9). If a job row exists → abort with **409** `{code: "WORLD_DELETION_IN_PROGRESS"}`. (Any job row means deletion is in progress — `complete` is never persisted; the row's absence is the terminal condition.)
   e. Cross-world references (rev 15 — supersedes the rev-10 prohibition): if `asset.world_id != target_world_id`, the reference is permitted as a SHARED reference. The transaction atomically ensures `target_world_id` is in the asset's `shared_with_worlds` array (append if absent and not the owner), under the same asset-row lock (position 6) — the array can never disagree with draft reality. The rev-10 blanket prohibition ("the product excludes a shared asset library," 422 `ASSET_WRONG_WORLD`) is superseded because its rationale is obsolete: it existed because deletion scans were world-scoped and a cross-world reference would escape the owning world's deletion protection. Every deletion scan now checks `shared_with_worlds` and `asset_snapshot_references` (§4.3b, §4.7c), so a cross-world reference cannot escape protection. The `ASSET_WRONG_WORLD` code is retained for the endpoint-authorization context (403 — operating on a foreign asset via a world-scoped management path, e.g. `DELETE /worlds/:id/media/:assetId` where the row belongs to another world); it is no longer returned by reference validation.

   **Note on 403 vs 422 for `ASSET_WRONG_WORLD` (rev 19 — B6):** the same error *code* exists in two contexts, but reference validation NEVER returns it — the rev-10 422 behavior is fully superseded, not merely narrowed:
   - **403** on asset endpoints (`GET/DELETE /worlds/:id/media/:assetId` where the row's `world_id` ≠ the path's `:id`): this is an **authorization** failure — "you are operating in world B's path but this asset belongs to world A; you cannot touch it." (See §4.1 error table.) This is the ONLY context in which `ASSET_WRONG_WORLD` is returned.
   - **Reference validation (this contract, step 3e):** a cross-world URL is a permitted shared reference — it is VALIDATED (steps 3a–3d) and the `shared_with_worlds` array is updated, never rejected. Any documentation, code comment, or test asserting a 422 `ASSET_WRONG_WORLD` from reference validation describes superseded behavior and is wrong; S18 asserts the success path.
   
   The distinction matters for clients: 403 means "stop, check your permissions/identity"; a validation failure on a URL means "fix the value and retry" (with `ASSET_UNKNOWN`/`ASSET_DELETED`/`ASSET_FILE_MISSING` as appropriate — never `ASSET_WRONG_WORLD`). Monitoring can separate "cross-world access attempts" (403, potential abuse signal) from "authoring mistakes" (422, UX signal).
4. If any URL fails validation: `ROLLBACK`. **No partial reference updates.** The operation is all-or-nothing.
5. Write the reference change(s). `COMMIT` while locks are still held.

**Publish-specific rule:** The publish flow MUST run this validation for every asset URL in the draft *before* committing the canon snapshot. A draft referencing a non-`active` asset is a blocking validation error — publish fails, no snapshot is created.

**External file loss window:** `file_confirmed_present = true` records the *latest confirmed* storage state — that the file was present at the last upload, reconciliation, or check — not a real-time guarantee that the bytes exist at this instant. Between confirmation and use there is an unavoidable window in which external file loss (disk failure, operator error, volume corruption) can occur. This window cannot be closed by locking: the filesystem is outside the database's transactional control. The mitigation is the serving layer's honest degradation (§4.5): if the file is missing when actually read, serving returns **404** with an error-level log, rather than a silent placeholder. Validation therefore guarantees "the latest confirmed state was present," not "the bytes are retrievable now" — and the system degrades explicitly when that distinction matters.

**Why the locks matter:** Without holding the asset-row lock through commit, a concurrent delete could transition the asset to `pending_deletion` between validation and the metadata write — creating a reference the deletion scan never saw. The shared lock ordering (§4.3c) closes this race: delete and reference-writers contend on the same asset-row lock in the same order.

### 4.3 Lifecycle operations

| Operation | Behavior |
|---|---|
| **Upload** | Validate → quota check (under advisory lock, §5.3) → write file (temp → fsync → rename → fsync dir, §4.5) → INSERT asset row (`lifecycle='active'`, `file_confirmed_present=true`) → commit → return 201. On row-insert failure after file write: delete the file synchronously, return 500 (see §4.5). |
| **Replace** | **Two transactions** (§4.3a). (1) Upload new file as a new asset row and commit. (2) In a separate transaction, update the metadata reference to the new URL. If step 2 fails, the new asset is unreferenced — recoverable via synchronous delete, not data loss. The old asset row remains `active`. |
| **Detach** (remove from draft) | Clear the metadata reference. Asset row stays `active`; file retained. Still counts toward quota (§5.1). |
| **Delete** | See §4.3b — the unified deletion state machine. This is the ONLY deletion algorithm in this ADR. |
| **Cleanup** | No background job in MVP. The synchronous delete path (§4.3b) handles reclamation. `pending_deletion` rows whose file removal failed are retried on the next DELETE call. |

### 4.3a Replacement transaction boundary (accepted trade-off)

A filesystem write and a PostgreSQL transaction cannot form one atomic unit, and neither can a two-step "create asset + update reference" operation. The design accepts **two separate transactions** with an explicit recoverability contract:

- **Transaction 1:** Upload new file → insert new asset row with `roles='{}'` (holds no draft role yet — truthful, §4.2) → commit. After this commits, the new asset exists but nothing references it.
- **Transaction 2:** Run the §4.2b reference-validation contract; update the scene/world metadata reference to the new URL; in the same transaction, add the role to the new row's `roles` and remove it from the old row's `roles` → commit.

**Failure modes:**
- Crash after T1 commits, before T2 starts: unreferenced asset row (`roles='{}'`) + file. Recoverable — the creator can delete it via the synchronous delete path (§4.3b), which will find zero references and hard-delete. **Not data loss.** The empty `roles` array is truthful here: the file genuinely holds no draft role.
- T2 fails (validation error, concurrent modification): same as above — new row keeps `roles='{}'`, old row keeps its role. No lying state (S24).
- T2 partially applies (metadata updated but response lost): client retries; setting the same URL twice is idempotent (role-add is a set union).

The alternative — holding a distributed lock across file write + row insert + metadata update — would serialize all asset operations per world and still not survive a process crash between filesystem and database commits. Two transactions with a recoverable intermediate state is the correct trade-off.

### 4.3b Unified deletion state machine (the ONLY deletion algorithm)

This section replaces all prior deletion descriptions. There is one algorithm, one lock order, one state machine.

**Lock order:** Delete acquires its required locks per the global ordering defined in §4.3c (file-mutating class): required locks in ascending global order. No operation may acquire locks out of order; deadlock-freedom follows from the consistent global ordering (see §4.3c).

**Design principle:** A transaction-scoped advisory lock is released the moment its transaction commits. Therefore **no claim is made that a transaction-scoped lock protects filesystem work performed after commit.** The algorithm is split into two separately-committed transactions with a durable boundary between them. Each transaction reacquires the locks it needs; T2 re-verifies the preconditions under its own locks before touching the filesystem.

**State machine:**

```
[active] --DELETE requested--> T1: acquire locks (per §4.3c, file-mutating class)
                                    |
                    +---------------+---------------+
                    |                               |
            Scan finds references           Scan finds zero references
          or scan cannot complete                   |
                    |                       UPDATE lifecycle='pending_deletion'
            ROLLBACK, change nothing         COMMIT  <-- durable boundary
                    |                        (locks released)
                    v                               |
            [active] (unchanged)              [pending_deletion]
            (409 ASSET_REFERENCED /                |
             503 SCAN_UNAVAILABLE)      T2: reacquire locks (per §4.3c)
                                                    |
                                        Re-verify: still pending_deletion
                                        AND fresh zero-reference scan
                                                    |
                                    +---------------+---------------+
                                    |                               |
                          Re-verification OK              References appeared
                          (or file already absent)        (invariant violation —
                                    |                     see step 10)
                            Stat the file:                          ROLLBACK, return 409
                                    |                               {ASSET_REFERENCED_UNEXPECTED}
                                    |                               (stays pending_deletion;
                        +-----------+-----------+                    operator investigates;
                        |                       |                    next DELETE re-runs
                  File present             File already absent        the T1 scan)
                  (unlink it)              (idempotent: treat
                        |                   as success)
                        v                       |
            SET file_confirmed_present=false     |
            (within finalizing txn;             |
             quota released on commit, §5.1)    |
                        |                       |
            DELETE registry row <----------------+
                        |
                    COMMIT, return 204
```

**T1 — Prove unreferenced and commit the durable boundary:**

1. `BEGIN`. Use `READ COMMITTED` (the default) — same reasoning as §4.2b: locks are acquired (step 2) *before* the scan (step 4), so the scan's statement snapshot postdates lock acquisition and sees every commit that happened before the locks were held. `REPEATABLE READ` is explicitly forbidden here for the same reason: its snapshot could predate lock acquisition.
2. Acquire locks per §4.3c (file-mutating class): global media advisory lock → per-world quota advisory lock → world row → asset row → all scene rows of the world. **No reference-scan statement may execute before these locks are held.**
3. If asset `lifecycle` is already `'pending_deletion'`: this is a retry of a T2 that never completed. Commit the no-op and proceed to T2.
4. Run the reference scan: draft metadata (`illustrationUrl`, `coverArtUrl`) + all retained canon snapshots + `shared_with_worlds` (other worlds' draft references — a non-empty array IS a reference set) + `asset_snapshot_references` (retained snapshot references from any world — each row IS a reference). The scan fails closed: if any of these sources cannot be read completely → step 5 (503), never `pending_deletion`.
5. **If the scan cannot complete** (lock timeout, transient DB error): `ROLLBACK`. Change nothing. Return **503** with `Retry-After: 5` header and `{code: "SCAN_UNAVAILABLE", retryable: true}`. **Rationale:** an unverified asset might be referenced by a published snapshot. Changing its state on inconclusive evidence risks breaking canon. There is no path from "scan failed" to "pending_deletion".
6. **If references found:** `ROLLBACK`. Return **409** with `{code: "ASSET_REFERENCED", references: [...]}` listing scene titles and published versions. Change nothing.
7. **If zero references:** `UPDATE world_media_assets SET lifecycle = 'pending_deletion', updated_at = now() WHERE asset_id = ?`. `COMMIT`. ← **Durable boundary.** The advisory locks are released here. The asset is provably unreferenced *as of this scan*. No new reference can be created afterward without holding the asset-row lock and passing the §4.2b contract, which rejects `pending_deletion` — a writer that validated the asset as `active` before this commit must re-acquire the asset-row lock to commit its own reference, at which point it sees `pending_deletion` and aborts.

**T2 — Reacquire locks, re-verify, remove file, finalize:**

8. `BEGIN`. Reacquire locks per §4.3c (file-mutating class): global → quota → world row → asset row → scene rows.
9. Re-read the asset row. If `lifecycle != 'pending_deletion'`: `ROLLBACK`, return **409** `{code: "ASSET_STATE_CHANGED"}` (another operation legitimately changed state — e.g., an operator restored it). Do not proceed.
10. Re-run the reference scan (fresh, under T2's locks). If references are found:
    - **Invariant:** Under the lock contract (§4.3c), this is **impossible** for a compliant reference writer. T1 held the asset-row lock through its scan and commit; §4.2b requires every reference writer to hold that same asset-row lock while validating and committing. A writer that validated the asset as `active` before T1's commit must re-acquire the asset-row lock to commit its own reference — at which point it sees `lifecycle='pending_deletion'` and aborts. There is no compliant execution in which a reference commits between T1's scan and T2's re-verification without holding the lock T1/T2 hold.
    - **If it happens anyway:** Treat as an **invariant violation** — log at critical with `asset_id`, the found references, and the transaction IDs involved; alert the operator. `ROLLBACK`. The asset stays `pending_deletion`; the file is preserved (canon is safe — nothing was deleted).
    - **Recovery path:** Operator investigates. If a writer bypassed the lock contract (code bug), fix the writer before retrying. If the found "reference" is stale or corrupt data (e.g., a snapshot row with a malformed URL that the scanner mis-matched), the operator clears or corrects the corrupt reference, then retries the DELETE (which re-runs the T1 scan). **Never automatically restore the asset to `active`**: that could re-expose an asset whose deletion was legitimately authorized, and the operator has not yet proven the reference is invalid.
    - Return **409** `{code: "ASSET_REFERENCED_UNEXPECTED", invariant_violation: true, references: [...]}` — distinct from the normal `ASSET_REFERENCED`, so monitoring can distinguish "legitimately referenced" from "contract violated".
11. Stat the file on disk:
    - **File present:** `unlink(/data/media/{filename})`.
    - **File already absent:** idempotent success — treat exactly as if the unlink had just succeeded. (Covers: retry after a crash between unlink and commit; a concurrent DELETE that already finished; external removal. The row records *intent*; the stat records *fact*.)
12. If unlink failed (I/O error, permission): `ROLLBACK`. Row stays `pending_deletion`. Return **500** `{code: "FILE_REMOVAL_FAILED", retryable: true, asset_id}`. The next DELETE retries from T2 step 8.
13. `UPDATE world_media_assets SET file_confirmed_present = false WHERE asset_id = ?` — part of the finalizing transaction (see quota rule, §5.1).
14. `DELETE FROM world_media_assets WHERE asset_id = ?`.
15. `COMMIT`. Return **204**.

**Crash between steps 11–15 (after a successful unlink):** The transaction rolls back, so the row remains `pending_deletion` with `file_confirmed_present` still `true` (the step-13 update rolled back with it). Quota is **not** released — the file's bytes are still counted until a retry finalizes deletion. This temporary overcounting is safe and accepted: the next DELETE retries T2: step 11 stats the file, finds it absent, treats it as success, and re-applies steps 13–15 to completion. **No manual intervention required** — retry-after-crash is the standard path, not an edge case.

**Crash between T1's commit and T2's start:** The asset sits in `pending_deletion` with its file on disk. Startup `diagnose` (§9.4) logs it as an expected state. The next DELETE on the asset resumes at T2. No data loss; quota still counts the file (§5.1), which is correct — the bytes are there.

**Key invariants:**
- A `409` means: nothing changed in this transaction, safe to retry later.
- A `503` means: scan inconclusive, nothing changed, retry after the `Retry-After` interval.
- A `204` means: file confirmed gone (by stat), row deleted, quota reclaimed. Complete.
- A `500` with `retryable: true` means: asset is in `pending_deletion`, safe to retry the DELETE.
- The filesystem and database are never claimed to be atomic. T1 and T2 are separately committed; T2's re-verification under freshly acquired locks is what makes the split safe — not any lock surviving across the commit boundary.
- `pending_deletion` is only entered after a **successful, conclusive** zero-reference scan. There is no path from "scan failed" to "pending_deletion".
- No reference-setting operation can introduce a URL for a `pending_deletion` asset: §4.2b requires the asset-row lock and rejects non-`active` lifecycle, and T1/T2 hold that same lock while scanning.

### 4.3c Global lock-acquisition order (all operations)

Every operation that touches media state acquires the locks it needs **in ascending global order**. An operation **may omit** levels it does not require — it must never acquire a lock out of order, and never hold a lower-level lock while waiting for a higher-level one. Deadlock-freedom holds by construction: all lock wait graphs are acyclic because every participant uses the same total order.

**Operation classes** (each class defines which lock levels are required; omissions are explicit, not exceptions):

| Class | Required positions | Operations | Rationale |
|---|---|---|---|
| **File-mutating** | 1 → 2 → (+3, 6, 7, 8, 9 as needed) | Upload, asset delete (T1, T2), world deletion steps | Mutates the filesystem; must exclude reconciliation and other mutators (1) and serialize quota (2) |
| **Quota-affecting** | 2 → 3 | Quota-only adjustments (none in MVP beyond upload/delete) | Upload and delete are already file-mutating; this class exists for future quota operations that don't touch files |
| **Reference-changing** | 3 → (+6, 8, 9) | Row-lock portion of metadata switches | Changes which URLs are referenced; needs row locks for the §4.2b contract |
| **Reference-changing + freeze** | 1 → 3 → (+6, 8, 9) | Scene/world metadata updates, publish, replacement T2 | As above, PLUS level 1: these mutate backfill classification inputs, so the freeze check must serialize against backfill completion (§4.7b; rev-15 B2 verification) |
| **Freeze-serialized** | 1 → (+3, 4, 5, 6) | Backfill completion, conflict resolution | Operate on backfill state; level 1 is the serialization point |
| **Read-only** | None, or 1 only | Reference scans (no locks), reconciliation `diagnose` (level 1) | A pure row scan takes no locks; a full-filesystem scan takes level 1 so it never observes a filesystem mid-mutation |

**Row-lock order is preserved wherever rows are touched:** whenever an operation locks rows at multiple positions, it does so in ascending canonical order (world → backfill_runs → conflict → asset → unattributed → snapshot-ref → scene). Advisory locks (positions 0–2) always precede row locks (positions 3–9). An operation that starts at position 3 is not "skipping ahead" — it simply has no position-1/2 requirements, and it acquires its position-3+ locks in ascending order.

**The order:**

0. **Per-job session advisory lock** — Used **only** by world-deletion recovery (§4.9): acquired once at the start of a recovery pass, held for the entire multi-transaction pass, released when the session ends. This provides whole-pass exclusivity that a transaction-scoped lock cannot: the job-row `FOR UPDATE` lock is released at each commit, so a second recovery worker could otherwise acquire it between file deletions. Job-row `FOR UPDATE` still protects each individual state transition; the session lock provides the outer exclusion.

   **Operational contract for the session-level lock (mandatory):**
   - **Acquisition:** `SELECT pg_try_advisory_lock(hashtext('world_deletion_recovery:' || job_id))` — the **non-blocking** try variant, never the blocking `pg_advisory_lock`. On `false`: retry with 100ms jitter, up to a 30-second deadline. On deadline expiry: abort the recovery attempt, log at warning with `job_id`, emit an alert (`RECOVERY_LOCK_TIMEOUT`). **A worker must never proceed without holding the lock** — proceeding without exclusion risks two workers unlinking the same files and corrupting the progress accounting.
   - **Dedicated session:** the recovery worker opens its **own database connection** for the entire pass. This connection is **never taken from the application connection pool** — it is created for the recovery pass and closed when the pass ends. Rationale: a pooled connection returned to the pool while still holding a session-level lock would leak the lock to an unrelated request (or block it indefinitely). This is a hard rule, not a guideline.
   - **Release:** `SELECT pg_advisory_unlock(hashtext('world_deletion_recovery:' || job_id))` in a guaranteed cleanup path (`finally` block / `defer` / try-finally) after the pass completes — whether it succeeded, failed, or was cancelled. Verify release by checking the unlock result; log at warning if the lock was not held (indicates a logic bug).
   - **Crash semantics:** if the worker process dies, its database session ends → PostgreSQL releases all session-level locks held by that session **automatically**. The job remains in its last committed state; the next recovery attempt acquires the lock cleanly and resumes. No stale-lock cleanup is ever needed — this is the reason for choosing a session-level advisory lock over a lock-table row.
   - **Pool safety restated:** the dedicated connection is **closed**, never returned to any pool. Code review must verify this path — a `pool.release()` on the recovery connection is a correctness bug.
1. **Global media advisory lock** — `pg_advisory_xact_lock(hashtext('media_global'))`. Transaction-scoped (auto-released on commit/rollback). Serializes all file-mutating operations against each other and against reconciliation, AND serializes the backfill-freeze check for classification-input mutations (§4.7b).
   - *`system_maintenance` row:* read via the fail-closed `is_maintenance_active()` wrapper (§4.3d) immediately after acquiring level 1, before any `FOR UPDATE` row lock. Writer transactions never take `FOR UPDATE` on this row (only the operator's activation/deactivation does, while holding level 1) — so it cannot participate in a deadlock cycle and needs no position in the total order.
2. **Per-world quota advisory locks** — `pg_advisory_xact_lock(hashtext('media_quota:' || world_id))`. Transaction-scoped. Serializes quota-affecting operations for one world. A transaction touching multiple worlds acquires them in ascending `world_id` (UUID string comparison).
3. **World rows** — `SELECT ... FOR UPDATE OF worlds WHERE world_id = ?`. Multiple worlds: ascending `world_id`.
4. **`backfill_runs` rows** — `SELECT ... FOR UPDATE OF backfill_runs WHERE run_id = ?`, ascending `run_id`. (The completion transaction is level 1 → backfill_runs row: a prefix of the total order.)
5. **`backfill_conflicts` rows** — `SELECT ... FOR UPDATE OF backfill_conflicts WHERE conflict_id = ?`, ascending `conflict_id`.
6. **`world_media_assets` rows** — `SELECT ... FOR UPDATE OF world_media_assets WHERE asset_id IN (...)`, ascending `asset_id`.
7. **`unattributed_media_files` rows** — `SELECT ... FOR UPDATE OF unattributed_media_files WHERE file_id = ?`, ascending `file_id`.
8. **`asset_snapshot_references` rows** — `SELECT ... FOR UPDATE OF asset_snapshot_references WHERE filename = ?`, ascending (`filename`, `snapshot_id`) (rev 16 — B4.2: filename is the stable identity).
9. **Scene rows** — `SELECT ... FOR UPDATE OF scenes WHERE ...`, ascending `scene_id`.

**Reconciliation with prior revisions (rev 15):** the rev-10 "world → asset → scene" row order is preserved as positions 3 → 6 → 9. The rev-14 resolution order "level-1 → world → conflict → asset" is positions 1 → 3 → 5 → 6 — the conflict lock's place between world rows and asset rows is now canonical, not resolution-specific. The per-world quota lock keeps position 2; its multi-world ascending-`world_id` rule is new.

**Deadlock-freedom (rev 16 — B4.3):** by construction over the *actual* acquisition sequence, not the intended list. A *blocking acquisition* is any lock that can wait on another transaction: advisory locks (0–2), `FOR UPDATE` row locks (3–9), `FOR KEY SHARE` taken on a row not already held, cascade row locks, speculative unique-insert waits, and single-row UPDATE/DELETE locks. INSERTs of new rows, plain SELECTs, and self-held upgrades are non-blocking and create no wait edges. Advisory-lock waits are invisible to PostgreSQL's deadlock detector — this proof never relies on detection.

- *Ordering rule E1 (explicit):* every transaction acquires blocking locks in strictly ascending (position, ID); multi-row statements use the lock-first `SELECT … FOR UPDATE ORDER BY <id>` pattern (R2 below); `world_deletion_jobs` rows are position 4 (R1 below).
- *Ordering rule E2 (implicit):* every FK-validation `FOR KEY SHARE` is taken on a row the transaction already holds `FOR UPDATE` (R5, R6, R7 below; upload/publish/T1-job-INSERT hold it by prior design). `FOR UPDATE` conflicts with `FOR KEY SHARE`, so E2 is load-bearing: the check can never block on a foreign holder.
- *Lemma A (explicit order):* every transaction's blocking explicit acquisitions ascend — verified per operation in the actual-sequence table below, after R1–R7. **Terminal-singleton operations (rev 18 — B14):** the following acquire exactly one unpositioned lock and no other unpositioned lock, making them terminal nodes per Lemma F (out-degree 0) — they are listed here for inventory completeness: reservation rollback (terminal UPDATE on the reservation row), ENOSPC-failure handoff (reservation → ABANDONED), writer heartbeat (`UPDATE ... WHERE released_at IS NULL`), abandoned-temp cleanup (reservation row + file unlink under level-1), startup recovery state repair (single reservation-row UPDATEs), backfill run-start INSERT (`backfill_runs`), maintenance activation/deactivation (`UPDATE system_maintenance ... WHERE id = 1` under level-1), and the claim-protocol terminal UPDATEs (unpositioned, Lemma F). None can extend a wait cycle.
- *Lemma B (FK neutrality):* the only blocking FK locks are self-held (E2) → non-blocking. Residual case (a future writer omitting E2): every `FOR UPDATE` holder on `worlds`/`world_media_assets`/`backfill_runs` co-holds level 1 with the requester (all such paths hold level 1), and `pg_advisory_xact_lock` is exclusive, so the `FOR KEY SHARE` can never meet a concurrent conflicting holder. The wait cannot materialize.
- *Lemma C (unique neutrality, rev 17 — A13, order corrected rev 18 — B8):* speculative-insert waits occur only between level-1 holders. Every INSERT into `world_media_assets` or `unattributed_media_files` executes inside a level-1-holding transaction: upload Phase-2 commit (1 → 3 → 6, rev 17 — A8), backfill classification inserts (1 → 3 → (6 or 7) → 8, rev 18 — B8: G3 precedes the registry INSERT), attribution INSERT (1 → 3 → 7 → 6; the 6 is a non-blocking new-row INSERT per Lemma A — the blocking sequence is 1 → 3 → 7), T1 transfer INSERT (1 → 2 → 3 → 6 → 8), repair orphan INSERTs (1). Level 1 is exclusive, so two such INSERTs cannot overlap: the second starts strictly after the first commits or aborts. If the first committed a row with the same filename, the second's pre-insert check (inside its level-1 section) observes it → 409/500 per §4.1, never a speculative-insert wait. The wait can therefore only queue behind a committed-or-aborted transaction — it resolves immediately. Queueing, not a cycle. (The pre-rev-17 gap — whether the Phase-2 commit holds level-1 — is settled by A8: it does, by the mandatory pre-insert protocol. Phase-2 chunk writes take no DB locks and perform no INSERTs, so they are not speculative-insert participants.)
- *Lemma D (cascade neutrality, corrected rev 18 — B14):* the only cascade that fires in the current design is T5's world-row delete cascading to the `world_deletion_jobs` row (R3) — and it fires only after T5's explicit deletes have emptied the referencing sets, so it is a no-op safety net. (T1, T4, and asset-delete T2 take no cascade row locks: T4's ref-row and asset-row deletes are explicit per R4, and T2 deletes no rows that cascade.) The cascade is taken by a level-1 holder (T5 holds 1); no concurrent holder of the referencing rows can exist.
- *Lemma E (session lock):* level 0 is acquired exactly once per recovery pass via `pg_try_advisory_lock` (non-blocking, bounded retry) *before* any transaction begins, on the dedicated non-pooled connection; never re-acquired; never requested by non-recovery code paths. No cycle passes through 0: a recovery session waiting on level 1 holds no row locks (row locks come after 1 inside the pass), and a non-recovery transaction never requests level 0 — so any wait involving a recovery session is a single edge, never a cycle. A second recovery worker for the same job fails the try-lock while holding nothing (bounded retry → abort + alert), so it cannot extend a wait chain.
- *Lemma F (single-lock terminal):* locks outside positions 0–9 (`storage_reservations` rows, `system_maintenance` row) are acquired singly, by transactions holding no other unpositioned lock; in the wait graph they are terminal nodes (out-degree 0) and cannot extend a cycle.
- *Theorem:* the wait-for graph is acyclic. Every wait edge either goes strictly upward in (position, ID) (Lemmas A, E1), or targets a terminal node (Lemma F), or is non-blocking by Lemmas B–D. A cycle would require a strict increase around a closed loop — impossible.
- *Corollary:* the rev-14 no-upgrade rule remains subsumed: out-of-order acquisition is forbidden, now verified against the actual sequence including implicit locks.
- *Explicit proof assumptions (rev 18 — B14):* the theorem above is conditional on the following. Each is stated here so a future change that violates one is recognizable as a proof-breaking change, not a refactor:
  - **(i) Statement-order fidelity:** the implementation's actual SQL matches the specified statement order in every transaction — especially the lock-first `SELECT … FOR UPDATE ORDER BY` pattern (R2) and the pinned backfill sequence (B8). A plan that reorders blocking acquisitions invalidates Lemma A for that transaction.
  - **(ii) No hidden lock-takers:** no undisclosed triggers, rules, or deferred constraints take blocking locks outside the specified sequences. Adding a trigger that locks rows (e.g., an audit trigger doing `FOR UPDATE` on a log table) requires re-verifying Lemma A for every affected transaction.
  - **(iii) Phase-2 commit indivisibility (Lemma C precondition):** the Phase-2 commit transaction (rename + asset INSERT + reservation→COMMITTED) is never split into multiple transactions. Lemma C's "speculative-insert waits occur only between level-1 holders" depends on the INSERT executing inside the level-1-holding commit transaction. Splitting the commit would silently void Lemma C.
  - **(iv) Coherent `flock` domain:** the writer and expiry worker share a coherent POSIX file-locking domain over `/data/media` (verified by the S51 self-test at every startup). If the deployment degrades to the rev-15 timing bounds (operator-acknowledged), the B1.2 enforcement argument no longer holds — capacity accounting remains conservative via `size_bytes`, but the zero-post-abandonment-write guarantee is replaced by the timing bound.
  - **(v) Single advisory key:** `pg_advisory_xact_lock(hashtext('media_global'))` is the same key at every call site. A second key (e.g., a per-world variant) would partition the serialization domain and void the proof for cross-key interleavings.
  - **`flock` is outside the wait-graph:** the (position, ID) ordering covers PostgreSQL locks only. POSIX `flock` cannot participate in a PostgreSQL deadlock (different lock manager; PG's deadlock detector cannot see it), so it is correctly excluded from the acyclicity argument. `flock` is a *liveness* mechanism (writer↔claim exclusion), not a deadlock-freedom mechanism. The corresponding liveness hazard — a process holding `LOCK_SH` forever and starving claims — is mitigated by per-chunk release, kernel release on process death, and `LOCK_NB` (non-blocking) on the claim side with the `EXPIRY_CLAIM_DEFERRED` alert after 3 deferred cycles.

**Required transaction-boundary redesigns (rev 16 — B4.3):** the rev-15 proof assumed the intended lock list; reconciling with SQL-level locking behavior (implicit `FOR KEY SHARE` from FK validation, plan-order multi-row locking, cascade trigger order, the job row's undeclared position) forced seven concrete redesigns. Each is a transaction-boundary or statement-order change, not a new lock:

- **R1 — Job row is position 4; statement order fixed.** `world_deletion_jobs` rows join position 4 ("run/job state rows," alongside `backfill_runs`). This resolves the rev-15 discrepancy (T2 prose said 1→2→3→4, the table said 1→2→3→6→7 — both incomplete). New orders: T2 = 1→2→3→**4**→6→7 with the job-row `FOR UPDATE` **first**; T3 per-file = 1→2→3→**4**→6; T4 = 1→2→3→**4**→6→7→8 (order corrected rev 18 — B10: was 6→8→7, not ascending); T5 = 1→2→3→**4**→6; recovery inner txns = 0→1→2→3→**4**→6→7.
- **R2 — ORDER BY mandate for multi-row blocking statements.** PostgreSQL locks rows in plan/visit order, not sorted — so "same-position ascending-ID" was false as written for multi-row statements. Rule: any statement that can block on >1 row at one position must lock via `SELECT … FOR UPDATE ORDER BY <id>` with the identical predicate, then mutate by primary key of the locked set (PostgreSQL has no `ORDER BY` on `UPDATE`/`DELETE`; the two-step pattern is mandatory, not stylistic). Applies to: publish asset/scene locks; asset-delete T1/T2 scene locks; world-deletion T1 enumerations; T2 asset and unattributed UPDATEs; T4 asset DELETE, snapshot-ref DELETE, unattributed UPDATE; T5 asset DELETE. Single-row statements are trivially ordered. (Snapshot GC's multi-row `DELETE FROM asset_snapshot_references WHERE snapshot_id = ?` is not listed — GC is DORMANT in MVP per §5.4; if GC is ever enabled, its DELETE must follow the lock-first `ORDER BY (filename, snapshot_id)` pattern. Rev 18 — B14.)
- **R3 — T5 deletes referencing rows explicitly.** New T5: 1 → 2 → 3 (world `FOR UPDATE`) → 4 (job `FOR UPDATE`) → lock-first assets `ORDER BY asset_id` → `DELETE FROM world_media_assets WHERE world_id = ?` → `DELETE FROM worlds WHERE world_id = ?`. The `ON DELETE CASCADE`s then find empty referencing sets — no-op safety nets (Lemma D). This removes the only uncontrolled lock order in the system (cascade trigger firing order).
- **R4 — T4 deletes snapshot-ref rows explicitly at position 8 (lock order corrected rev 18 — B10).** **DESIGN DECISION (rev 18):** the rev-16/17 acquisition order was 6 → 8 → 7, which is not ascending in the canonical position order (asset=6 < unattributed=7 < snapshot-ref=8) and made Lemma A's "strictly ascending (position, ID)" claim false for T4. The order is now 6 → 7 → 8: after the asset-row locks (6), lock the unattributed rows (7) via lock-first `SELECT ... FOR UPDATE WHERE :world_id = ANY(referencing_worlds) ORDER BY file_id` (R2), then the snapshot-ref rows (8) via lock-first `ORDER BY (filename, snapshot_id)` (rev 16 — B4.2: filename-keyed), then `DELETE FROM asset_snapshot_references WHERE filename = ANY(<locked filenames>)`. The reorder is safe: no semantic dependency requires the ref DELETE before the unattributed UPDATE (disjoint row sets; both already serialized by level-1), and no other transaction acquires 8 before 7 — backfill's 8-touching statements are non-blocking INSERTs (Lemma A), drift resolution and publish touch 8 but never 7. Downstream: §4.3c table, §4.7c reference-lifecycle table, §4.9 T4 spec, and the per-transaction lock-ownership table are all updated to 1 → 2 → 3 → 4 → 6 → 7 → 8. (With the B4.2 cascade removed, the explicit ref-row DELETE remains *required*, not belt-and-braces.)
- **R5 — Attribution locks the world row first.** New attribution transaction: 1 → 3 (`SELECT … FOR UPDATE OF worlds WHERE world_id = ?`) → 7 → check → INSERT → DELETE. The FK1 `FOR KEY SHARE` becomes self-held; without R5 the actual sequence contained a downward 7→3 edge. **Lock-order annotation (clarification):** the *blocking* acquisition sequence is 1 → 3 → 7, strictly ascending per E1. The trailing INSERT (position 6 in operation listings) inserts a *new* row — non-blocking per Lemma A, creates no wait edge; the DELETE reuses the position-7 lock already held. Operation listings that show `1 → 3 → 7 → 6` describe statement order, not a descending lock acquisition.
- **R6 — T1 locks new-owner world rows and its asset rows first.** T1 collects distinct new-owner `world_id`s from shared assets and locks them `WHERE world_id = ANY($1) ORDER BY world_id FOR UPDATE` after the deleted world's row (same position 3, ascending ID). Transfer enumerations use `ORDER BY asset_id` with `FOR UPDATE`, so move-path DELETEs are self-held. (Without R6, the transfer UPDATE's FK1 validation on the new owner's row was a downward edge from position 6.)
- **R7 — Backfill write transactions lock the referenced row first.** Classification INSERT txns: 1 → 3 (world row) → INSERT. Conflict-row INSERT txns: 1 → 4 (run row) → INSERT. FK1/FK4 `FOR KEY SHARE` become self-held.

**Representative competing-transaction analysis (rev 16 — B4.3):** three interleavings walked through with actual sequences:

(a) *Upload vs backfill-attribution, same filename F (world W1).* Upload commit txn U (rev 18 — B14: sequence corrected to the A8 split): `file LOCK_SH → 1 → 3(W1 FOR UPDATE) → [plain SELECT: F absent] → INSERT asset(F): speculative-unique wait impossible while a competitor holds level 1 (Lemma C) → FK1 FOR KEY SHARE on W1 = self-held → UPDATE reservation (terminal) → COMMIT → LOCK_UN`. Attribution txn A: `1 → 3(W1) → 7 → …` (R5). Whoever reaches level 1 first runs to completion; the loser waits on the advisory lock *holding nothing* — its first statement is the lock acquisition. Single wait edge; the loser's cross-table check then sees the winner's committed state (duplicate → 409/500 per §4.1). Acyclic.

(b) *World-deletion T3 (per-file) vs conflict resolution on a shared asset.* T3 per-file (redesigned): `1 → 2 → 3(W1) → 4(job) → 6(B FOR UPDATE, re-verify world_id) → unlink → COMMIT`. Resolution R: `1 → 3(W2) → 5(conflict) → 6(A FOR UPDATE) → COMMIT`. Both hold level 1 → serialized. The loser parks on the advisory lock before its first row acquisition, so the position-6 contention never becomes a wait edge between two lock-holders. At most one edge in every interleaving. Acyclic.

(c) *Recovery pass (0 held) vs concurrent upload.* Recovery inner txn Sₙ waits on 1 holding only 0 (row locks come after 1 inside the pass — Lemma E); upload U wants 1 holding nothing. If Sₙ holds 1→2→3→4→6, U waits on 1 — Sₙ's row-lock waits are impossible (every `FOR UPDATE` holder co-holds level 1, Lemma B inventory, and Sₙ holds it). If U holds 1 mid-commit, Sₙ waits on 1 holding 0 — U never requests 0 (only recovery paths do), and Sₙ's prior inner transactions released their row locks at commit (transaction-scoped). No interleaving produces Sₙ→U→Sₙ. Acyclic. Kill-9 of S mid-pass: the session ends, PostgreSQL releases 0 automatically.

(d) *Drift resolution vs conflict resolution on the same conflict (rev 17 — A14).* Drift resolution D: `1 → 3 → 5(conflict FOR UPDATE) → 8(ref rows FOR UPDATE, ORDER BY (filename, snapshot_id))`. Conflict resolution R: `1 → 3 → 5(conflict FOR UPDATE) → 6(asset FOR UPDATE)`. Both acquire level-1 FIRST — they serialize on the advisory lock before either touches a row. The loser parks on level-1 holding nothing (its first statement is the lock acquisition); the winner runs 3→5→8 (or 3→5→6) to completion. The position-5 contention never becomes a wait edge between two row-lock holders, because the level-1 serialization precedes all row acquisition. At most one wait edge (loser → winner on level-1) in every interleaving. Acyclic. (This case was absent from the rev-16 inventory — the drift-resolution transaction acquires a (5, 8) combination no other transaction takes. It is now in the §4.3c table and in Lemma A's inventory.)

**Snapshot-content stability during drift resolution (rev 17 — A22):** the reviewer's requirement — "the resolution transaction's locks must protect the snapshot content being reconciled, not merely the reference rows" — is satisfied as follows. The drift-resolution transaction holds level-1 for its entire duration. Snapshot publication (which creates snapshots and inserts ref rows) requires level-1; snapshot GC (which deletes snapshots and ref rows) requires level-1. Therefore no snapshot can be created, deleted, or have its `canon_data` modified while the drift-resolution transaction runs — the snapshot set and their immutable content are stable for the re-scan. The re-scan reads `canon_snapshots.canon_data` (immutable by the platform's canon guarantee); no row lock on the snapshot row is needed because content cannot change under level-1 exclusion. The ref rows (position 8) are locked `FOR UPDATE` in `(filename, snapshot_id)` order to serialize against a concurrent drift resolution on overlapping filenames (case (d) above).

**Recovery lock acquisition (§4.9):** A recovery worker acquires level 0 **once** at the start of its pass (session-level — held across all subsequent transactions, Lemma E). For each transaction within the pass, it then acquires levels 1→2→3→4 in ascending order (R1). The hierarchy is never inverted: level 0 precedes level 1, and every transaction inside the pass follows the same ascending order.

**Which operations take which locks:**

| Operation | Class | Locks (canonical positions) | Notes |
|---|---|---|---|
| Upload Phase-1 (reserve) | Quota-affecting | 1 → 2 → 3 | Check-and-reserve ONLY: level-1 serializes the check-and-reserve; commits immediately (milliseconds). No filesystem mutation. (rev 17 — A8) |
| Upload Phase-2 chunk writes | (Domain R) | NONE (DB) — file `LOCK_SH` per chunk | **No DB locks held.** Protection is Domain R: durably active reservation + per-chunk `flock` handshake (§5.5). NOT a lock-order participant — it takes no position 0–9 locks. (rev 17 — A6/A8) |
| Upload Phase-2 commit | File-mutating | file `LOCK_SH` → 1 → 3 → 6 (+ reservation UPDATE, terminal) | Rename + asset INSERT + reservation→COMMITTED in ONE transaction. Level-1 required by the mandatory pre-insert protocol (§4.1: every filename insert holds level-1 for check-then-insert). World row (3) `FOR UPDATE` first so the INSERT's FK1 `FOR KEY SHARE` is self-held (E2). Reservation UPDATE is unpositioned/terminal (Lemma F). (rev 17 — A8) |
| Delete (asset) T1 | File-mutating | 1 → 2 → 3 → 6 → 9 | Scan + boundary commit; snapshot-ref check is a non-blocking SELECT under level-1 (rev 18 — B14: not a position-8 `FOR UPDATE`; level-1 exclusivity makes the read safe) |
| Delete (asset) T2 | File-mutating | 1 → 2 → 3 → 6 → 9 | Reacquire; re-verify (snapshot-ref check is a non-blocking SELECT under level-1, rev 18 — B14); unlink; finalize |
| Replacement T1 (upload new) | File-mutating | (Phase-1: 1 → 2 → 3; Phase-2 chunks: Domain R; Phase-2 commit: file `LOCK_SH` → 1 → 3 → 6) | Same as upload — the three sub-operations above (rev 17 — A8) |
| Replacement T2 (metadata switch) | Reference-changing + freeze | 1 → 3 → 6 → 9 | §4.2b contract; level 1 for backfill-freeze serialization |
| Metadata update (scene) | Reference-changing + freeze | 1 → 3 → 6 → 9 | §4.2b contract: 6 for EVERY URL validated/set (the asset-row lock must be held through commit — without it a concurrent delete could transition the asset to `pending_deletion` between validation and the metadata write); level 1 for freeze serialization (rev 17 — A9) |
| Metadata update (world) | Reference-changing + freeze | 1 → 3 → 6 | §4.2b contract; level 1 for freeze serialization |
| Publish | Reference-changing + freeze | 1 → 3 → 6 → 8 → 9 | Snapshot creation; snapshot-ref inserts (8); level 1 for freeze serialization |
| World deletion T1 | File-mutating | 1 → 2 → 3 → 6 → 8 | Shared-asset transfer + snapshot-protected move; ref-row decision locks at 8 (§4.9; rev 16 — B4.2/B4.3 R6) |
| World deletion T2 | File-mutating | 1 → 2 → 3 → 4 → 6 → 7 | Job row (4) first; lock-first ORDER BY for 6, 7 (R1, R2) |
| World deletion T3 (per file) | File-mutating | 1 → 2 → 3 → 4 → 6 | Job row (4) before asset row; unlink; skips transferred assets (R1) |
| World deletion T4 | File-mutating | 1 → 2 → 3 → 4 → 6 → 7 → 8 | Lock-first ORDER BY at 6, 7, 8 (R1, R2, R4; order corrected rev 18 — B10): asset rows, then unattributed rows, then explicit snapshot-ref delete |
| World deletion T5 | File-mutating | 1 → 2 → 3 → 4 → 6 | Explicit referencing-row deletes; cascade is safety net (R1, R3) |
| World deletion recovery | File-mutating | 0 (once, session) then 1 → 2 → 3 → 4 → 6 → 7 per txn | Lemma E; inner txns per R1 |
| Backfill completion | Freeze-serialized | 1 → 4 | Atomic verification + marking (§4.7b) |
| Conflict resolution | Freeze-serialized | 1 → 3 → 5 → 6 | Atomic resolution (§4.7c) |
| Reconciliation `diagnose` | Read-only | 1 | Scan only; never mutates rows or files |
| Reconciliation `repair` | File-mutating | 1 → 3 → 6 (row-mutating parts); 1 (scan/filesystem parts) | Operator-invoked; may set flags and move files (§9.4). Quarantine moves hold level-1 only; the roles-recompute row UPDATEs take 1 → 3 → 6 per the reference-changing class (rev 18 — B14). |
| Backfill classification insert | Freeze-serialized | 1 → 3 → (6 or 7) → 8 | Per-file insert txn (R7): world row (3) `FOR UPDATE` first (FK1 self-held); G2 single-owner check; G3 check — which MUST execute BEFORE the registry INSERT and BEFORE the transaction's first ref-row INSERT (rev 18 — B8: pinned order); then the registry (6) or unattributed (7) row INSERT; then ref-row INSERTs (8, ascending (filename, snapshot_id), rev 17 — A2) in the SAME transaction. G3 applies (new-file registration). (rev 17 — A10) |
| Backfill conflict-row insert | Freeze-serialized | 1 → 4 → 5 | Conflict-row INSERT txn (R7): run row (4) `FOR UPDATE` first (FK4 self-held); then the `backfill_conflicts` INSERT (5). (rev 17 — A10) |
| Drift resolution | Freeze-serialized | 1 → 3 → 5 → 8 | Operator resolution txn (§4.7c): level-1 serializes against publish and GC (both level-1 holders), so the snapshot set is stable for the re-scan; conflict row (5) before ref rows (8). See Lemma A case analysis. (rev 17 — A10/A14) |
| Attribution | Freeze-serialized | 1 → 3 → 7 → 6* | R5: world row (3) `FOR UPDATE` first (FK1 self-held); unattributed row (7) `FOR UPDATE`; cross-table check; INSERT (6); DELETE (7). G3 EXEMPT (identity-preserving transfer, rev 17 — A1). (rev 17 — A10) |
| Snapshot GC | Freeze-serialized | 1 → 8 | `DELETE FROM asset_snapshot_references WHERE snapshot_id = ?` in the SAME transaction as the snapshot-row delete. DORMANT in MVP per §5.4 (rev 17 — A4/A23): specified for completeness; no pruning job exists. (rev 17 — A10) |
| Expiry claim | (fenced) | file `LOCK_EX` → 1 → reservation UPDATE (terminal) | Claim txn: file lock FIRST (before any DB lock — file→DB in both parties), then level-1 (for the `is_maintenance_active()` check per the background-writer rule), then the terminal reservation UPDATE (unpositioned, Lemma F terminal). The file lock and level-1 are never held in the opposite order. Starvation analysis: the writer's `LOCK_SH` (per-chunk) and the claim's `LOCK_EX` are mutually exclusive — a writer cannot hold `LOCK_SH` while the claim holds `LOCK_EX`, so the "writer holds LOCK_SH and waits on level-1 while claim holds LOCK_EX" interleaving is impossible; the writer's commit `LOCK_SH` is acquired before level-1, and the claim's critical section (one UPDATE + COMMIT) is bounded. (rev 17 — A10/A15) |

\* **Attribution `6*` annotation (clarification):** the table shows statement order. The *blocking* acquisition sequence is 1 → 3 → 7, strictly ascending per E1 — the trailing 6 is the INSERT of a *new* row, non-blocking per Lemma A (creates no wait edge); the DELETE reuses the position-7 lock already held. There is no descending lock acquisition; E1's "strictly ascending" governs blocking acquisitions, and the INSERT is explicitly excluded from that class by definition.

**Per-world quota serialization (rev 18 — B11; replaces the stale "Quota reservation" paragraph):** the per-world quota advisory lock (level 2) is acquired in the upload Phase-1 transaction and held through its commit/rollback. No other quota-affecting operation for the same world can interleave during Phase 1 — the check-then-insert is atomic with respect to concurrent uploads, deletes, and world deletions on that world. (Terminology: "reservation" in this ADR always means the `storage_reservations` row, never the advisory-lock hold — §5.3, rev 17 — A7.)

**Global lock duration:** The global lock (level 1) is held for the minimum duration necessary — acquired at the start of the file-mutating transaction, released automatically on commit/rollback (transaction-scoped). It serializes uploads, deletes, world deletions, and reconciliation across all worlds.

**MVP throughput trade-off (rev 12, accepted):** A single global lock serializes ALL file-mutating operations across ALL worlds. This is an intentional correctness-over-throughput decision for the MVP, justified by:
- **Workload:** Asset operations are low-frequency authoring actions (uploads, deletes), not high-frequency reads. Expected throughput is <10 mutations/minute across all worlds.
- **Simplicity:** A single lock order is easier to verify than per-world sharding with cross-world operations (reconciliation, backfill).
- **Safety:** The failure mode of contention is latency (503 `LOCK_TIMEOUT` after 30s), not corruption.

**Operational impact:** p99 lock-wait time is the metric to watch (exposed via application metrics). **Redesign trigger:** If p99 lock-wait exceeds 5 seconds sustained over 1 hour, OR if `LOCK_TIMEOUT` 503s exceed 1% of mutation requests, the mitigation is to narrow the lock scope (e.g., per-world file-mutation locks + a separate reconciliation lock) — not to remove locking. This redesign requires an ADR amendment.

**Why most reference-changing operations take level 1 — the freeze exception (rev 15, B2 verification defect):** The rev-14 text claimed "a metadata update or publish validation holds only row locks" and the operations table omitted level 1 for them. That contradicts §4.7b's own completion-serialization proof, which requires EVERY writer that can invalidate the `attribution_input_hash` — metadata updates, publish, replacement T2, world-deletion T1 — to hold level 1 during its freeze check and mutation. Without level 1, a metadata commit could land between the completion transaction's hash recompute and its `complete` marker (both inside one level-1-holding transaction), and the run would complete on stale inputs. The table above is corrected: classification-input mutations are "Reference-changing + freeze" — they take level 1 for freeze serialization, not for filesystem exclusion (they remain non-file-mutating). The cost is bounded: these are low-frequency authoring actions (<10/min), covered by the same MVP contention rationale as file mutations. The deadlock argument is unaffected: all participants still acquire in ascending canonical order, so the wait graph remains acyclic. Pure row-lock reference validation with no classification-input mutation (none in the current operation set — every metadata write is a potential hash input) would not need level 1; the class is retained for that future case.

### 4.3d Filesystem-exclusion invariant (global)

**Invariant (rev 17 — A6):** No filesystem mutation — write, rename, unlink, quarantine move, restore copy, or upload-compensation cleanup — may occur except under one of two protection domains. It is not sufficient to have held the lock in a preceding transaction: the protection must be active *during* the filesystem operation itself.

- **Domain L (lock-protected):** the performing session holds the global media advisory lock (level 1) **in the same transaction/session that performs the syscall.** This covers every filesystem mutation EXCEPT reservation-protected Phase-2 temp writes: the upload final rename (in the commit transaction), upload compensation, delete-T2 unlinks, world-deletion T3 unlinks, recovery unlinks, `repair` quarantine moves, and restore copies (operator procedure under the maintenance fence).
- **Domain R (reservation-protected):** the mutation is a Phase-2 temp-file chunk write performed under a durably active reservation (§5.5). NO level-1 is held during chunk writes — it cannot be, as writes may take minutes. The protection is instead: (1) the committed `storage_reservations` row, visible to all competitors BEFORE the first byte is written (capacity accounting + file identity); (2) the deterministic temp path `/data/media/.tmp/{reservation_id}.part` — one writer per reservation, so no two writers can address the same path; (3) the `flock` handshake (§5.5 B1.2) — write-vs-claim exclusion on that path.

**Why Domain R is sufficient (the properties Domain L provides, restated):**
- *Mutator exclusion:* temp paths are unique per `reservation_id`; only the owning writer holds the fd. Two writers cannot write the same path — there is no shared file to contend over, so no lock is needed for writer↔writer exclusion.
- *Scan exclusion:* `diagnose` and the periodic scan treat `.tmp/` paths with active reservations as the expected temp set — they never mutate them (the orphan path only touches files with NO reservation row, §5.5).
- *Capacity protection:* the durable reservation (`active_reservations_bytes`), committed before the first byte hits disk — this is the rev-13 correction: durable state, not lock duration, protects capacity during long writes.
- *Crash safety:* the reservation row survives process crashes; the §5.5 claim protocol converges every terminal state. A crashed writer's lock is released by the kernel; its bytes remain accounted.

The pre-rev-17 invariant text ("no filesystem mutation except while holding level 1") was false as written: §5.5 has always specified that Phase-2 chunk writes do not hold level-1. The two-domain formulation above is the honest statement of the design that revs 13–16 actually specify. Domain R is not a weaker exception — it is a different, complete protection mechanism for the one operation class whose duration makes lock-holding infeasible.

| Operation | Filesystem mutation | Protection active during the syscall |
|---|---|---|
| Upload Phase-2 temp write (§5.5) | chunk writes to `/data/media/.tmp/{reservation_id}.part` | **Domain R (rev 17 — A6):** NO level-1 held. Protected by the durably active reservation row + the per-chunk `flock` handshake (validate+write inside `LOCK_SH`). One writer per deterministic path; capacity via `active_reservations_bytes` |
| Upload final rename (§4.4 steps 4–4b) | rename temp → final `{uuid}.{ext}`, dir fsync | **Domain L:** Level 1 held in the commit transaction during the syscall (commit txn lock set: §4.3c) |
| Upload compensation (row-insert failure, §4.4) | unlink of the orphan temp file | **Domain L:** **Same session** that performed the upload: the compensation runs before the transaction rolls back, while level 1 is still held. If the process crashed instead, no compensation runs in-process — the orphan is handled by §9.4 reconciliation (which itself holds level 1) |
| Delete T2 (§4.3b step 11) | unlink of the asset file | Level 1 reacquired at T2's `BEGIN`, held through T2's commit — the unlink happens inside T2 |
| World deletion T3 (§4.9) | per-file unlink | Level 1 acquired per file-transaction, held through that transaction's commit |
| World-deletion recovery (§4.9) | per-file unlink during recovery pass | Level 1 acquired in each recovery transaction (after the level-0 session lock, per the ordering); the session lock provides pass-exclusion, level 1 provides per-transaction filesystem exclusion |
| `repair` reconciliation (§9.4) | quarantine moves, (no unlinks — repair never unlinks) | Level 1 acquired at repair-transaction start, held through commit; the operator-invoked repair is a file-mutating operation and takes the full file-mutating lock set |
| Restore copy (§9.2) | file copies during volume restore | Operator procedure: restore runs with uploads frozen (503 `MIGRATION_IN_PROGRESS` or maintenance mode), which is equivalent to holding exclusion — no concurrent writer can exist |

**What the invariant rules out (rev 17 — A6):**
- A "fire-and-forget" background thread that unlinks files without acquiring level 1 — forbidden. Every Domain-L file mutation goes through a lock-holding transaction.
- A Phase-2 temp write performed WITHOUT a durably active reservation or outside the `flock` handshake — forbidden. Domain R's three elements (committed reservation row, deterministic path, per-chunk `LOCK_SH` validate+write) are all mandatory; a temp write missing any of them is a correctness bug, not a degraded mode.
- Reconciliation `diagnose` (read-only) performing any mutation — forbidden by definition; diagnose holds level 1 for scan exclusion but must not mutate (enforced by code review: the diagnose path has no filesystem-write calls).
- Operator repair scripts that bypass the application lock protocol — the repair entry point (§9.4) acquires level 1 before any file operation; ad-hoc shell commands against `/data/media/` are an operational violation, not a supported path.

**Filesystem mutation actor boundary (rev 13):** The level-1 lock provides exclusion *among application operations*. It does not — and cannot — exclude operator shell actions, which bypass PostgreSQL entirely. The design therefore defines two complementary exclusion mechanisms with an explicit boundary between them:

**Permitted actors for volume mutation:**
1. **The application server process**, via the protection protocol for the operation's domain (rev 17 — A6): Domain L — level 1 held during the syscall in the performing transaction (deletes (T2), world-deletion file removals, recovery unlinks, `repair` quarantine moves, upload final rename in the commit transaction); Domain R — durably active reservation + `flock` handshake (Phase-2 temp chunk writes ONLY). This covers: uploads, deletes (T2), world-deletion file removals, recovery unlinks, and `repair` quarantine moves.
2. **The operator**, ONLY through defined procedures that establish the durable maintenance fence (below). Each procedure MUST use the fence — no exceptions.

**Explicitly forbidden:**
- Ad-hoc shell writes (`cp`, `rsync`, `mv`, `vim`, `rm`) to `/data/media/` outside a defined procedure. These are operational violations, not a supported path.
- Cron jobs or background scripts writing to the volume.
- Any process mutating the volume while the application is serving traffic normally.

**Durable maintenance fence (rev 13 — B5):** Maintenance mode is not a runbook suggestion — it is a database-recorded, system-wide fence:

```sql
CREATE TABLE system_maintenance (
  id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  active       BOOLEAN NOT NULL DEFAULT false,
  reason       TEXT NOT NULL DEFAULT '',
  started_at   TIMESTAMPTZ,
  started_by   TEXT,  -- operator identity
  CONSTRAINT single_row CHECK (id = 1)
);
-- Exactly one row always exists. INSERTed at migration time; only UPDATEs thereafter.
```

**Fail-closed maintenance check (rev 15 — B5.1):** The rev-14 `COALESCE((SELECT active ...), true)` handles a missing ROW but not a missing TABLE — PostgreSQL raises `undefined_table` before `COALESCE` runs — and says nothing about query errors or incomplete migrations. The check is therefore defined as an application function with an explicit fail-closed contract, not as bare SQL:

```
function is_maintenance_active(): boolean
  -- Contract: returns TRUE when fenced OR when the fence state cannot be proven.
  -- Returns FALSE ONLY when the row provably exists AND active = false.
  -- NO caller may interpret an error, exception, or ambiguous result as "not in maintenance."
  try:
    row = SELECT active FROM system_maintenance WHERE id = 1
    if row is null:            -- table exists, row missing
      log at error (MAINTENANCE_ROW_MISSING)
      return true
    return row.active
  catch (any error):           -- undefined_table, connection failure, permission denied,
    log at error with the error -- serialization failure, statement timeout, ...
    return true                -- FAIL CLOSED
```

Behavior matrix:

| Condition | `is_maintenance_active()` | Mutating endpoints | Health |
|---|---|---|---|
| Row exists, `active = false` | `false` | Proceed normally | `healthy` |
| Row exists, `active = true` | `true` | **503** `MAINTENANCE_MODE` | `degraded` (maintenance) |
| Row missing (table exists) | `true` | **503** `MAINTENANCE_MODE` | `degraded`; critical alert `SYSTEM_MAINTENANCE_ROW_MISSING` |
| Table missing | `true` (caught `undefined_table`) | **503** `MAINTENANCE_MODE` | `degraded`; critical alert `SYSTEM_MAINTENANCE_TABLE_MISSING` |
| Any query error | `true` | **503** `MAINTENANCE_MODE` | `degraded`; error alert with the failure |
| Migration version below required | `true` (checked at startup) | **503** until migrations complete | `degraded` |

**Call sites:** every mutating transaction calls `is_maintenance_active()` immediately after acquiring the level-1 lock and before any other work; `true` → `ROLLBACK` + **503** `{code: "MAINTENANCE_MODE", retryable: true}`. This covers all filesystem-mutating endpoints, all metadata-mutating endpoints, the backfill worker, the periodic capacity job, and startup recovery. A writer that does not call it is a bug (new-writer checklist).

**Startup verification:** on startup, the server verifies (a) the `system_maintenance` table exists, (b) the singleton row exists, (c) the migration version is ≥ the version that created the table. Any failure → health `degraded`, all mutating endpoints 503 via the function contract above, critical alert. The server does NOT proceed to serve writes on a "best effort" basis.

**No ambiguous path:** there is no code path, fallback, cache, or default that interprets a check failure as "maintenance inactive." Startup and request-time behavior agree: both fail closed on any anomaly. The function's contract is reviewed as a security invariant — a change that inverts the default is a correctness bug, not a refactor.

**Single check path (rev 16 — B5.1):** `is_maintenance_active()` is the ONLY permitted way to read maintenance state. No writer path may issue a direct `SELECT active FROM system_maintenance` — code review rejects it. A direct SELECT reintroduces the exact bug this contract fixes (a bare query that fails open on `undefined_table` or a swallowed exception). The function exists so the fail-closed behavior has one implementation, one contract, one review target.

**No narrowing (rev 16 — B5.1):** the `catch (any error)` is intentionally broad. A future edit that catches only specific SQLSTATEs and lets others propagate — or converts an uncaught error into an inactive default — is a correctness bug, not a refactor. The contract to preserve: *any* failure to prove `active = false` returns `true`.

**Background writers use the same contract (rev 16 — B5.1 verification):** every background writer calls `is_maintenance_active()` before its mutating work, with no alternative path:
- Periodic capacity job (§5.5): checks before the filesystem scan and before any reservation-state transition or temp-file cleanup. A fenced result skips the cycle (log + retry next interval).
- Backfill worker (§4.7): checks before starting a run and before the completion transaction. Fenced → the run does not start / the completion aborts.
- Startup recovery (§9.4, §5.5): checks before any state repair. If fenced, recovery reports `degraded` and retries — it does not repair under a fence it cannot see.
- World-deletion recovery worker (§4.9): checks at pass start and before each per-file transaction (inside the level-1-holding section).
- Snapshot GC job (§5.4): checks before deleting snapshots and their `asset_snapshot_references` rows. (DORMANT in MVP per §5.4 — listed here for contract completeness; no pruning job exists.)
- Operator `repair` command (§9.4): requires the fence to be inactive, OR a valid recovery authorization held by this session (rev 19 — B3). Repair never silently bypasses the fence: under an active fence without authorization it refuses to start; under authorization it is confined to the recovery allowlist.

A background writer that skips the check is a bug under the new-writer checklist — whose item (3) now reads: "check the maintenance flag via `is_maintenance_active()` under level 1 before mutating."

**Invariant (rev 15 — B5.1):** No writer can mutate while maintenance is logically active OR while the fence state is unprovable — covering missing row, missing table, query errors, and incomplete migrations. Missing or erroneous state = active fence, at startup and at request time alike.

**Fence coverage:** EVERY application instance, background worker, scheduled task, and recovery process checks this flag. It is in the shared database — there is no instance-local maintenance state. The check is mandatory in:
- All filesystem-mutating endpoints (upload, delete T2, world deletion T3, repair)
- All metadata-mutating endpoints (scene/world updates, publish, world deletion T1)
- The backfill worker, the periodic capacity job, and startup recovery
- Any future writer (the check is part of the "new writer checklist" — a writer that does not check the flag is a bug)

**Race-free activation:** The operator activates maintenance via:
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1: serialize against all writers
UPDATE system_maintenance SET active = true, reason = ?, started_at = now(), started_by = ? WHERE id = 1;
-- Invalidate in-flight Phase-2 uploads ATOMICALLY with fence activation (rev 19 — B8,
-- state corrected rev 20): Phase-2 chunk writes hold no level-1 and their heartbeats
-- do not check the fence, so the fence alone cannot stop an already-running upload.
-- Invalidating the reservation is what stops it: the writer's next heartbeat UPDATE
-- affects 0 rows and its next chunk re-validation reads a non-active reservation →
-- both abort.
-- The target state is ABANDONED, not ROLLED_BACK (rev 20 — B8 end-to-end verification):
-- ROLLED_BACK promises "file confirmed absent" (the transition commits only after
-- stat confirms ENOENT), which activation cannot promise — the writer may be
-- mid-upload with bytes on disk. ABANDONED means "bytes may exist, conservatively
-- counted in abandoned_temp_bytes, periodic job will unlink and transition to
-- CLEANED" — exactly the invalidation situation. The claim-audit columns stay NULL
-- (permitted: they travel together or are both NULL); invalidation origin is
-- distinguished from expiry-claim origin by the activation log entry.
UPDATE storage_reservations
   SET state = 'ABANDONED', released_at = now()
 WHERE state IN ('RESERVED','WRITING');
-- Orphaned temp files from invalidated reservations are cleaned by the periodic
-- job via the normal ABANDONED path (§5.5 — the job selects WHERE state='ABANDONED';
-- no special cleanup needed).
COMMIT;
```
**Why invalidation, not drain-wait (rev 19 — B8):** a drain would wait for in-flight uploads to finish or time out — unbounded if a writer is stuck, and a stuck writer could hold the fence hostage. Invalidation is immediate and fail-closed: the upload aborts and the client retries after the fence lifts (503 `MAINTENANCE_MODE`, retryable). The cost (aborted in-flight uploads on fence activation) is accepted because fence activation is rare and operator-initiated.

**In-flight chunk bound (the B8 proof):** after the activation transaction commits, NO new chunk write can begin. Proof: every chunk iteration re-validates the reservation under `LOCK_SH` before `write()` (rev 16 — B1.2 writer obligations). Any iteration starting after activation reads `state = 'ABANDONED'` (or the heartbeat's 0-row update) and aborts BEFORE `write()`. The only bytes that can land post-activation are from a chunk whose `write()` syscall was already in flight when activation committed — bounded by a single chunk, after which the loop re-validates and aborts. Those bytes are conservatively counted: the row's `size_bytes` (the reserved maximum, ≥ actual bytes) sits in `abandoned_temp_bytes` from the activation commit — there is no instant where post-activation bytes are uncounted. Post-activation uploads cannot *keep writing*; at most one in-flight chunk completes.
Every writer's mutation transaction does (rev 19 — B7: the example MUST use the wrapper — a direct `SELECT active FROM system_maintenance` here would contradict the single-check-path rule that S55 enforces):
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1: first
-- Check INSIDE the locked section, via the ONLY permitted path:
-- is_maintenance_active() — never a direct SELECT (single-check-path rule).
IF is_maintenance_active() THEN
  ROLLBACK;  -- 503 {code: "MAINTENANCE_MODE", retryable: true}
END IF;
-- proceed with the mutation
... mutation ...
COMMIT;
```
**Why this is race-free:** Both the activation and every writer acquire level 1. They serialize. A writer that acquired level 1 *before* the operator's activation commits its mutation normally (it checked `active=false` while holding the lock — the operator could not have activated concurrently). A writer that attempts to acquire level 1 *after* activation blocks until activation commits, then sees `active=true` → 503. There is no interleaving where a writer passes the check and then mutates after the fence is up. The check-and-act is atomic with respect to activation because both hold the same exclusive lock.

**In-flight transactions at activation:** Transactions that already passed the check (holding level 1, mid-mutation) complete normally. The operator MUST wait for level-1 quiescence (no active holders) before beginning filesystem mutations. This is verified by: `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = hashtext('media_global')` returning 0, OR by the operator's activation transaction itself (it blocks until all level-1 holders release).

**Explicit release criteria (rev 13):** Maintenance mode may be lifted ONLY when ALL of the following hold (verified in order, all in a single operator verification transaction):
1. Reconciliation `diagnose` reports zero error-level findings.
2. If `diagnose` found warnings → `repair` has been run and reports zero error-level findings.
3. Single-owner invariant verified: `SELECT count(*) FROM world_media_assets w JOIN unattributed_media_files u ON w.filename = u.filename` returns 0.
4. No active `UNMANAGED_FILE_DETECTED` or `FILE_UNEXPECTEDLY_ABSENT` alerts.
5. No `backfill_runs` row with `state='in_progress'` (backfill and maintenance are mutually exclusive).
6. Operator explicitly executes: `UPDATE system_maintenance SET active = false WHERE id = 1` (in a level-1-holding transaction, symmetric with activation).

**Recovery authorization protocol (rev 19 — B3):** The fence rules create a circular dependency if read naively: `repair` must not bypass an active fence (§9.4), but the fence cannot be released until `repair` resolves the findings (criterion 2 above), and the §9.2 restore runbook needs both. The resolution is NOT to weaken the fence and NOT to lift it early — it is a separate, explicitly authorized **recovery-only protocol**. Normal writers and recovery writers are different principals with different permissions.

**What the fence still guarantees (unchanged):** `is_maintenance_active() = true` blocks ALL normal writers — application endpoints, background jobs (periodic capacity job, backfill worker, startup recovery, world-deletion recovery, expiry-claim worker), uploads, deletes, metadata writes. The fence is fail-closed and binary. Nothing below changes that.

**Recovery authorization (durable, auditable, exclusive):**
```sql
CREATE TABLE recovery_authorizations (
  authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT NOT NULL CHECK (scope IN ('repair','restore-reconcile')),
  authorized_by    TEXT NOT NULL,  -- operator identity (auditable)
  authorized_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '4 hours',
  revoked_at       TIMESTAMPTZ,    -- set on revocation; NULL = not revoked
  revoke_reason    TEXT CHECK (revoke_reason IN ('operator','expired','superseded')),
                   -- why the row left the unrevoked set (audit; NULL while unrevoked).
                   -- 'expired' is set by the establishment transaction's close-expired
                   -- step (rev 20 — B1); 'operator' by explicit revoke; 'superseded'
                   -- reserved for a future rotation protocol (unused in MVP).
);
-- At most one UNREVOKED authorization, by exclusion. The predicate MUST be
-- time-independent (rev 20 — B1): PostgreSQL requires index-predicate functions
-- to be immutable, and `now()` is not — the rev-19 predicate
-- `WHERE revoked_at IS NULL AND expires_at > now()` is REJECTED at CREATE INDEX
-- time, so the migration could not complete as written. Expiry is enforced by
-- the establishment transaction (close-expired step, below) and by
-- per-transaction revalidation — never by the index. Expired-but-unrevoked rows
-- are closed by the establishment transaction before a new authorization is
-- inserted, so expiry can never permanently block a replacement.
CREATE UNIQUE INDEX one_unrevoked_recovery_auth
  ON recovery_authorizations ((1))
  WHERE revoked_at IS NULL;
```

**Establishment protocol (in order — every step required):**
1. **Fence active:** `is_maintenance_active()` must return true. A recovery authorization cannot be created while the fence is inactive — rejected outright (nothing to recover from; use normal paths).
2. **Operator authorization — the establishment transaction (rev 20 — B1):** the operator establishes the authorization with ONE transaction, holding level-1 for its whole duration (canonical order — establishments serialize against each other and against all Domain-L writers):
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1: serialize establishments
-- (a) Fence must be active (step 1) — else reject outright.
-- (b) Close expired authorizations FIRST: expiry is a terminal transition, never a block.
--     An expired-but-unrevoked row must never permanently occupy the single slot.
UPDATE recovery_authorizations
   SET revoked_at = now(), revoke_reason = 'expired'
 WHERE revoked_at IS NULL AND expires_at <= now();
-- (c) Exclusivity: any row still unrevoked after (b) is LIVE (not expired).
--     If one exists, another operator holds it → reject; do NOT insert.
-- (d) Insert the new authorization (auditable: who, when, why, scope).
INSERT INTO recovery_authorizations (scope, authorized_by, reason)
SELECT ?, ?, ?
 WHERE NOT EXISTS (SELECT 1 FROM recovery_authorizations WHERE revoked_at IS NULL);
-- Zero rows inserted → a live authorization exists → raise RECOVERY_AUTH_CONFLICT.
COMMIT;
```
   **Concurrency:** two operators racing serialize on level-1. The loser's INSERT matches zero rows (the `WHERE NOT EXISTS` guard) — or, without the guard, hits the unique index — and the procedure raises an explicit `RECOVERY_AUTH_CONFLICT` error (retryable=false; the winner's `authorization_id` is returned in the error detail so the operators can coordinate). There is no interleaving in which two live authorizations exist: the index is the backstop, the guard is the fast path, level-1 is the serializer.
   **Crash recovery:** (b) and (d) are ONE transaction. Crash before COMMIT → everything rolls back → the expired row is still expired-but-unrevoked → the next establishment re-runs (b) and proceeds. Crash after COMMIT → the new row is live and durable; the crashed operator's retry sees it as live → conflict → the operator either resumes under that same live authorization (it is theirs and unexpired) or explicitly revokes it (`revoke_reason='operator'`, `authorized_by` match required) and re-establishes. No outcome wedges the protocol: every crash point has a defined next step, and the 4-hour expiry bounds the worst case (see below).
   **Expiry never blocks replacement:** because (b) runs inside EVERY establishment, an expired row can never permanently occupy the slot. A replacement authorization is always obtainable after expiry — no operator action on the old row is required.
   **The 4-hour default is fixed, not configurable (rev 20):** making it configurable would require specifying the configuration surface and its security implications (who may change it, permitted bounds, audit of changes) — that specification does not exist, so the value is fixed. Safety does not come from the duration; it comes from the per-transaction revalidation contract (step 4).
3. **Writer-exclusion verification (the proof, not a flag):** before any recovery mutation, the operator verifies ALL of:
   a. **Level-1 quiescence:** `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = hashtext('media_global')` returns 0 — no in-flight Domain-L mutation.
   b. **No active reservations:** `SELECT count(*) FROM storage_reservations WHERE state IN ('RESERVED','WRITING')` returns 0. This holds after fence activation because activation atomically invalidates all active reservations (rev 19 — B8); and no new reservation can be created while the fence is active (Phase-1 checks the fence under level-1 before inserting).
   c. **No application sessions:** role-filtered `pg_stat_activity` shows no application-role sessions (rev 15 — B5.2 procedure).
   
   If any check fails → do NOT proceed; investigate. The authorization row alone authorizes nothing.
4. **Recovery session — the authorization-lifetime contract (rev 20 — B2):** the operator's recovery session runs on an admin connection (never the application pool). EVERY mutating transaction in the session follows this exact shape:
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1 first (canonical order)
-- BEGIN-gate: exactly one live authorization must exist.
-- clock_timestamp() = TRUE current wall-clock time (rev 21 — the finding).
-- At transaction start it coincides with now(); it is used at BOTH gates for
-- uniformity, so the BEGIN and pre-COMMIT checks evaluate the same predicate
-- against the true clock at their respective execution moments.
SELECT authorization_id INTO auth FROM recovery_authorizations
 WHERE revoked_at IS NULL AND expires_at > clock_timestamp();
-- Must return exactly one row; zero rows → ROLLBACK before any work
-- (the authorization expired, was revoked, or never existed).
... allowlisted work (step 5) ...
-- PRE-COMMIT gate: re-execute the identical assertion immediately before COMMIT.
-- now() would be WRONG here (rev 21): now() returns the transaction-START
-- timestamp and does NOT advance during the transaction, so a gate using now()
-- would evaluate expiry against the BEGIN timestamp and PASS even after the
-- authorization's real expiry time. clock_timestamp() advances with the clock.
SELECT authorization_id INTO auth2 FROM recovery_authorizations
 WHERE revoked_at IS NULL AND expires_at > clock_timestamp();
-- Zero rows → ROLLBACK. The DB mutation does not commit if the authorization is
-- not live when THIS gate executes (true current time), even if it was live at
-- BEGIN. Expiry between this gate and COMMIT is outside the enforceable boundary.
COMMIT;
```
   **Time semantics (rev 21 — the finding):** `now()` is the transaction-start timestamp — frozen for the whole transaction. `clock_timestamp()` is the actual current wall-clock time and advances as the transaction runs. The rev-20 gates used `now()` at both boundaries, so the BEGIN gate and the pre-COMMIT gate could evaluate expiry against the *same frozen timestamp*: an authorization live at BEGIN would still pass the pre-COMMIT check after its real expiry time. Both gates therefore use `clock_timestamp()` — each gate evaluates expiry against the true clock at the moment it executes.
   **Authorization boundary — exact definition (rev 21):** *"Authorization must be valid at the moment the pre-COMMIT gate executes (evaluated with `clock_timestamp()`). The gate is the final statement before `COMMIT`; no recovery work executes between the gate and the commit."* This is the weaker, enforceable boundary the protocol guarantees. The stronger guarantee — "the COMMIT itself lands before `expires_at`" — is explicitly NOT claimed: a timestamp check immediately before COMMIT cannot prove when the commit will be applied (WAL flush, lock waits, and scheduling are outside the gate's control). A future revision must not reintroduce the stronger claim without a protocol that genuinely enforces it.
   **Lemma — revocation cannot race the pre-COMMIT gate (rev 21):** the recovery transaction holds level-1 continuously from its BEGIN gate through `COMMIT` (`pg_advisory_xact_lock` is transaction-scoped; nothing releases it early). Revocation of a recovery authorization (step 7) requires acquiring level-1 in canonical order. An exclusive advisory lock has exactly one holder at a time: a revocation attempted while a recovery transaction holds level-1 BLOCKS until that transaction commits or rolls back. Therefore no revocation can execute in the window between the pre-COMMIT gate (the final statement before COMMIT) and COMMIT. A revocation that blocks applies to the *next* recovery transaction — whose BEGIN-gate then fails — never mid-flight. Expiry is time-based, not an action: it cannot be serialized by locking, and is governed by the boundary definition above, evaluated against the true current clock.
   The `authorization_id` is logged with every mutation (audit trail).
   **What the contract does NOT claim (rev 20 — B2 correction):** the rev-19 sentence "if the authorization expires mid-procedure, the in-flight transaction rolls back" is WITHDRAWN as unenforceable. PostgreSQL does not roll back a transaction because a timestamp passed, and a database ROLLBACK cannot undo a filesystem rename/unlink already performed. The protocol claims no such mechanism. What it guarantees instead is bounded by the two gates:
   - **No new work begins after expiry:** the BEGIN-gate rejects any transaction whose authorization is not live at start.
   - **A DB mutation commits only if the authorization was valid at the pre-COMMIT gate (rev 22 — boundary wording):** the gate evaluates `expires_at > clock_timestamp()` (true current time, rev 21) as the final statement before COMMIT, and rejects the commit when expiry fell between BEGIN and the gate. The absolute phrasing "no DB mutation commits after expiry" is WITHDRAWN as stronger than the enforceable boundary: an authorization that was valid at the gate may expire in the microseconds before COMMIT is applied, and that commit still lands. The guarantee is exactly "valid at the moment the pre-COMMIT gate executes" — see the definition above; the stronger "commit lands before expiry" is explicitly declined.
   - **Filesystem effects need no rollback because they are idempotent by construction (step 6):** quarantine moves are path-conditional (a file already in `.quarantine/` is a no-op on retry); temp-cleanup unlinks are ENOENT-tolerant; row updates are state-conditional (`WHERE state = ...`); scans are re-runnable. A transaction aborted at the pre-COMMIT gate leaves only filesystem effects that the next run treats as already-done. There is no filesystem effect in the allowlist whose partial application is unrecoverable — this is a property of the allowlist's closed set, not a hope about timing.
   - **The fence never lifted during the window:** the fence was active before establishment (step 1) and stays active through revocation (step 7). Every normal writer was excluded for the entire session. An "unprotected filesystem mutation" would require a mutator no principal is accountable for — every recovery mutation is logged with its `authorization_id`, performed while the session held a live authorization at BEGIN, and DB-gated at COMMIT. No conflicting writer could have observed or depended on partial recovery state, because no conflicting writer could run.
   **Crash/retry:** after a crash mid-repair, the operator re-establishes per step 2 (close-expired + insert, or resumes under the still-live row — the row survives the crash; it is a separate committed row) and resumes from durable state. No step assumes the previous authorization or the previous attempt's progress: each recovery transaction re-derives its work from current DB/filesystem state.
   **Invariant (rev 20 — B2; boundary precision rev 21; wording rev 22):** *Authorization expiry never creates an unprotected filesystem mutation or an inconsistent recovery state.* Proof: expiry takes effect only at a transaction boundary (BEGIN-gate or pre-COMMIT gate, both evaluated with `clock_timestamp()`). Within a transaction: (i) the fence excludes all normal writers for the whole window; (ii) every filesystem effect is idempotent/resumable by the allowlist's construction; (iii) no DB change commits unless the authorization was live at the pre-COMMIT gate — the final statement before COMMIT, with revocation provably unable to interleave (Lemma, rev 21). After expiry, the session can begin nothing (BEGIN-gate rejects) and pass no further pre-COMMIT gate (a gate executed after expiry finds zero live rows) — the absolute phrasing "after expiry the session can commit nothing" is WITHDRAWN as stronger than the boundary: a commit whose gate executed while the authorization was live still lands even if expiry falls before COMMIT is applied. The next session resumes idempotently under a fresh (or still-live) authorization. The DB and filesystem converge because the filesystem operations are defined to be safely repeatable — they do not need the DB to agree first. **Proving scenarios:** S60 (expiry-mid-procedure boundary), S62 (abort-then-resume convergence), S63 (true-clock gate + revocation race).
5. **Permitted operations (allowlist — closed set):** `diagnose` needs no authorization (read-only). Under authorization, the session may ONLY perform: quarantine moves of zero-reference orphans; abandoned-temp cleanup for `ABANDONED`/`ROLLED_BACK` reservation rows; `file_confirmed_present = false` updates with data-loss alerts; `pending_deletion` finalization after a fresh conclusive zero-reference scan; `roles` recompute from draft metadata; `unattributed_media_files` row creation for referenced orphans. It may NOT: serve user traffic, accept uploads, perform user-initiated deletes, write draft metadata, publish, run backfill, or lift the fence. An operation outside the allowlist is a spec violation even under authorization.
6. **Failure behavior:** every allowlisted operation is idempotent and restartable (quarantine moves are path-conditional; temp-cleanup unlinks are ENOENT-tolerant; row updates are state-conditional; scans are re-runnable) — this idempotency is load-bearing for the B2 lifetime contract (step 4), not incidental. If repair fails: the failing transaction rolls back (or is blocked at the pre-COMMIT gate), the fence STAYS active, health stays `degraded`. The operator investigates and then EITHER resumes under the still-live authorization (the row survives a session crash — it is a separate committed row) OR revokes it (`revoke_reason='operator'`) and establishes a new one per step 2 to retry. A "new authorization" is NOT established while the old one is still live — the unique index forbids it (step 2). Normal writes NEVER reopen as a side effect of repair failure.
7. **Revocation and release (rev 21 — revocation holds level-1):** after repair reports zero error-level findings, the operator revokes the authorization in a level-1-holding transaction (canonical order — this is load-bearing for the Lemma in step 4):
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level 1: revocation serializes
UPDATE recovery_authorizations
   SET revoked_at = clock_timestamp(), revoke_reason = 'operator'
 WHERE authorization_id = ? AND revoked_at IS NULL;
COMMIT;
```
then verifies the release criteria below (criterion 2 now references this protocol), then lifts the fence. The fence is never lifted while an unrevoked, unexpired authorization exists (checked in the same verification transaction as the release criteria). Because revocation requires level-1, it can never interleave between a recovery transaction's pre-COMMIT gate and its COMMIT (Lemma, step 4): a revocation attempted mid-session blocks and applies to the next transaction.

**Why this is not "a second flag" (the B3 proof obligation):** the authorization row alone authorizes nothing — steps 3 (exclusion proof), 4 (per-transaction assertion + allowlist), and 7 (revocation before release) are what make it safe. A bare flag without the verification would be exactly the hole B3 warns about. Proof that no conflicting writer can mutate the same state under this protocol:
- *Normal writers:* blocked by the unchanged fail-closed fence — they cannot start, period.
- *In-flight Domain-L writers:* excluded by 3(a) — none holds level-1 when recovery begins, and none can acquire it afterwards (their fence check under level-1 fails).
- *In-flight Domain-R writers:* excluded by 3(b) — no active reservation exists after fence activation (B8 invalidation is atomic with activation), and Phase-1 cannot create one under fence. Additionally, recovery's file mutations never address a path that could have a live reservation row: temp cleanup only touches `ABANDONED`/`ROLLED_BACK` rows; quarantine moves only touch files with NO reservation row (a live writer's file always has one in `RESERVED`/`WRITING`).
- *World-deletion recovery:* NOT in the allowlist and never runs under fence (background-writer rule unchanged — it waits for fence release). Its level-0 session lock is orthogonal and untouched by this protocol.
- *A second recovery session:* impossible — the partial unique index permits exactly one unrevoked authorization, the establishment transaction admits only one live (unrevoked, unexpired) row, and every recovery transaction re-asserts liveness under level-1 at BEGIN and pre-COMMIT (step 4). Two operators cannot hold it concurrently.

**Release criterion 2 (revised, rev 19 — B3):** criterion 2 now reads: "If `diagnose` found warnings → `repair` has been run **under a valid recovery authorization** (or during normal operation with the fence inactive, for non-fence repairs) and reports zero error-level findings." The circular dependency is resolved: repair no longer needs the fence lifted; it runs under recovery authorization while the fence stays active.

**Deletion enforcement resumption:** While `active=true`, ALL `DELETE` endpoints (asset delete, world delete) return 503 `{code: "MAINTENANCE_MODE"}`. Deletion enforcement resumes ONLY after the flag is cleared per the criteria above. There is no partial resumption — the fence is binary.

**Warning-level findings:** `UNMANAGED_FILE_DETECTED` (warning) BLOCKS maintenance release (criterion 4). A warning does not disappear because it was noticed — it requires disposition: either the file is classified (gets a row via backfill or manual attribution) or removed. Until then, the fence stays up. Warnings are not "informational" — they are release blockers.

**Out-of-band mutation detection:** The periodic capacity job (§5.5) performs a filesystem scan on every run. It compares the on-disk file set against the expected set (registry + unattributed + quarantine + staging):
- File on disk with no row in either table and not in the expected temp set → alert `UNMANAGED_FILE_DETECTED` (warning) with filename and size. The file is counted in `unregistered_bytes` (not ignored).
- Expected file (has a row with `file_confirmed_present=true`) absent from disk → alert `FILE_UNEXPECTEDLY_ABSENT` (error) with `asset_id`.
- While either alert is active and unresolved, **deletion enforcement is suspended**: `DELETE` endpoints return 503 `{code: "RECONCILIATION_PENDING", retryable: true}`. The system fails closed — it will not make deletion decisions while the filesystem state is uncertain.

**Lock scope clarification (rev 17 — A6):** The global level-1 lock guarantees: "No two *Domain-L application* filesystem mutations overlap, and no Domain-L application mutation overlaps a *diagnose* scan." Phase-2 temp writes (Domain R) are excluded from this guarantee by design — they CAN overlap with each other in time (two uploads writing concurrently), but they cannot overlap *on the same file*: deterministic paths are unique per reservation, and the `flock` handshake excludes the expiry claim. Domain R needs no writer↔writer exclusion because there is no shared path to contend over. Level-1 does NOT guarantee: "No operator action overlaps an application operation." That second guarantee comes from the durable maintenance fence (all writers check the flag under level 1; Phase-2 writers check it in Phase 1 and abort on 0-row heartbeats). The runbook MUST ensure these mechanisms never overlap — i.e., never run an operator volume procedure without activating the fence, and never clear the fence while a procedure is in progress. The two exclusion domains (L and R) plus the fence are complementary, not overlapping.

**Multi-transaction passes (rev 11):** world deletion (T1–T5) and world-deletion recovery are multi-transaction passes. Because transaction-scoped advisory locks release at each commit, **each transaction in the pass independently re-acquires the level-1 lock** — the pass as a whole holds no filesystem-exclusion lock across its commit boundaries, and none is claimed. What the pass *does* hold across boundaries is durable state (the `world_deletion_jobs` row; the `pending_deletion` lifecycle) plus, for recovery only, the session-level level-0 pass-exclusion lock. Per-transaction lock ownership for every step is documented in §4.9 ("Per-transaction lock ownership" and "Recovery-pass lock ownership"). The rule is uniform for Domain-L operations (rev 18 — B3): the transaction that performs the syscall holds level 1 during the syscall — whether that transaction is a single request (upload final rename, T2) or one step of a pass (T3 per-file, recovery unlink). (Domain-R Phase-2 chunk writes are not covered by this rule — their protection is the durably active reservation + the per-chunk `flock` handshake, §5.5.)

**Contention test (S26):** repair, world deletion, asset deletion, and upload-compensation cleanup contend for the same storage. The test asserts that every observed filesystem mutation (via filesystem audit log or instrumented syscalls) occurred while the mutating session held level 1, and that no two mutations overlapped.

**Complete mutation-path verification (rev 14):** Every filesystem-mutating path in this ADR is enumerated here with its serialization binding. If a path is not in this list, it is not authorized to mutate the filesystem:

| # | Path | Filesystem mutation | Serialization binding | ADR section |
|---|---|---|---|---|
| 1 | Upload temp write (Phase-2 chunks) | temp file write to `/data/media/.tmp/` | Domain R (rev 18 — B1): NO level-1 held. Protected by the durably active reservation row + the per-chunk `flock` handshake (validate+write inside `LOCK_SH`) (§5.5) | §4.4, §5.5 |
| 2 | Upload final rename | rename temp → final path | Level-1 held in the commit transaction during the syscall | §4.4 |
| 3 | Upload compensation | unlink of orphan temp file | Same session, before rollback, level-1 still held; else §9.4 reconciliation | §4.4 |
| 4 | Replacement T1 | new file write (via upload path) | Temp write: Domain R as #1 (no level-1); final rename: level-1 held in the commit transaction as #2 | §4.3a |
| 5 | Asset deletion T2 | unlink of asset file | Level-1 reacquired at T2 BEGIN, held through commit | §4.3b |
| 6 | World deletion T3 | per-file unlink | Level-1 per file-transaction | §4.9 |
| 7 | World-deletion recovery | per-file unlink | Level-1 per recovery transaction (after level-0) | §4.9 |
| 8 | Repair quarantine | file move to `.quarantine/` | Level-1 at repair-transaction start, held through commit | §9.4 |
| 9 | Repair temp cleanup | unlink of abandoned temp file | Level-1 held during the cleanup transaction | §5.5, §9.4 |
| 10 | Restore volume copy | file copies during restore | Durable maintenance fence + external process stop (NOT level-1 — operator procedure) | §9.2 |
| 11 | Backfill | NONE (row inserts only, no filesystem writes) | Level-1 for serialization of classification (not filesystem exclusion) | §4.7 |
| 12 | Attribution (unattributed→registry) | NONE (row DELETE + INSERT, no file move) | Level-1 for check-and-write serialization (B3) | §4.7 |
| 13 | Publish snapshot-ref inserts | NONE (row inserts into `asset_snapshot_references`) | Level-1 (freeze serialization) → 3 → 6 → 8; same transaction as snapshot creation | §4.2, §4.7c |

**Paths 11–13 are explicitly NOT filesystem mutations** — they are included to prevent misreading. If a future change adds filesystem writes to backfill, attribution, or publish, it must be added to this table with a level-1 binding.

**New-writer checklist (normative):** Any new code path that mutates the filesystem MUST: (1) be added to this table (filesystem-mutating paths) or the §4.3c table (row-only paths) (rev 17 — A11), (2) hold the protection for its domain during the syscall — Domain L: acquire level-1 in the performing transaction during the syscall; Domain R (Phase-2 temp writes ONLY): hold a durably active reservation and execute every chunk inside the `flock` handshake; operator procedures: use the maintenance fence, (3) check the maintenance flag via `is_maintenance_active()` (never a direct SELECT) under level-1 before mutating — Phase-2 writers check in Phase 1, abort on 0-row heartbeats, and are invalidated atomically if the fence activates mid-upload (rev 16 — B5.1; rev 19 — B8), (4) have a corresponding scenario in §6. A writer that does not meet all four is a bug.

### 4.4 Failure atomicity (upload path)

**Upload sequence:** (1) validate → (2) write file to temp name → (3) `fsync` file → (4) rename to final `{uuid}.{ext}` → (4b) `fsync` the **directory** file descriptor (on Linux, required for rename durability) → (5) INSERT asset row → (6) commit. Quota check happens inside a transaction with the per-world advisory lock (§5.3) *before* step 2.

| Failure point | Compensation |
|---|---|
| Crash between file rename (4b) and row insert (5) | Orphan file, no row. §9.4 reconciliation: quarantine, never auto-delete. |
| Crash after row INSERT (5) but before COMMIT (6) | Transaction rolls back; row never visible. File remains as orphan (same handling). |
| Row insert (5) fails (application error, not crash) | Delete the file synchronously, return 500. Log for §9.4 cross-check. |
| Crash between row commit (6) and HTTP response | Row + file consistent. Client retries; duplicate upload is harmless (new UUID). |

### 4.5 Serving-layer behavior

**Registry-gated serving:** `GET /media/{filename}` checks the registries before serving:

1. Look up the URL in `world_media_assets`. If found:
   - `lifecycle = 'active'` AND `file_confirmed_present = true` → check shared-asset authorization (below); if authorized → serve the file.
   - `lifecycle = 'pending_deletion'` → **404** (file may still exist on disk during removal; must not be served).
   - `file_confirmed_present = false` → **404** (data loss; file is gone).
2. Else look up the URL in `unattributed_media_files` (§4.7). If found, determine the request context — `protected` gates **deletion**, never serving; serving is gated by context authorization (rev 16 — B4.2):
   - **Snapshot context** (the request presents a `snapshot_id`, e.g. reading a published version): authorized iff (i) the snapshot row exists and the requester is entitled to it, and (ii) `EXISTS (SELECT 1 FROM asset_snapshot_references WHERE filename = :filename AND snapshot_id = :snapshot_id)` — the fast path; ground truth on drift is the snapshot's `canon_data` containing the URL (§4.2 contract). Authorization is validated against the **snapshot row's persisted published state**, not the world row: the snapshot's world may have been deleted, and the snapshot row persists per §5.4 precisely so published canon stays servable. If the world row still exists, its access policy applies as today; if it is gone, the snapshot row's state is authoritative. Authorized → serve. Otherwise → **404**.
     - **Unresolved `missing_row` drift (rev 17 — A24):** if (ii) fails BUT an unresolved `snapshot_ref_drift`/`missing_row` conflict exists for the filename whose expected snapshot-id set includes `:snapshot_id` → SERVE (do not 404). Rationale: the conflict already blocks deletion fail-closed (§4.7c), so the file is protected; refusing to serve a published snapshot's asset during the drift window would break published reads for a condition the design otherwise tolerates (the drift is a bookkeeping lag, not a content change — the snapshot's `canon_data` still contains the URL). Serving is the fail-*safe* direction for reads; blocking deletion is the fail-safe direction for writes. The two are consistent: reads follow ground truth (snapshot content), writes follow the protection table + open conflicts. Once the operator resolves the drift (row re-inserted), the fast path (ii) applies again.
     - **Unresolved `stale_row` drift:** the stale row still exists in the table → (ii) passes → serve normally. No special case needed (over-protection is the safe default).
   - **Draft context** (live world read/authoring): → **404**. The file has no registry row, so it is not a live asset of any world; §4.2b rejects new draft references to unattributed files (`ASSET_UNKNOWN`). A draft-context hit is a stale reference or a guess. (A snapshot reference never confers draft-context rights — §4.7c(d)(3), unchanged.)
   - **No context** (bare `GET /media/{filename}`): legacy grace-period rule unchanged — served before backfill completes; genuine 404 after.
3. Else → **404**.

**Shared-asset authorization (rev 15 — B4.1a):** when the row's `shared_with_worlds` is non-empty, the request's world context determines authorization:
- The request is authorized iff the context world = the row's `world_id` (owner) OR ∈ `shared_with_worlds` (read from the current row; a concurrent membership removal takes effect on the next request).
- Authorization is validated against the CONTEXT WORLD's access policy (published? reader entitled?), not the owner's. A World B reader's access to the shared file follows World B's rules.
- The grant is per-file, per-request. A World B reader authorized for the shared file gains no access to World A's other assets; requesting a non-shared file under a foreign context → **404** (existence not leaked via 403).
- Context world neither owner nor shared → **404**.

Before backfill completes (§4.7), step 1's "no row" case serves normally (legacy grace period). After backfill, an unregistered URL is a genuine 404 — every legitimate file has a row in one of the two tables.

### 4.6 What changes vs. what stays

**Changes (new work):**
1. New `world_media_assets` table + repository (Level 3: migration). Includes `lifecycle` and `file_confirmed_present` columns.
2. New `unattributed_media_files` table for legacy backfill inventory (§4.7).
3. New `backfill_runs` table for the durable backfill completion gate, plus `backfill_conflicts` table for rerun classification disagreements (§4.7).
4. New `world_deletion_jobs` table for resumable world deletion (§4.9).
5. `POST /worlds/:id/media` inserts registry row; enforces size/quota server-side; acquires locks per §4.3c.
6. New `DELETE /worlds/:id/media/:assetId` endpoint implementing the §4.3b state machine.
7. Serving layer: registry check before file serve (404 for non-active/non-present assets; serves unattributed legacy files).
8. Reference-validation contract (§4.2b) enforced on all metadata updates and publish.
9. Fly volume mount for `/data/media` (ops change, not code).
10. Legacy backfill job with durable run record (§4.7).

**Stays the same:**
- URL scheme (`/media/{uuid}.{ext}`) — immutable object keys by construction (never overwrite).
- Reference mechanism (metadata URLs) — no canon schema migration.
- Reader path — reads from snapshot, unchanged.
- Narration storage — separate system, unaffected.
- Publish flow — no change (snapshots already capture URLs); publish now also validates that referenced assets are `active` (§4.2).

### 4.7 Legacy backfill policy

Existing `/data/media/` files predate the registry. Without backfill, the reference scanner cannot associate existing URLs with asset records, deletion blocking won't protect them, and quota reporting will be incomplete.

**Unattributed-files table** (new — separate from the main registry):

```sql
CREATE TABLE unattributed_media_files (
  file_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename           TEXT NOT NULL UNIQUE,   -- storage filename ({uuid}.{ext})
  url                TEXT NOT NULL,          -- /media/{filename}
  size_bytes         BIGINT,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_world_id   UUID REFERENCES worlds(world_id),  -- NULL until attributed
  referencing_worlds UUID[] NOT NULL DEFAULT '{}',      -- worlds whose drafts/snapshots contain this URL
  protected          BOOLEAN NOT NULL DEFAULT true,      -- true = deletion endpoint refuses
  -- Enforcement-gate status (see below): every discovered file must reach a
  -- terminal state before lifecycle enforcement is enabled.
  classification_status TEXT NOT NULL DEFAULT 'pending_review'
                         CHECK (classification_status IN ('pending_review','reviewed','classified')),
  notes              TEXT,
  -- Which backfill run created this row (rev 19 — B4). NULL for rows created
  -- outside backfill (should not occur in practice; backfill owns this table).
  backfill_run_id UUID REFERENCES backfill_runs(run_id)
);
CREATE INDEX ON unattributed_media_files (backfill_run_id) WHERE backfill_run_id IS NOT NULL;
```

**Why a separate table:** `world_media_assets.world_id` is `NOT NULL` — an unmatchable file cannot satisfy the ownership constraint. Weakening the main registry's ownership constraint to accommodate orphans would silently corrupt deletion and reference-scan behavior (a `NULL`-world row would be invisible to per-world scans). The separate table keeps the main registry's invariants strict while giving orphans a first-class, protected home.

**Backfill procedure** (run once at deployment, before the new lifecycle endpoints go live):

1. Scan `/data/media/` for all files (excluding `.quarantine/`).
2. For each file, search existing draft metadata (`scenes.metadata.illustrationUrl`, `world.metadata.coverArtUrl`) and all canon snapshots for matching URLs. Record every world whose draft or snapshot contains the URL in `referencing_worlds`.
3. If matched to exactly one world: determine `mimetype` and `roles` per the policy below, then create a `world_media_assets` row with the resolved `world_id`, `lifecycle='active'`, `file_confirmed_present=true`.
4. If matched to a snapshot's world but no draft: same, using the snapshot's `world_id`.
5. If matched to **more than one world**, or to no world at all: create an `unattributed_media_files` row with `protected=true`, `referencing_worlds` populated, `matched_world_id=NULL`. **Never silently assign a shared reference to one world.** Attribution requires explicit operator resolution (or a future matching pass with a documented disambiguation rule).
6. **Snapshot-reference population (rev 17 — A2):** for EVERY snapshot reference discovered in step 2 (each `(filename, snapshot_id, world_id)` triple where the file's URL appears in a retained snapshot's `canon_data`), INSERT the corresponding `asset_snapshot_references` row **in the same transaction as the registry/unattributed row insert** (steps 3–5). The population is not deferred and not a separate pass: the transaction that creates the file's row also creates its protection rows, so the re-verification cross-check (§4.7c step 2) never observes a half-populated state. **Pinned SQL sequence (rev 18 — B8):** the intra-transaction statement order is NORMATIVE, not advisory:
   ```sql
   BEGIN;
   SELECT pg_advisory_xact_lock(hashtext('media_global'));                    -- 1
   SELECT ... FROM worlds WHERE world_id = ? FOR UPDATE;                      -- 3 (R7: FK1 self-held)
   -- G2: single-owner pre-insert check ("filename absent from the other table")
   -- G3: SELECT 1 FROM asset_snapshot_references WHERE filename = ?;
   --     If found → abort, 500 STALE_SNAPSHOT_REF_RESURRECTION. G3 MUST run here:
   --     BEFORE the registry INSERT and BEFORE the transaction's first ref-row INSERT.
   INSERT INTO world_media_assets ...;        -- 6 (or unattributed_media_files, 7)
   INSERT INTO asset_snapshot_references ...; -- 8, ascending (filename, snapshot_id)
   COMMIT;
   ```
   Rationale for the pin: the G3 pre-insert check queries `asset_snapshot_references` for the filename. A transaction sees its own writes — if ref rows were inserted before the G3 check, G3 would observe the transaction's own rows and false-fire with 500, making backfill unable to classify any snapshot-referenced legacy file. The pre-rev-18 text specified two different orders (§4.3c table vs S50); this sequence is the single authoritative order. Lock order for the combined insert: 1 → 3 → (6 or 7) → 8. (Ref-row INSERTs take no FK locks — `asset_snapshot_references` has no FK to either registry table or to snapshots, §4.1 — so the statement reorder does not affect the deadlock proof.) A file matched only to drafts (no snapshot references) inserts zero ref rows — the empty set is the correct, complete population for it.
7. Log every decision at info level. Any file that cannot be read → log at error, skip, manual review.

**Why same-transaction (not a follow-up pass):** the re-verification cross-check demands set equality between discovered snapshot references and table rows. A two-pass population would create a window where re-verification flags `missing_row` drift for every legacy file — a false positive that blocks the run's completion (unresolved conflicts block `complete`). The atomic population makes "populated" a per-file commit property, not a run-level eventual property.
8. **Invariant protected:** backfill and re-verification agree on the complete snapshot-reference set — no false drift on legacy files. **Proving scenario:** S43/S46-adjacent — a re-verification immediately after backfill produces zero `missing_row` conflicts for legacy snapshot-referenced files (asserted in S50).

**Backfill field policy (deterministic — never fabricate):**

- **`mimetype`:** Detect via file magic bytes (libmagic / `file --mime-type`), **not** by file extension. Extensions on legacy files are untrusted (uploads were never extension-validated server-side).
  - If magic-byte detection yields a supported image mimetype (`image/jpeg`, `image/png`, `image/webp`, `image/gif`) → use it.
  - If detection fails or yields an unsupported type → the file goes to `unattributed_media_files` (`protected=true`), never into the main registry with a guessed mimetype. **Never fabricate a classification merely to satisfy a database constraint.**
- **`roles`:** Determined by reference role(s) within the owning world. One row per physical file — a dual-role file gets a single row with both roles, never two rows (two rows for one file would break the UNIQUE constraints in §4.1 and make deletion unsafe: deleting one row could unlink the file while the other row still references it).
  - **Dual-role detection is by canonical filename/URL, not by content.** The *same* `/media/{filename}` URL appearing at both a cover path (`world.metadata.coverArtUrl`) and an illustration path (`scene.metadata.illustrationUrl`) in draft metadata → one row with `roles='{cover,illustration}'`.
  - **Two different filenames with identical bytes are two separate physical files** — two rows, two URLs, full stop. Even if their SHA-256 checksums match, they are distinct storage objects with distinct URLs, distinct reference sets, and independent lifecycles. **Never merge registry rows by content hash.** Content checksums are used for migration transfer verification (§2.1) only — never for registry identity.
  - Referenced **only** as cover art → `roles='{cover}'`.
  - Referenced **only** as a scene illustration → `roles='{illustration}'`.
  - Referenced by **neither** (file on disk, no draft or snapshot reference found) → `unattributed_media_files` (`protected=true`). An unreferenced legacy file is not safe to attribute — it may belong to a deleted world or a snapshot whose row was lost. Its `roles` are unknown, so it cannot enter the main registry.
  - Unsupported extension or unresolvable mimetype → `unattributed_media_files`, regardless of reference role. A file the system cannot classify cannot enter the lifecycle.

**Attribution** (moving a row from `unattributed_media_files` to `world_media_assets`) requires operator action: confirm the true owning world, set `matched_world_id`, insert the registry row, delete the unattributed row — as a single transaction. **Concurrent-deletion guard:** before committing, the attribution transaction must acquire the target world's row lock (`FOR UPDATE OF worlds`) and check for an active `world_deletion_jobs` row for that world — and for every world in the file's `referencing_worlds` array. If any deletion job exists → abort with **409** `{code: "WORLD_DELETION_IN_PROGRESS"}`. Rationale: attributing a file to a world that is mid-deletion would create a registry row the deletion's asset enumeration already passed, leaving the file permanently untracked. Until attributed, the file is served (§4.5) but cannot be referenced by new metadata (§4.2b: no row in the main registry → `ASSET_UNKNOWN`) and cannot be deleted (`protected=true`).

**During backfill:** the new `DELETE` endpoint returns **503** `{code: "BACKFILL_IN_PROGRESS"}` for any asset without a registry row. Do not apply new lifecycle rules to unmigrated data.

**Backfill-run record (durable completion gate):** A `pending_review` row count of zero does not prove the inventory is complete — an interrupted scan or a file added mid-process would also produce zero. Completion is proven by a durable run record, not by the absence of pending rows:

```sql
CREATE TABLE backfill_runs (
  run_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state                   TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (state IN ('in_progress','complete','failed')),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  failure_reason          TEXT,           -- set when state transitions to 'failed' (rev 19 — B4)
  final_inventory_count   INT,            -- authoritative file count after write-freeze
  final_inventory_checksum TEXT,          -- SHA-256 of the inventory manifest itself
  files_classified        INT NOT NULL DEFAULT 0,
  files_pending           INT NOT NULL DEFAULT 0
);

-- Durable per-file inventory manifest (rev 19 — B4). The checksum above seals the
-- manifest against tampering; THIS table is the authoritative set the
-- reconciliation proves equality against. One row per inventoried file per run.
CREATE TABLE backfill_inventory_files (
  run_id     UUID NOT NULL REFERENCES backfill_runs(run_id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,  -- storage filename ({uuid}.{ext})
  size_bytes BIGINT,
  sha256     TEXT,           -- content hash at inventory time (may be NULL if unreadable; then file goes to pending_review, never skipped)
  PRIMARY KEY (run_id, filename)
);
CREATE INDEX ON backfill_inventory_files (run_id);
```

**Backfill procedure with durable gate:**
1. `INSERT` a `backfill_runs` row (`state='in_progress'`). This run owns the backfill.
2. Take the final inventory (post-write-freeze, §2.1 step 7). For EVERY file, insert one row into `backfill_inventory_files` (`run_id`, `filename`, `size_bytes`, `sha256`) in the same transaction. Then record `final_inventory_count` (= `SELECT count(*) FROM backfill_inventory_files WHERE run_id = ?`) and `final_inventory_checksum` (SHA-256 over the sorted `filename+size_bytes+sha256` rows) in the run row. The manifest table is the authoritative set; the checksum seals it.
3. Classify each file per the policy above, incrementing `files_classified` / `files_pending`. Every classification INSERT into `world_media_assets` or `unattributed_media_files` sets `backfill_run_id` to this run's id (rev 19 — B4).
4. **Reconcile (executable — rev 19, B4):** every file in the final inventory must have exactly one outcome row for THIS run — proven by set equality in both directions, not by counts (counts could include rows from earlier runs):
```sql
-- Direction 1: every inventoried file has an outcome row for this run.
-- Must return ZERO rows.
SELECT i.filename
  FROM backfill_inventory_files i
 WHERE i.run_id = :run_id
EXCEPT
(SELECT w.filename FROM world_media_assets w WHERE w.backfill_run_id = :run_id
 UNION
 SELECT u.filename FROM unattributed_media_files u WHERE u.backfill_run_id = :run_id);

-- Direction 2: every outcome row for this run corresponds to an inventoried file.
-- Must return ZERO rows. (Catches rows inserted for files never inventoried.)
(SELECT w.filename FROM world_media_assets w WHERE w.backfill_run_id = :run_id
 UNION
 SELECT u.filename FROM unattributed_media_files u WHERE u.backfill_run_id = :run_id)
EXCEPT
SELECT i.filename FROM backfill_inventory_files i WHERE i.run_id = :run_id;
```
Additionally verify: (a) zero unresolved rows in `backfill_conflicts` for this run (`resolved_at IS NULL` count = 0); (b) zero off-manifest files on disk (re-list the directory and diff against the manifest — any file not in the manifest blocks completion per the added-after-freeze rule). Any discrepancy → investigate, do not complete. The old `<backfilled>` / `<this run>` placeholders are withdrawn — every predicate above is executable against the schema as defined.
5. Only when reconciliation passes: `UPDATE backfill_runs SET state='complete', completed_at=now()` in a single transaction.

**Enforcement gate:** lifecycle enforcement (registry-gated serving per §4.5, `DELETE` endpoint, quota accounting) enables **only** when a `backfill_runs` row exists with `state='complete'`. The startup check queries this table — not the `pending_review` count. If no `complete` run exists, enforcement stays disabled and health reports `"media_lifecycle": "backfill_incomplete"`.

**Write-freeze enforcement boundary (rev 11):** A final-inventory checksum proves *what was inventoried*; it does not prove the filesystem stayed unchanged while classification ran. And a `complete` run can go stale if a file lands after reconciliation but before enforcement enables. The boundary that closes both gaps is a **database-recorded write freeze**, not an operator promise:

- **Freeze signal:** a `backfill_runs` row with `state='in_progress'` IS the freeze. There is no separate flag to drift out of sync — the run's state is the freeze's state. The freeze begins when the run row is inserted (procedure step 1) and ends atomically when the run is marked `complete` (procedure step 5).
- **Actors that must honor the freeze** (checked before acquiring any filesystem-mutating locks):
  1. **Upload endpoint** (`POST /worlds/:id/media`): if an `in_progress` backfill run exists → return **503** `{code: "BACKFILL_IN_PROGRESS", retryable: true}` before any file write. The check runs inside the upload transaction's locked section (after acquiring level 1, before the quota check) so a freeze cannot begin mid-upload without the upload seeing it.
  2. **Replacement T1** (new-file upload, §4.3a): same 503 — it is an upload.
  3. **`repair` reconciliation** (§9.4): the repair entry point refuses to start while an `in_progress` run exists (quarantine moves during backfill would invalidate the inventory). `diagnose` (read-only) may run — it changes nothing.
  4. **Volume restore procedure** (§9.2): restores are scheduled outside backfill windows; the runbook requires verifying no `in_progress` run before starting a restore.
  5. **Direct operator filesystem writes** (shell, cron, ad-hoc scripts): prohibited by runbook during a run. The freeze is announced in the run's log at warning level when the run starts; any file appearing off-manifest is caught by reconciliation step 4(b) regardless.
- **Serving is unaffected:** reads (`GET /media/*`) continue under the legacy grace period (§4.5) during the run. The freeze covers writes only.
- **Atomic transition (the boundary):** the sequence is freeze (run inserted) → final inventory recorded → classify → reconcile (including off-manifest diff and zero-conflict checks) → `UPDATE backfill_runs SET state='complete'` **in a single transaction that simultaneously ends the freeze and enables enforcement**. Because the freeze *is* the run state, there is no window in which (a) the freeze is lifted but enforcement is not yet enabled (a file could land unclassified), or (b) enforcement is enabled while the freeze is still on (uploads would 503 after the inventory they should belong to). After the transition, any new file arrives through the normal upload path — which creates its registry row in the same transaction — so it can never exist in the unclassified gap the backfill was designed to close.
- **Crash during the run:** the run stays `in_progress`; the freeze stays on. On restart the run is marked `failed` (freeze implicitly lifted — a `failed` run is not a freeze), enforcement stays disabled, and the operator starts a new run (new freeze, new inventory). There is no path where a crashed run leaves the freeze on forever: the freeze lifetime is exactly the `in_progress` lifetime, and startup resolves every stale `in_progress` row.

**Distinction from the migration freeze (§2.1 step 6):** the migration freeze is an HTTP-level maintenance mode (`503 MIGRATION_IN_PROGRESS`, operator-initiated, covers the volume cutover). The backfill freeze is database-recorded and covers the classification window. During the §2.1 migration, both may be active sequentially (migration freeze during transfer, backfill freeze during classification) but they are separate mechanisms with separate lifecycles — the runbook must not conflate them.

**Rerun semantics — verify, never blindly skip (rev 11):** A new backfill run (after a `failed` run, or an operator-initiated re-run) creates a new `backfill_runs` row. It does NOT resume the old run and does NOT skip files merely because a row already exists. "Skipped via UNIQUE constraint" was the rev-10 wording and it is withdrawn: a file classified in a failed run may have been classified incorrectly, or its metadata references may have changed since. Every file in the new run's final inventory is **re-verified**:

1. **File has a `world_media_assets` row:** recompute the expected classification from the *current* draft metadata and *current* retained snapshots (owning `world_id` by URL match, `mimetype` by magic bytes, `roles` by current draft paths).
   - Recomputed classification matches the row → row confirmed; count as classified.
   - Recomputed classification differs (wrong `world_id`, stale `roles`, references changed, mimetype re-detected differently) → **conflict.** The run MUST NOT update the row in place — silently overwriting a row that other operations may have depended on is forbidden, and silently accepting a wrong row perpetuates the error. Instead the run inserts a row into `backfill_conflicts` (see below) and leaves the registry row untouched. The run cannot reach `complete` while any conflict is unresolved (reconciliation step 4 checks `conflicts` count = 0).
2. **File has an `unattributed_media_files` row:**
   - `classification_status = 'reviewed'` → **preserve untouched.** The operator's decision stands even if reclassification would produce a different outcome. Count as classified; log at info with `file_id` noting "operator-reviewed, preserved."
   - Otherwise (`pending_review` or `classified` by a prior run, not yet operator-reviewed) → re-run classification. If the recomputed outcome matches → keep. If it differs → apply the new outcome (update the row, or perform the attribution move to `world_media_assets` if the file is now uniquely attributable). Overwriting a non-operator-reviewed classification is safe: no human decision is being overridden.
3. **File has no row in either table:** classify fresh per the policy above.

**Conflict table** (new — the operator's review queue for rerun disagreements):

```sql
CREATE TABLE backfill_conflicts (
  conflict_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES backfill_runs(run_id),
  filename          TEXT NOT NULL,
  url               TEXT NOT NULL,
  existing_world_id UUID,               -- world_id on the current registry row (NULL if none)
  recomputed_world_id UUID,             -- world_id the new run's classification produced
  existing_roles    TEXT[],
  recomputed_roles  TEXT[],
  reason            TEXT NOT NULL,      -- e.g. 'world_id changed', 'roles stale', 'mimetype re-detected'
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,        -- set when the operator resolves
  resolution        TEXT                -- 'accepted_recomputed' | 'kept_existing' | notes
);
```

**Conflict resolution (operator action, outside the run):** for each conflict, the operator either (a) accepts the recomputed classification — performed through the normal attribution/row-update path with its locks, then marks the conflict resolved; or (b) keeps the existing row — marks resolved with a note. The backfill run is re-executed (new run row) after all conflicts are resolved; the re-verification in step 1 will then confirm the rows and the run can complete. A run with unresolved conflicts stays `in_progress` indefinitely — it never auto-completes, and enforcement stays disabled.

**Files added after the inventory freeze:** the write freeze (§4.7 "Write-freeze enforcement boundary" below) forbids new files during a run. If a file appears on disk that is **not** in the run's final inventory manifest (operator bypass, restore side-effect), the run MUST NOT silently absorb it: reconciliation step 4 compares the on-disk file set against the manifest; any off-manifest file is logged at error, recorded as an unattributed row with `classification_status='pending_review'` and a note `"appeared after inventory freeze"`, and the run **cannot complete** until the operator either removes the file or aborts the run and starts a new one (new freeze, new inventory). The invariant is: the set of classified files is exactly the set of inventoried files — no more, no fewer.

**Files removed after the inventory freeze:** a file in the final inventory manifest that no longer exists on disk when the run classifies it is **not** skipped — skipping would break the reconciliation equation. The run classifies it by references (draft metadata + snapshots) to determine the owning world, creates the `world_media_assets` row with `file_confirmed_present = false`, and the data-loss alert path (§9.2) fires. The file has an outcome (row + alert), so reconciliation counts it as classified. This is honest: the run records what *should* exist and flags that it doesn't, rather than pretending the file never existed.

**Interrupted run:** on startup, any `backfill_runs` row with `state='in_progress'` from before the last clean shutdown is marked `failed` (single transaction, logged at warning). Enforcement remains disabled until an operator explicitly restarts the backfill, which creates a new run. A `failed` run is never resumed — the new run re-verifies every row per the protocol above; the failed run's partial classifications are evidence, not state to build on.

**A file that cannot be read is never silently skipped** — it sits in `pending_review`, blocking the run's reconciliation (step 4 cannot pass while any file lacks an outcome), until a human accounts for it. This is deliberate: silent skips are how files fall out of lifecycle protection.

**Principle:** "No registry row" does NOT mean "irrelevant to canon." An unregistered file might be referenced by a published snapshot. The backfill must prove non-reference before any deletion rule applies.

### 4.7b Backfill consistency boundary — classification-input freeze (rev 12)

The rev-11 write freeze covers *file* mutations (uploads, replacement-T1, repair, restore). But backfill classification depends on three inputs, not one:

1. **Filesystem inventory** (the files themselves) — covered by the rev-11 freeze.
2. **Draft metadata** (scene/world `illustrationUrl`/`coverArtUrl` values) — NOT covered in rev 11.
3. **Retained snapshots** (`canon_snapshots` rows) — NOT covered in rev 11.

A backfill that inventories `/media/x.jpg` as World A's cover, then has the creator change it to an illustration mid-run, classifies against a metadata state that no longer exists. Re-verifying every row does not fix this — it re-verifies against the *new* state, but the run's inventory-to-classification mapping was built on the *old* state. The run needs a consistent boundary around ALL classification inputs, not just files.

**Extended freeze (rev 12):** While a `backfill_runs` row with `state='in_progress'` exists, the following operations are frozen in addition to the rev-11 list:

5. **Scene/world metadata updates** (any `illustrationUrl`/`coverArtUrl` change): check for `in_progress` run AFTER acquiring the world-row lock but BEFORE the metadata write. If found → **503** `{code: "BACKFILL_IN_PROGRESS", retryable: true}`. No metadata change, no row update.
6. **Publish** (snapshot creation): same check in the publish transaction's locked section. If found → **503** `{code: "BACKFILL_IN_PROGRESS"}`. No snapshot created.
7. **World deletion T1** (job initiation): same check. If found → **503** `{code: "BACKFILL_IN_PROGRESS"}` (not 409 — this is a transient freeze, not a semantic conflict).

**Operations explicitly PERMITTED during backfill:**
- All reads: `GET /media/*` (serving), session reads, metadata reads, snapshot reads.
- Reconciliation `diagnose` (read-only).
- The backfill job itself.

**Why freeze metadata (not versioned reconciliation):** Backfill is a rare, operator-initiated, time-bounded operation (minutes). Freezing metadata writes during it is a proportional trade-off — far simpler than a versioned reconciliation protocol, with no measurable impact on normal operations. The freeze is announced; creators see a retryable 503, not a silent failure.

**Proof of input validity (rev 13 — B2.1):** Prevention (the freeze) can be bypassed by a bug or direct SQL. The run therefore *proves* its classification inputs remained valid — not via timestamps (which a direct SQL update can bypass without touching `updated_at`), but via a content hash over the actual attribution inputs:

**`attribution_input_hash`:** SHA-256 over the canonical JSON serialization of:
1. For each world (sorted by `world_id`): `{world_id, coverArtUrl}` — the actual URL value (or null).
2. For each scene (sorted by `scene_id`): `{scene_id, world_id, illustrationUrl}` — the actual URL value (or null).
3. For each retained snapshot in `canon_snapshots` (sorted by `snapshot_id`): `{snapshot_id, world_id, media_urls}` where `media_urls` is the sorted list of asset URLs extracted from `canon_data` via the §4.2 query contract.
4. The sorted list of filenames in `/data/media/` at inventory time (the filesystem inventory itself).

This hashes the *data the backfill actually used for classification*, not metadata about the data. A direct SQL update that changes a URL without touching `updated_at` WILL change this hash. A timestamp collision cannot hide a content change. The set of covered inputs is explicit and complete: if an input affects attribution and is not in this list, the design is incomplete (review must catch it).

- At inventory time, the run records `attribution_input_hash`.
- At completion time (in the same transaction that marks the run `complete`), the run recomputes the hash and compares.
- If the hashes differ → the classification inputs changed during the run → the run transitions to `failed`, NOT `complete`. Enforcement stays disabled. Log at critical with both hashes and a diff summary (which worlds/scenes/snapshots changed). Operator investigates before starting a new run.

**Writer contract (enforced, not just documented):** Every application code path that modifies any input in the hash's coverage (scene/world metadata URLs, snapshot creation, file creation/deletion) MUST perform its freeze check (for `in_progress` backfill) inside the same level-1-holding transaction as the mutation (§4.7b freeze rules). Direct SQL modification of these inputs bypassing the application is an operational violation; the content hash is the detection mechanism (the run fails at completion, it does not silently complete on stale inputs).

**Completion gate — atomic protocol (rev 13 — B2.2):** The freeze checks reduce the race window but do not eliminate it. The authoritative serialization is the completion transaction itself:

```
-- Completion transaction (single transaction, all-or-nothing):
BEGIN;
-- 1. Acquire level-1 global lock (transaction-scoped). This is the serialization point.
SELECT pg_advisory_xact_lock(hashtext('media_global'));
-- 2. Lock the backfill run row.
SELECT * FROM backfill_runs WHERE run_id = ? FOR UPDATE;
-- 3. Recompute attribution_input_hash from current database + filesystem state.
-- 4. Compare with the inventory-time hash.
-- 5a. If match AND zero unresolved conflicts AND inventory reconciliation passes:
--       UPDATE backfill_runs SET state = 'complete', completed_at = now() WHERE run_id = ?;
-- 5b. If mismatch OR unresolved conflicts OR inventory mismatch:
--       UPDATE backfill_runs SET state = 'failed', failure_reason = ? WHERE run_id = ?;
COMMIT;  -- Level-1 lock released; freeze lifts atomically with the state change.
```

**Why this serializes the boundary:** Every writer that could invalidate the hash (metadata update, publish, world-deletion T1, upload, repair) acquires level-1 in its mutating transaction BEFORE performing the freeze check. The completion transaction holds level-1 for its entire duration. Therefore:
- A writer cannot pass its freeze check *after* the completion transaction has acquired level-1 (it blocks on the lock until completion commits, then sees `state='complete'` → no freeze → proceeds normally).
- The completion transaction cannot commit while a writer holds level-1 with an in-flight mutation (it blocks until the writer commits or rolls back, then recomputes the hash *after* the writer's changes are visible).
- There is no interleaving where the hash is verified against state S, then a writer commits state S' before the `complete` marker commits. The lock makes verification and marking atomic with respect to all writers.

**Single active run:** A partial unique index `CREATE UNIQUE INDEX ON backfill_runs ((1)) WHERE state = 'in_progress'` ensures at most one `in_progress` run exists. A second backfill start while one is active → unique violation → 409 `{code: "BACKFILL_ALREADY_RUNNING"}`.

**Schema change (rev 13):**
```sql
ALTER TABLE backfill_runs ADD COLUMN attribution_input_hash TEXT;
-- Replaces metadata_version_hash (rev 12). The timestamp-only hash is removed;
-- it proved less than the design required.
ALTER TABLE backfill_runs DROP COLUMN IF EXISTS metadata_version_hash;
```

The freeze is the prevention; the content hash is the proof; the level-1 completion transaction is the serialization. All three are required — none alone is sufficient.

**Post-completion write consistency (rev 14 — B2):** The completion transaction is the atomic enforcement-enable point. There is no separate "enable enforcement" step that could race with writers:

**Enforcement definition (rev 15):** `enforcement_active` is a DERIVED state, not a stored flag:
```sql
-- enforcement_active is TRUE iff:
EXISTS (SELECT 1 FROM backfill_runs WHERE state = 'complete')
AND NOT EXISTS (SELECT 1 FROM backfill_runs WHERE state = 'in_progress')
AND NOT is_maintenance_active()  -- fail-closed wrapper (§4.3d): true on missing row/table/query error
```
The completion transaction's COMMIT is the instant enforcement enables. No writer can observe "completed but not yet enforcing" — the state is derived from the same committed rows every reader sees.

**Post-completion writes (rev 14):** A write that begins after the completion transaction commits:
1. Checks for `in_progress` backfill → finds none (the run is `complete`).
2. Proceeds via the NORMAL registry path: acquires level-1, checks maintenance fence, checks quota/capacity, writes file, inserts registry row with `world_id` and `roles`, commits.
3. The file is fully registered immediately — it does NOT need a "future backfill" to be consistent. Backfill is only for legacy files that predate the registry; post-completion writes are native registry writes.

**Invariant (rev 14 — B2):** The registry is never in a state where enforcement assumes a completed backfill but un-backfilled files exist. Every file created after completion goes through the normal path and gets a registry row atomically with its bytes. The S44 Case A "future backfill" language is superseded: the post-completion writer's file is registered immediately, not eventually.

**What the rev-13 S44 got wrong:** It said "the next backfill will see it" for post-completion writes. This was misleading — it implied the file would be unregistered until a future backfill. In fact, the normal upload path creates the registry row in the same transaction as the file write. No backfill is needed. S44 is updated to reflect this.

**Post-completion mutation coverage (rev 15 — B2 verification):** "post-completion writes use the normal path" must hold for EVERY mutation type, not just uploads. Verified against the full ADR:
- **Draft metadata changes** (URL add/remove/swap) → §4.2b contract: reference validation under row locks, `roles` updated atomically with the URL write, freeze check under level 1. Registry stays consistent.
- **Publishing** → §4.2b validation + snapshot creation + `asset_snapshot_references` inserts in the same transaction (path 13, §4.3d). New snapshot references are tracked immediately; no backfill needed.
- **Asset replacement** → §4.3a: T1 is the normal upload path (registry row for the new file); T2 is the §4.2b metadata switch (roles + URL atomically). Old file enters the §4.3b deletion lifecycle only after the switch commits.
- **World deletion** → §4.9: shared-asset transfer (T1), snapshot-protected transfer to `unattributed_media_files`, normal per-file lifecycle otherwise. No orphaned registry rows.
- **Repair** (§9.4) → holds level 1; never unlinks a referenced file; quarantine moves only. Registry rows are updated, not orphaned.
- **Recovery** (§4.9, §9.4) → reconciliation first; enumerate-and-stat; idempotent transitions. Crash-recovered state converges on the same invariants.
- **Uploads** → §4.4 + §5.5: reservation → registry row in one commit transaction.

**Filesystem/database crash boundary (rev 15 — B2 verification):** the filesystem and the database are never atomic with each other (§4.3b). The crash interleavings and their recovery:
- **Crash between file rename and registry-row commit (upload):** orphan file, no row → §9.4 reconciliation: reference-check (draft + snapshots); referenced → `unattributed_media_files` row (`protected=true`); unreferenced → `.quarantine/`. Never silently servable as a registered asset; never silently deleted.
- **Crash between unlink and row deletion (T2):** row stays `pending_deletion`; retry stats the file (absent → idempotent success) and finalizes (§4.3b).
- **Crash between temp-file write and reservation commit (Phase 1):** reservation row never existed → temp file (if any) has no row → periodic scan counts it in `unregistered_bytes`; cleanup via the orphan path. Capacity was never consumed (no reservation).
- In every case: no crash ordering exposes an unregistered file as a registered asset, and no crash ordering loses reference protection for a referenced file. Reference protection is a property of the scan + row state, both of which are re-derived from ground truth after a crash — never trusted from pre-crash memory.

### 4.7c Backfill conflict resolution contract (rev 12)

The `backfill_conflicts` table (rev 11) records disagreements. This section defines the durable resolution protocol.

**Conflict identity:** `(run_id, filename)` — a conflict is specific to one run's re-verification of one file. A new run that re-detects a disagreement on the same file creates a NEW conflict row (with the new `run_id`); it does not reuse or update the old one.

**Status transitions:**
```
detected (resolved_at IS NULL)
  → resolved (operator action, resolved_at set)
  → superseded (a newer run created a new conflict for the same filename;
                    the old row's resolution is set to 'superseded_by_<new_conflict_id>')
```
There is no `reopened` state — if the operator's resolution proves wrong, the next run creates a fresh conflict.

**Resolution transaction (atomic):** The operator's decision and the conflict marker commit together. There is no state where a conflict is "marked resolved" but the row was not corrected (or vice versa):

```sql
BEGIN;
-- 1. Lock the conflict row
SELECT * FROM backfill_conflicts WHERE conflict_id = ? FOR UPDATE;
-- 2. Lock the registry row (if the conflict involves an existing row)
SELECT * FROM world_media_assets WHERE filename = ? FOR UPDATE;
-- 3a. Option A (accept recomputed): apply the recomputed classification
UPDATE world_media_assets
   SET world_id = ?, roles = ?, updated_at = now()
 WHERE filename = ?;
-- 3b. Option B (keep existing): no row change; record rationale in resolution notes
-- 4. Mark resolved (atomic with step 3)
UPDATE backfill_conflicts
   SET resolved_at = now(), resolution = ?
 WHERE conflict_id = ?;
COMMIT;
```

**Re-verification algorithm (rev 13 — B4, exact and testable):** "Re-verify every row" is not an aspiration — it is this deterministic procedure, executed for each row in each new backfill run:

For each row in `world_media_assets`:
1. **Extract expected owner from draft metadata:** Scan ALL worlds' current drafts (not just the row's `world_id` — rev 15): check each `world.metadata.coverArtUrl` and each `scene.metadata.illustrationUrl` for the row's URL.
   - If URL found in exactly one world's draft → `expected_world_id` = that world, `expected_roles` = set of matched role names (`cover` and/or `illustration`).
   - If URL found in MULTIPLE worlds' drafts → apply the multi-world rules (§4.7c "Multi-world URL references"): owner = lexicographically smallest `world_id`; other worlds recorded in `shared_with_worlds` (recomputed, compared against the stored array).
   - If URL NOT found in any draft → proceed to step 2.
2. **Extract expected owner from retained snapshots:** Using the §4.2 snapshot query contract, search all retained `canon_snapshots` for the row's URL.
   - If URL found in any snapshot → `expected_world_id` = the snapshot's `world_id`, `expected_roles` = `{}` (snapshot-referenced but not in draft; the file is protected but holds no draft role).
   - If URL NOT found in any snapshot → `expected_world_id` = NULL, `expected_roles` = `{}` (unreferenced; candidate for operator review, NOT auto-deleted — deletion is a separate decision via §4.3b).
   - **Cross-check (rev 16 — B4.2):** the set of snapshots found here must equal the set of `asset_snapshot_references` rows for this `filename` (stable identity). A mismatch → conflict with `reason='snapshot_ref_drift'` and the three-condition handling in §4.7c(d) (snapshots win — the table is a cache of the immutable snapshot content, not the other way around).
3. **Compare:** If `expected_world_id != row.world_id` OR `expected_roles != row.roles` (as sets) → create a `backfill_conflicts` row with `existing_world_id`, `existing_roles`, `recomputed_world_id`, `recomputed_roles`, `reason` (one of: `world_mismatch`, `roles_stale`, `orphaned`).
   - If match → mark row as `verified` for this run (in-memory; no DB write needed — verification is recomputation, not state).

For each row in `unattributed_media_files`:
4. Perform steps 1–2 using the file's URL. If now attributable to a world (`expected_world_id` non-null) → create a conflict row with `reason='attributable'` and the suggested attribution. The run does NOT auto-attribute; the operator resolves via the atomic transaction.

**Determinism guarantee:** The algorithm is a pure function of (draft metadata, retained snapshots, registry rows). Two runs on the same inputs produce the same conflicts. There is no heuristic, no fuzzy matching, no "probably." A test can construct a database state and assert the exact conflict set.

**Multi-world URL references (rev 14 — B4a):** A single URL (one physical file, one registry row) may be referenced by multiple worlds' drafts or snapshots. The re-verification algorithm handles this deterministically:

1. **Draft references in multiple worlds:** If the row's URL is found in the draft metadata of more than one world, the owner (`expected_world_id`) is the world with the lexicographically smallest `world_id` (UUID string comparison). This is deterministic and total — every URL maps to exactly one owner. The other referencing worlds are recorded in the row's `shared_with_worlds` array (a `UUID[]` column, empty if not shared). They are NOT conflicts — shared references are legitimate.
2. **Snapshot references in multiple worlds (no draft reference):** If the URL is found only in snapshots (not in any draft), the owner is the world of the most recent snapshot (by `snapshot.created_at`); ties broken by lexicographically smallest `world_id`.
3. **Draft takes precedence over snapshots:** If the URL is in World A's draft AND World B's snapshot, the owner is World A (draft is the live reference; snapshots are historical).
4. **Owner change detection:** If the recomputed owner (per rules 1–3) differs from the row's stored `world_id` → conflict with `reason='world_mismatch'`, `recomputed_world_id` set. The operator resolves via the atomic transaction (which updates `world_id` and `shared_with_worlds` together).
5. **Shared-with changes:** If the set of referencing worlds changes but the owner (lowest `world_id`) is unchanged → update `shared_with_worlds` WITHOUT a conflict (this is not a disagreement about ownership, just a reference set update). Log at info.

**Conflict record for shared files:** When two worlds legitimately share a file, NO conflict is created. The `shared_with_worlds` array is the representation. A conflict is created ONLY when the computed ownership (per the deterministic rules) disagrees with the stored row — indicating a contract violation or stale data, not legitimate sharing.

**Invariant (rev 14 — B4a):** For every URL, the re-verification algorithm computes exactly one owner deterministically. The same inputs always produce the same owner. There is no ambiguity.

**Shared-asset authorization and deletion contract (rev 15 — B4.1):** Deterministic ownership answers "which world is the canonical owner." It does not answer "who may read" or "when may it be deleted." This contract does:

**(a) SERVING shared assets:** `GET /media/{filename}` for a registry row with non-empty `shared_with_worlds`:
1. Determine the requesting context's world (the story/session being read).
2. The request is authorized iff the context world equals the row's `world_id` (owner) OR is a member of `shared_with_worlds`. Membership is read from the current row (READ COMMITTED — a concurrent removal of the world takes effect on the next request; the bound is one request).
3. Authorization is validated against the CONTEXT WORLD's access policy (e.g., is that world's story published? does this reader have access to it?) — not the owner's policy. A World B reader's access to the shared file is governed by World B's rules.
4. The grant is per-file, per-request: a World B reader authorized for the shared file gains NO access to World A's other assets. A request for a non-shared file under a foreign world context → **404** (not 403 — existence is not leaked).
5. If the context world is neither owner nor in `shared_with_worlds` → **404**.

The file never becomes inaccessible to legitimate readers merely because the canonical owner was selected lexicographically: any world in `shared_with_worlds` confers serving rights under its own policy.

**(b) DELETION and reference protection:** `shared_with_worlds` and `asset_snapshot_references` BOTH participate in reference protection — they are reference sets, not advisory metadata:
1. **Asset deletion T1/T2** (§4.3b): the reference scan treats every world in `shared_with_worlds` as a draft reference and every row in `asset_snapshot_references` as a snapshot reference. A shared file with a non-empty `shared_with_worlds` or any snapshot-ref rows → **409** `{code: "ASSET_REFERENCED"}`. A shared file can only enter `pending_deletion` after ALL shares are removed (via (c) below) and no snapshot references remain.
2. **World deletion — owner deleted with shares outstanding** (§4.9): the file MUST NOT be unlinked. In T1's transaction, for each asset of the deleted world with `shared_with_worlds <> '{}'`: ownership transfers to the lexicographically smallest `world_id` in `shared_with_worlds`; that world is removed from the array; `updated_at` is set. The transfer is deterministic and total. The asset is excluded from T2's `pending_deletion` marking and T3's unlinking (T2's `WHERE world_id = ?` no longer matches it).
3. **World deletion — owner deleted, no draft shares, but snapshot references from other worlds remain:** the registry row is moved to `unattributed_media_files` (`protected = true`, `referencing_worlds` = the snapshot-owning worlds, `notes` recording the transfer) and the registry row is deleted, in T1's transaction (§4.9 step 2). (Rev-16 correction: the transfer must complete inside T1 — T2 marks `pending_deletion` on `WHERE world_id = ?` and T3 unlinks, so a still-registered protected row at T2 would be unlinked, destroying the file this contract protects.) The file stays on disk and remains servable via the snapshot context (§4.5 step 2). It is never auto-deleted — an operator attributes or retires it explicitly.
4. **World deletion — owner deleted, no shares, no snapshot refs:** normal unreferenced lifecycle (T2 marks `pending_deletion`, T3 unlinks).

**(c) REFERENCE REMOVAL (share lifecycle):** when a world's draft stops referencing a shared URL:
1. The metadata-update transaction that removes the URL (holding 1 → 3 → 6 per §4.3c) also executes `shared_with_worlds = array_remove(shared_with_worlds, :removing_world_id)` on the asset row — in the same transaction, under the same asset-row lock. The array can never disagree with draft reality: every draft-reference removal updates the array atomically.
2. A world ADDING a reference to an existing shared URL (its draft newly contains the URL): the metadata-update transaction appends its `world_id` to `shared_with_worlds` (if not the owner and not already present), same transaction, same locks.
3. When the array becomes empty AND the owner's draft no longer references the URL → the file is unreferenced → the normal two-phase deletion lifecycle (§4.3b) applies. (The owner still cannot delete while `asset_snapshot_references` has rows.)
4. **Owner drops its own reference while shares remain (rev 16 — B4.1):** if the *owner's* draft removes its last reference to the URL but `shared_with_worlds` is non-empty, the metadata-update transaction applies the deterministic ownership rule *eagerly* in the same transaction: `new_owner` = lexicographically smallest `world_id` in `shared_with_worlds`; `UPDATE world_media_assets SET world_id = new_owner, shared_with_worlds = array_remove(shared_with_worlds, new_owner)`. The removing owner's ID is not added to the array (it no longer references the file). Leaving a non-referencing world as canonical owner would make every re-verification flag a `world_mismatch` conflict for a legitimate state; the eager transfer keeps the row truthful at every commit, using the identical rule as the world-deletion transfer (§4.9 T1) — one ownership rule, not two.
5. **Lock discipline:** only the metadata-update transaction of the referencing world mutates its own membership, and it always holds the asset-row lock (position 6) while doing so. Two worlds adding/removing concurrently serialize on the asset-row lock. The backfill re-verification recomputes the full array from ground truth (draft scan) and corrects drift via the conflict mechanism — the array is self-healing.

**(d) SNAPSHOT REFERENCES (immutable protection) (rev 16 — B4.2):** snapshots are immutable — a snapshot referencing the file protects it even if no draft references it, even if the owning world is deleted. Protection rows live in `asset_snapshot_references` and are keyed by the file's **stable identity (`filename`)**, never by the registry row:
1. Every retained snapshot reference is one row in `asset_snapshot_references`, keyed `(filename, snapshot_id)` — independent of which table (`world_media_assets` or `unattributed_media_files`) currently holds the file's row. The reference scanner resolves the file by filename and looks up the file's current table by filename when it needs row state. A registry-row move (world-deletion transfer, attribution) never touches these rows — protection survives ownership transfer by construction, not by careful ordering.
2. **Most-recent-snapshot's world deleted:** ownership transfers to the world of the next-most-recent remaining snapshot (by `snapshot.created_at`, ties by smallest `world_id`) — deterministic. The `asset_snapshot_references` rows are unaffected (they key on `filename` and `snapshot_id`, never on the owner or the registry row). If no snapshots remain and no draft references the file → unreferenced lifecycle.
3. A snapshot reference NEVER confers serving rights to a draft context — it only blocks deletion. Serving via a snapshot context follows §4.5: the snapshot's own published state governs, and the snapshot row persists per §5.4 even when its world row is gone.

**Re-verification drift handling (rev 16 — B4.2):** the authoritative source for all three conditions is `canon_snapshots.canon_data` scanned via the §4.2 query contract. The table is a cache of immutable snapshot content; **snapshots win, always.** The conflict reason remains `snapshot_ref_drift`, with a `subtype` (`missing_row` / `stale_row`) and expected-vs-actual snapshot-id sets on the `backfill_conflicts` row:
- **(a) Content references the URL AND the table agrees** (snapshot-id sets equal for the filename) → no action, no conflict.
- **(b) Content references the URL but the table is missing/incorrect** → conflict `snapshot_ref_drift`/`missing_row`. Fail-closed: while unresolved, the file is treated as referenced — scanners consult unresolved `snapshot_ref_drift` conflicts by filename *in addition to* the table; any hit → **409** `ASSET_REFERENCED` (without this, the missing row is an unprotected window). Operator resolution (locks 1 → 3 → 5 → 8): re-run the §4.2 scan, INSERT the missing rows, mark resolved. The repair is purely additive — it cannot over-protect beyond ground truth.
- **(c) The table has a row with no corresponding URL in authoritative content** → conflict `snapshot_ref_drift`/`stale_row`. Fail-closed by default: the stale row keeps blocking deletion (409) until resolved — a phantom protection row can only over-protect (operator-visible), never under-protect. Operator resolution (same locks): **first** re-run the §4.2 scan under the locks and confirm the URL is absent from that snapshot's `canon_data` (guards against a scanner false negative — deleting a *real* protection row would be data loss); **only then** DELETE the stale row and mark resolved. If the re-scan finds the URL, the row is NOT deleted — reclassify as (b)-type handling; a protection row is never silently dropped.

**Snapshot GC × the stable identity (rev 16 — B4.2):** the GC transaction is `1 → 8`: `DELETE FROM asset_snapshot_references WHERE snapshot_id = ?` in the SAME transaction as the snapshot-row delete (orphan ref rows impossible inside the contract). For each filename that lost its LAST ref row: if the file is in `world_media_assets` → no row change (it becomes deletion-eligible under the normal owner-initiated §4.3b lifecycle); if in `unattributed_media_files` → `classification_status = 'pending_review'`, `protected = true` retained — never auto-deleted; the operator decides. Out-of-contract orphans (a `snapshot_id` with no snapshot row) are detected by the re-verification cross-check as condition (c) and by a periodic `NOT EXISTS` query → same `stale_row` conflict; cleanup touches only ref rows, never the file.

**Reference-lifecycle verification (rev 16 — B4.1):** every path that can add or remove a reference was checked against the share structures:

| # | Removal path | Structure updated | Transaction / locks |
|---|---|---|---|
| 1 | World's draft removes URL (metadata update) | `shared_with_worlds` (`array_remove`) | Metadata-update txn, 1 → 3 → 6, same txn as URL removal |
| 2 | Owner's draft removes last self-reference, shares remain | `world_id` + `shared_with_worlds` (eager ownership transfer) | Metadata-update txn, 1 → 3 → 6 |
| 3 | World deletion T1 — shared assets | `world_id` + `shared_with_worlds` (transfer to lowest shared) | T1 txn, 1 → 2 → 3 → 6 → 8 |
| 4 | World deletion T1 — snapshot-only assets | Row moved to `unattributed_media_files`; registry row deleted; ref rows untouched (filename-keyed) | T1 txn, 1 → 2 → 3 → 6 → 8 |
| 5 | World deletion T4 — unattributed `referencing_worlds` | `referencing_worlds` (`array_remove`) | T4 txn, 1 → 2 → 3 → 4 → 6 → 7 → 8 (order corrected rev 18 — B10) |
| 6 | Snapshot GC (retention) | `asset_snapshot_references` rows deleted with the snapshot | GC txn, 1 → 8 |
| 7 | Publish (snapshot replaced) | Old snapshot's refs cleaned via path 6 when the old snapshot is GC'd | — |

**Invariant (rev 16 — B4.1):** every reference addition or removal updates the corresponding share structure in the same transaction under the asset-row lock (position 6). Draft reality and the share structures cannot durably disagree — drift is bounded to concurrent-transaction windows and self-heals via re-verification.

**Invariant (rev 15 — B4.1):** (i) no legitimate reader loses access due to ownership selection — every world in `shared_with_worlds` confers serving rights under its own policy; (ii) no file is deleted while any retained reference exists — draft references via `shared_with_worlds`, snapshot references via `asset_snapshot_references`, both checked by every deletion scan; (iii) no unauthorized access is granted via sharing — the grant is per-file under the context world's policy, never a world-level privilege.

**Resolution transaction — lock ordering (rev 15):** The resolution transaction follows the canonical total order (§4.3c): positions 1 → 3 → 5 → 6.

1. **Position 1** (global media lock): `SELECT pg_advisory_xact_lock(hashtext('media_global'))` — FIRST, before any row lock.
2. **Position 3** (world row): `SELECT * FROM worlds WHERE world_id = ? FOR UPDATE` — the world named by the resolution (the expected owner).
3. **Position 5** (conflict row): `SELECT * FROM backfill_conflicts WHERE conflict_id = ? FOR UPDATE`.
4. **Position 6** (asset row, if the conflict involves an existing registry row): `SELECT * FROM world_media_assets WHERE filename = ? FOR UPDATE`.
5. Apply the correction (UPDATE the asset row and/or mark the conflict resolved). The correction also updates `shared_with_worlds` atomically when ownership changes.
6. COMMIT (releases all locks atomically).

**Why this order:** the conflict row (position 5) is ordered BEFORE the asset row (position 6) because the conflict is the *driver* of the change — every resolution starts from a conflict, so every participant locks the conflict first. A concurrent backfill re-verification that needs the same asset row also acquires position 1 first, then attempts the position-5 lock — it blocks (does not deadlock) because the lock order is identical. The wait graph is acyclic per the §4.3c theorem: all participants acquire in ascending canonical order.

**Lock-ordering safety rule (rev 15 — subsumed by the canonical order):** the rev-14 rule ("a transaction holding the asset lock must not acquire the conflict lock — release and restart in order") is now a corollary of the §4.3c ascending-order requirement: out-of-order acquisition is forbidden, period. The conflict-resolution transaction is the ONLY transaction that acquires both conflict and asset locks, and it always acquires them as 5 → 6. All other transactions that need conflict information (e.g., a backfill worker checking for an open conflict) do so in a separate short transaction holding NO asset locks — typically: acquire position 1, read the conflict row (position 5), release.

**Invariant (rev 15 — B4b/B4.3):** No lock-ordering cycle exists. Every transaction acquires locks in the canonical total order (0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9) or a prefix/subsequence thereof, with same-position multi-locks in ascending ID order. A transaction never "upgrades" from a later position to an earlier one.

**Terminal state rule:** A run with any unresolved conflict (`resolved_at IS NULL` for its `run_id`) CANNOT transition to `complete`. It remains `in_progress` indefinitely. The operator must resolve all conflicts (via the atomic transaction above) and start a new run, which re-verifies and — if zero conflicts — completes.

**Why S31's stale-roles example is valid (correction):** The normal §4.2b metadata-switch path updates `roles` atomically with the URL write and does NOT produce conflicts. A conflict indicates the row was written by a path *outside* the contract. Valid sequences that produce S31's mismatch:
- (a) **Legacy data:** the row was classified by backfill R1 before the §4.2b contract existed; the metadata was later changed through the normal path, but R1's classification predates the contract.
- (b) **Interrupted migration:** a pre-rev-11 migration wrote the row without the atomic role update.
- (c) **Direct SQL:** an operator or script updated metadata bypassing the application.
In all cases, the conflict is evidence of a contract violation or legacy state — never of the normal path. The resolution process (above) is how the system heals.


### 4.8 Change classification

**Level 3 (Architecture/Data/Contract)** per `governance/AI_AGENT_RULES.md` §5: new table (migration), new endpoint, storage infrastructure change. Requires: this ADR (approved), migration plan, impact analysis, tests, full review.

### 4.9 Draft-only world deletion (resumable multi-step)

World deletion is **blocked (409)** if any published version exists (§6 S10). For draft-only worlds, deletion is a recoverable multi-step operation — never one uncommitted transaction spanning database and filesystem work.

**State table:**

```sql
CREATE TABLE world_deletion_jobs (
  job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id      UUID NOT NULL REFERENCES worlds(world_id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'assets_pending'
                  -- Terminal condition is "job row absent" (T5 deletes the world
                  -- row; the job cascades). `complete` is NOT a persisted state —
                  -- it was removed from this constraint in rev 9 because no row
                  -- can ever exist in that state, and a CHECK value that can
                  -- never occur invites misreading the state machine. If audit
                  -- history of completed deletions is ever required, that is
                  -- future work (log at info before T5's delete).
                  CHECK (state IN ('assets_pending','files_removing','rows_removing')),
  files_total   INT NOT NULL DEFAULT 0,
  files_removed INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id)   -- one job per world
);
```

`not_started` is the implicit state when no job row exists (the normal case). Any job row blocks new references, uploads, and publication for that world — enforced by the §4.2b contract (step 3d) and the upload path's pre-check. (There is no persisted `complete` state; a finished deletion leaves no job row.)

**The publish race:** A publish that commits between "check for published versions" and "insert deletion job" would leave a world with a published version scheduled for deletion. This is closed by acquiring the world-row lock **before** the version check: publication must hold the world-row lock while checking for an active deletion job (§4.2b step 3d runs inside the publish transaction's locked section), and T1 holds the world-row lock while checking for published versions and inserting the job. The two operations contend on the same lock; one wins, the other sees the winner's committed state.

**Procedure** (locks per §4.3c at each step; each step is a separate committed transaction):

- **T1 — Initiate (locks first, then check):** `BEGIN`. Acquire locks (file-mutating class: 1 → 2 → 3 → 6 → 8 — asset rows for the shared-asset transfer, snapshot-ref rows for the transfer decision; rev 16 — B4.2/B4.3 R6). New-owner world rows are locked at position 3 in ascending `world_id` after the deleted world's row (R6). **While holding the world-row lock:** check for published versions. If any exist → `ROLLBACK`, return **409** `{code: "WORLD_HAS_PUBLISHED_VERSIONS", versions: [...]}`, no job created. If zero:
  1. **Shared-asset ownership transfer (rev 15 — B4.1b):** for each asset of this world with `shared_with_worlds <> '{}'`:
     - `new_owner =` lexicographically smallest `world_id` in `shared_with_worlds` (deterministic).
     - `UPDATE world_media_assets SET world_id = new_owner, shared_with_worlds = array_remove(shared_with_worlds, new_owner), updated_at = now() WHERE asset_id = ?`.
     - These assets are now owned by `new_owner` and are EXCLUDED from this deletion's T2/T3 (T2's `WHERE world_id = ?` no longer matches them). The files are never unlinked; the remaining shares are intact.
  2. **Snapshot-protected assets with no draft shares (rev 16 — B4.2):** for each remaining asset of this world with `shared_with_worlds = '{}'` but with rows in `asset_snapshot_references` (filename-keyed, stable identity):
     - Enumerate candidates and lock asset rows (position 6, `ORDER BY asset_id FOR UPDATE`), then lock the ref rows the decision depends on (position 8, `ORDER BY (filename, snapshot_id) FOR UPDATE` — serializes against snapshot-GC).
     - For each candidate, in filename order: (a) single-owner pre-insert check (`SELECT 1 FROM unattributed_media_files WHERE filename = ?` — inside the level-1 section per the rev-13 protocol; if found → ROLLBACK all of T1, critical alert `DUPLICATE_FILE_REGISTRATION`, 500); (b) compute `:ref_worlds` = distinct snapshot-owning world_ids from the ref rows; (c) `INSERT INTO unattributed_media_files (filename, url, size_bytes, matched_world_id, referencing_worlds, protected, classification_status, notes) VALUES (:filename, :url, :size_bytes, NULL, :ref_worlds, true, 'classified', 'transferred from world deletion ' || :world_id || '; snapshot-protected')`; (d) `DELETE FROM world_media_assets WHERE asset_id = ?`. The INSERT+DELETE commit atomically — no instant of zero/two owners.
     - `asset_snapshot_references` rows are NOT TOUCHED: they key on `filename` and survive the inter-table move by construction.
     - On any statement failure or crash before commit: all of T1 rolls back — registry rows restored, no unattributed rows, no job row, world intact. Retry is safe (the transfer is a pure function of committed state; ref rows never changed).
     - The file stays on disk, servable via the snapshot context (§4.5 step 2). Never auto-deleted.
  3. `INSERT` job row (`state='assets_pending'`). `COMMIT`. (Because the check, the transfers, and the insert happen in the same transaction under the world-row lock, no publish or share-change can interleave — §4.2b requires publish and metadata updates to hold the same locks.)
- **T2 — Mark assets:** Acquire locks (1→2→3→4→6→7, job row first per R1). Lock asset rows first (`SELECT … WHERE world_id = ? ORDER BY asset_id FOR UPDATE`, R2), then `UPDATE world_media_assets SET lifecycle='pending_deletion'`. Lock unattributed rows first (`ORDER BY file_id FOR UPDATE`, R2) for the `array_remove` update — **why position 7 (rev 17 — A12):** unattributed rows carry a `referencing_worlds` array that may contain the deleted world's ID (the file was referenced by the world's drafts or snapshots). T2 removes the deleted world's ID from every such array (`array_remove(referencing_worlds, :world_id)`). Without this, the array would permanently reference a non-existent world — breaking the re-verification recomputation (which expects array members to be live worlds) and leaking the deleted world's ID into future attribution decisions. The update is under the unattributed-row `FOR UPDATE` lock (position 7) so it serializes with concurrent attribution and re-verification. `UPDATE world_deletion_jobs SET state='files_removing', files_total=N, updated_at=now()`. Commit. (Assets are now unreferenceable: §4.2b rejects `pending_deletion` URLs, and the job blocks all new writes.)
- **T3 — Remove files (enumerate-and-stat; per file, each its own transaction):** Acquire locks (1→2→3→4→6 per R1 — job row `FOR UPDATE` before the asset row). Query the job's asset list (`SELECT asset_id, filename FROM world_media_assets WHERE world_id = ? ORDER BY asset_id`). **Defensive:** this query inherently excludes assets transferred to another world in T1 (their `world_id` no longer matches) — but each per-file transaction re-verifies `world_id = ?` on the asset row before unlinking; a mismatch → skip with a critical log (indicates a transfer raced T2, which the lock order forbids — investigate). For each asset: stat the file. If present → `unlink`. If absent → skip (already removed; idempotent). On successful unlink or confirmed-absent: `UPDATE world_deletion_jobs SET files_removed = files_removed + 1, updated_at=now()`; commit. On unlink failure: STOP. Job remains in `files_removing`. Return **500** `{code: "WORLD_DELETION_FILE_FAILED", files_total, files_removed, retryable: true}`.

  **`files_removed` is a progress report, not a recovery offset.** Recovery never uses the counter as an index into the file list. Instead, recovery re-enumerates the asset list from the database and stats each file — a file that is already absent is counted as removed without error. This makes the crash-between-unlink-and-counter-update case safe by construction: the next run stats the file, finds it gone, and moves on. The counter exists for operator visibility and the S10 progress assertions, not for correctness.

- **T4 — Remove rows:** Acquire locks (1→2→3→4→6→7→8, R1; order corrected rev 18 — B10). Lock asset rows first (`ORDER BY asset_id FOR UPDATE`, R2), then unattributed rows (`WHERE :world_id = ANY(referencing_worlds) ORDER BY file_id FOR UPDATE`, R2), then explicitly `DELETE FROM asset_snapshot_references WHERE filename = ANY(<locked filenames>)` (lock-first `ORDER BY (filename, snapshot_id)`, R4 — required now that the cascade is removed), then `DELETE FROM world_media_assets WHERE world_id = ?`. `UPDATE world_deletion_jobs SET state='rows_removing', updated_at=now()`. Commit. (The state stays `rows_removing` after T4's commit. T5 then deletes the world row, which cascades the job row — there is no persisted `complete` state; the job row's absence after T5 is the terminal condition. Recovery for a job found in `rows_removing` verifies zero asset rows remain and then runs T5; it does not "re-run T4" as a terminal step.)
- **T5 — Remove world:** Acquire locks (1→2→3→4→6, R1). Job row `FOR UPDATE` first, then lock-first asset rows (`ORDER BY asset_id FOR UPDATE`, R2) and explicitly `DELETE FROM world_media_assets WHERE world_id = ?` (R3 — the `ON DELETE CASCADE` then finds an empty referencing set and is a no-op safety net). Verify zero rows remain (defensive re-check). `DELETE FROM worlds WHERE world_id = ?` (job row cascades). Commit. Return **204**. The job reaches `complete` implicitly — no job row survives the world deletion, which is itself the completion record. (If an audit trail of completed deletions is required, log at info before the delete; the job table is for in-progress recovery, not history.)

**Per-transaction lock ownership (rev 11):** T1–T5 are separate committed transactions. Transaction-scoped advisory locks (`pg_advisory_xact_lock`) release at each commit — no lock survives from one step to the next, and none is claimed to. The exact lock set re-acquired by each step:

| Step | Locks acquired (in order, per §4.3c) | Filesystem work in this txn | Lock held during syscall |
|---|---|---|---|
| T1 (initiate) | 1 → 2 → 3 → 6 → 8 | Shared-asset transfer + snapshot-protected move; new-owner world rows at 3 ascending (R6); ref-row decision locks at 8 | N/A |
| T2 (mark assets) | 1 → 2 → 3 → 4 → 6 → 7 | Job row (4) first; lock-first ORDER BY for 6, 7 (R1, R2) | N/A |
| T3 (per file) | 1 → 2 → 3 → 4 → 6 | `unlink` of that file (skips transferred assets); job row (4) before asset row (R1) | Level 1 held from this transaction's `BEGIN` through its commit; the unlink executes inside |
| T4 (remove rows) | 1 → 2 → 3 → 4 → 6 → 7 → 8 | Lock-first ORDER BY at 6, 7, 8 (R1, R2, R4; order corrected rev 18 — B10) | N/A |
| T5 (remove world) | 1 → 2 → 3 → 4 → 6 | Lock-first asset DELETE; cascade is no-op safety net (R1, R3) | N/A |

Safety across the commit boundaries comes from **durable state + re-verification**, not from lock continuity: T3 re-stats each file (stat is the source of truth, not the counter); T4's `array_remove` is idempotent; T5 defensively re-checks zero asset rows. A crash between steps leaves the job row in its last committed state, and recovery resumes from the transition table — it never assumes a prior step's locks are still held.

**Recovery-pass lock ownership (rev 11):** the recovery pass is different from the normal path in exactly one respect — it holds a **session-level** level-0 lock for pass-exclusion. The precise arrangement:

1. The worker opens a **dedicated, non-pooled connection** and acquires the level-0 session lock (`pg_try_advisory_lock(hashtext('world_deletion_recovery:' || job_id))` — the non-blocking try variant, rev 18 — B14) once. This lock is session-scoped: it survives transaction commits on that connection and releases only when the session ends (explicit unlock in `finally`, or automatic on crash/disconnect).
2. **Every transaction of the recovery pass executes on that same dedicated connection.** This is mandatory, not incidental — running pass transactions on pooled connections would detach them from the session holding level 0.
3. Within each transaction of the pass, the worker additionally acquires levels 1 → 2 → 3 → 4 via `pg_advisory_xact_lock` (transaction-scoped), **in order after the already-held level 0**. The acquisition order per transaction is therefore 0 (already held, acquired first) → 1 → 2 → 3 → 4: the hierarchy is never inverted.
4. On each transaction's commit, levels 1–4 release automatically; level 0 persists for the next transaction. On pass completion (or crash), the dedicated connection is closed (never returned to the pool), releasing level 0.

**Level 0 does NOT replace level 1.** They protect different things and both are required:
- **Level 0 (session, per-job):** pass-exclusion — no two recovery workers operate on the same job concurrently.
- **Level 1 (transaction, global):** filesystem exclusion — no filesystem mutation occurs except inside a transaction holding level 1 (§4.3d).

A session-level lock at level 0 held across the pass does not satisfy §4.3d's requirement that the *performing transaction* hold level 1 during the syscall. Every `unlink` in the recovery pass therefore occurs inside a transaction that holds **both** level 0 (session, from the dedicated connection) and level 1 (transaction, freshly acquired). The §4.3d syscall-scope table's "World-deletion recovery" row is amended accordingly: "Level 1 acquired in each recovery transaction (after the level-0 session lock, per the ordering); the session lock provides pass-exclusion, level 1 provides per-transaction filesystem exclusion" — both locks, every mutating transaction, no exceptions.

**Unattributed files referencing the deleted world:** `unattributed_media_files` rows are never deleted by world deletion — they live outside the world's ownership (that is why they are in a separate table). However, the deleted world's ID must be removed from their `referencing_worlds` arrays so the record stays truthful. This update is part of T4's transaction (same locks 1→2→3→4), so it commits atomically with the asset-row deletions:

- `UPDATE unattributed_media_files SET referencing_worlds = array_remove(referencing_worlds, :world_id) WHERE :world_id = ANY(referencing_worlds)`.
- **Idempotency:** `array_remove` on an already-absent element is a no-op. If T4 is retried after a crash (recovery re-runs T4 when asset rows remain), the update is safe to repeat — it cannot lose references belonging to other worlds, because it only removes the deleted world's ID.
- **Operator-status protection:** the retry path performs ONLY the `array_remove`. It never issues a blind `UPDATE` of the whole row. If an operator set `classification_status='reviewed'` (or added `notes`) between the original T4 and the retry, those fields are untouched — the retry's `UPDATE` lists only `referencing_worlds` in its `SET` clause.
- After removal: if `referencing_worlds` becomes empty **and** no retained snapshot references the file's URL (re-check under the same locks) → the file is flagged for **operator review** (`classification_status='pending_review'`, `protected=true` retained). It is **never auto-deleted** — an empty `referencing_worlds` means "no known claimant," not "safe to delete." The operator decides: attribute to a world, keep protected, or authorize deletion through the normal §4.3b path after attribution.
- If `referencing_worlds` becomes empty but a snapshot still references the URL → the row stays `protected=true`; the snapshot reference is now recorded in `notes` (the world that owned the snapshot may be gone, but the snapshot row persists per the retention rule, §5.4).
- **Crash around T4:** if the process crashes before T4 commits, nothing changed — recovery re-runs T4 (the `array_remove` is idempotent, the asset-row `DELETE` is idempotent). If it crashes after T4 commits but before T5, recovery finds `rows_removing`, verifies zero asset rows remain, and proceeds to T5 — it does not re-run the unattributed update (the `WHERE :world_id = ANY(referencing_worlds)` clause already excludes rows from which the ID was removed).

**Crash recovery:** On startup, query for all rows in `world_deletion_jobs` — any job row is by definition an incomplete deletion (`complete` is never persisted; only a finished deletion removes the row). For each job, the recovery worker first acquires the **session-level per-job advisory lock** (`pg_try_advisory_lock(hashtext('world_deletion_recovery:' || job_id))`, §4.3c level 0, rev 18 — B14: try-variant, never blocking) — held for the entire recovery pass, across all its transactions. A second recovery worker attempting the same job fails the try-lock (bounded retry → abort + alert) instead of starting a concurrent pass. If the worker crashes, its session ends and the lock is released automatically; the job remains in its last committed state and the next attempt resumes cleanly. Within the pass, each individual state transition additionally takes the job row `FOR UPDATE OF world_deletion_jobs` — the row lock protects the transition, the session lock protects the pass. Resume from the recorded state by walking the transition table below. `files_removed` is a progress report only; on every recovery pass it is **reset to 0 and rebuilt from ground truth** — never incremented on top of a stale value:
- `assets_pending` → re-run T2 (idempotent: setting `pending_deletion` twice is harmless).
- `files_removing` → reset `files_removed = 0`, then **re-enumerate the full asset list** for the world, stat each file, unlink present files, and set `files_removed` to the absolute count of confirmed-removed-or-absent files. The counter is rebuilt from ground truth, not trusted.
- `rows_removing` → verify zero asset rows remain; if any rows remain (T4 never ran or rolled back), run T4 first; then run T5 (delete the world row — the job row cascades, which is the terminal condition; no `complete` row is persisted).

**Recovery transition table** (recovery is a state-machine walk, not "rerun the last transaction" — each step checks the current state and advances to the next):

| Job state at recovery | Action | Next state |
|---|---|---|
| `assets_pending` | Re-run T2 (mark assets `pending_deletion`) | `files_removing` |
| `files_removing` | Reset counter, enumerate-and-stat all assets, unlink present files, set counter to absolute confirmed count | `rows_removing` (via T4) |
| `rows_removing` | Verify zero asset rows remain; if rows remain, run T4; then run T5 (delete world — job row cascades) | Terminal: job row absent |

Every transition is idempotent: each step re-verifies preconditions (asset rows present? files present?) before acting, so a retry after a crash in any transition simply re-applies the same checks. A recovery pass never assumes a prior partial step completed.

The job row is the durable source of truth for *which phase* the deletion is in. The filesystem (via stat) is the source of truth for *which files are gone*. No step trusts a stale counter as an offset into the file list. A world row is never committed as deleted while any asset file remains untracked.

## 5. Quota Accounting and Concurrency

### 5.1 Authoritative quota rule

**There is exactly one definition, used by every path** (upload check, delete, reconciliation, error responses). It counts BOTH committed registry usage AND outstanding reservations — a reservation is bytes the system has promised to a future registry row, and omitting it lets concurrent uploads overspend (rev 19 — B2):

```sql
-- Authoritative per-world admission figure (single definition):
quota_used_bytes(world_id) =
  registered_usage(world_id) + outstanding_reservations(world_id)

registered_usage(world_id) = COALESCE(SUM(size_bytes), 0)
  FROM world_media_assets
  WHERE world_id = :world_id
    AND lifecycle IN ('active', 'pending_deletion')
    AND file_confirmed_present = true

outstanding_reservations(world_id) = COALESCE(SUM(size_bytes), 0)
  FROM storage_reservations
  WHERE world_id = :world_id
    AND state IN ('RESERVED','WRITING')   -- active reservations only (rev 16 — B1.1)
```

**Atomic reservation→registry handoff (rev 19 — B2):** the Phase-2 commit transaction performs BOTH the reservation state change and the registry row insert atomically:
```sql
BEGIN;  -- holds level-1 (commit lock set, §4.3c)
UPDATE storage_reservations
   SET state = 'COMMITTED', released_at = now()
 WHERE reservation_id = :rid AND state IN ('RESERVED','WRITING');
INSERT INTO world_media_assets (world_id, filename, url, mimetype, size_bytes, roles, ...)
VALUES (...);  -- same size_bytes as the reservation
COMMIT;
```
The bytes leave the reservation bucket and enter the registry bucket in the SAME commit — no double-count (a `COMMITTED` reservation is excluded from `outstanding_reservations`), no gap (a missing row would mean the transaction didn't commit, and then the reservation is still `RESERVED`/`WRITING` or was rolled back). If the transaction rolls back, the reservation row is unchanged and the bytes remain counted exactly once as outstanding. On `ABANDONED`, the bytes leave the reservation bucket and enter `abandoned_temp_bytes` (durable SUM, §5.5) — exactly once, never zero and never two. On `ROLLED_BACK`, the bytes leave the reservation bucket and enter nothing: the transition commits only after the file's absence is confirmed via stat, so there are no bytes to count (rev 20 — B8 end-to-end verification: the rev-19 sentence lumped `ROLLED_BACK` with `ABANDONED` here, but `abandoned_temp_bytes` counts only `ABANDONED` rows).

| Category | Counts toward quota? | Reason |
|---|---|---|
| `active` assets, file confirmed present | **Yes** | Live working set |
| `active` assets, file confirmed missing | **No** | Nothing on disk; triggers data-loss alert instead (§9.2) |
| `pending_deletion` assets | **Yes** | File still on disk until removal confirmed; prevents quota evasion |
| Detached assets (unreferenced, still `active`) | **Yes** | On disk; incentivizes proper deletion |
| Active reservations (`RESERVED`/`WRITING`) | **Yes** | Bytes promised to an in-flight upload; prevents concurrent overspend (rev 19 — B2) |
| Committed/abandoned/rolled-back reservations | **No** | Left the outstanding bucket atomically (into registry or abandoned accounting) |
| Quarantined orphans (no registry row) | **No** (toward any world) | Cannot attribute to a world; tracked separately as `unattributed_bytes` for ops visibility |

**Reconciliation input:** `file_confirmed_present` is set `true` at upload. The periodic reconciliation job (§9.4) may set it `false` if the file is missing. Per-request quota checks use the database value — never a live filesystem walk.

**Quota release timing (single rule):** Quota is reclaimed when the deletion-finalization transaction commits. Specifically:
- For the synchronous delete path (§4.3b): quota is released by T2's commit (steps 13–15 are one transaction; the `file_confirmed_present=false` update and the row DELETE commit together). If T2 fails or rolls back after the unlink, the flag update rolls back with it and quota remains counted — temporary overcounting that is safe and accepted. The retry finalizes and releases quota.
- If reconciliation (`repair` mode) discovers a missing file, it sets `file_confirmed_present=false`, which both releases quota and triggers the data-loss alert (§9.2) — two separate consequences of the same state change.
- There is no path where quota is "released at unlink" independent of the finalizing commit. §4.3b, §5.1, S4, and S15 all follow this rule.

**Example error response** (references the config variable):
```json
{
  "error": "World storage quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "quota_exceeded": true,
  "quota_mb": "{MEDIA_WORLD_QUOTA_MB}",
  "used_mb": 47.3
}
```

### 5.2 Limits

- **10 MB per file:** Keep. Matches the existing UI hint.
- **50 MB per world:** Initial default as config value (`MEDIA_WORLD_QUOTA_MB`), not hardcoded. Revisit after observing usage.
- **Enforcement point:** Server-side in `POST /worlds/:id/media`, checked inside the upload transaction (§5.3).

### 5.3 Concurrency control

Two simultaneous uploads could each pass the quota check and collectively exceed it. **Mechanism:** locks per the global ordering (§4.3c), in two phases (§5.5).

**Phase 1 — check-and-reserve (rev 17 — A7):**
1. Acquire the global media advisory lock (level 1): `SELECT pg_advisory_xact_lock(hashtext('media_global'))`.
2. Acquire the per-world quota advisory lock (level 2): `SELECT pg_advisory_xact_lock(hashtext('media_quota:' || world_id))`.
3. Acquire the world row lock (level 3): `SELECT ... FOR UPDATE OF worlds WHERE world_id = ?`.
4. Inside the same transaction: compute `quota_used_bytes(world_id)` per §5.1 — registered usage PLUS outstanding reservations (rev 19 — B2: the old formula counted only registry rows, so two concurrent Phase-1s could both pass against the same 45 MB and overspend); add the in-flight file size, compare against quota; run the capacity check per §5.5 (which reads the durable `storage_reservations` state).
5. If within quota and capacity: INSERT the `storage_reservations` row and COMMIT. All locks release (transaction-scoped). Phase 1 holds level-1 for milliseconds — it never spans the file write.

**Phase 2 — write and commit:** the file write proceeds under Domain R (durable reservation + `flock` handshake, §5.5 — no level-1 held); the commit transaction (rename + asset INSERT + reservation→COMMITTED) re-acquires level-1 per the §4.3c lock set. See §5.5 for the full two-phase protocol.

**Phase-1 lock scope (rev 17 — A7; replaces the stale "Quota reservation" paragraph):** the per-world quota advisory lock (level 2) is held only for the duration of the Phase-1 transaction — from the check-and-reserve through the reservation-row commit. It does NOT span the file write. The durable `storage_reservations` row (not the advisory lock) is what prevents overspend during the write: the capacity check counts `active_reservations_bytes` from committed rows, so a concurrent Phase-1 sees the reservation even though the first upload's level-2 lock is long released. The term "reservation" in this ADR always means the `storage_reservations` row, never the advisory-lock hold.

The delete path (§4.3b) acquires the same Phase-1 locks in the same order before its quota-affecting state transition, so the S6 upload/delete race serializes correctly: whichever commits first, the other's quota computation sees the updated state.

**Why advisory locks over `FOR UPDATE` on a quota row:** No natural per-world quota row exists to lock. Advisory locks achieve serialization without a schema change. Both are transaction-scoped (`pg_advisory_xact_lock`), so a crashed backend releases them automatically — no stale-lock cleanup needed.

### 5.4 Snapshot retention rule

**All published canon snapshots are retained indefinitely.** Canon immutability is the platform's core guarantee.

**Eligible for deletion:** Only assets in `pending_deletion` whose file removal is confirmed. Since snapshots are never pruned in MVP, any asset referenced by any published version can never enter `pending_deletion` (the reference scan in §4.3b will find it).

**Snapshot GC is specified but DORMANT in MVP (rev 17 — A4/A23):** the GC transaction (§4.1, §4.7c: locks 1 → 8, same-transaction ref-row cleanup) is fully specified so the design is complete, but NO pruning job exists in the MVP and none is authorized by this ADR. Consequences, stated plainly:
- `asset_snapshot_references` rows are NEVER deleted in MVP (no GC transaction runs). The table grows monotonically with publishes.
- S46(h)'s GC simulation tests the specified-but-dormant transaction — it proves the transaction is correct IF pruning is ever enabled, not that pruning happens.
- If a future version introduces snapshot pruning, this section AND the GC authorization must be revisited via ADR amendment — enabling the dormant transaction without amendment is a spec violation.
- Storage growth from retained snapshots is bounded by publish frequency, not by time — the capacity plan (§5.5) must size for monotonic snapshot growth.

If a future version introduces snapshot pruning, this section must be revisited.

### 5.5 Operational storage-capacity metric (rev 12 — complete physical accounting)

The §5.1 quota formula answers "how much of *this world's* allocation is used." It does not answer "is the disk full." The rev-11 capacity metric counted managed bytes but missed unregistered files, had no staleness bound, and did not account for concurrent or incoming writes. This section corrects all three.

| Metric | Scope | Answers | Enforced where |
|---|---|---|---|
| `quota_used_bytes` (§5.1) | Per world | Fair allocation across creators | Upload path (507 `QUOTA_EXCEEDED`) |
| `storage_used_bytes` (this section) | Per volume | Physical exhaustion (managed) | Upload path (507 `STORAGE_FULL`); health; alerts |
| `filesystem_used_percent` (this section) | Per volume | Actual OS-reported utilization | Health; alerts (MAX with managed percent) |

**Complete physical accounting (rev 13):** Every byte on the volume is counted in exactly one category at any instant. The invariant is: **no byte is counted twice, no byte is uncounted.** The categories form a partition:

```
storage_used_bytes = registry_bytes            -- SUM(size_bytes) FROM world_media_assets WHERE file_confirmed_present
                   + unattributed_bytes        -- SUM(size_bytes) FROM unattributed_media_files
                   + quarantine_bytes          -- du -sb /data/media/.quarantine/
                   + abandoned_temp_bytes      -- NEW (rev 13): temp files with no live reservation (see below)
                   + unregistered_bytes        -- files on disk with no row in either table (excludes temp files)
                   + filesystem_overhead_bytes -- reserved for filesystem metadata (configurable, default 5% of capacity)
```

**Authoritative accounting treatment per upload state (rev 13 — B1.1):** An in-flight upload's bytes are in exactly one accounting category at any instant. The transitions are:

| Upload state | Bytes counted in | Transition trigger |
|---|---|---|
| Reservation created, no bytes written yet | `active_reservations_bytes` (NOT in `storage_used_bytes`) | Reservation row committed (durable) |
| Temp file being written / written | `active_reservations_bytes` (temp file EXCLUDED from `storage_used_bytes`) | First byte hits disk |
| Upload transaction commits | `COMMITTED` state (counted nowhere as a reservation; the file is now a registry file — see measurement-freshness bound) | Commit transaction: asset-row INSERT + `state='COMMITTED'` in ONE transaction |
| Upload transaction rolls back | Nothing (temp file confirmed deleted via stat before the state transition commits) | Rollback path: stat confirms deletion, then `state='ROLLED_BACK'` |
| Process crashes mid-upload | `active_reservations_bytes` until the expiry claim finalizes; then `abandoned_temp_bytes` (durable, via the row) | Expiry claim CAS (see B1.2) |
| ENOSPC during write, cleanup succeeds | Nothing | Temp file confirmed deleted, `state='ROLLED_BACK'` |
| ENOSPC during write, cleanup FAILS | `abandoned_temp_bytes` (durable — one UPDATE transitions the row) | Cleanup failure detected; `state='ABANDONED'` in one transaction |

**Critical rule (no double-counting):** Temp files (`/data/media/.tmp/*`) are EXCLUDED from `storage_used_bytes`. The `active_reservations_bytes` term covers them. The capacity check is:

```
effective_available = storage_capacity_bytes
                    - storage_used_bytes
                    - active_reservations_bytes
```

where `active_reservations_bytes = SUM(size_bytes FROM storage_reservations WHERE released_at IS NULL)`.

There is no `staging_bytes` term — it was the source of the rev-12 double-counting defect (temp file bytes counted in both `staging_bytes` and the reservation). The reservation IS the staging accounting.

**Capacity definitions (rev 13 — B1.4):**
- `storage_capacity_bytes`: the application's configured usable capacity (operator-set via `STORAGE_CAPACITY_BYTES`, MUST be ≤ volume size). This is the enforcement boundary — the number the capacity check uses. It is a configuration value, not a measured value.
- `filesystem_overhead_bytes`: planning reserve WITHIN the managed accounting (`STORAGE_OVERHEAD_RESERVE_PERCENT` of `storage_capacity_bytes`, default 5%). It reduces `effective_available`; it does not claim the OS reserves exactly this amount.
- `filesystem_used_percent`: independent OS signal from `statvfs` on `/data/media/`. NOT derived from managed accounting. Alerts fire on `MAX(storage_used_percent, filesystem_used_percent)` where `storage_used_percent = storage_used_bytes / storage_capacity_bytes`. If the OS reports higher utilization than our accounting (other processes, unmeasured overhead), the OS wins — the discrepancy itself triggers an investigation alert (`ACCOUNTING_DIVERGENCE`).

- `unregistered_bytes`: the periodic job lists every file under `/data/media/` (excluding `.quarantine/` and active temp files) and checks for a row in either table. Files with no row → summed here. This closes the rev-11 gap where a crash-created orphan had no row and was therefore invisible to the metric. The S9 contradiction is resolved: `diagnose` (read-only) *logs* the orphan at warning; the *periodic capacity job* (which performs the filesystem scan) *accounts* for its bytes in `unregistered_bytes`. Logging and accounting are separate operations by separate components.
- `filesystem_overhead_bytes`: a configurable reservation (default: 5% of `storage_capacity_bytes`, via `STORAGE_OVERHEAD_RESERVE_PERCENT`). Accounts for filesystem metadata, journal, and fragmentation overhead that `du` does not capture. This is a planning reserve, not a measured value.
- `filesystem_used_percent`: from `statvfs` on `/data/media/` (actual OS-reported utilization). This captures what the managed metric cannot: bytes consumed by other processes, filesystem overhead beyond the reserve, and measurement error. **Alerts fire on `MAX(storage_used_percent, filesystem_used_percent)`** — whichever is higher. If the OS says 95% but we count 80%, the OS wins.

**Cache age enforcement (fail-closed):** The metric is computed by a periodic job (default every 5 minutes). The cached value carries `measured_at`.

- **Max age:** `STORAGE_METRIC_MAX_AGE_SEC` (default 300 = 5 minutes, matching the job interval).
- **If the cached metric is older than max age** (job failed, job delayed, clock skew): uploads are REJECTED with **503** `{code: "STORAGE_METRIC_STALE", retryable: true}`. The stale metric does NOT authorize writes. This is fail-closed: no fresh measurement = no new files.
- **If the last measurement failed** (scan error, DB error): same 503. A failed measurement is treated as stale, not as "last known good."
- **Health exposure:** `/health` → `"media_storage": {"used_bytes": N, "capacity_bytes": M, "used_percent": P, "filesystem_percent": F, "measured_at": "...", "stale": false}`. If stale, `"stale": true` and the health status is `degraded`.

**Concurrency-safe capacity reservation (rev 13 — B1.2):** The cached metric alone cannot prevent concurrent uploads from overspending. The reservation system closes this, with a durability contract that survives crashes:

```sql
CREATE TABLE storage_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id       UUID NOT NULL,
  size_bytes     BIGINT NOT NULL,
  temp_filename  TEXT,  -- audit only (rev 14); safety decisions use the deterministic path
  state          TEXT NOT NULL DEFAULT 'RESERVED'
                   CHECK (state IN ('RESERVED','WRITING','ABANDONED','COMMITTED','ROLLED_BACK','CLEANED')),
                 -- DURABLE accounting category (rev 15 — B1.1). The capacity query derives
                 -- categories SOLELY from this column. No filesystem scan is load-bearing
                 -- for the accounting handoff.
  epoch          BIGINT NOT NULL DEFAULT 0,
                 -- heartbeat generation counter (rev 15 — B1.2). Incremented on every
                 -- heartbeat. Expiry claims use compare-and-swap on epoch.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  released_at    TIMESTAMPTZ,  -- set when the reservation leaves active accounting
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_epoch    BIGINT,       -- epoch observed when the expiry claim finalized (audit)
  claim_finalized_at TIMESTAMPTZ,  -- when state transitioned to ABANDONED via expiry (audit)
  -- State/timestamp consistency (rev 16 — B1.1): the state column ALONE determines
  -- the accounting category. These constraints make released_at a provable function
  -- of state — no row can exist in a combination that would silently omit or
  -- double-count bytes.
  CHECK (
    (state IN ('RESERVED','WRITING') AND released_at IS NULL)
    OR
    (state IN ('ABANDONED','COMMITTED','ROLLED_BACK','CLEANED') AND released_at IS NOT NULL)
  ),
  -- Claim audit columns are meaningful only for abandonments; they travel together.
  CHECK (
    (claim_epoch IS NULL AND claim_finalized_at IS NULL)
    OR
    (claim_epoch IS NOT NULL AND claim_finalized_at IS NOT NULL AND state = 'ABANDONED')
  ),
  CHECK (size_bytes > 0),
  CHECK (epoch >= 0)
  -- A reservation is "active" iff state IN ('RESERVED','WRITING') — provably
  -- equivalent to released_at IS NULL by the first CHECK above.
  -- Crash safety: the row is durable (committed before any bytes are written).
);
CREATE INDEX ON storage_reservations (expires_at) WHERE released_at IS NULL;
```

**Durable capacity accounting (rev 15 — B1.1):** The reservation-attributable categories are derived SOLELY from database state — no filesystem scan participates:

```sql
-- Active (in-flight) reservations: bytes not yet committed, still protected.
-- Predicate is on state — the authoritative accounting category (rev 16 — B1.1).
active_reservations_bytes = SUM(size_bytes) FROM storage_reservations WHERE state IN ('RESERVED','WRITING');
-- (Provably equivalent to released_at IS NULL by the state/timestamp CHECK constraint.)

-- Abandoned temp files: bytes durably counted via the reservation row's size_bytes.
-- Conservative: size_bytes is the reserved (maximum) size, >= actual partial bytes on disk.
abandoned_temp_bytes      = SUM(size_bytes) FROM storage_reservations WHERE state = 'ABANDONED';
```

The periodic scan additionally measures `abandoned_temp_bytes_measured` (actual bytes in `/data/media/.tmp/` with no active reservation). Its roles are (a) targeting cleanup, (b) the `ACCOUNTING_DIVERGENCE` cross-check — if measured > durable, bytes exist with no responsible row and the operator investigates. The scan is NEVER the load-bearing mechanism for capacity protection; the durable row is.

**Two-phase reservation protocol (durable before writes):**

*Phase 1 — Reserve (separate committed transaction, BEFORE any bytes are written):*
1. BEGIN; acquire level-1 global lock (`pg_advisory_xact_lock`, §4.3c).
2. Verify cached metric is fresh (not stale). If stale → 503 `STORAGE_METRIC_STALE`, ROLLBACK.
3. Compute `effective_available` per the formula above (using only *active* reservations).
4. If `effective_available < incoming_file_size` → 507 `STORAGE_FULL`, ROLLBACK.
5. INSERT the reservation row (with `temp_filename=NULL`, `expires_at = now() + 5 min`).
6. COMMIT. **The reservation is now durable and visible to all competitors.** Level-1 lock released.

*Phase 2 — Write and commit:*
7. Write temp file bytes to `/data/media/.tmp/{reservation_id}.part`. After the temp file is created, UPDATE the reservation: `SET temp_filename = ?, last_heartbeat_at = now()`.
8. For uploads expected to exceed 4 minutes, the worker MUST heartbeat: `UPDATE storage_reservations SET epoch = epoch + 1, expires_at = now() + interval '5 minutes', last_heartbeat_at = now() WHERE reservation_id = ? AND released_at IS NULL` at least every 2 minutes. (Rev-16 fix: the heartbeat MUST increment `epoch` — the B1.2 claim protocol's compare-and-swap depends on it. A heartbeat without the increment is a correctness bug.) A reservation whose `expires_at` passes without heartbeat is eligible for expiry cleanup — but see the safety rule below.
9. On upload transaction commit — the durable handoff (rev 15 — B1.1): in the SAME commit transaction as the asset-row INSERT, execute `UPDATE storage_reservations SET state = 'COMMITTED', released_at = now() WHERE reservation_id = ?`. The reservation leaves `active_reservations_bytes` at the exact instant the asset row becomes durable — one transaction, one commit, no scan in between. The file is now a registry file; its bytes enter `registry_bytes` via the row's `size_bytes` (exact from the database — no measurement lag for the DB-derived sum). Until the periodic scan confirms the file on disk, the row's `file_confirmed_present` handling follows §4.4.
10. On rollback: stat the temp file to confirm deletion (ENOENT), then in the same rollback-completion step `UPDATE storage_reservations SET state = 'ROLLED_BACK', released_at = now()`. The state transition commits only after confirmed deletion — there is no instant where bytes exist but are counted nowhere.

**Commit-transition size semantics (rev 16 — B1.1):** the reservation's `size_bytes` is the *reserved upper bound* (what the capacity check held); the asset row's `size_bytes` is the *actual file size* (from `stat` after fsync, before commit). The commit transaction performs both the asset-row INSERT (actual size) and the reservation's `state = 'COMMITTED'` transition — no instant where both count the bytes, none where neither does. The difference (reserved − actual) returns to available capacity atomically. Accounting is conservative at every instant: it never counts fewer bytes than the file can occupy.

**What the database can and cannot prove at commit (honest boundary, rev 16):** the transaction proves the OWNERSHIP handoff is atomic. It does NOT prove the file's bytes are physically complete on disk — that is established BEFORE the transaction by the write path (`fsync` file + `fsync` directory + `stat` confirming `size > 0`). If the volume fails between the fsync and the commit, the row commits with a missing file — and §4.4/§9.4 reconciliation flags it (`FILE_UNEXPECTEDLY_ABSENT`, data-loss alert). The design does not claim the database makes the filesystem durable; it claims the accounting handoff has no gap, and that a missing file is always detectable and alerted, never silently absorbed.

**Why two phases (not inside the upload transaction):** An uncommitted reservation is invisible to competitors under READ COMMITTED. If the reservation were created inside the upload transaction, two concurrent uploads could both pass the capacity check before either commits. The Phase-1 commit makes the reservation durable and visible BEFORE any bytes are written — this is what makes the capacity check sound under concurrency. The level-1 lock in Phase 1 serializes the check-and-reserve sequence.

**Safe expiry (rev 15 — B1.1, B1.2):** A reservation leaves active accounting ONLY via a durable state transition. The expiry worker never "deletes" a reservation to release protection — it transitions the row's `state`, and the capacity query follows the state. The permitted transitions:

- (a) `released_at IS NOT NULL` already (committed, rolled back, previously abandoned, or cleaned) — expiry is hygiene only; nothing to protect.
- (b) No bytes ever written: deterministic temp path stats as ENOENT (absent) → `UPDATE ... SET state = 'ROLLED_BACK', released_at = now()`. Nothing on disk; nothing to count. (The `temp_filename` column is not consulted — audit only.)
- (c) File absent from disk (verified by stat on the deterministic path) → same as (b): `state = 'ROLLED_BACK'`, `released_at = now()`.
- (d) File present on disk → the reservation is NOT silently released. The bytes are reclassified via the race-safe claim protocol below: on a successful claim, ONE transaction executes `UPDATE ... SET state = 'ABANDONED', released_at = now(), claim_epoch = ?, claim_finalized_at = now()`. The capacity protection transfers from `active_reservations_bytes` to `abandoned_temp_bytes` in that single commit — never dropped, never dependent on a scan.

**Rule:** Expiry NEVER drops capacity protection while bytes may remain on disk. Every path out of active accounting is a durable `state` transition; the accounting query reads the state. There is no path where bytes on disk are counted in neither category, because the categories are two views of the same row's state column.

**Crash-safe reservation state machine (rev 14 — B1):** The rev-13 rule (b) was unsafe: a process can create the temp file and crash BEFORE persisting `temp_filename`. The expiry worker would see `temp_filename IS NULL`, conclude "no bytes written," and release capacity protection — while the orphaned temp file still consumes bytes. The fix:

**Deterministic temp path (rev 14):** The temp file path is derived SOLELY from the reservation ID: `/data/media/.tmp/{reservation_id}.part`. The upload path MUST use this exact path — no alternatives, no configurable temp names. This is a hard requirement, not a convention. The `temp_filename` column is now informational/audit only; it is NOT load-bearing for safety decisions.

**Writer liveness obligations (rev 16 — B1.2):** A heartbeat timestamp alone cannot distinguish "crashed" from "slow," and a state check alone cannot close the check-then-write race (the rev-15 gap: writer validates `state=active`, claim commits, writer's in-flight chunk lands post-abandonment). The writer therefore has three obligations — liveness proof, fenced writes, abort discipline:

1. **Heartbeat with epoch:** at least every 2 minutes while the upload is in flight:
   ```sql
   UPDATE storage_reservations
      SET epoch = epoch + 1,
          expires_at = now() + interval '5 minutes',
          last_heartbeat_at = now()
    WHERE reservation_id = ? AND released_at IS NULL;
   ```
   If 0 rows are updated → the reservation is no longer active (claimed, committed, or rolled back) → the writer MUST abort: stop writing immediately, release any file lock, attempt temp-file cleanup (best-effort), return an error to the caller. Continuing to write after a 0-row heartbeat is a correctness bug. The heartbeat takes no file lock (DB-only); races with the expiry claim are resolved by the claim's `WHERE epoch = $E1` compare-and-swap.
2. **Fenced chunk writes:** the writer opens the deterministic path ONCE per upload (`O_CREAT|O_WRONLY|O_APPEND`) and keeps the fd for the whole upload. For EVERY chunk, in this exact order:
   a. `flock(fd, LOCK_SH)` — shared lock on the temp file.
   b. `SELECT state, released_at FROM storage_reservations WHERE reservation_id = ?` — re-validate under the lock.
   c. If `state` is not `RESERVED`/`WRITING`, or `released_at IS NOT NULL` → `flock(fd, LOCK_UN)`, close, abort as in obligation 1. No bytes are written.
   d. `write(fd, chunk)` — the single in-flight syscall.
   e. `flock(fd, LOCK_UN)` — release immediately; NEVER hold the shared lock across chunks.

   The lock makes "validate + write" atomic with respect to the expiry claim (which must hold `LOCK_EX` to finalize). The per-chunk cost is two `flock` syscalls plus the SELECT the writer already performed — cheap, and no DB lock is held during the upload (the level-1 constraint is untouched). Holding `LOCK_SH` across chunks is forbidden: it would block legitimate claims and pin capacity after a crash (the kernel releases the lock on process death, which is what lets the claim proceed for a dead writer).
3. **Fenced commit and rollback:** the commit sequence (temp→final rename + the INSERT/UPDATE commit transaction) and the voluntary-rollback sequence execute while holding `LOCK_SH`. The commit transaction's reservation UPDATE MUST be:
   ```sql
   UPDATE storage_reservations
      SET state = 'COMMITTED', released_at = now()
    WHERE reservation_id = ? AND released_at IS NULL AND state IN ('RESERVED','WRITING');
   ```
   and the writer MUST verify exactly 1 row was affected — if 0 rows, the reservation was claimed or rolled back concurrently: ROLLBACK the entire commit transaction (including the asset-row INSERT) and abort. Committing an asset row against a non-active reservation is a correctness bug. (Lock-order note: both writer and expiry worker acquire the file lock BEFORE any DB row lock — file→DB in both parties — so the fenced commit cannot deadlock with the fenced claim.)

   **Lock-release ordering — every exit path (rev 17 — A18):** `LOCK_SH` for the commit/rollback sequence is released AFTER the database transaction's COMMIT or ROLLBACK completes — on EVERY exit path, without exception:
   - Normal commit: COMMIT → `flock(fd, LOCK_UN)` → close fd.
   - 0-row abort: ROLLBACK completes → `flock(fd, LOCK_UN)` → close fd → abort. (The ROLLBACK must finish first: releasing the lock while the transaction is still open would let a claim finalize against a reservation the writer still believes it owns.)
   - SQL error mid-commit (constraint violation, connection error): the error handler ROLLBACKs → then releases the lock → then closes. The release MUST be in a `finally`/deferred block, not after the success path only.
   - Exception in the rename or fsync: same — ROLLBACK (if a transaction is open), then unlock, then close, then propagate.
   - Process termination: the kernel releases `LOCK_SH` on death; the transaction is rolled back by the database on session end. No action needed, but no invariant depends on cleanup code running.
   
   **Normative:** releasing `LOCK_SH` before the commit/rollback transaction ends is a correctness bug — the proof's "no write after finalization" depends on the writer never holding the lock across a state change it didn't observe, AND never dropping the lock while its own terminal transaction is still open (a claim could finalize between the unlock and the COMMIT, and the writer's commit would then land against an abandoned reservation — the 0-row guard catches it only if the UPDATE hasn't executed yet). The fd is closed AFTER the lock is released. **Invariant protected:** no terminal state transition commits while the writer holds `LOCK_SH` across an open transaction it might still commit. **Proving scenario:** S52 (fencing failure cases — lock released before commit is detected as a spec violation in review; kill -9 at each boundary).

**Temp-path identity invariant (rev 17 — A17):** The deterministic temp path `/data/media/.tmp/{reservation_id}.part` for a reservation with `released_at IS NULL` (active) is NEVER unlinked, renamed, or replaced except by: (a) the owning writer's commit sequence (rename temp→final, while holding `LOCK_SH`); (b) the owning writer's voluntary rollback (unlink after the `ROLLED_BACK` transition commits, while holding `LOCK_SH`); or (c) the abandoned-temp cleanup job acting on a `state='ABANDONED'` row — whether the ABANDONED origin is the expiry claim (claim finalized under `LOCK_EX`) or fence-activation invalidation (rev 20 — B8). For the invalidation origin, the writer may still be alive when the job unlinks: this is POSIX-safe (unlink of an open file removes the directory entry; an in-flight `write()` lands in the unlinked inode, invisible and reclaimed on close), and the row's `size_bytes` conservatively covers any such bytes in `abandoned_temp_bytes`. No other path touches it:
- The orphan scan (`/data/media/.tmp/` files with NO reservation row) only processes files with no row at all — a file with an active reservation row is not an orphan by definition.
- `repair` quarantine moves only orphans (no active reservation row).
- Startup crash recovery stats the path but never unlinks it — it transitions row state; the claim protocol decides deletion.
- The expiry worker never unlinks the temp path during the claim (it only unlinks files it created, and this protocol creates none — `O_CREAT` is forbidden).

This invariant is what makes the step-5a inode comparison meaningful: if the path changed between stat and open while the reservation is active, the only compliant explanations are the writer's own commit/rollback — both of which the sub-protocols handle. Any other change is a contract violation, and the claim aborts fail-closed.

**Race-safe expiry claim protocol (rev 16 — B1.2, rev 17 — A16/A17):** The rev-15 epoch compare-and-swap closed the heartbeat race but not the write race: a writer that validated `state=active` could have the claim commit underneath it and land its in-flight chunk post-abandonment. Timing bounds cannot close a check-then-act race across the DB/filesystem boundary. The rev-16 protocol separates two questions and answers each with the right primitive: *liveness* ("is the writer alive?") with the rev-15 epoch/observation/mtime evidence, and *safety* ("is a write in flight right now, and can one follow finalization?") with a POSIX file-lock handshake on the deterministic temp path. Rev 17 closes the remaining holes: the `O_CREAT` lock-target hole (replaced by the safe-open protocol above), the lock-release-before-commit hole (A16: normative hold-through-commit), and the rename-window hole (documented CAS-decided outcome).

1. **Candidate selection:** `SELECT reservation_id, epoch, size_bytes FROM storage_reservations WHERE released_at IS NULL AND expires_at < now()`. Record `E1 = epoch`, `T1 = now()`.
2. **Observation wait:** at least 60 seconds must elapse between `T1` and the claim attempt. (The worker processes other candidates meanwhile; it must not busy-wait on one reservation.)
3. **Re-read:** `SELECT epoch, state, released_at FROM storage_reservations WHERE reservation_id = ?`.
   - If `released_at IS NOT NULL` → done (committed, rolled back, or claimed by another worker).
   - If `epoch != E1` → the writer heartbeated during the observation window → writer is alive → skip this cycle (optionally extend `expires_at` by 5 minutes to avoid immediate re-selection).
4. **File-mtime grace:** stat the deterministic path `/data/media/.tmp/{reservation_id}.part`.
   - If stat fails with a non-ENOENT error → do not claim; log at error; retry next cycle. Fail closed.
   - If stat succeeds but file mtime is NEWER than `T1 - 120s` → the file was modified recently; the writer may be alive with delayed heartbeats → DO NOT CLAIM this cycle. Log at info with `reservation_id`.
   - If stat returns ENOENT → no bytes observed → proceed to the fenced claim, which re-verifies under the lock (a writer may create the file between this stat and the lock acquisition).
5. **Fenced claim — safe open protocol (rev 17 — A17):** `flock` locks the open file description (inode), not the pathname. Opening with `O_CREAT` to "create a lock target" is UNSAFE: if the writer renamed the temp file away (commit in progress) between the step-4 stat and the open, `O_CREAT` creates a NEW empty file at the path — a different inode than the writer's fd — and the resulting `LOCK_EX` excludes nothing. The worker MUST establish inode identity between the step-4 stat and the locked fd. The protocol:
   a. **Open WITHOUT `O_CREAT`:** `open(path, O_RDONLY)`. `O_CREAT` is forbidden in the claim path — there is no case where creating a file to lock it is correct.
      - Step-4 stat succeeded, open succeeds → `fstat(fd)`; compare `(st_dev, st_ino)` with the step-4 stat result. If different → the path was REPLACED between stat and open → ABORT the claim for this cycle (log at error, `INODE_REPLACED`, fail closed; retry next cycle). If identical → the fd is the file that was statted → proceed to (b).
      - Step-4 stat succeeded, open fails with ENOENT → the path VANISHED between stat and open: the writer renamed it (commit sequence) or unlinked it (voluntary rollback). → "Path-vanished" sub-protocol below. (Any other open error → abort, log at error, retry next cycle. Fail closed.)
      - Step-4 stat returned ENOENT, open fails with ENOENT → confirmed absent → "Path-absent" sub-protocol below.
      - Step-4 stat returned ENOENT, open SUCCEEDS → the file was CREATED between stat and open → a writer is active (it opened the path after our stat) → ABORT the claim for this cycle (log at info, `FILE_APPEARED`). Do not proceed — the writer's liveness evidence was stale.
   b. `flock(fd, LOCK_EX | LOCK_NB)` — non-blocking, NEVER blocking. If it fails with `EWOULDBLOCK` → a writer holds `LOCK_SH`: a chunk validate+write is in flight RIGHT NOW → ABORT the claim for this cycle (not a deferred timeout — an abort; retried next ≥60 s cycle). Log at info with `reservation_id`, `reason: "write_in_flight"`. This enforces property (a): the terminal UPDATE in step (c)/(d) executes only inside this exclusive-lock critical section, so it cannot commit while any `write()` is in flight. If the lock holder is a crashed writer, the kernel has already released its lock — the next cycle succeeds.
   c. `fstat(fd)` (on the identity-verified fd): if `size > 0` → bytes branch. If `size == 0` → the file existed at step 4 but is empty (a writer opened it but wrote nothing yet, or a 0-byte upload) → bytes branch as well (never unlink a file the worker did not create — the worker creates nothing in this protocol). The no-bytes branch is taken ONLY via the path-absent sub-protocol.
   d. **Bytes branch — claim.** Execute while still holding `LOCK_EX`:
      **Fenced DB section (rev 18 — B6):** the expiry claim is a background writer — it MUST honor the maintenance fence and the canonical lock order (file `LOCK_EX` → level-1 → terminal UPDATE, per the §4.3c table). Before the CAS UPDATE below:
      ```sql
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('media_global'));  -- level-1, per the background-writer rule
      ```
      If `is_maintenance_active()` returns true → `ROLLBACK`; `flock(fd, LOCK_UN)`; close; ABORT the claim for this cycle (log at info, `maintenance_fence_active`; no state change; retry next cycle). The CAS UPDATE below executes inside this level-1-holding transaction; on 1 row → COMMIT (with `LOCK_EX` still held per A16); then `flock(fd, LOCK_UN)`; close.
      ```sql
      UPDATE storage_reservations
         SET state = 'ABANDONED', released_at = now(),
             claim_epoch = $E1, claim_finalized_at = now()
       WHERE reservation_id = $id AND epoch = $E1 AND released_at IS NULL
         AND state IN ('RESERVED','WRITING');
      ```
      - If 0 rows → a heartbeat incremented `epoch` (or another worker claimed/rolled back) between step 3 and now → abort the claim; `flock(fd, LOCK_UN)`; close. The writer is alive or handled.
      - If 1 row → claim finalized. **The `LOCK_EX` MUST remain held until this transaction's COMMIT completes (rev 17 — A16); releasing the file lock between the UPDATE and the COMMIT is a correctness bug — a writer could acquire `LOCK_SH`, validate against the pre-commit state, and `write()` before the abandonment commits.** From the commit instant, the bytes are durably counted in `abandoned_temp_bytes` via the row's `size_bytes` (conservative: reserved size ≥ actual bytes, including any chunk that landed before finalization). Log at warning with `reservation_id`, `size_bytes`, `claim_epoch`. Then `flock(fd, LOCK_UN)`; close.
      - On any error before COMMIT → ROLLBACK the transaction FIRST, then `flock(fd, LOCK_UN)`, then close. The lock is never released while the transaction is still open.
   e. **No-bytes branch — path-absent sub-protocol.** The path was confirmed absent at both the step-4 stat and the step-5a open — there is no file to lock, so this branch executes WITHOUT the file lock. Safety comes from the CAS plus the writer's chunk-1 validation (below), not from the lock.
      **Fenced DB section (rev 18 — B6):** `BEGIN; SELECT pg_advisory_xact_lock(hashtext('media_global'));` (level-1, per the background-writer rule). If `is_maintenance_active()` returns true → `ROLLBACK` and abort this branch (no UPDATE; no file lock to release; log at info, `maintenance_fence_active`). The CAS below executes inside the level-1-holding transaction.
      ```sql
      UPDATE storage_reservations
         SET state = 'ROLLED_BACK', released_at = now()
       WHERE reservation_id = $id AND epoch = $E1 AND released_at IS NULL
         AND state IN ('RESERVED','WRITING');
      ```
      - If 0 rows → abort (writer heartbeated or raced); done. (No file was created by the worker; nothing to clean.)
      - If 1 row → `ROLLED_BACK` committed. **Post-commit re-stat (rev 17 — A17):** stat the path once more AFTER the commit. If a file now exists → a writer won the race between our open-ENOENT and the CAS commit (it opened the path and its chunk-1 validation saw the still-active reservation). The reservation MUST NOT stay `ROLLED_BACK` with an uncounted file on disk: immediately execute a follow-up `UPDATE ... SET state = 'ABANDONED', released_at = now() WHERE reservation_id = $id` (the file exists; count it conservatively). Log at warning. If the path is still absent → `ROLLED_BACK` stands; the transition committed only after the file's absence was confirmed twice (stat + open) — there is no instant where bytes exist but are counted nowhere.
      - **Writer-side safety for this race:** a writer that opens the path after our CAS commit takes `LOCK_SH`, validates under the lock, observes `ROLLED_BACK` → aborts WITHOUT writing (obligation 2c). A writer whose chunk-1 validation ran BEFORE our CAS commit saw `active`, wrote one chunk, and its chunk-2 validation observes the terminal state → aborts. At most one chunk can land in this race, and the post-commit re-stat converts the row to `ABANDONED` so even that chunk is durably counted. The orphan scan is the backstop, never the primary mechanism.
   f. **Path-vanished sub-protocol.** The file existed at the step-4 stat but is gone at open: the writer renamed it (commit sequence: temp→final) or unlinked it (voluntary rollback). Do NOT create a lock target. Proceed to the CAS directly WITHOUT the file lock — the writer is past its chunk loop (rename/rollback happen after the last chunk), so no `write()` can land; the only remaining race is DB-level (writer's terminal UPDATE vs our claim UPDATE), which the CAS decides.
      **Fenced DB section (rev 18 — B6):** `BEGIN; SELECT pg_advisory_xact_lock(hashtext('media_global'));` (level-1, per the background-writer rule). If `is_maintenance_active()` returns true → `ROLLBACK` and abort (no UPDATE; log at info, `maintenance_fence_active`). The CAS below executes inside the level-1-holding transaction.
      ```sql
      -- (rev 18 — B9): claim columns MUST stay NULL here. The CHECK constraint
      -- permits (claim_epoch, claim_finalized_at) NOT NULL only with
      -- state = 'ABANDONED'; this transition is ROLLED_BACK (the temp file is
      -- gone — there is nothing to clean up in .tmp/), so setting them would
      -- violate the constraint and PostgreSQL would reject the UPDATE.
      UPDATE storage_reservations
         SET state = 'ROLLED_BACK', released_at = now()
       WHERE reservation_id = $id AND epoch = $E1 AND released_at IS NULL
         AND state IN ('RESERVED','WRITING');
      ```
      - If 0 rows → the writer's terminal UPDATE committed first (COMMITTED or its own ROLLED_BACK) → abort; done. The writer's outcome stands.
      - If 1 row → our claim won the rename race. **Documented outcome (rev 17 — A17):** the writer's commit transaction will find 0 rows on its reservation UPDATE → it ROLLBACKs the entire commit transaction INCLUDING the asset-row INSERT (obligation 3). The renamed file at the FINAL path has no registry row → it is an orphan → §9.4 reconciliation (reference-check; quarantine, never auto-delete). The reservation is `ROLLED_BACK`; the file is counted in `unregistered_bytes` until reconciled. No byte is uncounted; no write lands post-claim (the writer is in its commit sequence, not its chunk loop).
      - **Why this is safe without the file lock:** the flock exclusion is void in this window (the writer's fd is on the renamed inode), but it is also UNNEEDED — the property to protect is "no `write()` after finalization," and the writer has no more `write()` calls to make. The CAS provides the single decider for the DB state; the writer's 0-row guard provides the abort. Both orders converge safely.
6. **Post-claim writer abort:** the writer's next chunk iteration acquires `LOCK_SH` (succeeds — the claim released `LOCK_EX`), re-validates under the lock, reads `state = 'ABANDONED'` (or `released_at IS NOT NULL`) → aborts WITHOUT writing. Its next heartbeat UPDATE affects 0 rows → aborts as well. Post-abandonment writes are ZERO — not "bounded by one chunk," zero: the writer cannot be between validation and `write()` when the claim commits, because validation+write is inside `LOCK_SH` and the claim is inside `LOCK_EX`.

**Deployment assumption (explicit, rev 16):** the handshake requires the writer and the expiry worker to share a coherent POSIX file-locking domain over `/data/media` — a single host, or a shared filesystem with working lock coordination. The temp→final atomic rename already requires temp and final paths on the same filesystem; this is the same deployment constraint, now stated. A deployment self-test MUST verify it: process A takes `LOCK_EX|LOCK_NB` on a scratch file in `.tmp/` → process B's `LOCK_SH|LOCK_NB` on the same path MUST fail (and reversed). If the deployment cannot guarantee coherent `flock`, the mechanism degrades to the rev-15 timing bounds (one-chunk/30 s overrun, conservatively covered by `size_bytes`) — this degradation MUST be a conscious operator decision, never silent.

**Bounded windows (rev 16):**

| Parameter | Value | Rationale |
|---|---|---|
| Heartbeat interval | ≤ 2 min | Writer proves liveness; `epoch` advances |
| `expires_at` | creation + 5 min, extended per heartbeat | Eligibility threshold for expiry consideration |
| Claim observation wait | ≥ 60 s | Separates the two epoch observations (liveness evidence) |
| File-mtime grace | 120 s | Protects a writer with delayed heartbeats (liveness evidence) |
| Writer validation | every chunk, inside `LOCK_SH` (validate→write→unlock) | Validate+write atomic w.r.t. claims — replaces the 1 MB/30 s bound |
| Post-abandonment writes | ZERO (enforced) | No `write()` can execute after finalization — proven by lock exclusion, not bounded by timing |
| Claim lock attempt | `LOCK_EX\|LOCK_NB` — never blocks | Failure = a write is in flight → abort claim this cycle (property (a) enforced) |
| Writer lock hold | per chunk only; released before next chunk | A held lock across chunks would block legitimate claims; kernel releases on crash |
| In-flight write bound | one `write()` syscall | The claim defers only while a syscall is actually in flight; next ≥60 s cycle proceeds |
| Lock-contention alert | claim aborted by `EWOULDBLOCK` on >3 consecutive cycles → warning `EXPIRY_CLAIM_DEFERRED` | A live-but-wedged writer would pin capacity; operator investigates |

**Invariant (rev 16 — B1.2):** Every byte on the deterministic temp path `/data/media/.tmp/{reservation_id}.part` was written while the reservation row was durably active (`released_at IS NULL`), and no terminal state transition (`ABANDONED`, `ROLLED_BACK`, `COMMITTED`) commits while a `write()` on that path is in flight — with ONE scoped exception (rev 20 — B8): fence-activation invalidation commits `ABANDONED` without holding the file lock, because activation must not block on a live writer's `LOCK_SH` (that would let a stuck writer hold the fence hostage). The exception is safe by the B8 proof, not by the lock: after the activation commit no NEW `write()` can begin (every chunk re-validates under `LOCK_SH` first), so at most the single already-in-flight chunk's `write()` completes, and its bytes are conservatively counted in `abandoned_temp_bytes` via the row's `size_bytes` from the activation commit — never uncounted. Equivalently: **(a)** the expiry worker cannot finalize abandonment while a write operation is in flight; **(b)** no write can occur after abandonment is finalized — where "finalized" for the invalidation origin means "after the activation transaction commits," and the bound is the B8 in-flight-chunk proof rather than lock exclusion.

*Enforcement argument (not timing):* bytes change only through the writer's chunk loop — `LOCK_SH → validate(state active) → write() → LOCK_UN` — validation and write inside one shared-lock critical section. Expiry finalization — `LOCK_EX|LOCK_NB → terminal UPDATE → LOCK_UN` — the UPDATE inside one exclusive-lock critical section. POSIX `flock` makes the two critical sections mutually exclusive (same file, coherent locking domain per the deployment assumption). Interleaving analysis:
- **Writer validates, then claim attempts:** the writer holds `LOCK_SH`; its `write()` lands; it releases. The claim's `LOCK_EX|LOCK_NB` either failed during the writer's critical section (claim aborted — property (a): no finalization while the write was in flight) or succeeds after release, committing after the bytes landed. Every byte was written while the reservation was active.
- **Claim commits, then writer validates:** the claim held `LOCK_EX` through the UPDATE commit, then released. The writer's next chunk acquires `LOCK_SH`, validates under the lock, observes `ABANDONED` → aborts with zero bytes written. No write after finalization.
- **The interleaving rev 15 could not close** (writer validates `active` → claim commits → writer's `write()` lands): IMPOSSIBLE under rev 16. Validation and `write()` are inside `LOCK_SH`; the claim's commit is inside `LOCK_EX`. The writer cannot be "between validation and write" when the claim commits. The claim committed either entirely before the writer's critical section (→ writer aborts) or entirely after it (→ bytes pre-date abandonment). No third order exists. This is mutual exclusion, not a timing bound: no assumption about scheduler speed, chunk duration, or clock skew appears in the argument.
- **Liveness side (live writers still never claimed):** unchanged from rev 15 — the epoch compare-and-swap across the ≥60 s observation window plus the 120 s mtime grace mean a successful claim implies no heartbeat and no file growth in the window. The lock does not replace this evidence; it enforces the handoff once the evidence says "dead."

*Scenario proving it:* S43 steps 18–21 (pause-writer race with both winners + process-termination variant).

**Reservation state machine (rev 15 — durable):**
```
RESERVED ──(first byte written to deterministic path)──> WRITING
   │                                                          │
   │ (path stats ENOENT: no bytes ever written)               │ (commit txn: asset-row INSERT
   v                                                          │  + state='COMMITTED', one txn)
ROLLED_BACK ──(terminal: nothing counted)                     v
                                                         COMMITTED ──(terminal:
                                                          reservation counted nowhere;
                                                          file is a registry file)
   │ (expiry claim CAS succeeds, or ENOSPC cleanup fails:
   │  ONE transaction sets state='ABANDONED', released_at=now())
   v
ABANDONED ──(temp file confirmed deleted via stat)──> CLEANED ──(terminal: nothing counted)
   │
   │ (durable: from the claim commit instant, the row's size_bytes
   │  counts the bytes in abandoned_temp_bytes — no scan required)
```

Every transition is a single committed transaction on the reservation row. The state column IS the accounting handoff: the capacity query reads `state`, so there is no instant where a reservation has left one category but not yet entered the next. The scan never participates in the handoff — it only verifies and cleans up afterward. **(rev 16 — B1.2 execution annotation):** expiry-initiated terminal transitions (`ABANDONED`, `ROLLED_BACK` via the claim protocol) execute their UPDATE inside the `LOCK_EX` critical section on the deterministic temp path; writer-initiated transitions (fenced chunk validation, `COMMITTED`/`ROLLED_BACK` via the writer's own commit/rollback) execute inside `LOCK_SH`. The mutual exclusion is what makes the handoff race-safe; the single-transaction property is what makes it crash-safe.

**Accounting guarantees (rev 15 — B1.3):** The rev-14 "counted exactly once at every instant" conflated two different guarantees. They are now stated separately:

**(a) DURABLE RESPONSIBILITY invariant (exact):** Every reservation row is durably in exactly one accounting category at every instant, determined SOLELY by its `state` column:
- `RESERVED` / `WRITING` (`released_at IS NULL`) → `active_reservations_bytes`
- `ABANDONED` → `abandoned_temp_bytes` (durable, via the row's `size_bytes`)
- `COMMITTED` → the file is a registry file; its bytes are in `registry_bytes` via the asset row's `size_bytes` (exact from the database)
- `ROLLED_BACK` / `CLEANED` → counted nowhere (the transition commits only after the file's absence is confirmed via stat)

This invariant is provable from database state alone — `SELECT state, COUNT(*), SUM(size_bytes) FROM storage_reservations GROUP BY state` fully determines the reservation-attributable accounting. No filesystem scan is needed to prove it. A test can assert it after every operation, including kill -9 at any point.

**(b) MEASUREMENT FRESHNESS bound (bounded, not exact):** Scan-derived terms — `unregistered_bytes` (true orphans with no row), `quarantine_bytes` (`du`), `filesystem_used_percent` (`statvfs`) — reflect the filesystem as of the last periodic scan (≤ 5 minutes old, enforced by the fail-closed staleness bound). The overhead reserve (`STORAGE_OVERHEAD_RESERVE_PERCENT`, default 5% of `storage_capacity_bytes`) is sized to cover the maximum bytes that can exist on disk without durable responsibility within one scan interval: filesystem metadata/journal overhead, plus true orphans not yet discovered by the scan. (Temp files under active reservations need no reserve coverage — they are durably counted in `active_reservations_bytes`.) Capacity decisions use `MAX(managed_percent, filesystem_used_percent)`, so the OS-reported figure backstops the managed accounting. If OS utilization exceeds managed accounting by more than the reserve → `ACCOUNTING_DIVERGENCE` alert (the bound is violated; operator investigates).

**Explicit separation:** The overhead reserve is a *capacity-planning margin* — it keeps capacity decisions conservative despite measurement lag. It does NOT prove exact accounting. Exact accounting comes from (a): durable row states, provable from the database alone. The rev-14 text is corrected wherever it implied the reserve proves exactness.

**Crash recovery:** On startup, the recovery process scans `storage_reservations WHERE released_at IS NULL`:
- For each: stat the deterministic path `/data/media/.tmp/{reservation_id}.part` (never `temp_filename` — audit only). If the path stats ENOENT → `UPDATE ... SET state = 'ROLLED_BACK', released_at = now()` (no bytes to protect).
- If the file is present → the reservation stays active (`RESERVED`/`WRITING`, still counted in `active_reservations_bytes`); the normal expiry claim protocol (B1.2) will observe the epoch, wait, check mtime, and finalize via the fenced claim (rev 16: `LOCK_EX|LOCK_NB` on the deterministic path, terminal UPDATE inside the exclusive-lock critical section) if the writer is truly dead. Startup recovery does NOT bypass the claim protocol — it only ensures the scan happens promptly. Log at warning with `reservation_id`, `world_id`, size.
- Heartbeat check: a reservation with `last_heartbeat_at` older than 10 minutes and `expires_at` passed is a claim *candidate* — but candidacy is not abandonment. The claim protocol (epoch CAS + mtime grace) is the only path to `ABANDONED`. There is no "treated as crashed" shortcut that skips the CAS.

**Lock interaction:** Phase 1 holds level 1 only for the check-and-reserve (milliseconds). The file write (Phase 2) does NOT hold level 1 continuously — it cannot, as writes may take minutes. The reservation (durable, visible) is what provides the concurrency safety during the write, not the lock. This is the key rev-13 correction: **durable state, not lock duration, protects capacity during long writes.**

**ENOSPC during write (defense in depth, rev 13 — B1.3):** Even with reservations, `ENOSPC` can occur (another process wrote, filesystem overhead exceeded the reserve, measurement error). The upload path MUST handle it, including cleanup failure:

1. On `ENOSPC` (or `EDQUOT`) during the temp-file write: attempt to delete the partial temp file synchronously.
2. **If the unlink succeeds:** verify deletion (stat returns ENOENT). Then release the reservation (`UPDATE ... SET released_at = now()`). Bytes are gone; nothing to account for.
3. **If the unlink FAILS (rev 15 — B1.1):** execute the durable handoff in ONE transaction: `UPDATE storage_reservations SET state = 'ABANDONED', released_at = now() WHERE reservation_id = ? AND released_at IS NULL`. From that commit instant, the partial file's bytes are durably counted in `abandoned_temp_bytes` via the row's `size_bytes` (conservative: the reserved size ≥ the partial bytes). No scan is involved in the handoff. Then:
   - Log at error with `reservation_id`, `world_id`, `size_bytes`, and the unlink error.
   - Return **507** `{code: "STORAGE_WRITE_FAILED", retryable: true, detail: "filesystem full during write; cleanup incomplete"}`.
   - The bytes have NOT escaped accounting at any instant: before the UPDATE they were in `active_reservations_bytes`; after, in `abandoned_temp_bytes` — the same row, one commit.
   - **If the process crashes during cleanup** (before the UPDATE commits): the reservation is still active (`RESERVED`/`WRITING`); the expiry claim protocol (B1.2) will claim it via CAS. Either path converges on `ABANDONED` with no gap.
4. **Abandoned-temp cleanup (rev 15):** the periodic job selects `storage_reservations WHERE state = 'ABANDONED'` and, for each, attempts to unlink the deterministic temp path. On success (stat confirms ENOENT): `UPDATE ... SET state = 'CLEANED', released_at = now()` — the bytes leave `abandoned_temp_bytes` via the same durable state column. On unlink failure: the row STAYS `ABANDONED` (bytes remain durably counted), alert `TEMP_CLEANUP_FAILED` (error) fires with `reservation_id` and `size_bytes`, operator intervenes manually. Separately, the job scans `/data/media/.tmp/` for files with NO reservation row at all (true orphans — e.g., file created but the Phase-1 commit never happened): each such file's bytes go to `unregistered_bytes` and it is logged at warning. **At no point are bytes on disk uncounted: every temp file is either covered by an active reservation row, an ABANDONED row, or `unregistered_bytes`.**
5. Trigger immediate metric recomputation (do not wait for the periodic job).
6. If the recomputed metric shows >95% used → critical alert (`STORAGE_CAPACITY_CRITICAL`).

**Invariant (rev 15 — B1.1, B1.3a):** Every accounting handoff is a single committed transaction on the reservation row's `state` column. Capacity protection is released from one category at the exact instant it is assumed by the next — the state column is read by the capacity query, so "release" and "assume" are the same commit. The filesystem scan is never load-bearing for the handoff; it verifies and cleans up afterward.

**`abandoned_temp_bytes` definition (rev 15):** `SUM(size_bytes) FROM storage_reservations WHERE state = 'ABANDONED'` — DURABLE, derived from database state alone. The scan-derived `abandoned_temp_bytes_measured` (actual bytes in `/data/media/.tmp/` with no active reservation) is used for cleanup targeting and the `ACCOUNTING_DIVERGENCE` cross-check, not for capacity protection. If measured > durable, bytes exist with no responsible row → investigate (this indicates a bug: every temp file must have a reservation row).

**Error code taxonomy (rev 12 — corrections 1, 2, 5):**

| Code | Status | Retryable | Meaning | Creator action | Operator action |
|---|---|---|---|---|---|
| `QUOTA_EXCEEDED` | 507 | No | Per-world quota exceeded (§5.1) | Delete own assets | None |
| `STORAGE_FULL` | 507 | No | Volume capacity exhausted (pre-check) | Wait; cannot fix by deleting own assets | Expand volume |
| `STORAGE_WRITE_FAILED` | 507 | Yes | ENOSPC during write despite reservation | Retry after delay | Check volume; expand if needed |
| `STORAGE_METRIC_STALE` | 503 | Yes | Capacity metric too old or failed | Retry after delay | Check periodic job |
| `STORAGE_UNAVAILABLE` | 503 | Yes | Volume unmounted/unwritable | Retry with backoff | Check mount |

**Blocking vs recoverable (correction 5):**
- **Blocking** (halt the operation, require intervention): `STORAGE_FULL` (operator must expand), `SCAN_UNAVAILABLE` (infrastructure issue), invariant violations (`DUPLICATE_FILE_REGISTRATION`). These do not clear on retry — the underlying condition must change.
- **Recoverable** (retry automatically or on next attempt): `STORAGE_METRIC_STALE` (clears when job recovers), `STORAGE_WRITE_FAILED` (clears when space available), `LOCK_TIMEOUT` (clears when contention resolves), `BACKFILL_IN_PROGRESS` (clears when backfill completes).
- **Alert clearing:** `STORAGE_CAPACITY_WARNING` clears when usage drops below 75% (5-point hysteresis). `STORAGE_CAPACITY_CRITICAL` clears below 85%. `UNMANAGED_FILE_DETECTED` clears when the file is classified or removed.

**Behavior when physical storage is exhausted (quotas all OK):**
1. Uploads and replacement-T1s rejected with **507** `{code: "STORAGE_FULL"}` *before* the quota check.
2. Threshold alerts at 80% (warning) and 90% (critical), firing on `MAX(managed_percent, filesystem_percent)`.
3. Reads unaffected. `diagnose` unaffected. `repair` quarantine *moves* unaffected (moves don't add bytes); repair *copies* blocked.
4. Recovery: operator expands volume; periodic job recomputes; uploads resume. No deploy needed.

**Why not per-request `statvfs`:** Rejected in rev 11 (hot-path syscall, no freshness gain over 5-min cache + 10% margin). Rev 12 retains the cached metric but adds: (a) fail-closed staleness bound, (b) reservation for concurrency, (c) `filesystem_used_percent` as a cross-check. The combination provides stronger guarantees than per-request `statvfs` alone (which also cannot prevent concurrent overspend).

## 6. Acceptance Scenarios

### S1: Published version keeps old image after replacement
1. World v3 is published with scene S referencing `/media/aaa.jpg`.
2. Creator uploads `/media/bbb.jpg` and sets it as S's illustration (draft now references bbb).
3. Creator publishes → v4 snapshot references `/media/bbb.jpg`.
4. **Assert:** v3 snapshot still references `/media/aaa.jpg`. Both files exist. Readers on v3 see aaa; new readers see bbb.

### S2: Detach from draft preserves published reference
1. World v2 published with cover `/media/cover1.jpg`.
2. Creator removes cover art from draft (metadata cleared).
3. **Assert:** v2 snapshot still references `/media/cover1.jpg`. File retained. Row stays `active`.

### S3: Deletion blocked with reference list
1. Asset `/media/aaa.jpg` referenced by scene "The Gate" (draft) and published v2.
2. `DELETE /worlds/:id/media/:assetId` → **409** `{code: "ASSET_REFERENCED", references: ["scene 'The Gate' (draft)", "published version v2"]}`.
3. **Assert:** Row still `active`. File untouched. Locks released.

### S4: Unreferenced asset deleted synchronously, quota reclaimed
1. Asset `/media/old.jpg` is unreferenced (replaced earlier, no snapshot references it).
2. `DELETE` → **T1:** locks acquired → scan finds zero references → `lifecycle='pending_deletion'` committed (durable boundary, locks released) → **T2:** locks reacquired → re-verification passes → file unlinked → `file_confirmed_present=false` → row deleted → **204**.
3. **Assert:** `quota_used_bytes` decreased by the file's size. Subsequent upload within the freed quota succeeds. `GET /media/old.jpg` → 404.
4. **Assert:** No claim is made that any lock survived from T1 to T2 — T2's safety comes from re-verification under freshly acquired locks, not from lock continuity.

### S5: Concurrent uploads near quota boundary (rev 19 — B2: reservations in admission)
1. World has 45 MB registered of 50 MB quota, zero outstanding reservations. Two 4 MB uploads (A and B) start simultaneously.
2. Upload A Phase-1: acquires level-1 + level-2, computes 45 (registered) + 0 (outstanding) + 4 = 49 ≤ 50 → passes, inserts its 4 MB reservation (`RESERVED`), commits. Locks release.
3. Upload B Phase-1: acquires the locks, computes 45 (registered) + 4 (A's outstanding reservation) + 4 = 53 > 50 → **507** `{code: "QUOTA_EXCEEDED", quota_exceeded: true}`. No reservation inserted, no file written.
4. **Assert:** exactly one upload proceeds. (Under the pre-rev-19 registry-only formula, B would have computed 45 + 4 = 49, passed, and both uploads would have finished at 53 MB registered vs 50 MB quota — the finding's exact overspend. The outstanding-reservation term closes it: serialization alone was never sufficient.)
5. Upload A Phase-2 commits: reservation → `COMMITTED` AND registry row inserted in ONE transaction. **Assert:** quota reads 49 MB (45 + 4 registered, 0 outstanding) — the 4 MB moved buckets atomically, counted exactly once at every instant. Then A is deleted via T2: quota returns to 45 MB on T2's commit.

### S6: Upload racing with deletion
1. Upload of 5 MB file starts (holds advisory lock, computing quota). Concurrent DELETE of a 3 MB unreferenced asset starts.
2. **Assert:** The advisory lock serializes quota-affecting operations. Whichever commits first, the other sees the updated `quota_used_bytes`. No double-counting, no negative quota. Both operations complete correctly.

### S7: Attempt to attach a soft-deleted / pending-deletion asset URL
1. Asset `/media/gone.jpg` has `lifecycle='pending_deletion'`.
2. Creator attempts to set it as a scene illustration.
3. **Assert:** **422** `{code: "ASSET_DELETED"}`. Metadata unchanged.

### S8: Failed metadata switch after successful upload (orphan recovery)
1. Replacement T1 completes (new file + row committed, `active`, `roles='{}'` — holds no draft role yet). T2 (metadata update) fails validation.
2. **Assert:** New asset row exists, `active`, zero references, `roles='{}'` (truthful — the failed switch never assigned it a role). Old row keeps its role unchanged. No lying state.
3. Creator calls DELETE → synchronous path finds zero references → 204, quota reclaimed. No orphan left behind.

### S9: Crash recovery — file-without-row and row-without-file
1. Simulate crash after file rename but before row INSERT → restart.
2. **Assert:** Startup `diagnose` (read-only) logs "file without row" at warning, moves nothing, deletes nothing, creates no rows. The *periodic capacity job's* filesystem scan (§5.5) accounts for the file's bytes in `unregistered_bytes` — logging (diagnose) and accounting (capacity job) are separate operations; the rev-11 wording "unattributed_bytes increases" during diagnose was contradictory and is withdrawn. In `repair` mode (explicit `--repair-media` flag), the file is reference-checked first: if any draft or snapshot references its URL, it stays at its serving path with an `unattributed_media_files` row (`protected=true`); only a zero-reference file is moved to `.quarantine/`.
3. Simulate row committed but file deleted externally → restart.
4. **Assert:** Reconciliation sets `file_confirmed_present=false`, logs at error with `asset_id`/`world_id`, raises data-loss alert. Quota decreases (file not counted). Asset remains `active` (still referenced) — serving returns 404 for the missing file, which is correct behavior for data loss (not silent).

### S10: World deletion — blocked with published versions, resumable for draft-only
1. World has published v2, v3. `DELETE /worlds/:id` → **409** `{code: "WORLD_HAS_PUBLISHED_VERSIONS", versions: [2, 3]}`. No job row created. Nothing touched.
2. Draft-only world with 3 assets. `DELETE /worlds/:id`:
   a. T1: locks acquired **first**, then published-version check (zero), then job row created (`assets_pending`), commit. **Assert:** upload attempts now fail with **409** `{code: "WORLD_DELETION_IN_PROGRESS"}`.
   b. T2: all 3 assets → `pending_deletion`; job → `files_removing` (`files_total=3`). **Assert:** setting any of these URLs as an illustration → **422** `{code: "ASSET_DELETED"}`.
   c. Simulate crash after 2 files removed (job shows `files_removed=2`, but the counter is not trusted). Restart.
   d. **Assert:** Startup recovery finds the job in `files_removing`, **re-enumerates the full asset list from the database**, stats each file. The 2 already-removed files are confirmed absent (idempotent skip); file 3 is unlinked. `files_removed` is rebuilt from ground truth. No asset row deleted while its file might still exist.
   e. All files removed → T4 (asset rows deleted) → T5 (world row deleted, job cascades) → **204**.
   f. **Assert:** At no point was the world row committed as deleted while any asset file remained untracked.

### S11: Failed reference scan returns 503, changes nothing
1. Simulate lock timeout during the reference scan (e.g., long-running publish holding the world lock).
2. `DELETE` → **503** `{code: "SCAN_UNAVAILABLE", retryable: true}` with `Retry-After: 5`.
3. **Assert:** Asset row still `active`. File untouched. No state change whatsoever. Retry after the interval succeeds or fails on its own merits.

### S12: Legacy file backfilled before lifecycle enforcement
1. `/data/media/legacy123.jpg` exists on disk, no registry row. It is referenced by published v1's snapshot.
2. Backfill job runs → creates row with resolved `world_id`, `lifecycle='active'`.
3. Creator attempts DELETE → reference scan finds v1 snapshot reference → **409**. Canon protected.
4. **Assert:** "No registry row" never meant "safe to delete."

### S13: Reference-validation contract rejects invalid URLs atomically
1. Scene metadata update sets `illustrationUrl` to a `pending_deletion` asset's URL, alongside a valid title change in the same request.
2. **Assert:** **422** `{code: "ASSET_DELETED"}`. The title change is also rolled back — all-or-nothing, no partial update (§4.2b step 4).
3. Publish with a draft referencing an asset whose file was deleted externally (`file_confirmed_present=false`, row still `active`).
4. **Assert:** Publish fails with **422** `{code: "ASSET_FILE_MISSING"}`. No snapshot created. The draft is unchanged.

### S14: Global lock excludes reconciliation from file mutation
1. Reconciliation (read-only scan) starts and holds the global media lock (§4.3c level 1).
2. Concurrent upload starts.
3. **Assert:** Upload blocks on the global lock until reconciliation releases it, then proceeds normally. No interleaving; no file observed mid-scan. Lock ordering (global before quota before rows) prevents deadlock.
4. If the global lock cannot be acquired within 30s at startup → media subsystem starts degraded: `/media/*` returns **503**, health reports `"media_storage": "degraded"`, critical log emitted.

### S15: Quota accounts for pending_deletion correctly
1. World at 48 MB / 50 MB quota. Asset A (3 MB, `active`) is deleted → transitions to `pending_deletion`, file still on disk.
2. **Assert:** `quota_used_bytes` still includes A's 3 MB (formula counts `lifecycle IN ('active','pending_deletion')` with `file_confirmed_present=true`). A new 3 MB upload → **507** `{code: "QUOTA_EXCEEDED", quota_exceeded: true}`.
3. A's file removal confirmed → T2 commits (steps 13–15: `file_confirmed_present=false` and row DELETE in one transaction) → quota drops to 45 MB.
4. **Assert:** The new 3 MB upload now succeeds. Quota was released when T2's finalization committed — not at scan time, and not at unlink time independent of commit. If T2 had rolled back after the unlink, quota would have remained counted until the retry finalized (§5.1).

### S16: Concurrent publish vs world deletion — one wins
1. Draft-only world. Two requests start simultaneously: `POST /worlds/:id/publish` and `DELETE /worlds/:id` (world deletion).
2. Both contend on the world-row lock (publish holds it during its §4.2b deletion-job check; T1 holds it during its published-version check + job insert).
3. **Assert:** Exactly one wins. If publish wins: the snapshot commits, then T1 sees the published version → **409** `{code: "WORLD_HAS_PUBLISHED_VERSIONS"}`. If T1 wins: the job row commits, then publish's §4.2b check sees the active job → **409** `{code: "WORLD_DELETION_IN_PROGRESS"}`. No interleaving produces a published version on a world with an active deletion job, or a deletion job on a world with a published version.

### S17: Crash after unlink but before counter update (world deletion)
1. Draft-only world with 2 assets. World deletion reaches T3. File 1 is unlinked, then the process crashes **before** the `files_removed` counter is incremented.
2. Restart. Recovery finds the job in `files_removing` with `files_removed=1` (stale counter — file 1 was unlinked but the increment never committed; or `files_removed=0` if the increment was in the same lost transaction — either way, untrusted).
3. **Assert:** Recovery does NOT trust the counter. It acquires the job row `FOR UPDATE OF world_deletion_jobs` (excluding concurrent recovery), **resets `files_removed = 0`**, re-enumerates both assets, stats file 1 (absent → counts as removed, no error, no double-unlink attempt), unlinks file 2, and sets `files_removed` to the absolute confirmed count (2). The stale counter caused no incorrect behavior — overcounting is impossible because the counter is rebuilt, not incremented.

### S18: Cross-world asset URL becomes a shared reference (rev 15 — supersedes the rev-10 rejection)
1. World A has asset `/media/aaa.jpg` (`world_id` = A, `shared_with_worlds = []`). Creator of World B sets it as a scene illustration in World B.
2. **Assert:** the metadata update SUCCEEDS (no 422 — the rev-10 prohibition is superseded). The transaction atomically appends B to the asset's `shared_with_worlds` (`= ['B']`) under the asset-row lock. World B's metadata now references the URL.
3. **Assert:** World A's deletion scan now sees World B's reference: attempting to delete `/media/aaa.jpg` → **409** `{code: "ASSET_REFERENCED"}` (the scan checks `shared_with_worlds`). The world-scoped deletion soundness that the old 422 protected is now provided by the shared-reference tracking (§4.3b, §4.7c) — the 422's rationale is obsolete.
4. **Assert:** the endpoint-authorization 403 is unaffected: `DELETE /worlds/B/media/{assetId}` (B's path, A's asset) → **403** (B cannot manage A's asset; sharing confers read/reference rights, not management rights).
5. **Assert (rev 19 — B6):** reference validation NEVER returns `ASSET_WRONG_WORLD` — the rev-10 422 validation behavior is fully superseded (step 2 proves the success path). The code exists ONLY as the 403 endpoint-authorization above. Any test asserting a 422 from reference validation is testing obsolete behavior.

### S19: Dual-role backfill + independent role replacement
1. Legacy file `/media/dual.jpg` is referenced as World C's cover art (`world.metadata.coverArtUrl`) and as a scene illustration in the same world. Backfill runs.
2. **Assert:** Exactly **one** `world_media_assets` row is created, with `roles='{cover,illustration}'` — because the *same URL* appears at both draft paths. The UNIQUE constraints on `filename` and `url` hold — no duplicate rows.
3. Creator uploads new cover art (`/media/newcover.jpg`, row created with `roles='{}'`) and sets it as the world's cover. The metadata-switch transaction (same transaction as the URL write) adds `'cover'` to the new row's `roles` and removes `'cover'` from the old row's `roles`.
4. **Assert:** Old row now has `roles={'illustration'}`, remains `active`. The scene illustration still serves `/media/dual.jpg`. The old file is NOT unlinked. Quota counts `/media/dual.jpg` once.
5. Creator later detaches the illustration and deletes the old asset (zero references everywhere) → T1/T2 complete → file unlinked, row deleted, **204**.
6. **Assert:** Neither the role replacement (step 3) nor the deletion (step 5) broke the other reference. One row per file held throughout. `roles` was never consulted for deletion safety — the URL scan was.

### S20: Concurrent recovery workers — exactly one proceeds
1. Draft-only world with a deletion job stuck in `files_removing` (crashed worker). Two recovery workers start simultaneously (e.g., two app instances during a rolling restart).
2. **Assert:** Worker 1 acquires the session-level advisory lock `world_deletion_recovery:{job_id}` via `pg_try_advisory_lock` (§4.3c level 0 operational contract). Worker 2's try-lock returns false; it retries with 100ms jitter up to the 30s deadline, then aborts with a `RECOVERY_LOCK_TIMEOUT` alert — it does NOT start a second pass. Exactly one worker unlinks files and advances the job.
3. Worker 1 completes normally → its `finally` block runs `pg_advisory_unlock` → the dedicated connection is **closed** (never returned to the pool) → log confirms lock released and connection closed.
4. **Assert:** No `pool.release()` was called on the recovery connection (verified by code path / connection-leak detector). The lock is free for future recovery passes.
5. Simulate Worker 1 crashing mid-pass (kill -9, no cleanup) → its database session ends → PostgreSQL releases the session-level lock **automatically**.
6. **Assert:** Worker 2 (or a new attempt) acquires the lock cleanly and resumes from the job's last committed state. No files are double-unlinked (unlink is idempotent via stat); the `files_removed` counter is rebuilt from ground truth, not double-incremented. No stale-lock cleanup was needed.

### S21: Recovery lock ordering — no deadlock (rev 16)
1. Start a world-deletion recovery pass: worker acquires level 0 (session, try-lock) on its dedicated connection, then an inner transaction acquires 1 → 2 → 3 → 4 → 6 (R1).
2. While the inner transaction holds level 1, start an upload for a different world.
3. **Assert:** the upload blocks on `pg_advisory_xact_lock(media_global)` *before* its first row acquisition — it holds zero locks while waiting (verify via `pg_locks`: the waiter has no granted row locks). Single wait edge; no cycle.
4. Reverse: let an upload hold level 1 mid-commit; start the recovery pass (holds 0, inner txn waits on 1).
5. **Assert:** the upload never requests level 0 (only recovery code paths reference the `world_deletion_recovery:` key — static check); the recovery session while waiting on 1 holds no row locks. The graph is a single edge in both interleavings; kill -9 of the recovery worker releases 0 automatically and the upload completes.

### S22: Published image restored from backup stays servable at original URL
1. Volume snapshot is restored after data loss. A file `/media/pub.jpg` exists on the restored volume but has no registry row (DB backup is newer than the volume snapshot). Published v2's snapshot references `/media/pub.jpg`.
2. `repair` reconciliation runs: the reference check finds v2's snapshot referencing the URL → the file is **NOT** moved to `.quarantine/` → an `unattributed_media_files` row is created (`protected=true`, original path recorded).
3. **Assert:** `GET /media/pub.jpg` serves the file (via the §4.5 two-table lookup: main registry miss → unattributed hit → serve). The published URL is not broken when the bytes exist.
4. Contrast: a different orphan file with zero references is moved to `.quarantine/` and is NOT servable at its old URL (404) — correct, because nothing references it.

### S23: Same content, different physical files — never merged
1. Two legacy files `/media/a1.jpg` and `/media/b2.jpg` contain byte-identical content (same SHA-256). `/media/a1.jpg` is referenced as World D's cover art; `/media/b2.jpg` is referenced as a scene illustration in World D. Backfill runs.
2. **Assert:** **Two** `world_media_assets` rows are created — one per physical file, one per URL. The identical checksums do not cause a merge. Each row has its own `asset_id`, `filename`, `url`, and `roles` (`{cover}` and `{illustration}` respectively).
3. Creator deletes the illustration asset (after detaching; zero references) → T1/T2 complete → `/media/b2.jpg` unlinked, its row deleted, **204**.
4. **Assert:** `/media/a1.jpg` is untouched — still on disk, still `active`, still serving as World D's cover. The content-hash match did not link their lifecycles in any way. Deleting one physical file never affects the other.
5. **Assert:** The backfill log shows two separate classification decisions, one per file. No "deduplicated by content hash" entry exists anywhere.

### S24: Failed replacement does not corrupt roles
1. Asset `/media/old.jpg` has `roles={'cover'}`, `active`. Creator uploads `/media/new.jpg` (T1 commits: new row, `active`, `roles='{}'`).
2. The metadata switch (T2) fails — e.g. the §4.2b validation rejects because a concurrent operation changed the world.
3. **Assert:** New row still has `roles='{}'` — it does not claim the `cover` role it never held. Old row still has `roles={'cover'}`. The draft still references `/media/old.jpg`. No row contains a role for a reference that does not exist in draft metadata.
4. Creator retries the switch; this time T2 commits.
5. **Assert:** New row now has `roles={'cover'}`; old row has `roles='{}'`. The role transfer happened atomically with the URL write — at no point did both rows claim `cover`, and at no point did neither row's `roles` reflect reality (the URL scan, not `roles`, was authoritative throughout).

### S25: Recovery lock timeout and cleanup behavior
1. Worker 1 holds the session-level recovery lock for job J (simulated long pass). Worker 2 starts for the same job.
2. **Assert:** Worker 2's `pg_try_advisory_lock` returns false; it retries with 100ms jitter. After 30 seconds without acquiring the lock, Worker 2 aborts: logs at warning with `job_id`, emits `RECOVERY_LOCK_TIMEOUT` alert, **does not touch the job, its files, or its rows.** Zero state change from the timed-out worker.
3. Worker 1 finishes normally → `finally` block calls `pg_advisory_unlock` → unlock returns true → dedicated connection is closed (not pooled).
4. **Assert:** A subsequent recovery attempt for a *different* job acquires its own lock without interference. The closed connection does not appear in the pool's idle list.
5. (Crash variant — covered in S20 steps 5–6: session teardown auto-releases; no manual cleanup.)

### S26: Filesystem mutation exclusion under contention — Domain L (rev 18 — B2: scoped)
1. **Scope (rev 18 — B2):** Domain L ONLY. Phase-2 temp chunk writes (Domain R) are excluded from this scenario — they are covered by S53. The assertions below apply to Domain-L mutations.
2. Instrument the filesystem layer (audit log or syscall wrapper) to record every mutation (write, rename, unlink, quarantine move) with the performing session's lock state.
3. Start concurrently: (a) a `repair` reconciliation pass moving orphan files to quarantine, (b) a world-deletion T3 unlinking files, (c) an asset-deletion T2 unlinking a file, (d) an upload whose row-insert fails, triggering synchronous compensation unlink.
4. **Assert:** Every recorded Domain-L filesystem mutation occurred while the mutating session held the global media advisory lock (level 1) **in the same transaction/session that performed the syscall** (§4.3d). No Domain-L mutation is recorded outside a level-1-holding transaction.
5. **Assert:** No two Domain-L mutations overlapped in time (level 1 is exclusive). The audit log shows a strict serialization of all Domain-L filesystem operations.
6. **Assert:** The upload-compensation unlink (d) ran in the uploading session before its rollback, while level 1 was still held — not in a detached cleanup thread.

### S27: Cutover rollback — original machine remains usable
1. Migration proceeds through §2.1 step 8 (staging volume verified against final inventory). Step 9b: original machine stopped. Step 9c–9d: staging machine reconfigured (volume at `/data/media`, `MIGRATION_STAGING` removed) and started.
2. Step 9e verification **fails**: spot-check checksums on the new production machine do not match the final inventory (simulated corruption during remount).
3. **Assert:** Rollback executes: `fly machine start <orig-machine-id>`. The original machine's config is unchanged; its ephemeral `/data/media/` is intact; it resumes serving traffic. `GET /media/{known-file}` returns 200 from the original machine.
4. **Assert:** The original machine was never destroyed — `fly machine list` shows it as `stopped` (then `started`), never `destroyed`. The final inventory (step 7) is used to confirm the original machine's files are complete before resuming production traffic on it.
5. **Assert:** No creator-facing data loss: files uploaded before the maintenance-mode freeze (step 6) are all present on the original machine. Files uploaded *during* the freeze were rejected with 503 — none were lost in transit.
6. The team investigates the staging failure, fixes it, and re-attempts from step 9a. The second attempt's step 9e passes → original machine's fate is recorded per step 9f.

### S28: Metadata commit during deletion lock-wait is seen by the scan
1. Asset `/media/race.jpg` is unreferenced. A `DELETE` request starts T1 and blocks waiting for the world-row lock (held by a long-running publish).
2. While T1 waits, a metadata update commits a new reference: it acquires the world-row lock (after the publish releases it, before T1 acquires it), sets a scene's `illustrationUrl` to `/media/race.jpg`, and commits.
3. T1 acquires the locks, then runs its reference scan as a fresh statement **after** lock acquisition (`READ COMMITTED`, locks-first protocol, §4.2b).
4. **Assert:** the scan sees the newly committed reference (its statement snapshot postdates lock acquisition, and the writer could not have committed after T1 held the lock). T1 returns **409** `{code: "ASSET_REFERENCED", references: [...]}`. Nothing is deleted.
5. **Assert:** under the old `REPEATABLE READ` design this test would fail — the scan's snapshot could predate lock acquisition and miss the reference. This scenario is the regression proof for the isolation fix.

### S29: World-deletion crash around T4 — unattributed references preserved
1. Draft-only world W is being deleted. An `unattributed_media_files` row for `/media/shared.jpg` has `referencing_worlds = [W, X]` (world X also references it) and `classification_status='reviewed'` (operator reviewed it earlier).
2. Crash **before** T4 commits → restart → recovery finds `rows_removing` (or `files_removing` if the crash was earlier) and resumes.
3. **Assert:** after recovery completes T4: the row's `referencing_worlds = [X]` — W removed, X preserved. `classification_status` is still `'reviewed'` — the retry's `array_remove`-only `UPDATE` did not overwrite the operator's status. `notes` unchanged.
4. Crash **after** T4 commits but before T5 → restart → recovery finds `rows_removing`, verifies zero asset rows remain, and proceeds directly to T5.
5. **Assert:** T4's unattributed update is not re-applied blindly — the `WHERE :world_id = ANY(referencing_worlds)` clause excludes the already-updated row. No duplicate work, no lost references, no clobbered operator state.

### S30: Interrupted backfill cannot enable enforcement
1. Backfill starts: `backfill_runs` row inserted (`in_progress`), 60 of 100 files classified, then the process crashes.
2. Restart. Startup finds the `in_progress` run from before the clean shutdown → marks it `failed`, logs at warning.
3. **Assert:** enforcement stays disabled — health reports `"media_lifecycle": "backfill_incomplete"`. The `pending_review` count is irrelevant; the gate checks for a `complete` run row, and none exists.
4. Operator restarts backfill → new run row (`in_progress`), new final inventory (100 rows in `backfill_inventory_files`), new freeze. The 60 already-classified files are **re-verified** per the rev-11 rerun protocol (not skipped): each row's classification is recomputed against current metadata and snapshots; matches are confirmed, mismatches become `backfill_conflicts` rows, operator-reviewed unattributed records are preserved untouched. The remaining 40 are classified fresh, each INSERT setting `backfill_run_id` to the new run. Reconciliation runs the rev-19 executable set-equality queries (both directions against `backfill_inventory_files`) **and** zero unresolved conflicts.
5. **Assert:** run transitions to `complete` in a single transaction. Only then does enforcement enable. A file added to `/data/media/` *during* the backfill (after the final inventory was recorded) is caught by Direction-1 of the reconciliation (inventoried set minus outcome set ≠ ∅) — the run cannot complete until it is classified. The old count-based check (`60 + 40 = 100`) is withdrawn: counts could include rows from the failed R1.

### S31: Backfill rerun with changed metadata — conflict flagged, not overwritten
1. Backfill run R1 classifies `/media/x.jpg` as World A's cover (`world_media_assets` row: `world_id=A`, `roles={'cover'}`). R1 fails before completing (crash); marked `failed` on restart.
2. Before the rerun, the creator changes the draft: `/media/x.jpg` is now a scene illustration, not the cover (metadata updated through the normal §4.2b path).
3. Operator starts backfill run R2 (new run row, new final inventory, new freeze).
4. R2 re-verifies the existing row: recomputed classification is `roles={'illustration'}` ≠ stored `roles={'cover'}` → **conflict**. R2 does NOT update the row. It inserts a `backfill_conflicts` row (`existing_roles={'cover'}`, `recomputed_roles={'illustration'}`, `reason='roles stale'`).
5. **Assert:** the registry row still has `roles={'cover'}` — untouched. R2's reconciliation finds 1 unresolved conflict → R2 stays `in_progress`, cannot complete. Enforcement stays disabled.
6. Operator resolves the conflict via the normal row-update path (accepting `{'illustration'}`), marks it resolved. Operator starts R3.
7. **Assert:** R3's re-verification confirms the row; zero conflicts; R3 completes; enforcement enables.

### S32: File added during backfill freeze is blocked, then caught
1. Backfill run R1 starts (freeze active: `state='in_progress'`). Final inventory recorded: 100 files.
2. A creator attempts `POST /worlds/:id/media` during the run.
3. **Assert:** **503** `{code: "BACKFILL_IN_PROGRESS", retryable: true}`. No file written, no row created. The upload transaction's freeze check (after acquiring level 1, before the quota check) saw the `in_progress` run.
4. (Bypass variant) An operator copies `/media/sneaky.jpg` directly onto the volume via shell, bypassing the application.
5. R1's reconciliation re-lists the directory and diffs against `backfill_inventory_files` (rev 19 — B4: the manifest table, not just the checksum) → `/media/sneaky.jpg` is off-manifest. Direction-1 of the set-equality queries would also catch it if it were (incorrectly) given a row without manifest membership.
6. **Assert:** R1 logs at error, creates an `unattributed_media_files` row (`classification_status='pending_review'`, `backfill_run_id` = R1, notes `"appeared after inventory freeze"`), and **cannot complete** — the classified set must equal the inventoried set exactly. Operator removes the file (or aborts R1 and starts R2 with a new freeze/inventory including it). No silent absorption.

### S33: Lock re-acquisition across a multi-transaction deletion pass
1. Draft-only world with 2 assets; world deletion starts. Instrument lock acquisition (log every `pg_advisory_xact_lock` / `pg_advisory_lock` call with the transaction ID).
2. **Assert:** T1 acquires 1→2→3 and releases all three at its commit. T2 acquires 1→2→3→4 fresh (new transaction, new lock acquisitions — the log shows no lock "carried over" from T1). Each T3 file-transaction acquires 1→2→3→4 fresh; the `unlink` syscall for file N occurs strictly between that transaction's level-1 acquisition and its commit.
3. **Assert:** at no point does any transaction perform a filesystem syscall while *not* holding level 1, and at no point does the log show a transaction relying on a lock acquired by a previous (committed) transaction.
4. Recovery variant: kill the worker mid-T3, restart. The recovery pass opens its dedicated connection, acquires level 0 once (session-scoped), then each recovery transaction acquires 1→2→3→4.
5. **Assert:** every recovery `unlink` occurred in a transaction holding **both** level 0 (session, from the dedicated connection) and level 1 (transaction, freshly acquired). Level 0 alone never authorized a syscall — the audit shows level-1 acquisition preceding each unlink.

### S34: Disk exhausted while all world quotas are OK
1. Volume is at 96% used (mostly unattributed legacy files and quarantine; every world's `quota_used_bytes` is under 50% of its quota). The periodic capacity job has updated the cached `storage_used_percent`.
2. Creator attempts a 2 MB upload (well within their world quota).
3. **Assert:** **507** `{code: "STORAGE_FULL", retryable: false}` — returned *before* the quota check. The code is `STORAGE_FULL`, not `QUOTA_EXCEEDED`: the creator's quota is fine and deleting their own assets would not help.
4. **Assert:** operator alerts fired at 80% (`STORAGE_CAPACITY_WARNING`) and 90% (`STORAGE_CAPACITY_CRITICAL`) before the rejection — the 90%→100% gap absorbed the 5-minute metric cache staleness.
5. **Assert:** reads are unaffected — `GET /media/{existing}` still serves 200; `diagnose` reconciliation still runs. Only writes are blocked.
6. Operator expands the volume (`fly volumes extend`); the periodic job recomputes; the next upload succeeds without any code deploy.

### S35: Inconclusive snapshot scan fails closed
1. Asset `/media/maybe.jpg` has zero draft references. Its only possible protection is a published snapshot reference. The `canon_snapshots` table is made unreachable for the test (simulated connection failure on the snapshot query).
2. Creator calls `DELETE`.
3. **Assert:** T1's reference scan cannot complete the snapshot portion → **503** `{code: "SCAN_UNAVAILABLE", retryable: true}`. The asset row stays `active`. File untouched. No state change whatsoever.
4. Variant: the table is reachable but one snapshot row has `canon_data = NULL` (corrupt).
5. **Assert:** same result — 503, nothing changed. The NULL row *might* contain a reference the scanner cannot see; "can't see" is not "doesn't exist."
6. Variant: `repair` reconciliation encounters the corrupt snapshot while evaluating an orphan file for quarantine.
7. **Assert:** the file is NOT moved to `.quarantine/`; the row is NOT finalized. Repair logs at warning and retries on the next run. Inconclusive evidence never authorizes deletion or quarantine.

### S36: File removed after the inventory freeze gets a data-loss outcome, not a skip
1. Backfill run R1 records its final inventory: 50 files including `/media/vanished.jpg` (referenced by World B's published v1 snapshot).
2. Before R1 classifies it, `/media/vanished.jpg` is deleted from disk externally (operator error).
3. R1 reaches the file: stat fails (absent). R1 does NOT skip it — skipping would break the reconciliation equation.
4. **Assert:** R1 classifies by references (v1 snapshot → World B), creates the `world_media_assets` row with `file_confirmed_present = false`, and the data-loss alert fires (§9.2). The file has an outcome (row + alert) and counts as classified.
5. **Assert:** reconciliation passes (50 outcomes for 50 inventoried files); R1 completes. Serving `/media/vanished.jpg` returns 404 with an error-level log (honest degradation, §4.5) — the snapshot URL contract ("these bytes at publish time") is preserved as a record of what *should* exist, not silently rewritten.

### S37: Stale capacity metric blocks writes (fail-closed)
1. The periodic capacity job fails (simulated disk error during its filesystem scan). The cached metric is now 6 minutes old, exceeding the 5-minute `STORAGE_METRIC_MAX_AGE_SEC`.
2. Creator attempts a 2 MB upload (well within quota and actual disk space).
3. **Assert:** **503** `{code: "STORAGE_METRIC_STALE", retryable: true}`. No file written, no row created, no reservation made. The stale metric did NOT authorize the write — fail-closed.
4. **Assert:** `/health` reports `"media_storage": {"stale": true}` and degraded status.
5. The job recovers on the next interval; the metric is fresh.
6. **Assert:** the same upload now succeeds. No operator intervention was needed beyond the job recovering.

### S38: Concurrent uploads respect capacity reservation
1. Volume has 100 MB effective available (after overhead reserve and existing usage). Two 60 MB uploads (A and B) start simultaneously for different worlds.
2. Upload A acquires locks (level 1 → 2 → 3), verifies metric freshness, computes `effective_available = 100 MB - 0 (reservations) = 100 MB ≥ 60 MB` → inserts a `storage_reservations` row (60 MB), proceeds with file write.
3. Upload B acquires locks (after A commits or while A holds them — either way, serialized), computes `effective_available = 100 MB - 60 MB (A's reservation) = 40 MB < 60 MB` → **507** `{code: "STORAGE_FULL", retryable: false}`.
4. **Assert:** exactly one upload succeeds. The reservation prevented both from spending the same 100 MB of headroom. B's 507 is `STORAGE_FULL` (capacity), not `QUOTA_EXCEEDED` — the distinction is preserved.
5. **Assert:** after A commits (reservation released) or rolls back, a retry of B sees the correct available space.
6. Crash variant: kill the worker mid-upload (after reservation insert, before commit). The reservation row has `expires_at = now() + 5 min`.
7. **Assert (rev 17 — A20):** after 5 minutes, the expired reservation is a claim candidate — it is NEVER "ignored by the capacity check" (the pre-rev-17 text was wrong): the capacity query counts `state IN ('RESERVED','WRITING')` regardless of `expires_at`. The expiry worker runs the §5.5 claim protocol (candidate → 60 s observation → mtime grace → fenced CAS) and transitions the row to `ABANDONED` (bytes durably in `abandoned_temp_bytes`) or `ROLLED_BACK` (no bytes). Headroom is not held forever by a crashed upload — but it is released only via the durable state transition, never by ignoring the row.

### S39: File in both tables triggers invariant alert (single owner)
1. (Setup via direct SQL, simulating a bug or manual error): `/media/dup.jpg` has a row in `world_media_assets` (`world_id=A`, `active`) AND a row in `unattributed_media_files` (`protected=true`).
2. The periodic capacity job runs its cross-check.
3. **Assert:** critical alert `DUPLICATE_FILE_REGISTRATION` fires with `filename=/media/dup.jpg` and both table names. The job logs at critical.
4. **Assert:** capacity counts the file ONCE — under `registry_bytes` (rule (a) of §4.1 single-owner accounting). It is NOT double-counted.
5. **Assert:** `GET /media/dup.jpg` serves from the `world_media_assets` row (authoritative table). No 500 — readers are not punished for a bookkeeping error.
6. Operator resolves via the atomic attribution transaction (§4.1): the unattributed row is deleted (the file was already attributed; the duplicate was the error).
7. **Assert:** next job run finds no violation; the alert clears.

### S40: Metadata change during backfill freeze is blocked
1. Backfill run R1 starts (`state='in_progress'`; freeze active). Final inventory recorded.
2. Creator attempts to update a scene's `illustrationUrl` (metadata update path).
3. **Assert:** the metadata transaction's freeze check (after acquiring the world-row lock, before the write) finds the `in_progress` run → **503** `{code: "BACKFILL_IN_PROGRESS", retryable: true}`. Metadata unchanged. No row updated.
4. Creator attempts to publish a new version.
5. **Assert:** the publish transaction's freeze check → **503** `{code: "BACKFILL_IN_PROGRESS"}`. No snapshot created.
6. Creator attempts world deletion (T1).
7. **Assert:** **503** `{code: "BACKFILL_IN_PROGRESS"}` (not 409 — this is a transient freeze, not a semantic conflict). No job row created.
8. R1 completes (freeze lifts atomically in the completion transaction).
9. **Assert:** the creator retries all three operations; they succeed normally. The 503s were transient, not persistent.

### S41: Resolved conflict with subsequent metadata change re-verifies (no bypass)
1. Backfill R1 detects a conflict on `/media/x.jpg`: registry row has `roles={'cover'}`, recomputed classification is `roles={'illustration'}` → `backfill_conflicts` row inserted (`detected`, `resolved_at=NULL`).
2. Operator resolves via the atomic transaction (§4.7c): accepts recomputed → `UPDATE world_media_assets SET roles={'illustration'}` AND `UPDATE backfill_conflicts SET resolved_at=now(), resolution='accepted_recomputed'` commit together.
3. Operator starts R2. R2 re-verifies: recomputed `{'illustration'}` matches row `{'illustration'}` → confirmed, zero conflicts → R2 completes. Enforcement enables.
4. Creator changes the scene to use a different illustration (normal §4.2b path): the metadata-switch transaction updates the row to `roles='{}'` (no longer referenced).
5. Operator starts R3 (new backfill for unrelated operational reasons).
6. **Assert:** R3 re-verifies the row — it does NOT trust R2's "confirmed" status or R1's "resolved" marker. Recomputed from current metadata: `roles='{}'` (file unreferenced in draft). Row has `roles='{}'`. Match → confirmed. No new conflict.
7. **Assert:** the historical `resolved` marker did not suppress re-verification. If the metadata had changed to a *conflicting* state, R3 would have created a NEW conflict row (marking the old one `superseded`), not silently accepted the stale resolution.

### S42: Out-of-band file mutation during recovery is detected and fenced
1. During a volume restore procedure (§9.2), the application is in maintenance mode. An operator (violating the runbook) copies `/media/rogue.jpg` directly onto the volume via shell.
2. Post-restore reconciliation (`diagnose`) runs its filesystem scan.
3. **Assert:** the scan finds `/media/rogue.jpg` with no row in either table and not in the expected temp set → alert `UNMANAGED_FILE_DETECTED` (warning) with filename and size. The file is counted in `unregistered_bytes` (not ignored).
4. **Assert:** deletion enforcement is SUSPENDED while the alert is active: `DELETE /worlds/:id/media/:assetId` returns **503** `{code: "RECONCILIATION_PENDING", retryable: true}`. The system fails closed — it will not make deletion decisions while filesystem state is uncertain.
5. Operator investigates: if the file is legitimate (e.g., missed by the restore), they run backfill to classify it. If not, they remove it.
6. **Assert:** once the file has a row (classified) or is gone, the next periodic job clears the alert; deletion enforcement resumes. The out-of-band mutation was detected, fenced, and resolved — never silently absorbed.

### S43: Reservation accounting conservation (no double-count, no gap)
1. **Setup:** Volume has 100 MB effective available. No active uploads. Periodic job has run recently (fresh metric).
2. **Action:** Upload A (60 MB) starts. Phase 1: reservation committed (60 MB in `active_reservations_bytes`). Temp file write begins.
3. **Assert (state 1 — reserved, no bytes):** `storage_used_bytes` does NOT include the 60 MB (temp file not yet written or empty). `active_reservations_bytes` = 60 MB. Capacity check for a second upload sees `100 - 0 - 60 = 40 MB` available. The bytes are counted exactly once (in reservations).
4. **Action:** Upload A's temp file completes (60 MB on disk in `/data/media/.tmp/`).
5. **Assert (state 2 — reserved, bytes on disk):** `storage_used_bytes` STILL does not include the 60 MB (temp files excluded per rev-13 rule). `active_reservations_bytes` = 60 MB. Still counted exactly once. A filesystem scan confirms the temp file exists but it is NOT in `unregistered_bytes` (it has an active reservation).
6. **Action:** Upload A commits. Reservation released atomically with row insert.
7. **Assert (state 3 — committed, rev 17 — A19):** `active_reservations_bytes` = 0. The file is now at its final path; `registry_bytes` includes the 60 MB IMMEDIATELY — `registry_bytes` is `SUM(size_bytes) FROM world_media_assets WHERE file_confirmed_present`, a database query exact at the commit instant. There is NO scan, NO measurement lag, and NO uncounted window: the commit transaction moved the bytes from `active_reservations_bytes` to `registry_bytes` in a single commit (durable handoff, rev 15). The pre-rev-17 text describing a "measurement lag" here was stale rev-13-era prose contradicting the durable handoff.
8. **Failure assertion:** At no point in steps 3–7 were the 60 MB counted in both `storage_used_bytes` AND `active_reservations_bytes`, nor in neither. A test that sums `storage_used_bytes + active_reservations_bytes` at each step sees: 0 → 60 → 60 → 60 (reservations → registry, the handoff is atomic — the sum never drops to 0).
9. **Crash variant (rev 14):** Kill the worker with `kill -9` between steps 4 and 6 (after temp file written, before commit). Specifically: kill AFTER the temp file is fully written but BEFORE the `temp_filename` UPDATE commits (the exact unsafe point from B1).
10. **Assert:** On restart, recovery finds the unreleased reservation. It stats the DETERMINISTIC path `/data/media/.tmp/{reservation_id}.part` (not `temp_filename`, which is NULL) → file present (60 MB) → bytes move to `abandoned_temp_bytes` (counted in `storage_used_bytes`), reservation released. The 60 MB never disappeared from accounting. The periodic job later cleans the temp file and the bytes leave `abandoned_temp_bytes`.
11. **Assert:** The expiry worker did NOT release the reservation based on `temp_filename IS NULL`. It statted the deterministic path. If it had used the old rev-13 rule (b), the 60 MB would have escaped accounting — this test proves the rev-14 fix.
12. **Concurrent racer (rev 14):** Two uploads (B: 60 MB, C: 60 MB) start simultaneously with 100 MB available. Both attempt Phase-1 reservation.
13. **Assert:** Level-1 serializes the check-and-reserve. Exactly one reservation commits (say B). C's Phase-1 sees `effective_available = 100 - 0 - 60 = 40 < 60` → 507 `STORAGE_FULL`. B proceeds; C does not write any bytes. No overspend.
14. **Recovery verification (rev 14):** After step 10's crash recovery, run the periodic job's filesystem scan. Assert: the temp file is listed, has no active reservation, IS counted in `abandoned_temp_bytes`, and is NOT in `unregistered_bytes` (it's a known temp file, not an unknown orphan). The accounting is complete and categorized correctly.
15. **Expiry vs live writer (rev 15 — B1.2):** Upload D starts; reservation active; temp file growing. Simulate a heartbeat stall: no heartbeat for 6 minutes (`expires_at` passed, `epoch` unchanged at E1), BUT the writer is still writing chunks every 20 seconds (file mtime is fresh).
16. **Assert:** the expiry worker selects the candidate, records `(E1, T1)`, waits 60 s, re-reads: `epoch == E1` BUT file mtime is newer than `T1 - 120s` → mtime grace applies → DO NOT CLAIM. Log at info. The reservation stays active; the writer continues. When the stall ends and the writer heartbeats (`epoch = E1+1`), the reservation is healthy again. **A live writer is never abandoned merely for a delayed heartbeat.**
17. **Assert (true crash, rev 16 — fenced claim):** kill -9 the writer (no more chunks, no heartbeats). Expiry worker: `epoch` unchanged across the 60 s observation, mtime older than 120 s → `LOCK_EX|LOCK_NB` succeeds (dead writer holds no lock; the kernel released it) → fenced CAS `UPDATE ... WHERE epoch = E1 AND released_at IS NULL AND state IN ('RESERVED','WRITING')` commits inside the exclusive-lock critical section → `state = 'ABANDONED'` durably. Assert via SQL alone (no scan): `abandoned_temp_bytes` includes D's `size_bytes`; `active_reservations_bytes` excludes it. A heartbeat arriving after the claim updates 0 rows → the (hypothetical) writer would abort on its next check. **No byte is counted abandoned while a live writer believes it owns the reservation; a dead writer's bytes are never uncounted.**
18. **Expiry vs paused writer — writer holds the lock (rev 16 — B1.2 fenced claim):** Upload E starts; reservation active; writer writing chunks. Advance the test clock past `expires_at` + 60 s observation with epoch unchanged at E1 and file mtime older than 120 s (heartbeats stalled, writer alive — liveness evidence passes, isolating the lock behavior). Pause the writer deterministically AFTER it acquires `LOCK_SH` and validates `state=active` but BEFORE its `write()` syscall (instrumented breakpoint).
19. **Assert:** the expiry worker selects the candidate, passes liveness evidence, then `flock(LOCK_EX|LOCK_NB)` FAILS with `EWOULDBLOCK` (writer holds `LOCK_SH`) → the claim ABORTS for this cycle; log at info with `reservation_id`, `reason: "write_in_flight"`. Assert via SQL: reservation still `WRITING`, `released_at IS NULL`, `epoch = E1`. **Property (a): finalization did not occur while a write was in flight — enforced by the lock, not by timing.**
20. **Action + assert (writer-validates-first order):** resume the writer → its `write()` lands (before abandonment — legal), releases `LOCK_SH`. Expiry next cycle: `LOCK_EX|LOCK_NB` succeeds → fenced CAS claim commits → `ABANDONED`; record `claim_finalized_at` and file size S1. The writer's NEXT chunk acquires `LOCK_SH`, validates under the lock, observes `ABANDONED` → aborts with ZERO bytes written. Assert: file size == S1 and file mtime < `claim_finalized_at` after the writer's abort. **Property (b): no write occurred after abandonment was finalized.**
21. **Claim-first order + process-termination variant (rev 16):** Upload F starts; same stalled-heartbeat setup. Pause the writer BEFORE it acquires `LOCK_SH` for its next chunk (between chunks, lock free). Expiry cycle: `LOCK_EX|LOCK_NB` succeeds → fenced CAS claim commits → `ABANDONED`; record size S2. Resume the writer → acquires `LOCK_SH`, validates, observes `ABANDONED` → aborts WITHOUT `write()`. Assert: file size == S2, mtime unchanged — **property (b) for the claim-first order.** Then upload G: pause the writer after acquiring `LOCK_SH` and validating, before `write()`; `kill -9` the writer (lock held at death). Assert: the kernel released the dead process's `LOCK_SH`; expiry next cycle `LOCK_EX|LOCK_NB` SUCCEEDS → fenced claim commits → `ABANDONED`. Assert via SQL alone: `abandoned_temp_bytes` includes G's `size_bytes`, `active_reservations_bytes` excludes it; a subsequent expiry cycle on an unrelated reservation proceeds normally (no leaked lock state); any partial chunk bytes are covered by conservative `size_bytes`. **Crash-during-critical-section converges with no operator intervention and no timing assumption.**
22. **Reverse direction — pause expiry after `LOCK_EX` (rev 17):** Upload H starts; writer writing chunks. Expiry worker passes liveness evidence, acquires `LOCK_EX|LOCK_NB` successfully, then is paused deterministically AFTER acquiring the lock but BEFORE the terminal UPDATE. The writer attempts its next chunk: `flock(fd, LOCK_SH)` BLOCKS (expiry holds `LOCK_EX`).
23. **Assert:** the writer cannot enter its write critical section while the expiry worker holds `LOCK_EX` — its `LOCK_SH` acquisition does not return until the worker releases. Resume the worker → terminal UPDATE commits → `ABANDONED` → `LOCK_UN` → the writer's `LOCK_SH` unblocks → validates under the lock → observes `ABANDONED` → aborts with ZERO bytes written. **Property (b) holds in the reverse pause direction: the lock serializes the critical sections regardless of which party is paused.**
24. **Failure between terminal UPDATE and COMMIT (rev 17 — A16):** Upload I starts; writer dead (kill -9); expiry worker passes liveness, acquires `LOCK_EX`, executes the terminal UPDATE (`state='ABANDONED'`) — then inject a database failure BEFORE commit (kill the worker's DB session, simulating a connection drop).
25. **Assert:** the transaction ROLLBACKs (session end); `LOCK_EX` is released by the kernel ONLY AFTER the rollback completes (A16: lock held through rollback — assert via the normative ordering, verified by code inspection: the `flock(LOCK_UN)` call site is after the transaction-close call site on every path). The reservation is still active (`released_at IS NULL`); a subsequent writer heartbeat would succeed (no writer exists, but the row is claimable again). Next expiry cycle retries the claim cleanly → `ABANDONED` commits. **No half-committed terminal state; no lock released mid-transaction.** (The full kill-at-every-boundary matrix is in S52 step 7.)

### S44: Backfill completion race (no stale-input completion)
1. **Setup:** Backfill run R1 is `in_progress`. It has classified 100 files. It is about to run its completion transaction.
2. **Action (race):** Simultaneously: (a) R1 begins its completion transaction (acquires level-1 lock), and (b) a creator's metadata update transaction attempts to change a scene's `illustrationUrl` (tries to acquire level-1 lock).
3. **Assert:** The two transactions serialize on level-1. Exactly one of:
   - **Case A (R1 wins):** R1 holds level-1, recomputes `attribution_input_hash`, compares with inventory-time hash → match (the writer hasn't committed yet) → R1 marks `complete` and commits, releasing level-1. The writer then acquires level-1, checks for `in_progress` run → finds none (R1 is `complete`) → proceeds via the NORMAL registry path (creates registry row, assigns roles, full treatment). The file is registered immediately — NO future backfill needed. (Rev 14 correction: the rev-13 text misleadingly said "the next backfill will see it.")
   - **Case B (writer wins):** Writer holds level-1, passes freeze check (R1 still `in_progress`), commits the metadata change, releases level-1. R1 then acquires level-1, recomputes hash → MISMATCH (writer's change is now visible) → R1 marks `failed`, NOT `complete`. Enforcement stays disabled. Log at critical with hash diff.
4. **Assert:** There is NO interleaving where R1 verifies the hash against state S, then the writer commits state S', then R1 marks `complete`. The level-1 lock makes verification and marking atomic with respect to all writers.
5. **Assert:** In Case B, the operator starts R2 (new run, new inventory, new hash). R2 classifies against the post-change metadata. If clean → R2 completes. The failed R1 did not corrupt any state — its classifications were not committed as authoritative (backfill only writes rows, never marks them "final" until completion).
6. **Crash during completion (rev 14):** Kill the backfill worker with `kill -9` AFTER it acquires level-1 but BEFORE the completion transaction commits (mid-verification).
7. **Assert:** On restart, the run row is still `in_progress` (the completion transaction never committed). The level-1 lock was released automatically on session teardown. No partial `complete` state exists. The operator can safely start a new run (which will fail on the unique index if the old `in_progress` row wasn't marked `failed` — restart recovery marks it `failed` first per §4.7).
8. **Post-completion write verification (rev 14):** After Case A (R1 complete), have the writer complete its metadata update. Assert: the writer's file has a registry row with correct `world_id` and `roles` IMMEDIATELY after commit (query `world_media_assets`). No backfill run is needed to make it consistent. The invariant "no un-backfilled files exist post-completion" holds because post-completion writes are native registry writes.
9. **All post-completion mutation types (rev 15 — B2 verification):** after R1 completes, perform each of the following and assert registry consistency immediately after each commit (no backfill involved):
   - (a) Draft metadata change: swap a scene's `illustrationUrl` → assert the old asset's row has updated `roles`, the new URL has a registry row, §4.2b contract held (freeze check under level 1).
   - (b) Publish: create a snapshot → assert the snapshot row exists AND `asset_snapshot_references` rows were inserted for its asset URLs in the same transaction.
   - (c) Asset replacement T1+T2: upload new file, switch metadata → assert new file registered, old file in `pending_deletion` only after the switch commits.
   - (d) World deletion of an empty draft-only test world → assert job completes, zero asset rows remain.
   - (e) Metadata update racing backfill completion is covered by steps 2–4; assert the 503 `BACKFILL_IN_PROGRESS` path during `in_progress` and normal-path success after `complete`.
10. **Crash between filesystem rename and DB commit (rev 15 — B2 crash boundary):** kill -9 the uploader AFTER the temp→final rename but BEFORE the registry-row INSERT commits (post-completion, enforcement active).
11. **Assert:** the file exists on disk with NO registry row. §9.4 reconciliation finds it: reference-check against drafts + snapshots. Case 1: the crashed upload's URL was never referenced (metadata switch never happened) → file has zero references → moved to `.quarantine/`, logged at warning. Case 2 (variant): the URL had been pre-registered as a reference by a concurrent metadata update → `unattributed_media_files` row (`protected=true`). In NEITHER case is the file servable as a registered asset (no `world_media_assets` row → §4.5 step 1 misses → 404 unless protected-unattributed), and in neither case is reference protection lost (the scan re-derives references from ground truth). **No crash ordering exposes an unregistered file as registered or drops protection for a referenced file.**

### S45: Failed cleanup recovery (ENOSPC + unlink failure)
1. **Setup:** Volume has 10 MB effective available. Creator starts a 50 MB upload. Phase-1 reservation committed (50 MB reserved).
2. **Action:** Temp file write begins. After 10 MB written, the filesystem returns `ENOSPC`.
3. **Action:** The upload path attempts synchronous deletion of the partial temp file. **Simulate unlink failure** (e.g., permission error, I/O error on the directory).
4. **Assert (rev 15 — durable handoff):** the upload path executes ONE transaction: `UPDATE storage_reservations SET state = 'ABANDONED', released_at = now() WHERE reservation_id = ? AND released_at IS NULL`. From that commit instant, the 10 MB partial file's bytes are durably counted in `abandoned_temp_bytes` via the row's `size_bytes` (conservative: 50 MB reserved ≥ 10 MB actual). No scan participates in the handoff. The bytes have NOT escaped accounting at any instant: before the UPDATE they were in `active_reservations_bytes`; after, in `abandoned_temp_bytes` — same row, one commit.
5. **Assert:** Response is **507** `{code: "STORAGE_WRITE_FAILED", retryable: true, detail: "filesystem full during write; cleanup incomplete"}`. Log at error with `reservation_id`, `temp_filename`, and the unlink error.
6. **Action (rev 15):** the periodic job selects `storage_reservations WHERE state = 'ABANDONED'` — the row from step 4. It stats the deterministic path `/data/media/.tmp/{reservation_id}.part` (10 MB present, as expected) and attempts the cleanup unlink.
7. **Assert:** the bytes were ALREADY in `abandoned_temp_bytes` durably from step 4's state transition — the job does not reclassify; it cleans up. Accounting via SQL alone (no scan): `abandoned_temp_bytes` includes the row's 50 MB (conservative); `active_reservations_bytes` excludes it. The capacity protection was never dropped.
8. **Action:** The job attempts to delete the abandoned temp file. **Simulate continued unlink failure.**
9. **Assert:** The 10 MB REMAINS in `abandoned_temp_bytes`. Alert `TEMP_CLEANUP_FAILED` fires (error) with filename and size. Operator must intervene manually (fix permissions, free space, etc.).
10. **Assert:** Deletion enforcement is NOT suspended by this alert alone (unlike `UNMANAGED_FILE_DETECTED`) — the bytes are accounted for, just not yet cleaned. The system knows exactly how many bytes are stuck and where.
11. **Action:** Operator fixes the underlying issue and manually deletes the file (or the next job run succeeds).
12. **Assert:** Next scan finds the file gone → `abandoned_temp_bytes` decreases by 10 MB → `TEMP_CLEANUP_FAILED` clears. Every byte was accounted for through the entire failure sequence.
13. **Crash during cleanup (rev 15):** Kill the worker with `kill -9` AFTER the ENOSPC error but BEFORE the unlink attempt AND before the durable `ABANDONED` transition commits (the process dies with the partial file on disk and the reservation still active in `WRITING`).
14. **Assert:** On restart, recovery finds the active reservation. The expiry claim protocol (rev 16 — B1.2, fenced) takes over: candidate selected (`expires_at` passed), `(E1, T1)` recorded, 60 s observation, epoch unchanged, mtime older than 120 s (no writer alive) → CAS `UPDATE ... SET state = 'ABANDONED', released_at = now() WHERE reservation_id = ? AND epoch = E1 AND released_at IS NULL` succeeds → bytes durably in `abandoned_temp_bytes`. The reservation is `ABANDONED` (not "released silently") ONLY after the bytes are durably counted — the state column is the proof. At no point were the 10 MB uncounted.
15. **Recovery verification (rev 14):** After step 14, query the accounting: `SELECT SUM(size_bytes) FROM storage_reservations WHERE released_at IS NULL` = 0 (reservation released). The periodic scan confirms the 10 MB file exists in `/data/media/.tmp/` with no active reservation → counted in `abandoned_temp_bytes`. Sum check: `storage_used_bytes` includes the 10 MB exactly once. The conservation invariant held through crash + expiry + reclassification.
16. **State/timestamp constraint enforcement (rev 16 — B1.1):** attempt the following invalid writes directly against `storage_reservations` and assert each is REJECTED by the CHECK constraints (not by application logic):
    - `INSERT ... state='WRITING', released_at=now()` → rejected (active state must have `released_at IS NULL`).
    - `INSERT ... state='ABANDONED', released_at=NULL` → rejected (terminal state must have `released_at` set).
    - `UPDATE ... SET claim_epoch=5 WHERE state='COMMITTED'` → rejected (claim columns only for `ABANDONED`).
    - `UPDATE ... SET claim_epoch=5, claim_finalized_at=NULL WHERE state='ABANDONED'` → rejected (claim columns travel together).
    - `INSERT ... size_bytes=0` → rejected; `epoch=-1` → rejected.
    **Assert:** no invalid combination can be persisted — the database, not the application, is the last line of defense against misaccounting.
17. **Repeated failed cleanup (rev 16 — B1.1):** reset; new upload, ENOSPC, unlink fails → `ABANDONED` (durable). Run the periodic cleanup job 3 times, each time simulating unlink failure. **Assert after each run:** the row is still `ABANDONED`, `abandoned_temp_bytes` still includes its `size_bytes` exactly once (SQL: `SUM` grouped by state shows one row in exactly one category), and `TEMP_CLEANUP_FAILED` remains raised (not duplicated per run — one alert per reservation). Then simulate unlink success on run 4: **Assert:** `state='CLEANED'`, bytes leave `abandoned_temp_bytes`, alert clears. **Repeated failures never undercount (bytes always in exactly one category) and never double-count.**
18. **Commit-transition size conservation (rev 16 — B1.1):** upload with reserved 50 MB, actual file 48 MB. **Assert at the commit instant:** before commit, `active_reservations_bytes` = 50 MB; after commit, `active_reservations_bytes` = 0 AND `registry_bytes` includes 48 MB. The 2 MB difference returned to available capacity atomically — no instant where 98 MB was counted, none where 0 was counted. A concurrent Phase-1 capacity check racing the commit sees exactly one of the two states (READ COMMITTED).

### S46: Shared ownership lifecycle (multi-world references, authorization, deletion)
1. **Setup:** World A (`world_id` ending `...0001`, lexicographically smallest), World B (`...0002`). File F registered: `world_id = A`, `shared_with_worlds = ['B']`, `lifecycle = 'active'`. Both worlds' drafts reference F's URL. World B has a published story; World A has a different published story.
2. **Action:** A reader of World B's story requests `GET /media/F`.
3. **Assert:** 200, file served. Authorization was validated against World B's access policy (published → public reads allowed). Then: the same reader requests World A's *other* (non-shared) asset under World B's context → **404** (per-file grant; no world-level privilege leaked). Then: an unauthenticated request for F with no world context (or a World C context) → **404**.
4. **Action:** World B's creator removes F's URL from B's draft metadata.
5. **Assert:** the metadata-update transaction (1 → 3 → 6) atomically removed B from the array: `shared_with_worlds = []`. F is still owned by A, still referenced by A's draft → still served via A's context. No conflict was created (reference-set update, not ownership disagreement — §4.7c rule 5).
6. **Action:** World B's creator re-adds F's URL to B's draft.
7. **Assert:** `shared_with_worlds = ['B']` again (append under the asset-row lock). Two concurrent re-adds from different sessions → one wins the asset-row lock; the array ends with exactly one `'B'` (idempotent append, not double-add).
8. **Action:** Delete World A (draft-only; §4.9).
9. **Assert:** F is NOT unlinked. T1 transferred ownership: `world_id = B` (smallest in the array), `shared_with_worlds = []`. T2's `WHERE world_id = A` did not match F; T3 never statted it for removal. A World B reader requesting F → 200 (ownership transfer did not break serving).
10. **Variant — snapshot protection with stable identity (rev 16 — B4.2):** reset; World A deleted with `shared_with_worlds = []` BUT World B's retained snapshot S1 references F (row `(F.filename, S1)` in `asset_snapshot_references`). **Action:** DELETE World A (draft-only; §4.9). **Assert:** (a) T1's transfer committed: `world_media_assets` has NO row for F's filename; `unattributed_media_files` has exactly one row: `filename = F.filename`, `protected = true`, `referencing_worlds = [B]`, `notes` containing `'transferred from world deletion <A>'` and `'snapshot-protected'`. (b) The protection rows are BYTE-IDENTICAL before and after T1: `SELECT filename, snapshot_id, world_id, created_at FROM asset_snapshot_references WHERE filename = F.filename` returns exactly `{(F.filename, S1, B)}` with `created_at` unchanged — no delete+reinsert, no cascade. (c) The file is on disk, byte-identical. (d) `GET /media/F` in S1's snapshot context → 200 (snapshot published; ref row present — §4.5 step 2). (e) `GET /media/F` in World B's draft context → 404 (no registry row; snapshot refs confer no draft rights). (f) Deletion still blocked: world-deletion T3 enumerates by `world_id` — the file has none; a direct operator delete of the unattributed row → refused (`protected=true`). **The references survived the registry transition AND continue blocking deletion.** (g) Crash injection: kill the worker between the INSERT and DELETE of a candidate inside T1 → the whole T1 transaction rolls back (atomicity), so on restart no job row exists, `world_media_assets` still holds F's row, `unattributed_media_files` has none, ref rows unchanged → retrying the DELETE completes the transfer exactly once (assert a single unattributed row). (rev 17 — A29: the pre-rev-17 parenthetical cited "the pre-insert check + `UNIQUE(filename)`" as the duplicate guard — those matter for the *concurrent*-insert case, but in the crash case it is transaction atomicity (rollback) that prevents the duplicate, not the guards.) (h) Simulate retention GC of S1 (the last referencing snapshot): ref rows deleted in the snapshot-deletion transaction → F's unattributed row becomes `classification_status='pending_review'`, `protected=true` retained, never auto-deleted; a delete attempt is still refused until the operator decides.
11. **Action:** World B (now owner from step 9) removes F's URL from its draft; no snapshots reference F.
12. **Assert:** F is unreferenced: `shared_with_worlds = []`, no `asset_snapshot_references` rows, owner's draft clean → normal §4.3b lifecycle applies: T1 zero-reference scan → `pending_deletion` → T2 unlink → row deleted. **Every reference removal converges on the correct terminal state; no share, snapshot, or ownership edge case leaks a file or deletes a referenced one.**
13. **Drift (a) — agreement (rev 16 — B4.2):** Setup: S1's `canon_data` contains F's URL; the table holds `(F.filename, S1)`. **Action:** run re-verification. **Assert:** no conflict created for F; the row is unchanged. No operator action required.
14. **Drift (b) — missing row (rev 16 — B4.2):** Setup: S1's `canon_data` contains F's URL; the ref row is deleted (simulating a contract violation). **Action:** run re-verification. **Assert:** (i) conflict created: `reason='snapshot_ref_drift'`, `subtype='missing_row'`, expected=`{S1}`, actual=`{}`. (ii) Fail-closed: with the conflict unresolved, the §4.3b T1 scan for F's filename → **409** `ASSET_REFERENCED` (the unresolved conflict blocks, not just the table). (iii) Operator runs the drift-resolution transaction (1 → 3 → 5 → 8): re-scan confirms S1 references the URL → row re-inserted → conflict resolved → subsequent scans block via the table row.
15. **Drift (c) — stale row (rev 16 — B4.2):** Setup: row `(F.filename, S2)` exists but S2's `canon_data` no longer contains F's URL (out-of-contract snapshot edit). **Action:** run re-verification. **Assert:** (i) conflict `snapshot_ref_drift`/`stale_row`. (ii) Fail-closed default: asset-delete T1 scan for F → **409** `ASSET_REFERENCED` — the stale row still protects; over-protection is operator-visible, never data loss. (iii) Operator resolution: the transaction re-runs the §4.2 scan under its locks, confirms absence, DELETEs the stale row, marks resolved. (iv) Negative case: if the re-scan FINDS the URL (scanner false negative), the transaction must NOT delete the row — assert the row survives and the conflict is reclassified, never silently dropped.

### S47: Restore fencing (external guarantee + fail-closed check)
1. **Setup:** application running, maintenance fence inactive, media volume populated. One upload is mid-Phase-2 (active `RESERVED` reservation, writer heartbeating).
2. **Action:** operator activates the fence (`active = true`), waits for level-1 quiescence (0 holders), then stops all machines (`fly scale count 0`).
3. **Assert (B8 invalidation, rev 19; state corrected rev 20):** the activation transaction atomically set the in-flight reservation to `ABANDONED` — NOT `ROLLED_BACK` (rev 20: `ROLLED_BACK` promises "file confirmed absent," which activation cannot promise; `ABANDONED` means "bytes may exist, conservatively counted, job will clean"). The writer's next heartbeat UPDATE affects 0 rows → aborts; its next chunk re-validation reads the non-active reservation → aborts before `write()`. **Assert:** no chunk write begins after the activation commit (at most the already-in-flight chunk's `write()` completes). From the activation commit, the row's `size_bytes` sits in `abandoned_temp_bytes` — no uncounted window. The orphaned temp file is cleaned by the periodic job via the normal `ABANDONED` selection (`WHERE state='ABANDONED'` — the path §5.5 actually specifies).
4. **Assert (verification gate, rev 16 — B5.2):** `fly status` shows 0 machines AND the following query returns zero rows:
    ```sql
    SELECT pid, usename, application_name, state
      FROM pg_stat_activity
     WHERE usename = '<app_db_role>' AND pid <> pg_backend_pid();
    ```
    Then: open an ad-hoc `psql` session AS the application role (simulating a forgotten admin session or automation) and re-run the query → 1 row. **Assert:** the gate now FAILS — the restore must not proceed until that session is terminated. Terminate it, re-run → 0 rows → gate passes. **Machine count alone is not proof; the role-filtered session check is.**
5. **Action:** restore a database backup whose `system_maintenance` row has `active = false` (the dangerous case: the flag alone would un-fence).
6. **Assert:** with zero writer processes running, no write is possible regardless of the flag — the external guarantee holds independently of database state. Then the re-assertion runs as the FIRST SQL (the `INSERT ... ON CONFLICT DO UPDATE` setting `active = true`); a subsequent `is_maintenance_active()` call returns `true` (rev 19 — B7: the check goes through the wrapper, never a direct SELECT). Volume restore proceeds only after.
7. **Action:** simulate a missing table: `DROP TABLE system_maintenance` (in a test environment).
8. **Assert:** `is_maintenance_active()` catches `undefined_table` → returns `true`. All mutating endpoints → **503** `MAINTENANCE_MODE`. Health → `degraded`. Critical alert `SYSTEM_MAINTENANCE_TABLE_MISSING` fires. **No path interprets the error as "maintenance inactive."**
9. **Action:** restore the table; simulate a query error (revoke SELECT on the table from the app role).
10. **Assert:** same fail-closed behavior: 503 on mutations, `degraded` health, error alert. The function's contract ("true on any error") holds for permission errors as well as missing objects.
11. **Action (B3 recovery protocol, rev 19):** volume restored; `diagnose` reports discrepancies. Operator establishes a recovery authorization (scope `restore-reconcile`), verifies writer exclusion (level-1 quiescence ✓, zero active reservations ✓ — guaranteed by step 3's invalidation, zero app sessions ✓), then runs `repair` UNDER the authorization while the fence stays active.
12. **Assert:** repair mutates (quarantine moves, row fixes) with the fence still active — no circular dependency. A second concurrent authorization request is rejected by the partial unique index. After repair reports zero error-level findings: authorization revoked, release criteria (§4.3d) all pass (criterion 2 satisfied by this authorized repair run). Start ONE machine.
13. **Assert:** the machine's startup verification (table exists, row exists, migration version) passes; health reports correctly; operator lifts the fence; single machine serves writes; THEN scale to normal count. **At no instant was there a running writer without a provably active fence, no second writer started before the first was verified, and repair never required lifting the fence.**

### S48: Competing-transaction lock-order tests (rev 16 — B4.3)
Prerequisite: R1–R7 applied. `lock_timeout = 30s` on all test sessions (bounds any unforeseen wait; advisory waits are detector-invisible).

**S48a — FK-validation lock placement.** (i) Static: every `INSERT`/`UPDATE` touching an FK column is preceded in the same transaction by `SELECT … FOR UPDATE` on the referenced row (upload, publish, T1, attribution per R5, T1 new-owner rows per R6, backfill writes per R7) — assert by code inspection of the write paths. (ii) Dynamic: run the attribution transaction concurrently against a session holding `FOR UPDATE` on the same `worlds` row *without* level 1 (simulating a hypothetical non-compliant writer): **assert** the attribution either waits with the wait edge going 3→7-ascending per R5, or takes no wait at all with the R5 lock in place — no deadlock. (iii) Negative: `unattributed_media_files.matched_world_id` is NULL in all *committed* states — it is set only transiently within the attribution transaction (which holds the world-row lock per R5/E2, so the FK1 `FOR KEY SHARE` is self-held). Assert via column audit on committed rows; if any future path leaves it non-NULL after commit, that path must take the world-row lock first (E2). (rev 17 — A3: the pre-rev-17 wording "stays NULL on all ADR write paths" was factually wrong — §4.7's attribution sets it mid-transaction.)

**S48b — Multi-row ORDER BY verification.** Concurrently execute, in opposite start order: (1) publish locking N asset rows via `WHERE asset_id = ANY($ids)` and (2) asset-delete T1 locking the same world's scene rows plus one overlapping asset row. **Assert:** both complete with no deadlock and no `lock_timeout` — locks were acquired ascending-ID on both sides (R2). Contrast control: the same pair with the `ORDER BY` clauses removed **must** be rejected by a static check (the lock-first pattern is mandatory — grep the code for `FOR UPDATE` on multi-row predicates without a preceding `ORDER BY`; zero hits allowed).

**S48c — Session-level lock vs concurrent transaction.** Recovery worker holds 0(J) and an inner transaction holds 1 → 2 → 3 → 4 → 6; concurrent upload waits on 1. **Assert** via `pg_locks`/`pg_stat_activity`: (a) the upload's wait is on the advisory lock with no granted locks; (b) the recovery session's only session-level lock is 0(J); (c) kill -9 the worker mid-`unlink` → 0(J) disappears without cleanup, the upload proceeds, a new worker try-locks 0(J) cleanly and resumes from the job row state with `files_removed` rebuilt from stat (second unlink of an absent file is a stat-confirmed no-op).

**S48d — Unique-race serialization.** Two uploads with the same `filename` submitted simultaneously. **Assert:** the second blocks on level 1 (never reaches its INSERT while the first is in flight — Lemma C), then fails closed with the §4.1 duplicate-`filename` 500 / duplicate-`url` 409 contract — no hang, no second row, critical log emitted.

### S49: G3 anti-resurrection — new-file collision vs legitimate transfer (rev 17 — A1)
1. **Setup (phase A — G3 fires):** file `/media/protected.jpg` is snapshot-protected: row `(protected.jpg, S1)` exists in `asset_snapshot_references` (S1 is World B's retained snapshot). No row for `protected.jpg` exists in either registry table (the file's registry row was legitimately moved/deleted in a prior test, but the snapshot still references it — the protection row is live).
2. **New-file collision (G3 fires):** attempt an upload Phase-2 commit whose generated filename is `protected.jpg` (simulating UUID-RNG collision via direct SQL with the colliding filename).
3. **Assert:** the pre-insert G3 check finds the live ref row → the INSERT aborts, **500**, critical alert `STALE_SNAPSHOT_REF_RESURRECTION` with `filename=protected.jpg`. No row is created in either table. **A new physical file was prevented from hijacking live snapshot protection.**
4. **Reset for phase B (rev 18 — B12):** the phase-A state (no registry row) cannot exercise a transfer — a transfer moves an EXISTING row. Re-setup: `INSERT INTO world_media_assets` a row for `protected.jpg` owned by World B (simulating a world that owns a snapshot-protected file); the ref row `(protected.jpg, S1)` remains. Assert the setup: one registry row, one live ref row.
5. **Legitimate transfer — T1 (G3 exempt):** World B is deleted (draft-only, §4.9). T1's snapshot-protected transfer executes `INSERT INTO unattributed_media_files` for `protected.jpg` — the ref row `(protected.jpg, S1)` EXISTS by design.
6. **Assert:** the INSERT succeeds (G3 does not apply — the T1 sequence is specified without the G3 query; this is an identity-preserving transfer, not a new-file registration). The unattributed row is created; the ref row is byte-identical. **The transfer the old G3 text would have blocked now completes.**
7. **Legitimate transfer — attribution (G3 exempt):** operator attributes `protected.jpg` from `unattributed_media_files` to World C via the §4.7 attribution transaction.
8. **Assert:** the `INSERT INTO world_media_assets` succeeds despite the live ref row. The file is now registered to World C; the ref row still protects it. **Attribution of snapshot-protected files is possible.**
9. **Negative — silent G3:** add a new insert path to the spec (hypothetical review exercise): assert its transaction spec states either "G3 required (new-file registration)" or "G3 exempt (identity-preserving transfer, justification: …)". **Assert:** a spec silent on G3 is flagged as a spec bug in review. **The distinction is structural (in the transaction spec), not a runtime flag.**

### S50: Backfill populates snapshot references — no false drift (rev 17 — A2)
1. **Setup:** legacy volume with file `/media/legacy.jpg`. World L's retained snapshot S9 has `/media/legacy.jpg` in its `canon_data`. No row exists in `asset_snapshot_references` (pre-backfill state). No registry row exists.
2. **Action:** run the §4.7 backfill. The classification transaction for `legacy.jpg`: step-2 scan finds the snapshot reference; step 4 creates the `world_media_assets` row; step 6 (rev 17 — A2) inserts `(legacy.jpg, S9, L)` into `asset_snapshot_references` **in the same transaction**.
3. **Assert:** after the backfill commits, `SELECT * FROM asset_snapshot_references WHERE filename = 'legacy.jpg'` returns exactly `{(legacy.jpg, S9, L)}`. The registry row and the ref row committed atomically — no window where one exists without the other.
4. **Action:** run re-verification (new backfill run). The cross-check (§4.7c step 2) compares discovered snapshot references against the table.
5. **Assert:** ZERO `snapshot_ref_drift`/`missing_row` conflicts for `legacy.jpg`. **The first re-verification after backfill does not flag population as drift.** (Pre-rev-17, this produced a false `missing_row` conflict for every legacy snapshot-referenced file.)
6. **Draft-only file:** file `/media/draftonly.jpg` referenced only in World M's draft (no snapshots). **Assert:** backfill creates the registry row and ZERO ref rows — the empty set is the correct complete population. Re-verification: no conflict.
7. **Orphan snapshot (rev 19 — B5):** file `/media/orphan.jpg` is referenced in snapshot S7's `canon_data`, but S7's `world_id` is NULL (legacy orphan). **Action:** backfill classifies it. **Assert:** the `(orphan.jpg, S7, NULL)` ref row inserts successfully — the nullable `world_id` permits it (a NOT NULL constraint would have made this insertion impossible and broken the §4.2 orphan promise). The file gets an `unattributed_media_files` row (`protected = true`); the ref row protects it from deletion. Re-verification: the drift cross-check treats NULL-world rows as unowned-but-protected — no false drift, no invented owner.
8. **Atomicity:** kill -9 the backfill worker between the registry-row INSERT and the ref-row INSERTs (inside the classification transaction).
9. **Assert:** the transaction rolls back entirely — no registry row, no ref rows, no partial population. Retry completes both atomically. **Half-populated state is impossible.**

### S51: Deployment flock self-test (rev 17)
1. **Setup:** fresh deployment (or staging) before serving traffic.
2. **Action:** the startup self-test runs: process A takes `LOCK_EX|LOCK_NB` on a scratch file in `/data/media/.tmp/` → process B attempts `LOCK_SH|LOCK_NB` on the same path → MUST fail with `EWOULDBLOCK`. Then reversed: B takes `LOCK_EX|LOCK_NB` → A's `LOCK_SH|LOCK_NB` MUST fail.
3. **Assert:** both directions fail as expected → coherent `flock` domain confirmed → the server proceeds to serve. Log at info with the test result.
4. **Failure case:** simulate a filesystem without coherent lock coordination (e.g., NFS with lockd disabled — test hook).
5. **Assert:** the self-test FAILS → the server does NOT silently proceed with the rev-16 handshake. It either (a) refuses to start with a critical log (`FLOCK_INCOHERENT`), or (b) starts in the explicitly degraded mode (rev-15 timing bounds) ONLY if the operator has set an explicit acknowledgment flag (`FLOCK_DEGRADED_ACKNOWLEDGED=true`). **Degradation is a conscious operator decision, never silent.** The degraded mode is logged at warning on every claim cycle.
6. **Assert:** the self-test runs on EVERY startup (not just first deploy) — a volume remount or filesystem change between restarts is detected.

### S52: Fencing failure cases — lock lifetime and inode identity (rev 17 — A16/A17/A18)
1. **Lock released before commit (spec violation):** code-review exercise — a hypothetical claim implementation that orders `UPDATE → flock(LOCK_UN) → COMMIT`.
2. **Assert (static check + review):** this ordering is REJECTED as a correctness bug per the normative A16 rule ("`LOCK_EX` MUST be held until the claiming transaction's COMMIT (or ROLLBACK) completes"). The scenario documents the interleaving it would permit: worker releases `LOCK_EX` after UPDATE but before COMMIT → writer acquires `LOCK_SH`, validates against the pre-commit (still-active) state → `write()` lands → claim COMMITs → post-abandonment bytes exist. **Static check (rev 18 — B7, executable):** in the claim-path implementation, grep for `flock(fd, LOCK_UN)` / `flock(LOCK_UN)` call sites; for each, assert textually that the preceding statement on every control-flow path is the transaction-close call (`COMMIT`/`ROLLBACK` or the transaction-scope exit), not the `UPDATE`. Any `LOCK_UN` that can execute while the transaction is still open fails the check. **The test is that the spec forbids the ordering; no implementation may exhibit it.**
3. **Wrong-inode open (fail closed):** setup: reservation R active, temp file at the deterministic path. Between the worker's step-4 stat and step-5a open, replace the path: `unlink` + create a new file at the same path (simulating a contract violation — the temp-path identity invariant forbids this).
4. **Assert:** the step-5a `fstat` inode comparison detects `(st_dev, st_ino)` mismatch → the claim ABORTS for this cycle (log at error, `INODE_REPLACED`). No terminal UPDATE executes. The reservation stays active. **Locking the wrong inode is detected and failed closed, not silently tolerated.**
5. **Path vanished (rename race):** setup: writer in its commit sequence; it renames temp→final between the worker's step-4 stat (ENOENT — rename already happened) and step-5a open (ENOENT).
6. **Assert:** the worker takes the path-vanished sub-protocol (no `O_CREAT`, no file lock): CAS directly. **Case A (writer wins):** writer's COMMITTED commits first → worker's CAS matches 0 rows → abort; reservation COMMITTED; file is a registry file. **Case B (worker wins):** worker's ROLLED_BACK commits first → writer's commit UPDATE matches 0 rows → writer ROLLBACKs the asset INSERT; the renamed file is an orphan → §9.4 reconciliation. **Assert in both cases:** exactly one terminal state commits; no byte is uncounted; no `write()` lands post-claim (the writer is past its chunk loop).
7. **Kill at each boundary:** (a) kill the expiry worker between the terminal UPDATE and COMMIT → assert: transaction rolls back (database session end), `LOCK_EX` released by the kernel, reservation still active, next cycle retries cleanly. (b) Kill the writer between COMMIT and `flock(LOCK_UN)` → assert: kernel releases the lock, transaction already committed, no effect. (c) Kill the writer between ROLLBACK and `flock(LOCK_UN)` → assert: kernel releases the lock, transaction already rolled back, claim proceeds next cycle. **No kill ordering leaves a leaked lock, a half-committed terminal state, or uncounted bytes.**
8. **Writer lock-release ordering (A18):** instrument the writer's commit path: assert `flock(LOCK_UN)` is never called while the commit transaction is still open (check via `pg_stat_activity`/`txid_current` — the transaction must be committed or rolled back before the unlock syscall). **Assert on all three paths:** normal commit, 0-row abort, SQL-error rollback. **Releasing the lock before the transaction ends is a spec violation.**
9. **Claim-side A16 — executable (rev 18 — B13):** instrument the expiry worker's bytes-branch claim: pause the worker after the terminal UPDATE executes but before COMMIT.
   **Assert:** (a) a second worker's `LOCK_EX|LOCK_NB` on the same path fails with `EWOULDBLOCK` — the first worker still holds the exclusive lock; the UPDATE's uncommitted state is not observable under a lesser lock. (b) A writer's `LOCK_SH` attempt on the path blocks (does not acquire) — no writer can enter validate+write while the claim's UPDATE is uncommitted. (c) Resume the worker → COMMIT → `LOCK_UN`; assert the second worker's next `LOCK_EX|LOCK_NB` now succeeds (the lock was held through commit, then released — not before). **The A16 ordering is observably enforced, not just specified.**
10. **Path-absent sub-protocol (rev 18 — B13):** setup: reservation R active but expired; no file at the deterministic path (writer never wrote, or crashed before its first chunk). Step-4 stat → ENOENT; step-5a open → ENOENT.
    **Assert:** the worker takes the path-absent branch (no file lock): BEGIN → level-1 → `is_maintenance_active()` false → CAS `UPDATE ... SET state='ROLLED_BACK', released_at=now()` → COMMIT. Assert `released_at` is set, `claim_epoch`/`claim_finalized_at` remain NULL (CHECK constraint satisfied — rev 18, B9), and the worker created no file.
    **Race variant:** between the worker's open-ENOENT and the CAS COMMIT, a writer creates the file and writes one chunk (its chunk-1 validation observed the still-active reservation).
    **Assert:** the post-commit re-stat finds the file → the follow-up `UPDATE ... SET state='ABANDONED'` executes → the chunk's bytes are durably counted in `abandoned_temp_bytes`. The writer's chunk-2 validation observes the terminal state → aborts. **At most one chunk lands in this race, and it is counted — never silently uncounted.**

### S53: Domain-R exclusion — Phase-2 writes without level-1 (rev 18 — B2)
1. **Setup:** two active reservations R1, R2 (different `reservation_id`s, different deterministic paths P1, P2). Instrument: record level-1 (`pg_advisory_xact_lock('media_global')`) acquisitions and `flock` states per process.
2. **Action:** start chunk writes on P1 and P2 concurrently (two writer processes, one chunk each, slow writes).
3. **Assert:** NEITHER writer acquires level-1 at any point during chunk writes. Both hold `LOCK_SH` on their respective paths during validate+write. The two writes overlap in time — Domain R does not serialize writers against each other, by design (deterministic paths are unique per reservation; there is no shared path to contend over).
4. **Action:** while W1 holds `LOCK_SH` on P1 mid-chunk, the expiry worker attempts a claim on R1 (reservation expired, epoch stale, mtime older than the grace window — all liveness evidence says "claimable").
5. **Assert:** the worker's `LOCK_EX|LOCK_NB` on P1 fails with `EWOULDBLOCK` → the claim ABORTS for this cycle. No CAS UPDATE executes. R1's row is untouched (still active). **The claim cannot finalize while a write is in flight — enforced by `flock`, not by level-1.**
6. **Action:** W1 completes its chunk, releases `LOCK_SH`, heartbeats (epoch advances to E2).
7. **Assert:** the worker's next cycle observes `epoch = E2 ≠ E1` → skips R1 (writer alive). No capacity was released; no bytes went uncounted; no level-1 was ever acquired by any Domain-R participant in this scenario.
8. **Negative assertion:** if an implementation acquires level-1 during Phase-2 chunk writes, this scenario FAILS — it has reintroduced the multi-minute lock hold that Domain R exists to eliminate, and violated the §4.3d table's Domain-R binding.

### S54: Attribution atomicity — dedicated path coverage (rev 18)
1. **Setup:** file `attr.jpg` in `unattributed_media_files` (`matched_world_id = W1`, `protected = true`). No row in `world_media_assets` for `attr.jpg`. A live `asset_snapshot_references` row `(attr.jpg, S1)` exists (snapshot-protected).
2. **Action:** run the §4.7 attribution transaction for `attr.jpg` → World W1.
3. **Assert (atomicity):** at no observable instant do zero rows exist for `attr.jpg` across both tables (no "ownerless" window), and at no instant do two rows exist (single-owner invariant). The INSERT (6) and DELETE (7) commit atomically.
4. **Assert (G3 exempt):** the transaction succeeds despite the live ref row — G3 does not apply (identity-preserving transfer, §4.1). A G3 firing here would be a spec violation.
5. **Assert (lock order):** the transaction acquired 1 → 3 (W1 `FOR UPDATE`) → 7 (`FOR UPDATE`) → INSERT (6) → DELETE (7). The world-row lock precedes the unattributed-row lock (R5). The *blocking* acquisition sequence is 1 → 3 → 7, strictly ascending per E1 — the INSERT is a non-blocking new-row insert per Lemma A (see the `6*` annotation in the §4.3c table); the DELETE reuses the held position-7 lock.
6. **Concurrency:** simultaneously start an upload Phase-2 commit attempting to register `attr.jpg` as a new file (simulated UUID collision).
7. **Assert:** the two transactions serialize on level-1. Exactly one wins: either the attribution commits first (upload's G2 check then sees the registry row → 409) or the upload commits first (attribution's cross-table check then sees the registry row → aborts). **No interleaving creates two rows or zero rows.**
8. **Crash:** kill -9 between the INSERT (6) and the DELETE (7).
9. **Assert:** the transaction rolls back entirely — the unattributed row is intact, no registry row exists. Retry completes atomically. **Half-attributed state is impossible.**

### S55: Maintenance-fence single check path — every writer fenced (rev 18)
1. **Setup:** `system_maintenance.active = true` (fence active). For each writer below, attempt the operation and assert the outcome. **No writer may mutate while the fence is active.**
2. **Action + assert (application writers):** upload Phase-1 → **503** `MAINTENANCE_MODE`; upload Phase-2 commit → **503** (checked in Phase 1; commit aborts); asset delete T1/T2 → **503**; scene/world metadata update → **503**; publish → **503**; world deletion T1 → **503**; replacement T2 → **503**.
3. **Action + assert (background writers):** expiry-claim worker cycle → no CAS UPDATE executes (aborts at the B6 fenced section; log `maintenance_fence_active`); backfill worker → run does not start / completion aborts; periodic capacity job → cycle skipped; startup recovery → reports `degraded`, retries, does not repair; snapshot GC → n/a (dormant).
4. **Action + assert (recovery authorization, rev 19 — B3):** with the fence STILL active, the operator establishes a recovery authorization (scope `repair`), verifies writer exclusion (level-1 quiescence, zero active reservations, zero app sessions), then runs `repair` under the authorization. **Assert:** repair mutates (quarantine moves, row fixes) while every normal writer from steps 2–3 remains fenced — the circular dependency is broken WITHOUT lifting the fence. Then: attempt a second concurrent authorization → rejected by the partial unique index. Attempt a normal upload during the authorized repair → still **503** `MAINTENANCE_MODE` (the authorization does not weaken the fence for normal writers). Revoke the authorization → the next repair transaction aborts (zero live authorizations → ROLLBACK).
5. **Action + assert (fail-closed):** `DROP TABLE system_maintenance` (simulate failed migration). Repeat step 2's upload attempt.
6. **Assert:** **503** `MAINTENANCE_MODE` — `is_maintenance_active()` returns true on `undefined_table`. Health = `degraded`; critical alert `SYSTEM_MAINTENANCE_TABLE_MISSING`. **No code path interprets the missing table as "not in maintenance."**
7. **Action + assert (single path):** grep the implementation for direct `SELECT active FROM system_maintenance` outside `is_maintenance_active()`.
8. **Assert:** zero occurrences. **Any direct SELECT is a spec violation** (single-check-path rule, rev 16 — B5.1; the §4.3d example now uses the wrapper, rev 19 — B7). This assertion is code-review-enforced; steps 2–6 are executable.

### S56: Serving during unresolved `missing_row` drift (rev 18 — A24)
1. **Setup:** file `drift.jpg` has a `world_media_assets` row (World W1, `lifecycle='active'`). Snapshot S1's `canon_data` references `/media/drift.jpg`, but `asset_snapshot_references` has NO row for `(drift.jpg, S1)` (protection row missing — the drift). An unresolved `snapshot_ref_drift`/`missing_row` conflict exists for `drift.jpg`.
2. **Action:** request `GET /media/drift.jpg` with snapshot context S1 (requester authorized for W1's published snapshot).
3. **Assert:** **200, file served** — NOT 404. Per the A24 resolution: the open conflict already blocks deletion fail-closed, so the file is protected; refusing to serve would break published reads for a file whose ground-truth reference (the snapshot's `canon_data`) is intact. **Serving is the fail-safe direction for reads.**
4. **Action:** attempt `DELETE /worlds/W1/media/{assetId}` for `drift.jpg`.
5. **Assert:** **409** `ASSET_REFERENCED` — deletion is blocked while the drift conflict is unresolved (fail-safe direction for writes). Reads serve; writes block.
6. **Action:** operator resolves the drift (re-runs the §4.2 scan under locks 1 → 3 → 5 → 8, INSERTs the missing ref row, marks the conflict resolved).
7. **Assert:** serving continues to return 200; deletion now follows the normal §4.3b lifecycle (no longer blocked by drift). **The resolution was purely additive — no protection was dropped at any point.**

### S57: Migration failure rolls back cleanly (rev 19 — B1)
1. **Setup:** a migration applies the `world_media_assets` DDL including the `roles` domain CHECK and the `trg_world_media_assets_roles_unique` trigger (rev 19 — B1: no subquery in CHECK — PostgreSQL would reject the DDL otherwise).
2. **Action:** simulate a migration failure — e.g., the trigger function has a syntax error, or a data backfill in the same migration violates a constraint.
3. **Assert:** PostgreSQL rolls back the ENTIRE migration transaction — the table is not created (or not altered), the trigger does not exist without its table, no partial schema remains. **Assert** via `information_schema`: no `world_media_assets` table, no `trg_world_media_assets_roles_unique` trigger.
4. **Assert:** the migrate step exits non-zero → the Fly release fails → the previous release keeps serving. Health reports `degraded`; a critical alert fires with the migration name and the PostgreSQL error. The operator fixes the cause and re-runs the migration from a clean schema state.
5. **Assert (positive):** with the corrected DDL, the migration applies cleanly; inserting `roles = '{cover,cover}'` raises `check_violation` from the trigger (not a silent accept); inserting `roles = '{bogus}'` violates the CHECK. Both constraints are enforced, in the inserting transaction, with no subquery anywhere in the DDL.

### S58: NULL-world snapshot reference is protected, servable, drift-repairable (rev 19 — B5)
1. **Setup:** snapshot S7 exists in `canon_snapshots` with `world_id = NULL` (orphan — legacy data). Its `canon_data` references `/media/orphan.jpg`. File exists on disk. `asset_snapshot_references` has no row for it.
2. **Action:** backfill classifies `/media/orphan.jpg`: the §4.2 scan finds the URL in S7's `canon_data` (query (b) — orphan enumeration).
3. **Assert:** the `(orphan.jpg, S7, NULL)` ref row inserts successfully — the nullable `world_id` permits it. The file gets an `unattributed_media_files` row (`protected = true`, `referencing_worlds = []` — no world to name). **Assert:** attempting to delete the file → blocked (409 `ASSET_REFERENCED` — the ref row counts in the scan regardless of NULL `world_id`).
4. **Action:** request `GET /media/orphan.jpg` with snapshot context S7 (requester authorized for the snapshot).
5. **Assert:** **200, file served** — serving validates against the snapshot row's persisted state (§4.5); a NULL `world_id` on the ref row does not make the file unservable.
6. **Action:** delete the ref row manually (simulating drift); run re-verification.
7. **Assert:** `snapshot_ref_drift`/`missing_row` conflict created; the scan still finds the URL in S7's `canon_data` (ground truth); repair re-inserts `(orphan.jpg, S7, NULL)` additively. **Assert:** at no point was the file deletable while the snapshot referenced it.

### S59: Fence activation invalidates in-flight Phase-2 uploads (rev 19 — B8)
1. **Setup:** fence inactive. Upload U is mid-Phase-2: reservation in `WRITING`, temp file growing at the deterministic path, writer heartbeating every 2 min, chunks validating under `LOCK_SH`.
2. **Action:** operator activates the maintenance fence.
3. **Assert:** the activation transaction atomically set U's reservation to `ABANDONED` (rev 20 — corrected from `ROLLED_BACK`; same commit as `active = true`). The writer's next heartbeat `UPDATE ... WHERE released_at IS NULL` affects 0 rows → writer aborts. **Assert:** the writer's next chunk iteration re-validates under `LOCK_SH`, reads the non-active reservation, and aborts BEFORE `write()`. **Assert:** from the activation commit, U's `size_bytes` is counted in `abandoned_temp_bytes` (conservative) — the reservation left the outstanding bucket and entered the abandoned bucket in the same commit; no double-count, no gap, no uncounted window.
4. **Assert (the B8 invariant):** no chunk write begins after the activation commit. Instrument the writer: count `write()` syscalls after the activation timestamp → zero new chunks (at most the single in-flight chunk's `write()` — already inside the syscall when activation committed — completes; the loop then aborts).
5. **Action:** a NEW upload attempts Phase-1 while the fence is active.
6. **Assert:** **503** `MAINTENANCE_MODE` — Phase-1's fence check under level-1 fails before any reservation is inserted. The fence needs no cooperation from Phase-2 writers to prevent new work; invalidation handles the in-flight ones.
7. **Assert (cleanup):** the periodic job selects `WHERE state='ABANDONED'` → finds U's row → stats the deterministic temp path → unlinks it (ENOENT-tolerant) → `UPDATE ... SET state='CLEANED'` (bytes leave `abandoned_temp_bytes` via the same durable state column), logs at info. No orphan, no leaked capacity, no uncounted window at any instant.

### S60: Repair under active fence via recovery authorization (rev 19 — B3; lifetime contract rev 20 — B2)
1. **Setup:** fence active (`is_maintenance_active()` true). `diagnose` reports an error-level finding: orphan file `/media/orph.jpg` on disk, no row, zero references (confirmed by re-scan).
2. **Action:** operator runs `repair` WITHOUT establishing a recovery authorization.
3. **Assert:** repair refuses to start — logs `repair_refused_fence_active`, no mutation. (Pre-rev-19, the only fix was lifting the fence — the circular dependency.)
4. **Action:** operator establishes a recovery authorization via the step-2 establishment transaction (scope `repair`, reason recorded), verifies writer exclusion: level-1 quiescence = 0 holders, `SELECT count(*) FROM storage_reservations WHERE state IN ('RESERVED','WRITING')` = 0, role-filtered `pg_stat_activity` shows no app sessions. Then runs `repair` under the authorization.
5. **Assert:** repair moves `/media/orph.jpg` to `.quarantine/` while the fence stays active — every normal writer still 503s. The mutation is logged with the `authorization_id`. **Assert (rev 20 — B2):** each repair transaction executed the BEGIN-gate AND the pre-COMMIT gate (instrumented: both assertions ran; the `authorization_id` matches the established row).
6. **Action:** while the authorized repair runs, attempt a second recovery authorization (another operator session).
7. **Assert:** rejected — the establishment transaction's `WHERE NOT EXISTS` guard matches zero rows (backstopped by the partial unique index). Recovery is exclusive. The second session cannot mutate. The error is `RECOVERY_AUTH_CONFLICT` naming the live `authorization_id`.
8. **Action:** simulate repair failure — kill -9 the repair session mid-quarantine-move (after the filesystem rename, before COMMIT).
9. **Assert (rev 20 — B2 correction):** the DB transaction rolls back (session death); the filesystem rename STANDS (DB rollback cannot undo it — the rev-19 claim is withdrawn). The authorization row is STILL LIVE (separate committed row — the operator does NOT establish a "new" one; the unique index would reject it). The operator resumes the repair session under the SAME live authorization: the quarantine move is path-conditional → the already-moved file is a no-op → the DB updates commit under the pre-COMMIT gate → repair converges. The fence STAYED active throughout; health stayed `degraded`; normal writes did NOT reopen. **At no point was there an unprotected filesystem mutation:** the rename was performed by the authorized session while its authorization was live, and the fence excluded every other writer for the whole window.
10. **Action:** repair reports zero error-level findings. Operator revokes the authorization (`revoke_reason='operator'`), verifies release criteria, lifts the fence.
11. **Assert:** fence lifts ONLY after revocation + criteria. **At no point was repair able to run without authorization, and at no point did repair failure reopen normal writes.**

### S61: Establishment transaction — concurrency, crash, expiry (rev 20 — B1)
1. **Setup:** fence active. No unrevoked authorization rows.
2. **Action (concurrent race):** two operator sessions simultaneously execute the step-2 establishment transaction.
3. **Assert:** exactly one commits with a new row; the loser gets `RECOVERY_AUTH_CONFLICT` naming the winner's `authorization_id`. `SELECT count(*) FROM recovery_authorizations WHERE revoked_at IS NULL` = 1. There is no interleaving with two live authorizations (level-1 serialized the establishments; the guard + unique index backstop it).
4. **Action (crash between close-expired and insert):** revoke the live row (`revoke_reason='operator'`); insert an expired-but-unrevoked row directly (simulating a pre-rev-20 leftover: `expires_at` in the past, `revoked_at` NULL). Kill -9 the establishing session AFTER its close-expired UPDATE executes but BEFORE its INSERT commits (instrumented breakpoint).
5. **Assert:** the transaction rolled back — the expired row is STILL expired-but-unrevoked (the close did not persist). A fresh establishment re-runs the close-expired step: the row transitions to `revoke_reason='expired'`, the INSERT proceeds. **Assert:** expiry never permanently occupied the slot; no manual cleanup of the old row was required.
6. **Action (expiry close):** let the live authorization expire (advance the test clock past `expires_at`). Establish a replacement.
7. **Assert:** the establishment's close-expired step revoked the old row (`revoke_reason='expired'`) and inserted the new one in the same transaction — replacement required no operator action on the old row.
8. **Action (crash after commit):** kill -9 the operator session AFTER the establishment commits but BEFORE any repair transaction. The new operator (same identity) attempts to establish again.
9. **Assert:** `RECOVERY_AUTH_CONFLICT` — the row is live and theirs. They EITHER resume under it (re-assert per transaction) OR explicitly revoke (`authorized_by` match, `revoke_reason='operator'`) and re-establish. **Assert:** no wedged state — every crash point has a defined next step, and the 4-hour expiry bounds the worst case.

### S62: Expiry mid-procedure — the boundary contract (rev 20 — B2)
1. **Setup:** fence active; live recovery authorization (scope `repair`) with a deliberately short life — `expires_at = clock_timestamp() + interval '2 seconds'` (rev 21: the test must cross expiry on the REAL clock — `now()` is frozen per-transaction and would mask the bug, so a logical "test clock" advance is not a valid test); orphan file `/media/exp.jpg`, zero references.
2. **Action:** begin a repair transaction (BEGIN-gate passes — authorization live), perform the quarantine-move filesystem rename, then `pg_sleep(3)` so the real clock crosses `expires_at` BEFORE the transaction's pre-COMMIT gate.
3. **Assert:** the pre-COMMIT gate re-executes the liveness assertion with `clock_timestamp()` → zero rows → ROLLBACK. The DB mutation does NOT commit. (Under the old `now()` semantics this gate would have PASSED — this step fails if the fix regresses.) The filesystem rename STANDS (already performed — no mechanism undoes it, and none is claimed).
4. **Assert (idempotent resume):** the operator establishes a replacement authorization (step 2: close-expired revokes the old row with `revoke_reason='expired'`, inserts the new one). The repair transaction re-runs: the quarantine move finds `/media/exp.jpg` already in `.quarantine/` → path-conditional no-op → DB updates commit under the new authorization's gates. Repair converges with no duplicate move and no inconsistent state.
5. **Assert (no new work after expiry):** attempt to BEGIN another repair transaction under the expired authorization → BEGIN-gate rejects before any filesystem work. **Assert (fence held):** throughout steps 2–4 the fence was active — every normal writer 503'd; no conflicting writer observed or depended on the partial state.
6. **Assert (the invariant):** expiry created no unprotected filesystem mutation (the rename was performed by the authorized session while live, and is idempotent) and no inconsistent recovery state (the DB never recorded a move that didn't happen; the filesystem never holds a move the DB can't reconcile — the retry converges on the actual filesystem state).

### S63: Pre-COMMIT gate uses true current time; revocation cannot race the gate (rev 21)
1. **Setup (real-clock expiry):** fence active; operator establishes a recovery authorization (scope `repair`) with `expires_at = clock_timestamp() + interval '2 seconds'`. Orphan file `/media/clk.jpg`, zero references.
2. **Action:** begin a recovery transaction — the BEGIN-gate passes (`clock_timestamp()` < `expires_at`; at transaction start it coincides with statement time). Perform the quarantine-move rename. `pg_sleep(3)` so the real clock crosses `expires_at`. Execute the pre-COMMIT gate as the final statement before COMMIT.
3. **Assert (true-clock gate):** the pre-COMMIT gate evaluates `expires_at > clock_timestamp()` → false → zero rows → ROLLBACK. No DB mutation commits. The authorization was valid at BEGIN and expired mid-operation — exactly the interleaving the rev-20 `now()` gate could not detect (regression check: substituting `now()` makes this step fail).
4. **Assert (idempotent resume):** identical to S62 step 4 — the rename is path-conditional, the retry converges under a fresh authorization, the fence stayed active throughout.
5. **Assert (revocation race — second operator):** while a recovery transaction holds level-1 mid-mutation, a second operator executes the step-7 revocation transaction → its `pg_advisory_xact_lock` call BLOCKS until the recovery transaction commits or rolls back. After the commit, the revocation applies (`revoked_at` set, `revoke_reason='operator'`); the NEXT recovery transaction's BEGIN-gate finds zero live rows → ROLLBACK before any work. **No revocation ever interleaved between the pre-COMMIT gate and its COMMIT** (instrumented lock timeline).
6. **Assert (boundary as specified):** the instrumented statement log shows the pre-COMMIT gate as the final statement before COMMIT — no recovery work executes between gate and commit. The document claims only the weaker boundary ("valid at the pre-COMMIT gate"); a grep over the ADR finds no claim that the commit itself lands before `expires_at`.

## 7. Risks

| Risk | Mitigation |
|---|---|
| JSONB reference scan is expensive for large worlds | Assets per world <100; snapshots per world <50. Acceptable. Add GIN index if needed. |
| Advisory lock contention | Per-world scope; authoring operations are low-frequency. Acceptable. |
| Fly volume fills up | Monitor disk; quota prevents per-world runaway. |
| URL guessing / unauthorized access | Random UUID filenames. `/media/` is public (needed for readers). |
| Backfill misattributes a file to the wrong world | Unmatchable or multi-world files go to `unattributed_media_files` (never the main registry); `protected=true` blocks deletion; `referencing_worlds` records every claimant. Attribution requires explicit operator resolution — never silent assignment. |

## 8. Out of Scope

- Image editing, cropping, filters.
- AI-generated illustrations (Post-MVP).
- Cross-world shared asset library.
- CDN integration.
- The background cleanup job (the synchronous delete path in §4.3b handles MVP reclamation; a job is only needed for the narrow `pending_deletion`-with-failed-file-removal retry case, which the next DELETE call already handles).
- Narration audio lifecycle (separate system, already versioned).

## 9. Durability, Backup, and Degraded Storage

### 9.1 Byte immutability

The URL scheme (`/media/{uuid}.{ext}`) guarantees byte immutability: every upload generates a new random UUID filename. **The server must never write to an existing asset path.** Replacement = new file + new row + metadata pointer update (two transactions, §4.3a). The old file's bytes are never modified.

A published snapshot's `illustrationUrl` always resolves to the exact bytes captured at publish time, for as long as the file exists. Immutability is a property of the write path, not just the snapshot model.

### 9.2 Volume backup, recovery, and topology constraint

A Fly persistent volume protects against container replacement but **not** against volume corruption, host failure, or multi-machine setups (Fly volumes are single-machine).

**Deployment constraint:** The application MUST run as a single machine while media lives on a Fly volume. Before scaling to multiple machines, move to shared/object storage. This constraint must appear in deployment documentation, not just this ADR.

**Backup requirements:**
- Document the volume name, size, and mount path in `fly.toml`.
- Before first production use: take a manual volume snapshot via `fly volumes snapshot`.
- **Out of MVP scope:** automated scheduled snapshots (future ops task).

**Recovery runbook:**

| Observation | Classification | Action |
|---|---|---|
| Row exists (`active`), file missing | **Data loss** | Set `file_confirmed_present=false`. Log at error with `asset_id`, `world_id`, `url`. Alert operator. Quota decreases (file not counted). Affected snapshots will serve broken images. Restore from volume snapshot; if unavailable, creator must re-upload (new version — old snapshot URLs remain broken, document as such). |
| Row exists (`pending_deletion`), file missing | **Expected** | File removal already happened or is in progress. No alert. Reconciliation confirms and the next DELETE (or manual cleanup) finalizes the row deletion. |
| File exists, row missing | **Orphan** | Log at warning. **Check references first:** scan draft metadata and all retained snapshots for the file's URL. If ANY reference exists → the file stays at its serving path and gets an `unattributed_media_files` row (`protected=true`, original path recorded) — it is served, never quarantined (a quarantined file cannot be served at its published URL, §4.5). If ZERO references exist → move to `/data/media/.quarantine/`. Never auto-delete — even unreferenced orphans get manual review. Increment `unattributed_bytes`. |
| Row exists, file exists, `lifecycle='active'` | **Normal** | No action. |

Recovery must reconcile **both** directions. After any restore: re-run reconciliation and confirm zero error-level findings before declaring recovery complete.

**Backup/restore consistency:** A Fly volume snapshot and a PostgreSQL backup are **independent point-in-time copies** — they do not represent the same instant. Restoring both can produce a mismatched state: rows without files (volume snapshot older than DB backup) or files without rows (DB backup older than volume snapshot). **Restore procedure:**
1. Restore the database first (it is the system of record for lifecycle state).
2. Restore the volume.
3. Run reconciliation in `repair` mode (§9.4):
   - Files without rows → **reference-check first** (draft metadata + all retained snapshots). Files with any reference stay at their serving path and get an `unattributed_media_files` row (`protected=true`) so published URLs keep serving. Only files with **zero** references are moved to `/data/media/.quarantine/` and logged, added to `unattributed_bytes`. Never move a snapshot-referenced file to quarantine — the serving layer (§4.5) has no mechanism to serve files from `.quarantine/` at their published URLs, and creating a registry row alone cannot make a moved file available at `/media/{filename}`.
   - Rows without files → `file_confirmed_present=false`, data-loss alert raised. The registry row is preserved (it records what *should* exist); only the serving behavior changes.
4. **Published image URLs with missing files** return **404** with an error-level log entry per request (sampled if volume is high). This degradation is explicit and documented: the snapshot's URL contract is "this URL identified these bytes at publish time," not "these bytes are guaranteed retrievable." The 404 is honest; silently serving a placeholder would be dishonest.
5. Confirm zero error-level reconciliation findings before declaring recovery complete — except for the known data-loss rows, which remain flagged until the creator re-uploads.

**Restore traffic and writer fencing (rev 15 — B5.2):** The database and volume are restored independently (§9.2 "Backup/restore consistency"). During the restore window, the system is in an inconsistent state. The rev-14 procedure re-asserted the fence as the first SQL after DB restore — but between the restore completing (possibly with `active=false`) and the re-assertion executing, the database itself cannot enforce the block. The safety therefore rests on an EXTERNAL guarantee, made explicit and enforceable here. The database flag is the secondary mechanism; process stop is the primary. **Do not rely solely on the database flag to protect a database while that very database is being replaced.**

1. **Activate the maintenance fence:** operator executes `UPDATE system_maintenance SET active = true, reason = 'volume restore', ...` in a level-1-holding transaction per §4.3d. ALL mutating endpoints return 503 (`MAINTENANCE_MODE`). Reads MAY continue if the operator judges the pre-restore state servable; the decision is recorded in the runbook. (This fence is defense-in-depth for step 3 — the primary guarantee is the process stop.)
2. **No backfill during restore:** verify no `backfill_runs` row with `state='in_progress'`. If one exists → abort the restore, resolve the backfill first.
3. **Wait for quiescence:** verify no active level-1 lock holders (`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = hashtext('media_global')` returns 0), so no in-flight mutation survives into the stop.
4. **STOP all writers (rev 15 — the external guarantee):** stop every application machine (`fly scale count 0` / `fly machine stop`); confirm **zero running machines** via `fly status`. All writers run in the application process — background workers, the periodic capacity job, and startup recovery are in-process; there are no out-of-process writers except the operator. The ONLY database session permitted from this point is the operator's admin session (from the operator's workstation, not from the application).
   - **Verification gate:** the DB restore (step 6) MUST NOT begin until `fly status` shows 0 machines AND no application session appears in `pg_stat_activity`. This is a checklist item the operator confirms, not an assumption.
5. **Record fence state:** note that `system_maintenance.active = true` (it must be — step 1). Pre-restore baseline.
6. **Restore database** (system of record for lifecycle state) — via the operator's admin session only.
7. **Re-assert fence as first SQL after DB restore (defense in depth):** the restored database may have `active=false` or lack the row/table. Execute:
   ```sql
   INSERT INTO system_maintenance (id, active, reason, started_at, started_by)
   VALUES (1, true, 'restore in progress - fence re-asserted post-DB-restore', now(), 'restore-procedure')
   ON CONFLICT (id) DO UPDATE SET active = true, reason = 'restore in progress - fence re-asserted post-DB-restore', started_at = now();
   ```
   This closes the window for the case where a writer process is (incorrectly) restarted early: it would read `active=true` and 503. But the PRIMARY protection remains step 4 — no writer process exists to read anything.
8. **Restore volume.**
9. **Run reconciliation under recovery authorization (rev 19 — B3):** `diagnose` first (read-only assessment — needs no authorization). If discrepancies are found, the operator establishes a recovery authorization per the §4.3d protocol (fence already active from step 1; writer-exclusion verified), then runs `repair` under that authorization. The repair pass is what re-establishes DB↔filesystem consistency. On repair failure: the fence stays active, the authorization is revoked or expires, and the operator retries with a new authorization — normal writes never reopen. After repair reports zero error-level findings: revoke the authorization, then proceed to step 10.
10. **Verify per §4.3d release criteria:** zero error-level findings, single-owner invariant holds, no unmanaged/absent-file alerts, no in-progress backfill. (Criterion 2 is satisfied by the step-9 repair run under recovery authorization.)
11. **Controlled resumption (rev 15):** start ONE machine. Its startup verification (§4.3d: table exists, row exists, migration version) must pass and health must report `healthy` (or `degraded (maintenance)` with the fence still active — expected). The operator then lifts the fence per the release criteria (`UPDATE system_maintenance SET active = false`), verifies the single machine serves correctly, and only then scales to the normal machine count. At no point is a second writer started before the first is verified.

**Invariant (rev 15 — B5.2):** at no instant is there a running writer process while the fence is not provably active. During steps 4–10, the guarantee is physical (no writer processes exist); the database flag is a secondary tripwire for operator error (early restart). The restore procedure never depends on the database to protect itself mid-replacement.

**What must never happen:** do not begin the DB restore with any application machine running (step 4's verification gate). Do not lift the fence while reconciliation shows errors. Do not allow uploads during steps 5–9. Do not run backfill concurrently with restore. Do not start a second machine before the first passes health verification (step 11).

*Future multi-machine note:* when the deployment moves beyond the §9.2 single-machine constraint, this procedure's step 4 becomes "restore into an isolated target (separate database + volume), run fence + reconciliation there, and cut over only after checks pass." The cutover variant is documented here as the intended evolution, not the current procedure.

A volume snapshot alone does not establish that the database and files can be restored consistently. The repair pass is what re-establishes consistency, and it must be run after every restore — no exceptions.

### 9.3 Storage unavailable — status code mapping

| Failure | HTTP status | Body | Retryable? |
|---|---|---|---|
| Disk full (pre-check) | **507** | `{code: "STORAGE_FULL"}` | No — operator must expand volume |
| Disk full during write (despite reservation) | **507** | `{code: "STORAGE_WRITE_FAILED", detail: "filesystem full during write"}` | Yes — after operator expands or space frees |
| Capacity metric stale/failed | **503** | `{code: "STORAGE_METRIC_STALE"}` | Yes — retry after job recovers |
| World quota exceeded | **507** | `{code: "QUOTA_EXCEEDED", quota_exceeded: true, quota_mb: "{MEDIA_WORLD_QUOTA_MB}", used_mb: 47.3}` | No — creator must delete assets |
| Single file exceeds 10 MB | **413** | `{code: "FILE_TOO_LARGE"}` | No |
| Volume unmounted / path unwritable (transient) | **503** | `{code: "STORAGE_UNAVAILABLE"}` | Yes — retry with backoff |
| File write succeeds but row insert fails | **500** | `{code: "UPLOAD_FAILED"}` | Yes — orphan file deleted synchronously, logged |
| Invalid mimetype | **415** | `{code: "INVALID_MIMETYPE"}` | No |

**Code distinction rule (rev 12):** `QUOTA_EXCEEDED` = per-world fair-share (creator can fix). `STORAGE_FULL` = volume exhausted at pre-check (operator must fix). `STORAGE_WRITE_FAILED` = write failed despite passing pre-check (defense-in-depth; retryable). `STORAGE_METRIC_STALE` = cannot verify capacity (fail-closed; retryable). Monitoring MUST NOT conflate these — they indicate different failures requiring different responders.

**Rule:** A 2xx upload response means file on disk + row committed + quota accounted. All three, or it didn't happen.

### 9.4 Startup reconciliation (operational precision)

Reconciliation has two explicitly named modes. The names are used consistently across this ADR (§4.3b, §4.9, §9.2).

**`diagnose` (default): read-only.** On startup, the server compares `/data/media/` against `world_media_assets` rows. It **logs discrepancies and changes nothing** — no row updates, no file moves, no deletions. Specifically:

- File without row → log at warning with filename and size. Do NOT move, do NOT delete.
- Row (`active`) without file → log at error, raise data-loss alert. Do NOT set `file_confirmed_present=false` (that is a repair action).
- Row (`pending_deletion`) without file → log at info. This is the **expected** state after a successful T2 file removal whose row-finalization hasn't run yet — or after a crash between unlink and commit. It is safe to finalize, but `diagnose` does not finalize it.

**`repair`: explicit operator action only.** Started with an explicit `--repair-media` flag (or equivalent operator command). Entry requirement (rev 19 — B3): the session must EITHER observe the fence inactive (`is_maintenance_active()` false — normal-operation repair), OR hold a valid recovery authorization (established per the §4.3d protocol — fenced repair). Under an active fence with no live authorization, `repair` refuses to start (it does not weaken the fence and does not lift it). In addition to everything `diagnose` logs, `repair` may:

- Set `file_confirmed_present=false` for `active` rows whose file is confirmed missing (releases quota per §5.1 AND raises the data-loss alert — the two consequences are linked, never separated).
- Finalize `pending_deletion` rows whose file is confirmed absent — **only after a fresh, conclusive zero-reference scan** under the prescribed locks (world row → asset row → scene rows, §4.3c reference-changing class). This is the §4.3b T2 completion that a crash interrupted — expected, not anomalous — but the scan is still required:
  - Scan finds zero references → delete the row (finalize).
  - Scan finds references → **do NOT finalize.** Log at critical, alert the operator, leave the row in `pending_deletion`. This is the invariant-violation case (§4.3b step 10): the row is evidence the operator needs for diagnosis, and deleting it would erase that evidence. The file is already absent, so canon may already be degraded — but destroying the registry record cannot help and can only hinder recovery.
  - Scan fails or is inconclusive → **do NOT finalize.** Log at warning, leave the row, retry on the next repair run.
- Move orphan files (no row in either registry table) to `/data/media/.quarantine/` — **only after** a reference check (draft metadata + all retained snapshots) confirms zero references. A file with any reference stays at its serving path and gets an `unattributed_media_files` row (`protected=true`) instead. If a move fails: log at error, leave the file in place, continue.
- **Recompute `roles` from draft metadata (role source-of-truth repair):** draft metadata is the authority for role membership; the `roles` array is a cached convenience that can drift after partial failures (e.g. a T2 that updated the URL but crashed before updating `roles`). In `repair` mode, for each `world_media_assets` row: recompute the expected roles by scanning the world's current draft metadata for the row's URL (`coverArtUrl` → `cover`, `illustrationUrl` → `illustration`); if the stored `roles` differs, `UPDATE` it to the recomputed value and log at info with `asset_id`. This runs under the reference-changing lock class (world row → asset row, §4.3c). Snapshot references are never written into `roles` — only draft paths.

`repair` is never automatic. Quarantine (moving files) happens only in `repair` mode.

**Pending-deletion policy, applied consistently:**
| Context | Row `pending_deletion`, file absent | Action |
|---|---|---|
| Normal DELETE retry (§4.3b T2) | Expected (crash between unlink and commit) | T2's stat finds the file absent → idempotent success → finalize row automatically. No operator needed. |
| Startup `diagnose` | Expected | Log at info. Change nothing. |
| Startup `repair` | Expected | Fresh zero-reference scan under locks, then finalize the row. If the scan finds references or is inconclusive → do NOT finalize; log critical/warning, alert, leave the row. |
| World-deletion recovery (§4.9) | Expected | Enumerate-and-stat skips the absent file, increments progress. No operator needed. |

The apparent rev-5 contradiction is resolved: "flag for manual review" applied to the narrow case where the row DELETE itself failed *after* the quota-release update committed (a database error, not a crash — the row is in an unexpected state). The common crash cases above are all handled automatically by retry or repair.

**Locking:** Reconciliation (`diagnose` or `repair`) **acquires the global media advisory lock** (`pg_advisory_xact_lock(hashtext('media_global'))`, §4.3c level 1) before scanning, and releases it after (transaction-scoped, automatic on commit).

Because all file-mutating operations (upload, asset delete, world deletion) also acquire this same global lock as the first step in their lock ordering (§4.3c), the global lock is a **true exclusion lock**: reconciliation never observes a filesystem mid-mutation, and no mutation starts mid-scan. Deadlock is impossible: every participant acquires the global lock before any other lock, in the same order.

**Startup lock timeout:** If the global lock cannot be acquired within 30 seconds at startup (e.g., a long-running migration holds it), the media subsystem starts in degraded mode: all `/media/*` endpoints return **503** `{code: "STORAGE_UNAVAILABLE"}`, the health check reports `"media_storage": "degraded"`, and a critical log is emitted. The subsystem retries acquisition in the background and enables itself once the lock is obtained.

**Timeout mechanism (both lock types):** `pg_advisory_xact_lock` accepts no timeout parameter — it blocks indefinitely. The 30-second bound is implemented explicitly, per lock type:
- **Row locks (levels 3–5):** `SET LOCAL lock_timeout = '30s'` at the start of each media transaction. A row lock that cannot be acquired within 30s raises `SQLSTATE 55P03` (lock_not_available), which the application maps to **503** `{code: "SCAN_UNAVAILABLE", retryable: true}` (or the operation-specific 503). `SET LOCAL` scopes the timeout to the current transaction — it does not affect other sessions.
- **Advisory locks (levels 1–2):** Use `pg_try_advisory_xact_lock(key)` (non-blocking) in an application-side retry loop: attempt, sleep 100ms with jitter, repeat until acquired or 30 seconds elapse. On deadline expiry: for request paths, return **503** `{code: "LOCK_TIMEOUT", retryable: true}` with `Retry-After: 5`; for startup, enter degraded mode as above. `pg_try_advisory_xact_lock` is still transaction-scoped (auto-released on commit/rollback), so the crash-safety properties are unchanged — only the acquisition is non-blocking.

**Why not `statement_timeout`:** `lock_timeout` is narrower — it fires only on lock waits, not on slow queries. A 30s `statement_timeout` would kill legitimately slow scans; `lock_timeout` kills only stuck lock acquisitions.

**Volume unavailable at startup: FAIL FAST.** If `MEDIA_STORAGE_PATH` is not mounted, not writable, or not a directory:
- Log at critical: `MEDIA_STORAGE_PATH unavailable — refusing to start media subsystem`.
- The application MUST NOT start serving as if the directory were empty. An empty directory would cause the reference scanner to conclude "zero files" and the quota calculator to report "zero usage" — both wrong and dangerous.
- All `/media/*` endpoints return **503** `{code: "STORAGE_UNAVAILABLE"}` until the volume is available.
- Health check (`/health`) reports `"media_storage": "degraded"`.

This fail-fast behavior is non-negotiable: silently treating a missing mount as an empty directory could lead to incorrect deletion decisions.

---

**Revision history:**
- Rev 1 (2026-10-16): Initial draft — live-image model, basic lifecycle.
- Rev 2 (2026-10-16): Owner decisions applied — immutable versions, deletion blocking, crash recovery, quota, durability addendum.
- Rev 3 (2026-10-16): ChatGPT review — transaction boundaries, soft-delete consistency, MVP reclamation, quota rule, recovery runbook, topology constraint.
- Rev 4 (2026-10-16): ChatGPT rev-3 review — unified deletion state machine (single algorithm), no soft-delete on failed scan (503 instead), single authoritative quota rule, legacy backfill policy, world-deletion filesystem safety, operational reconciliation precision (read-only default, explicit quarantine flag, fail-fast on missing volume).
- Rev 5 (2026-10-16): ChatGPT rev-4 review — explicit reference-validation transaction contract with all-or-nothing semantics (§4.2b), single global lock-acquisition order covering advisory + row locks with per-operation lock matrix (§4.3c), quota formula corrected to count pending_deletion (§5.1), legacy orphans moved to separate unattributed_media_files table with cross-world protection (§4.7), draft-only world deletion as resumable multi-step jobs with crash recovery (§4.9), reconciliation coordinated via the same global exclusion lock with degraded-startup behavior (§9.4). 15 acceptance scenarios (S1–S15).
- Rev 6 (2026-10-16): ChatGPT rev-5 review — deletion split into T1 (scan + commit durable boundary) and T2 (reacquire locks, re-verify, unlink, finalize) with idempotent file-absent handling; no claim that transaction-scoped locks protect post-commit filesystem work (§4.3b). World-deletion T1 acquires locks before checking published versions, closing the publish race; publish checks deletion jobs under the same world lock (§4.9, §4.2b). Volume-mount deployment sequence: pre-mount inventory, staged transfer to temp path, checksum verification, cutover, backfill, enforcement — with rollback; backfill cannot recover mount-hidden files (§2.1). World-deletion recovery uses enumerate-and-stat, never counter offsets (§4.9). Reconciliation renamed to `diagnose` (read-only) vs `repair` (explicit flag) with a consistent pending-deletion policy table (§9.4). UNIQUE constraints on `filename` and `url` with duplicate-insert behavior (§4.1). Lock-order rule clarified: ascending order, levels may be omitted, four operation classes (file-mutating, quota-affecting, reference-changing, read-only) (§4.3c). 17 acceptance scenarios (S1–S17).
- Rev 7 (2026-10-16): ChatGPT rev-6 review — all 7 blockers + 4 clarifications (see header).
- Rev 8 (2026-10-16): ChatGPT rev-7 review — all 6 blockers + clarifications (see header).
- Rev 9 (2026-10-16): ChatGPT rev-8 review — all 5 blockers + 6 clarifications. B1: dual-role detection by canonical filename/URL only; identical-content different-filename files are separate rows; content hash for migration verification only (§4.7, S23). B2: `roles` = currently held in draft metadata; upload creates `roles='{}'`; metadata switch assigns/removes roles atomically with the URL write; DB CHECK enforces distinct allowed values; URL scan sole authority for deletion safety (§4.1, §4.2, §4.3a, S8, S19, S24). B3: session-level lock operational contract — nonblocking try-lock + 30s deadline, dedicated non-pooled session, explicit release in cleanup path, crash auto-release, pool-safety hard rule (§4.3c, S20, S25). B4: global filesystem-exclusion invariant (§4.3d) — no filesystem mutation except while holding level 1 in the performing transaction; per-operation syscall-scope table; contention test (S26). B5: exact cutover — stop (not destroy) original, reconfigure staging (remove MIGRATION_STAGING, remount at /data/media via machine restart), verify, rollback = restart original; brief downtime accepted; machine-inventory table (§2.1, S27). Clarifications: `complete` removed from job CHECK; `repair` recomputes `roles` from draft metadata; unattributed-file handling on world deletion; backfill enforcement gate (`classification_status`); REPEATABLE READ for reference scans (superseded in rev 10); ASSET_WRONG_WORLD 403 (endpoint auth) vs 422 (reference validation) documented. 27 acceptance scenarios (S1–S27).
- Rev 10 (2026-10-16): ChatGPT rev-9 review — 3 blockers (B1 critical, B2–B3 high). B1: reference scans switched from REPEATABLE READ to READ COMMITTED with mandatory locks-first-scan-second protocol; scan snapshot postdates lock acquisition; writers hold world-row lock while committing (§4.2b, §4.3b T1, S28). B2: durable backfill completion gate — `backfill_runs` table (`in_progress`/`complete`/`failed`); enforcement only on a `complete` run row; idempotent resume; interrupted runs marked `failed` (§4.7, S30). B3: unattributed-file update atomicity in T4 — `array_remove` in T4's transaction, idempotent retry, operator `classification_status` never overwritten, attribution aborts on active deletion jobs (§4.7, §4.9, S29). 30 acceptance scenarios (S1–S30).
- Rev 11 (2026-10-16): ChatGPT rev-10 review — 5 blockers (B1–B2 critical, B3–B5 high). B1: rerun semantics changed from skip-if-exists to verify-every-row; `backfill_conflicts` table for classification disagreements; operator-reviewed unattributed records preserved untouched; added-after-freeze files block the run; removed-after-freeze files get a data-loss outcome (§4.7, S31, S32, S36). B2: database-recorded write freeze (`in_progress` run = freeze); upload/replacement-T1/repair/restore must honor it (503 `BACKFILL_IN_PROGRESS`); freeze lifts atomically in the run-completion transaction (§4.7, S32). B3: per-transaction lock ownership tables for T1–T5 and recovery passes; whole recovery pass runs on the dedicated connection; level 0 (pass-exclusion) never substitutes for level 1 (per-transaction filesystem exclusion) (§4.3d, §4.9, S33). B4: operational storage-capacity metric separate from per-world quota; disk-exhausted behavior (507 `STORAGE_FULL`, 80%/90% alerts, reads unaffected) (§5.5, S34). B5: snapshot scan query contract — canonical-path + defensive full-JSONB search, orphan-snapshot handling, fail-closed on any inconclusive read (§4.2, S35). 36 acceptance scenarios (S1–S36).

- Rev 12 (2026-10-17): ChatGPT rev-11 architectural review — 5 blockers (B1–B2 critical, B3–B5 high) + 6 corrections. B1: complete physical accounting — `unregistered_bytes` (periodic filesystem scan) + `filesystem_overhead_bytes` (configurable reserve); enforced cache max age (stale → 503 `STORAGE_METRIC_STALE`, fail-closed); `storage_reservations` table for concurrency-safe capacity checks; ENOSPC-during-write handling (507 `STORAGE_WRITE_FAILED`); S9 reconciled; `filesystem_used_percent` cross-check with MAX-based alerts (§5.5, S37, S38). B2: backfill freeze extended to metadata updates, publish, and world-deletion T1 (all 503 `BACKFILL_IN_PROGRESS`); `metadata_version_hash` proves input validity at completion (§4.7b, S40). B3: single-owner invariant — one row per filename across both tables (pre-insert check + atomic attribution transaction); serving prefers registry on violation; capacity counts once (§4.1, S39). B4: conflict resolution contract — `(run_id, filename)` identity, atomic resolution transaction, mandatory re-verification, unresolved blocks `complete` (§4.7c, S41); S31 stale-roles sequence documented. B5: filesystem mutation actor boundary — permitted actors enumerated, ad-hoc shell forbidden, procedure freeze required, out-of-band detection with enforcement suspension (§4.3d, §9.2, S42). Corrections: error taxonomy (blocking vs recoverable); restore traffic fencing; global lock MVP trade-off with p99 redesign trigger. 42 acceptance scenarios (S1–S42).
- Rev 13 (2026-10-17): ChatGPT rev-12 delta review — 5 blockers refined (B1.1–B1.4, B2.1–B2.2, B3, B4, B5). B1: reservation is now the SOLE staging accounting (temp files excluded from `storage_used_bytes` — eliminates double-count); two-phase durable reservation (Phase-1 commit before any bytes written; level-1 serializes check-and-reserve); heartbeat lease renewal + safe expiry (bytes → `abandoned_temp_bytes`, never released uncounted); ENOSPC cleanup failure → bytes reclassified, reservation held, `TEMP_CLEANUP_FAILED` alert; `storage_capacity_bytes` defined as configured usable capacity (§5.5, S43, S45). B2: `metadata_version_hash` (timestamps) REPLACED with `attribution_input_hash` (content hash over actual URLs + file inventory); completion is an atomic level-1 transaction (verification + marking serialized against all writers); single active run via partial unique index (§4.7b, S44). B3: level-1 MANDATORY for entire check-and-write sequence (all writers: uploads, backfill, attribution, repair, recovery); invariant scoped to registered files (unregistered = detected exception); serving fails closed on auth-boundary duplicate (§4.1). B4: exact 4-step re-verification algorithm (pure function of draft+snapshots+rows); resolution lock order: level-1 → world row → conflict row → asset row (§4.7c). B5: `system_maintenance` table (durable singleton fence); race-free activation (flag check under level-1); 6-criterion release gate; warnings block release; restore uses durable fence (§4.3d, §9.2). 45 acceptance scenarios (S1–S45).
- Rev 14 (2026-10-17): ChatGPT rev-13 delta review — 5 remaining gaps. B1: crash-safe reservation state machine — deterministic temp path (`/data/media/.tmp/{reservation_id}.part`); expiry worker stats deterministic path; temp_filename audit-only; conservation invariant (unknown = assume bytes exist). B2: enforcement DERIVED from complete row (atomic enable); post-completion writes via normal path (immediately consistent). B4: multi-world ownership (lowest world_id, shared_with_worlds, draft precedence); lock-ordering safety rule (total order, no upgrade). B5: missing maintenance row fails closed (COALESCE true); DB restore re-asserts fence immediately. Full verification: 12-path mutation table; new-writer checklist; S43–S45 strengthened. B3 verified, no changes. 45 scenarios.
- Rev 15 (2026-10-17): ChatGPT rev-14 delta review — remaining gaps. B1.1: durable accounting handoff — `storage_reservations.state` column IS the accounting category; commit/rollback/ENOSPC/abandon transitions are single-transaction state changes (no scan in the handoff); `abandoned_temp_bytes` redefined as durable SUM over ABANDONED rows; periodic scan value demoted to verification/cleanup. B1.2: race-safe expiry claim protocol — epoch counter on heartbeats, 60s observation wait, 120s file-mtime grace, compare-and-swap claim (`WHERE epoch = E1`); writer obligations (0-row heartbeat → abort; chunk-check every 1MB/30s → abort on non-active state); bounded-windows table; live writers never claimed. B1.3: conservation invariant split into (a) DURABLE RESPONSIBILITY (exact, provable from DB state alone) and (b) MEASUREMENT FRESHNESS bound (scan lag ≤ 5 min; overhead reserve is a capacity-planning margin, explicitly NOT an accounting proof). B4.1: full shared-asset contract — per-file serving authorization under the context world's policy (404 on foreign context); `shared_with_worlds` AND `asset_snapshot_references` both block deletion (T1/T2 scans); world-deletion T1 ownership transfer to lowest shared world_id; snapshot-protected transfer to `unattributed_media_files`; atomic share add/remove in metadata-update transactions. B4.2: `asset_snapshot_references` table (publish-populated, retention-cleaned, with design justification); re-verification cross-checks it (`snapshot_ref_drift` conflict); most-recent-snapshot-world-deleted → ownership to next-most-recent. B4.3: ONE canonical total lock order (positions 0–9 covering session/global/quota/world/backfill_runs/conflict/asset/unattributed/snapshot-ref/scene locks); multi-world ascending-`world_id` and multi-row ascending-ID rules; deadlock-freedom Lemma/Theorem; rev-14 no-upgrade rule subsumed as corollary. B5.1: `is_maintenance_active()` fail-closed function contract (returns true on missing row, missing table, any query error, incomplete migration); behavior matrix; startup verification; startup/request-time agreement; no ambiguous path. B5.2: external fencing procedure — stop ALL machines with verified 0-running gate before DB restore; re-assertion demoted to defense-in-depth; controlled single-machine resumption; future multi-machine cutover variant noted. B2 verification: DEFECT FOUND AND FIXED — metadata updates, publish, and replacement T2 MUST hold level 1 for backfill-freeze serialization (rev-14 table contradicted §4.7b's proof; corrected); post-completion mutation coverage enumerated for all 7 mutation types; filesystem/DB crash-boundary interleavings specified. B3 verification: confirmed same `media_global` advisory key in all 8 call sites; lock held for entire operation; read-only vs mutating distinguished; 13-path table (added publish snapshot-ref path) — no changes needed. 47 acceptance scenarios (S1–S47; S43/S44 strengthened, S46 shared-ownership lifecycle + S47 restore fencing new).
- Rev 16 (2026-10-17): ChatGPT rev-15 delta review — 3 open correctness risks + consistency enforcement. B1.2: fenced writer/expiry coordination — per-chunk `LOCK_SH` validate+write critical section on the deterministic temp path; expiry finalizes only inside `LOCK_EX|LOCK_NB` (non-blocking; `EWOULDBLOCK` = abort cycle); epoch-CAS + 60s observation + 120s mtime retained as liveness evidence; post-abandonment writes ZERO (proven by lock exclusion, S43 steps 18–21); no new state or column; explicit coherent-`flock` deployment assumption with self-test. B4.2: stable identity = `filename` (no FK to registry tables; CASCADE replaced by blocking-before-delete + same-transaction GC cleanup + drift audit); T1 transfer transaction specified exactly (1→2→3→6→8); snapshot serving after transfer via snapshot-row state; three drift conditions with authoritative source (snapshots win) and fail-closed behavior; GC transaction; anti-resurrection guard G3. B4.3: lock-order proof completed against actual DB locking — R1 (job row = position 4), R2 (ORDER BY mandate for multi-row statements), R3 (T5 explicit deletes), R4 (T4 explicit snapshot-ref delete), R5 (attribution locks world row first), R6 (T1 locks new-owner world rows), R7 (backfill writes lock referenced row); Lemmas A–F + Theorem; three competing-transaction demonstrations; Lemma E (session lock). B1.1: state/timestamp CHECK constraints; capacity queries on `state`; commit-transition size semantics + honest DB/filesystem boundary. B4.1: owner-drops-reference eager transfer; reference-lifecycle verification table; serving lookup per registry state. B5.1: single-check-path rule, no-narrowing rule, background-writer contract enumeration. B5.2: role-filtered `pg_stat_activity` session check (verified, procedure already complete). 48 acceptance scenarios (S1–S48; S21 revised, S43/S45/S46/S47 strengthened, S48 new).
- Rev 17 (2026-10-17): Controlled corrective revision per the rev-16 full adversarial audit (30 findings: 7 CORRECTNESS, 13 CONSISTENCY, 10 COMPLETENESS). Phase 1: A6 (two-domain filesystem-exclusion invariant — Domain L/Domain R); A1 (G3 scoped to new-file registrations, transfers exempt); A2 (backfill populates snapshot refs atomically). Phase 2: A16 (LOCK_EX through COMMIT/ROLLBACK, normative); A17 (safe-open protocol, no O_CREAT, inode identity, rename-window outcome); A18 (writer lock-release ordering). Phase 3: A8 (Phase-1/Phase-2 lock sets); A10 (7 ops added to lock table); A13 (Lemma C restated); A14 (drift-resolution case (d)); A15 (claim lock set + starvation); A22 (snapshot-content stability). Phase 4: A7, A9, A19, A20, A3, A5, A12, A29, A4/A23 (GC dormant in MVP). Phase 5: S49–S52 new; S43 extended; A24 (serving during drift). 52 acceptance scenarios (S1–S52). Design Gate REMAINS CLOSED — a fresh full-document adversarial audit will follow before the gate is reconsidered. No implementation authorized.
- Rev 21 (2026-10-18): Targeted corrective revision per the rev-20 full-document review (1 critical finding: the recovery-transaction pre-COMMIT gate used `now()`, the frozen transaction-start timestamp — both gates could evaluate expiry against the same timestamp, so the gate could pass after real expiry). Both gates now use `clock_timestamp()` (true current time; at transaction start it coincides with `now()`). Authorization boundary defined exactly: *valid at the moment the pre-COMMIT gate executes* (the gate is the final statement before COMMIT; no recovery work between gate and commit) — the weaker, enforceable boundary; the stronger "commit lands before expiry" is explicitly declined as unprovable by a pre-commit check. New Lemma: revocation requires level-1 in canonical order (step 7 now a level-1-holding transaction), and the recovery transaction holds level-1 continuously from BEGIN through COMMIT — so no revocation can interleave between the pre-COMMIT gate and COMMIT; a blocked revocation applies to the next transaction. Scenarios: new S63 (true-clock expiry crossing + revocation race with lock-timeline instrumentation); S62 updated to a real-clock expiry (short-lived authorization + `pg_sleep(3)` — a logical clock advance would mask the bug). 63 acceptance scenarios (S1–S63). Design Gate REMAINS CLOSED — a fresh full-document adversarial audit must pass before the gate is reconsidered. No implementation authorized.
- Rev 22 (2026-10-18): Single-issue consistency pass per the rev-21 full-document review (1 critical finding: the defined boundary — *valid at the pre-COMMIT gate* — was contradicted by surviving absolute claims). Three sites rewritten to the exact boundary: the pre-COMMIT SQL comment (gate-time semantics; expiry between gate and COMMIT explicitly outside the boundary), the "does NOT claim" bullet (absolute "No DB mutation commits after expiry" WITHDRAWN; a commit whose gate executed while live still lands if expiry falls before COMMIT is applied), and the B2 invariant proof (absolute "after expiry the session can commit nothing" WITHDRAWN; restated as BEGIN-gate rejection + no post-expiry gate can pass). S63 step 6's document-wide assertion now holds. 63 acceptance scenarios (S1–S63) unchanged. Design Gate REMAINS CLOSED — a fresh full-document adversarial audit must pass before the gate is reconsidered. No implementation authorized.
- Rev 20 (2026-10-18): Targeted corrective revision per the rev-19 full-document review (2 critical findings B1–B2). B1: `one_active_recovery_auth` used `now()` in its predicate — invalid PostgreSQL (index predicates must be immutable). Replaced with time-independent `one_unrevoked_recovery_auth` (`WHERE revoked_at IS NULL`) + `revoke_reason` column + the establishment transaction (level-1-serialized; close-expired step before insert so expiry never wedges replacement; `WHERE NOT EXISTS` guard + unique-index backstop for concurrent operators → `RECOVERY_AUTH_CONFLICT`; defined crash recovery at every point). B2: withdrew the unenforceable "in-flight transaction rolls back on expiry" claim; the authorization-lifetime contract is now BEGIN-gate + pre-COMMIT gate per recovery transaction, filesystem idempotency by allowlist construction, fence held for the whole window, idempotent crash resume. New invariant: *expiry never creates an unprotected filesystem mutation or an inconsistent recovery state.* B8 end-to-end verification: invalidation targets `ABANDONED` (corrected from `ROLLED_BACK` — activation cannot promise file-absence; `ABANDONED` conservatively counts bytes and matches the periodic job's existing `WHERE state='ABANDONED'` cleanup selection); temp-path identity and B1.2 invariants carry scoped carve-outs for the invalidation origin (B8 proof, not lock exclusion). Judgment calls: 4-hour expiry fixed/not configurable (safety from revalidation); invalidation-over-drain kept; `roles` trigger kept with 6 conformance tests specified. Scenarios: S60 rewritten (B2 lifetime contract; corrected the "establish NEW after crash" step — the row survives, operator resumes or revokes-then-re-establishes), new S61 (establishment: concurrent race, crash-between-close-and-insert, expiry close, crash-after-commit), new S62 (expiry-mid-procedure: pre-COMMIT gate rollback, idempotent resume, fence held). 62 acceptance scenarios (S1–S62). Design Gate REMAINS CLOSED — a fresh full-document adversarial audit must pass before the gate is reconsidered. No implementation authorized.
- Rev 19 (2026-10-18): Corrective revision per the rev-18 full-document review (8 findings B1–B8). B3 FIRST (governing decision): new **recovery authorization protocol** in §4.3d — a durable `recovery_authorizations` table (scope/reason/expiry, at-most-one-live by partial unique index), a 7-step establishment protocol (fence must be active; operator authorization; writer-exclusion verification as proof, not a flag; per-transaction level-1 + authorization assertion; closed allowlist of permitted operations; failure keeps the fence active and health degraded; revocation before release), reconciliation with Domain R (no live reservation can exist post-activation — B8; recovery file mutations never address paths with live reservations), level-0 (world-deletion recovery not in the allowlist, untouched), level-1 (recovery transactions acquire canonically), and §9.2 (restore runs repair under authorization — the circular dependency is resolved without lifting the fence). Release criterion 2 revised. §9.4 repair entry requirement: fence inactive OR valid recovery authorization. B1: `roles` subquery CHECK replaced — domain stays in CHECK (`<@`), intra-array uniqueness moves to a BEFORE INSERT/UPDATE trigger (`check_roles_unique`, raises `check_violation`); migration atomicity documented; DDL is executable PostgreSQL. B2: authoritative quota formula is now `registered_usage + outstanding_reservations`; atomic reservation→registry handoff in one commit (no double-count, no gap); §5.1 table + Phase-1 step 4 updated. B4: new `backfill_inventory_files` manifest table + `backfill_run_id` on both registry tables + `failure_reason` on `backfill_runs`; reconciliation rewritten as executable set-equality queries in both directions (placeholders withdrawn). B5: `asset_snapshot_references.world_id` nullable — orphan snapshots get `(filename, snapshot_id, NULL)` ref rows; protection stays filename-keyed. B6: 422 `ASSET_WRONG_WORLD` on reference validation fully superseded — the code exists only as 403 endpoint authorization; S18 asserts the success path. B7: §4.3d example writer transaction uses `is_maintenance_active()` (single-check-path rule; S47 re-assertion fixed likewise). B8: fence activation atomically invalidates in-flight Phase-2 reservations (`→ ROLLED_BACK`); heartbeat/chunk re-validation aborts writers; at most one in-flight chunk completes post-activation; drain-wait rejected (unbounded). Scenarios: S5 rewritten (45/50/4+4 interleaving, exactly one upload proceeds, atomic handoff); S18 +B6 assert; S30–S32 executable reconciliation; S47 +B3/B8/B7 (invalidation, wrapper re-assertion, authorized repair in restore); S50 +B5 orphan-snapshot case; S55 +B3 recovery-authorization path (step 4); new S57 (migration failure rollback), S58 (NULL-world snapshot), S59 (fence invalidation), S60 (repair under active fence; failure keeps fence). 60 acceptance scenarios (S1–S60). Design Gate REMAINS CLOSED — a fresh full-document adversarial audit must pass before the gate is reconsidered. No implementation authorized.
- Rev 18 (2026-10-17): Targeted corrective revision per the rev-17 full adversarial audit (14 findings B1–B14). Phase 1 (correctness): B1 — §4.3d mutation table row 1 corrected to Domain R (no level-1 for Phase-2 chunk writes); B8 — backfill classification SQL sequence pinned normatively (G3 check BEFORE registry INSERT and BEFORE first ref-row INSERT; order 1 → 3 → (6 or 7) → 8); B9 — path-vanished CAS corrected (claim columns stay NULL for ROLLED_BACK per CHECK constraint); B6 — expiry-claim protocol steps 5d/5e/5f acquire level-1 and call is_maintenance_active() per the background-writer rule. Phase 2 (proof/coverage): B2 — S26 scoped to Domain L; new S53 (Domain-R exclusion); B10 — DESIGN DECISION: T4 lock order changed 6→8→7 to 6→7→8 (strictly ascending; no semantic dependency prevents it); all T4 tables reconciled; new S54 (attribution atomicity), S55 (maintenance-fence single check path), S56 (serving during unresolved drift); lock-proof assumptions (i)–(v) explicit in-document. Phase 3 (consistency): B3 (Domain-L qualification), B4 (history reordered), B5 (GC dormant in writer list), B7 (S52 static check), B11 (quota paragraph rewritten), B12 (S49 phase split), B13 (S52 claim-side executable + path-absent), B14 (proof hygiene: Lemma D, repair row, level-0 naming, Lemma A inventory, Delete T1/T2 position-8, R2 GC note, analysis (a) sequence). 56 acceptance scenarios (S1–S56). Design Gate REMAINS CLOSED — a fresh full-document adversarial audit must pass before the gate is reconsidered. No implementation authorized.
- Post-packet clarification (2026-10-18): S54/R5 lock-order annotation — the attribution listing `1 → 3 → 7 → 6` is statement order; the *blocking* acquisition sequence is 1 → 3 → 7 (strictly ascending per E1) because the trailing INSERT is a non-blocking new-row insert per Lemma A. Annotated in R5, the §4.3c table (`6*` footnote), Lemma C, and S54 step 5. No design change; no new revision.

**Next steps:** Product-owner approval → migration plan → implementation (separate work package, not authorized by this ADR).
