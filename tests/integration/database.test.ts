import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pool, query, getClient, closePool, setPool } from '../../src/shared/database/db.js';

const intentionalSkip = process.env.SKIP_DB_TESTS === 'true' || process.env.SKIP_DOCKER === 'true';
const describeFn = intentionalSkip ? describe.skip : describe;

describeFn('PostgreSQL Connection Pool & Database Integration', () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      const connectionString = container.getConnectionUri();
      setPool(connectionString);
    } catch (err) {
      throw new Error(`Docker daemon / PostgreSQL container startup failed and intentional skip mechanism is not enabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    try {
      await closePool();
    } catch {}
    if (container) {
      await container.stop();
    }
  });

  it('should connect to PostgreSQL via the B1 pool and execute a test query', async () => {
    if (!container) {
      throw new Error('Integration test failed: PostgreSQL container is not running and SKIP_DB_TESTS is not enabled.');
    }

    const res = await query('SELECT 1 AS connected, current_timestamp AS now');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].connected).toBe(1);
    expect(res.rows[0].now).toBeDefined();

    const client = await getClient();
    try {
      const clientRes = await client.query('SELECT 2 AS val');
      expect(clientRes.rows[0].val).toBe(2);
    } finally {
      client.release();
    }
  });
});
