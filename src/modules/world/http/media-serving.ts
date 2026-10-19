/**
 * SHARE-1: Registry-gated media serving (ADR-017 §4.5)
 *
 * Replaces the static file handler for /media/ with a registry-aware handler:
 * - Checks world_media_assets before serving
 * - Returns 404 for unregistered, non-active, or missing assets
 * - Returns 503 for drift (row exists, file missing)
 * - Serves unattributed files with a warning header (backward compat)
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../../shared/database/db.js';

export interface ServingDeps {
  mediaRoot: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

// Use `any` for app to avoid Fastify generic type mismatches across the codebase.
export function registerMediaServing(app: any, deps: ServingDeps): void {
  app.get('/media/:filename', async (request: any, reply: any) => {
    const { filename } = request.params as { filename: string };
    const url = `/media/${filename}`;

    // Basic path traversal protection
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ error: 'INVALID_FILENAME' });
    }

    const filePath = join(deps.mediaRoot, filename);

    // Registry lookup
    const result = await query(
      `SELECT asset_id, lifecycle, file_confirmed_present FROM world_media_assets WHERE url = $1`,
      [url]
    );

    if (result.rows.length === 0) {
      // Not in registry — check if file exists (unattributed, backward compat)
      try {
        await stat(filePath);
        // File exists but no registry row — serve with warning
        deps.log('warn', 'Serving unattributed file', { filename });
        reply.header('X-Unattributed', 'true');
        return reply.sendFile(filename);
      } catch {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
    }

    const asset = result.rows[0];

    // Only serve active assets
    if (asset.lifecycle !== 'active') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    // Check file exists
    try {
      await stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Drift: row exists, file missing
        deps.log('error', 'Drift detected: registry row without file', {
          assetId: asset.asset_id,
          filename,
        });
        return reply.code(503).send({
          error: 'ASSET_UNAVAILABLE',
          message: 'Asset file is temporarily unavailable',
        });
      }
      throw err;
    }

    // Serve the file
    return reply.sendFile(filename);
  });
}
