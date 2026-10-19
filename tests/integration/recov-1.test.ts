/**
 * RECOV-1 integration tests (design rev 2).
 *
 * Covers:
 * - establishRecoveryAuth: success, fence check, exclusivity
 * - verifyRecoveryAuth: valid, expired, wrong scope
 * - revokeRecoveryAuth: idempotent
 *
 * NOTE: UNVERIFIED — no PostgreSQL in this environment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

let pool: pkg.Pool;

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
});

afterAll(async () => {
  await pool.query(`DELETE FROM recovery_authorizations`).catch(() => {});
  await pool.end();
});

const mockDeps = {
  isFenceActive: async () => true, // Fence active for tests
  log: () => {},
};

describe('establishRecoveryAuth', () => {
  it('creates authorization under active fence', async () => {
    const { establishRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth = await establishRecoveryAuth(
      'repair',
      'Test repair',
      3600,
      'test-operator',
      mockDeps
    );

    expect(auth.authId).toBeDefined();
    expect(auth.scope).toBe('repair');
    expect(auth.expiresAt).toBeDefined();

    // Cleanup
    await pool.query(`DELETE FROM recovery_authorizations WHERE auth_id = $1`, [auth.authId]);
  });

  it('rejects when fence not active', async () => {
    const { establishRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    await expect(
      establishRecoveryAuth('repair', 'Test', 3600, 'op', {
        ...mockDeps,
        isFenceActive: async () => false,
      })
    ).rejects.toMatchObject({ code: 'FENCE_NOT_ACTIVE', httpStatus: 400 });
  });

  it('enforces exclusivity (one active auth)', async () => {
    const { establishRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth1 = await establishRecoveryAuth('repair', 'First', 3600, 'op', mockDeps);

    await expect(
      establishRecoveryAuth('repair', 'Second', 3600, 'op', mockDeps)
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_EXISTS', httpStatus: 409 });

    await pool.query(`DELETE FROM recovery_authorizations WHERE auth_id = $1`, [auth1.authId]);
  });
});

describe('verifyRecoveryAuth', () => {
  it('verifies valid auth', async () => {
    const { establishRecoveryAuth, verifyRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth = await establishRecoveryAuth('repair', 'Test', 3600, 'op', mockDeps);

    const client = await pool.connect();
    try {
      // Should not throw
      await verifyRecoveryAuth(auth.authId, 'repair', client);
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM recovery_authorizations WHERE auth_id = $1`, [auth.authId]);
  });

  it('rejects wrong scope', async () => {
    const { establishRecoveryAuth, verifyRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth = await establishRecoveryAuth('repair', 'Test', 3600, 'op', mockDeps);

    const client = await pool.connect();
    try {
      await expect(
        verifyRecoveryAuth(auth.authId, 'restore-reconcile', client)
      ).rejects.toMatchObject({ code: 'RECOVERY_SCOPE_DENIED', httpStatus: 403 });
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM recovery_authorizations WHERE auth_id = $1`, [auth.authId]);
  });
});

describe('revokeRecoveryAuth', () => {
  it('revokes auth (idempotent)', async () => {
    const { establishRecoveryAuth, revokeRecoveryAuth, verifyRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth = await establishRecoveryAuth('repair', 'Test', 3600, 'op', mockDeps);
    await revokeRecoveryAuth(auth.authId, mockDeps);

    // Verify is gone
    const client = await pool.connect();
    try {
      await expect(
        verifyRecoveryAuth(auth.authId, 'repair', client)
      ).rejects.toMatchObject({ code: 'RECOVERY_EXPIRED' });
    } finally {
      client.release();
    }

    // Second revoke should not throw (idempotent)
    await revokeRecoveryAuth(auth.authId, mockDeps);
  });
});

describe('hasActiveRecoveryAuth', () => {
  it('returns true when auth exists', async () => {
    const { establishRecoveryAuth, hasActiveRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const auth = await establishRecoveryAuth('repair', 'Test', 3600, 'op', mockDeps);

    const client = await pool.connect();
    try {
      expect(await hasActiveRecoveryAuth(client)).toBe(true);
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM recovery_authorizations WHERE auth_id = $1`, [auth.authId]);
  });

  it('returns false when no auth', async () => {
    const { hasActiveRecoveryAuth } = await import(
      '../../src/modules/world/domain/services/recovery-auth.service.js'
    );

    const client = await pool.connect();
    try {
      expect(await hasActiveRecoveryAuth(client)).toBe(false);
    } finally {
      client.release();
    }
  });
});
