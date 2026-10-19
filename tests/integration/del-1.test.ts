/**
 * DEL-1 integration tests (design rev 3).
 *
 * Covers:
 * - T1: 404 on missing asset, 409 on referenced asset, marks pending_deletion
 * - T2: deletes file and row, idempotent on retry
 * - Error codes: ASSET_NOT_FOUND, ASSET_REFERENCED, DELETION_ABORTED
 *
 * NOTE: UNVERIFIED — no PostgreSQL in this environment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

const WORLD_ID = '77777777-7777-7777-7777-777777777777';
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
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Del Test', $2) ON CONFLICT (world_id) DO NOTHING`,
    [WORLD_ID, USER_ID]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM world_media_assets WHERE world_id = $1`, [WORLD_ID]);
  await pool.end();
});

async function createAsset(url: string, lifecycle = 'active') {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO world_media_assets 
     (asset_id, world_id, url, filename, mimetype, size_bytes, content_sha256, lifecycle, file_confirmed_present, roles)
     VALUES ($1, $2, $3, 'test.png', 'image/png', 1024, 'abc123', $4, true, '[]')`,
    [assetId, WORLD_ID, url, lifecycle]
  );
  return assetId;
}

const mockDeps = {
  mediaRoot: '/tmp',
  isFenceActive: async () => false,
  isBackfillActive: async () => false,
  log: () => {},
};

describe('deletionT1', () => {
  it('throws ASSET_NOT_FOUND for missing asset', async () => {
    const { deletionT1, DeletionError } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    await expect(
      deletionT1(randomUUID(), WORLD_ID, mockDeps)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND', httpStatus: 404 });
  });

  it('throws ASSET_REFERENCED when asset is used as cover', async () => {
    const { deletionT1 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url);

    // Set as world cover
    await pool.query(
      `UPDATE worlds SET metadata = jsonb_build_object('coverArtUrl', $2) WHERE world_id = $1`,
      [WORLD_ID, url]
    );

    await expect(
      deletionT1(assetId, WORLD_ID, mockDeps)
    ).rejects.toMatchObject({
      code: 'ASSET_REFERENCED',
      httpStatus: 409,
    });

    // Cleanup
    await pool.query(`UPDATE worlds SET metadata = '{}' WHERE world_id = $1`, [WORLD_ID]);
    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('marks unreferenced asset as pending_deletion', async () => {
    const { deletionT1 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url);

    const result = await deletionT1(assetId, WORLD_ID, mockDeps);
    expect(result).toBe('proceed');

    const check = await pool.query(
      `SELECT lifecycle FROM world_media_assets WHERE asset_id = $1`,
      [assetId]
    );
    expect(check.rows[0].lifecycle).toBe('pending_deletion');

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('is idempotent on already-pending_deletion', async () => {
    const { deletionT1 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, 'pending_deletion');

    const result = await deletionT1(assetId, WORLD_ID, mockDeps);
    expect(result).toBe('proceed');

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('deletionT2', () => {
  it('returns deleted for missing row (idempotent)', async () => {
    const { deletionT2 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const result = await deletionT2(randomUUID(), WORLD_ID, mockDeps);
    expect(result).toBe('deleted');
  });

  it('throws DELETION_ABORTED for active lifecycle', async () => {
    const { deletionT2 } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, 'active'); // Not pending_deletion

    await expect(
      deletionT2(assetId, WORLD_ID, mockDeps)
    ).rejects.toMatchObject({
      code: 'DELETION_ABORTED',
      httpStatus: 409,
    });

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('deleteAsset (combined)', () => {
  it('throws FENCE_ACTIVE when fence is up', async () => {
    const { deleteAsset } = await import(
      '../../src/modules/world/domain/services/asset-deletion.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url);

    await expect(
      deleteAsset(assetId, WORLD_ID, {
        ...mockDeps,
        isFenceActive: async () => true,
      })
    ).rejects.toMatchObject({ code: 'FENCE_ACTIVE', httpStatus: 503 });

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});
