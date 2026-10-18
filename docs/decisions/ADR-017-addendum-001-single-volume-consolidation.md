# ADR-017 Addendum 001: Single-Volume Consolidation

**Status:** DRAFT — pending ChatGPT review and product-owner approval.
**Date:** 2026-10-18.
**Supersedes (partially):** ADR-017 §2 (Option A), migration plan §7.2 items 2 & 4, implementation breakdown OPS-0 procedure.
**Review basis:** ChatGPT verdict 2026-10-18 — storage consolidation PASS WITH REQUIRED ADDENDUM CHANGES.

---

## 1. Change summary

Fly.io permits only one volume per machine (`invalid config.mounts, only 1 volume supported`). The ADR-017 §2 Option A design (separate `media_data` volume) is not deployable.

**New design:** Extend the existing `narration_data` volume from 1 GB to 4 GB, mount at `/data`. Both `/data/narrations` (ADR-016 audio) and `/data/media` (ADR-017 uploads) live as subdirectories on the shared volume.

**What is preserved:** All ADR-017 guarantees (durable reservations, quota enforcement, capacity accounting, crash safety, publication integrity) are unchanged. Only the physical layout changes.

**What changes:** Capacity accounting must account for two consumers on one filesystem (see §2). Backup snapshots capture both data sets (§4). Documentation references to a separate volume are superseded (§5).

---

## 2. Shared capacity accounting (addresses ChatGPT high-severity finding)

### 2.1 The gap

ADR-017 §5.5's `storage_used_bytes` accounts only for media bytes under `/data/media`. Narration files under `/data/narrations` consume the same physical filesystem but are invisible to the media admission check. Without correction, media uploads could pass admission while the disk is actually full.

### 2.2 Resolution: documented narration reserve (ChatGPT Option 1)

Define a conservative, documented reserve for non-media usage. The media admission check enforces against the reduced capacity.

**Capacity formula (replaces §5.5 `storage_capacity_bytes` definition for the shared volume):**

```
media_capacity_bytes = volume_size_bytes
                     - narration_reserve_bytes
                     - filesystem_overhead_bytes
```

Where:
- `volume_size_bytes`: 4 GiB (actual provisioned volume).
- `narration_reserve_bytes`: `NARRATION_RESERVE_BYTES` config, default **1 GiB**. Rationale: narration audio files are small (ElevenLabs MP3s, tens of KB per scene); 1 GiB is conservative for the foreseeable scale. If narration approaches the reserve, an alert fires (see §2.4) and the reserve is raised by operator action, reducing media capacity accordingly.
- `filesystem_overhead_bytes`: `STORAGE_OVERHEAD_RESERVE_PERCENT` of `media_capacity_bytes` (default 5%, per §5.5). Unchanged semantics.

**Proposed values (require product-owner confirmation):**
- `NARRATION_RESERVE_BYTES` = 1 GiB.
- `STORAGE_CAPACITY_BYTES` (media) = **2.5 GiB** (4.0 − 1.0 narration − ~0.5 overhead/headroom).

The previous 1.5 GiB value was calibrated for a dedicated 2 GiB volume and is **superseded, not carried forward**.

### 2.3 Enforcement

The `effective_available` formula in §5.5 is unchanged, but `storage_capacity_bytes` is now the **media** capacity (2.5 GiB), not the raw volume size. The narration reserve is subtracted before enforcement, so media admission can never consume narration's headroom.

**Fail-closed:** If narration usage exceeds `NARRATION_RESERVE_BYTES`, media uploads continue (the reserve is planning headroom, not a hard partition), but a `NARRATION_RESERVE_EXCEEDED` alert fires and the operator must either raise the reserve (reducing media capacity) or clean up. The design does not silently allow unbounded narration growth to starve media.

### 2.4 Monitoring

- Alert if `narration_bytes > 0.8 * NARRATION_RESERVE_BYTES` (warning) or `> NARRATION_RESERVE_BYTES` (critical).
- The existing `ACCOUNTING_DIVERGENCE` alert (§5.5) now covers three-way divergence: managed media accounting vs. narration usage vs. OS-reported utilization.

---

## 3. Storage-health compatibility

The `findContainingMount()` longest-prefix matching (commit `36abbfd`) correctly identifies `/data` as the containing mount for `/data/media`. No further changes required. The health check reports the shared volume's device; per-consumer breakdown is available via the capacity metric, not the mount table.

---

## 4. Backup and recovery

A snapshot of the shared volume captures **both** narration audio and media uploads. Implications:

- **Restore:** Restoring the volume restores both data sets to the snapshot instant. There is no independent restore granularity. Documented as a known limitation; acceptable for MVP scale.
- **Retention:** Snapshot schedule unchanged (5-day retention per OPS-0).
- **Recovery:** The §4.4/§9.4 reconciliation procedures operate per-path (`/data/media` vs `/data/narrations`) and are unaffected by colocation.

---

## 5. Superseded documentation

The following are superseded by this addendum and must not be followed:

- ADR-017 §2, Option A (separate `media_data` volume, 1–2 GB).
- Migration plan §7.2 item 2 (`media_data`, 2 GB) — replaced by 4 GB shared volume.
- Migration plan §7.2 item 4 (`STORAGE_CAPACITY_BYTES` 1.5 GiB) — replaced by §2.2 above.
- Implementation breakdown OPS-0 procedure (separate volume provisioning steps) — replaced by: extend `narration_data` to 4 GB, mount at `/data`.

**Preserved:** ADR-017 §9.2 single-machine topology rule. The shared volume is machine-attached, not network storage. The app MUST run single-machine. This constraint is unchanged and remains explicit.

---

## 6. Cutover (completed 2026-10-18)

1. Extended `vol_r1jg5oo6577x7ypr` 1 GB → 4 GB (online, no downtime).
2. Updated `fly.toml`: single `[[mounts]]`, `source='narration_data'`, `destination='/data'`.
3. Deployed via `flyctl deploy` (machine replacement required for mount change).
4. Created `/data/narrations/` and `/data/media/` on the volume.
5. Verified: `/health` reports `ok`, `/dev/vdc`, writable; test upload persists and serves.
6. Snapshot scheduled.

**Rollback:** Revert `fly.toml` to `destination='/data/narrations'`, redeploy (machine replacement). The volume retains all files; only the mountpoint changes. No data migration required for rollback.

---

## 7. Open decisions requiring product-owner approval

1. Confirm `NARRATION_RESERVE_BYTES` = 1 GiB and `STORAGE_CAPACITY_BYTES` = 2.5 GiB (§2.2).
2. Confirm the supersession of migration plan §7.2 items 2 & 4.
