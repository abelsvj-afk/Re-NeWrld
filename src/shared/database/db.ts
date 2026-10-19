import pkg from 'pg';
const { Pool } = pkg;
import { env } from '../../config/env.js';
import { logger } from '../logger/pino.logger.js';

// STOP-2: refuse to connect unless the database name ends with _test when
// running in the test environment. This prevents the test suite from ever
// running migrations or seed data against a production database, even if
// DATABASE_URL is misconfigured.
if (env.APP_ENV === 'test') {
  const dbUrl = env.DATABASE_URL ?? '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? '';
  if (!dbName.endsWith('_test') && dbName !== 'test' && dbName !== 'dummy') {
    throw new Error(
      `Refusing to run against non-test database '${dbName}' (APP_ENV=test requires a _test suffix)`
    );
  }
}

export let pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database error on idle PostgreSQL client');
});

export function setPool(connectionString: string): void {
  // STOP-2: same guard for runtime pool swaps (integration tests use setPool
  // with TEST_DATABASE_URL or a Testcontainers URI).
  if (env.APP_ENV === 'test') {
    const dbName = connectionString.split('/').pop()?.split('?')[0] ?? '';
    if (!dbName.endsWith('_test') && dbName !== 'test' && dbName !== 'dummy') {
      throw new Error(
        `Refusing to run against non-test database '${dbName}' (APP_ENV=test requires a _test suffix)`
      );
    }
  }
  const oldPool = pool;
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database error on idle PostgreSQL client');
  });
  // Close the old pool asynchronously (don't block the swap).
  // QUOTA-1: Ensures clean handoff during test pool swaps.
  oldPool.end().catch(() => {});
}

/**
 * Async version that awaits closure of the old pool.
 * Use in tests where deterministic cleanup matters.
 */
export async function setPoolAndWait(connectionString: string): Promise<void> {
  const oldPool = pool;
  setPool(connectionString);
  try {
    await oldPool.end();
  } catch {}
}

export async function query<R extends pkg.QueryResultRow = any>(text: string, params?: any[]): Promise<pkg.QueryResult<R>> {
  const start = Date.now();
  try {
    const res = await pool.query<R>(text, params);
    const duration = Date.now() - start;
    logger.debug({ query: text, duration, rows: res.rowCount }, 'Executed PostgreSQL query');
    return res;
  } catch (err) {
    logger.error({ query: text, err }, 'PostgreSQL query execution failed');
    throw err;
  }
}

export async function getClient(): Promise<pkg.PoolClient> {
  const client = await pool.connect();
  return client;
}

/**
 * Minimal transaction primitive (Task E2a).
 *
 * Runs `fn` inside a single database transaction on one pooled client:
 * BEGIN → fn(client) → COMMIT. On any failure, rolls back and rethrows the
 * ORIGINAL error — a rollback failure is logged but never masks it.
 * The client is always released back to the pool.
 */
export async function withTransaction<T>(
  fn: (client: pkg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'Transaction rollback failed; rethrowing original error');
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('PostgreSQL connection pool closed');
}
