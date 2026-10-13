import pkg from 'pg';
const { Pool } = pkg;
import { env } from '../../config/env.js';
import { logger } from '../logger/pino.logger.js';

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
  try {
    pool.end();
  } catch {}
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database error on idle PostgreSQL client');
  });
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
