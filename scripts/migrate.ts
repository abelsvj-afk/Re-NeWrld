import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'pg';
const { Pool } = pkg;
import { env } from '../src/config/env.js';
import { logger } from '../src/shared/logger/pino.logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
  });

  const client = await pool.connect();
  try {
    // Acquire application-level advisory lock for migration synchronization
    await client.query('SELECT pg_advisory_lock(987654321)');

    // Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Read migration files from db/migrations
    const migrationsDir = path.resolve(__dirname, '../db/migrations');
    if (!fs.existsSync(migrationsDir)) {
      logger.info('No migrations directory found at %s', migrationsDir);
      return;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    // Get already applied versions
    const res = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(res.rows.map((row) => row.version));

    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      if (!match) continue;
      const version = parseInt(match[1], 10);

      if (appliedVersions.has(version)) {
        logger.info({ version, file }, 'Migration already applied');
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      logger.info({ version, file }, 'Applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [version, file]
        );
        await client.query('COMMIT');
        logger.info({ version, file }, 'Migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ version, file, err }, 'Migration failed, rolling back');
        throw err;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(987654321)');
    } catch {}
    client.release();
    await pool.end();
  }
}

// Allow direct execution via CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('✅ Migrations completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}
