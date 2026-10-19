/**
 * SHARE-1 integration tests (design rev 2).
 *
 * Covers:
 * - shareAsset/unshareAsset: basic flow, errors
 * - Snapshot protection in DEL-1
 * - REF-1 allows shared assets
 *
 * NOTE: UNVERIFIED — no PostgreSQL in this environment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

const WORLD_A = '88888888-8888-8888-8888-888888888888';
const WORLD_B = '99999999-9999-9999-9999-999999999999';
const USER_ID = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  pool = new pkg.Pool({ connectionString: TEST_DATABASE_URL });

  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const migDir = join(process.cwd(), 'db/migrations');
  const files = (await readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const mig of files) {
    const sql = await readFile(join(migDir, mig), 'utf-8');
    await pool.query(sql);
  }

  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role) VALUES ($1, 'test@test.com', 'hash', 'creator') ON CONFLICT (user_id) DO NOTHING`,
    [USER_ID]
  );
  for (const wid of [WORLD_A, WORLD_B]) {
    await pool.query(
      `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Share Test', $2) ON CONFLICT (world_id) DO NOTHING`,
      [wid, USER_ID]
    );
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM asset_snapshot_references WHERE snapshot_id IN (SELECT snapshot_id FROM canon_snapshots WHERE world_id IN ($1, $2))`, [WORLD_A, WORLD_B]).catch(() => {});
  await pool.query(`DELETE FROM world_media_assets WHERE world_id IN ($1, $2)`, [WORLD_A, WORLD_B]);
  await pool.end();
});

async function createAsset(url: string, worldId: string) {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO world_media_assets 
     (asset_id, world_id, url, filename, mimetype, size_bytes, content_sha256, lifecycle, file_confirmed_present, roles, shared_with_worlds)
     VALUES ($1, $2, $3, 'test.png', 'image/png', 1024, 'abc123', 'active', true, '[]', '{}')`,
    [assetId, worldId, url]
  );
  return assetId;
}

const mockDeps = { log: () => {} };

describe('shareAsset', () => {
  it('shares asset with another world', async () => {
    const { shareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    await shareAsset(assetId, WORLD_A, WORLD_B, mockDeps);

    const check = await pool.query(
      `SELECT shared_with_worlds FROM world_media_assets WHERE asset_id = $1`,
      [assetId]
    );
    expect(check.rows[0].shared_with_worlds).toContain(WORLD_B);

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('throws SELF_SHARE for same world', async () => {
    const { shareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    await expect(
      shareAsset(assetId, WORLD_A, WORLD_A, mockDeps)
    ).rejects.toMatchObject({ code: 'SELF_SHARE', httpStatus: 400 });

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('throws NOT_OWNER for non-owner', async () => {
    const { shareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    await expect(
      shareAsset(assetId, WORLD_B, WORLD_A, mockDeps)
    ).rejects.toMatchObject({ code: 'NOT_OWNER', httpStatus: 403 });

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('unshareAsset', () => {
  it('unshares asset', async () => {
    const { shareAsset, unshareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    await shareAsset(assetId, WORLD_A, WORLD_B, mockDeps);
    await unshareAsset(assetId, WORLD_A, WORLD_B, mockDeps);

    const check = await pool.query(
      `SELECT shared_with_worlds FROM world_media_assets WHERE asset_id = $1`,
      [assetId]
    );
    expect(check.rows[0].shared_with_worlds).not.toContain(WORLD_B);

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('is idempotent when not shared', async () => {
    const { unshareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    // Not shared — should succeed silently
    await unshareAsset(assetId, WORLD_A, WORLD_B, mockDeps);

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('REF-1 with shared assets', () => {
  it('allows reference to shared asset from target world', async () => {
    const { shareAsset } = await import(
      '../../src/modules/world/domain/services/asset-share.service.js'
    );
    const { validateAssetUrl } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);
    await shareAsset(assetId, WORLD_A, WORLD_B, mockDeps);

    const client = await pool.connect();
    try {
      // Should NOT throw ASSET_WRONG_WORLD
      const asset = await validateAssetUrl(url, WORLD_B, client, {
        isFenceActive: async () => false,
        isBackfillActive: async () => false,
        log: () => {},
      });
      expect(asset.assetId).toBe(assetId);
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('DEL-1 with snapshot protection', () => {
  it('blocks deletion of snapshot-protected asset', async () => {
    const { deletionT1 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_A);

    // Create a fake snapshot reference
    const snapshotId = randomUUID();
    await pool.query(
      `INSERT INTO asset_snapshot_references (snapshot_id, asset_id, role) VALUES ($1, $2, 'cover')`,
      [snapshotId, assetId]
    );

    await expect(
      deletionT1(assetId, WORLD_A, {
        mediaRoot: '/tmp',
        isFenceActive: async () => false,
        isBackfillActive: async () => false,
        log: () => {},
      })
    ).rejects.toMatchObject({
      code: 'ASSET_SNAPSHOT_PROTECTED',
      httpStatus: 409,
    });

    await pool.query(`DELETE FROM asset_snapshot_references WHERE asset_id = $1`, [assetId]);
    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});
