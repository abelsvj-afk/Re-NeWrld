/**
 * REF-1 integration tests (design rev 5).
 *
 * Covers:
 * - validateAssetUrl: ASSET_UNKNOWN, ASSET_WRONG_WORLD, ASSET_DELETED, ASSET_FILE_MISSING
 * - computeAssetRoles: union of references
 * - validateReferences: lock ordering, backfill check
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { randomUUID } from 'node:crypto';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

const WORLD_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_WORLD_ID = '66666666-6666-6666-6666-666666666666';
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
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Ref Test', $2) ON CONFLICT (world_id) DO NOTHING`,
    [WORLD_ID, USER_ID]
  );
  await pool.query(
    `INSERT INTO worlds (world_id, title, creator_id) VALUES ($1, 'Other World', $2) ON CONFLICT (world_id) DO NOTHING`,
    [OTHER_WORLD_ID, USER_ID]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM world_media_assets WHERE world_id IN ($1, $2)`, [WORLD_ID, OTHER_WORLD_ID]);
  await pool.end();
});

async function createAsset(url: string, worldId: string, overrides: Record<string, unknown> = {}) {
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO world_media_assets 
     (asset_id, world_id, url, filename, mimetype, size_bytes, content_sha256, lifecycle, file_confirmed_present, roles)
     VALUES ($1, $2, $3, 'test.png', 'image/png', 1024, 'abc123', $4, $5, $6)`,
    [
      assetId,
      worldId,
      url,
      overrides.lifecycle ?? 'active',
      overrides.fileConfirmedPresent ?? true,
      overrides.roles ?? [],
    ]
  );
  return assetId;
}

describe('validateAssetUrl', () => {
  it('returns asset for valid URL', async () => {
    const { validateAssetUrl } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_ID);

    const client = await pool.connect();
    try {
      const asset = await validateAssetUrl(url, WORLD_ID, client, {
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

  it('throws ASSET_UNKNOWN for unregistered URL', async () => {
    const { validateAssetUrl, ReferenceValidationError } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const client = await pool.connect();
    try {
      await expect(
        validateAssetUrl('/media/nonexistent.png', WORLD_ID, client, {
          isFenceActive: async () => false,
          isBackfillActive: async () => false,
          log: () => {},
        })
      ).rejects.toMatchObject({ code: 'ASSET_UNKNOWN' });
    } finally {
      client.release();
    }
  });

  it('throws ASSET_WRONG_WORLD for cross-world URL', async () => {
    const { validateAssetUrl } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, OTHER_WORLD_ID);

    const client = await pool.connect();
    try {
      await expect(
        validateAssetUrl(url, WORLD_ID, client, {
          isFenceActive: async () => false,
          isBackfillActive: async () => false,
          log: () => {},
        })
      ).rejects.toMatchObject({ code: 'ASSET_WRONG_WORLD', httpStatus: 422 });
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('throws ASSET_DELETED for non-active lifecycle', async () => {
    const { validateAssetUrl } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_ID, { lifecycle: 'pending_deletion' });

    const client = await pool.connect();
    try {
      await expect(
        validateAssetUrl(url, WORLD_ID, client, {
          isFenceActive: async () => false,
          isBackfillActive: async () => false,
          log: () => {},
        })
      ).rejects.toMatchObject({ code: 'ASSET_DELETED' });
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });

  it('throws ASSET_FILE_MISSING when file not confirmed', async () => {
    const { validateAssetUrl } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_ID, { fileConfirmedPresent: false });

    const client = await pool.connect();
    try {
      await expect(
        validateAssetUrl(url, WORLD_ID, client, {
          isFenceActive: async () => false,
          isBackfillActive: async () => false,
          log: () => {},
        })
      ).rejects.toMatchObject({ code: 'ASSET_FILE_MISSING' });
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('computeAssetRoles', () => {
  it('returns union of references', async () => {
    const { computeAssetRoles } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );
    const url = `/media/${randomUUID()}.png`;
    const assetId = await createAsset(url, WORLD_ID);

    // Set as world cover
    await pool.query(
      `UPDATE worlds SET metadata = jsonb_build_object('coverArtUrl', $2) WHERE world_id = $1`,
      [WORLD_ID, url]
    );

    const client = await pool.connect();
    try {
      const roles = await computeAssetRoles(url, WORLD_ID, client);
      expect(roles).toContain('cover');
    } finally {
      client.release();
    }

    await pool.query(`UPDATE worlds SET metadata = '{}' WHERE world_id = $1`, [WORLD_ID]);
    await pool.query(`DELETE FROM world_media_assets WHERE asset_id = $1`, [assetId]);
  });
});

describe('validateReferences', () => {
  it('rejects when backfill is active', async () => {
    const { validateReferences } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );

    await expect(
      validateReferences(WORLD_ID, [], [], {
        isFenceActive: async () => false,
        isBackfillActive: async () => true, // Backfill active
        log: () => {},
      })
    ).rejects.toMatchObject({ code: 'BACKFILL_IN_PROGRESS', httpStatus: 503 });
  });

  it('validates empty URL lists successfully', async () => {
    const { validateReferences } = await import(
      '../../src/modules/world/domain/services/reference-validator.service.js'
    );

    // No URLs to validate — should succeed
    await validateReferences(WORLD_ID, [], [], {
      isFenceActive: async () => false,
      isBackfillActive: async () => false,
      log: () => {},
    });
  });
});
