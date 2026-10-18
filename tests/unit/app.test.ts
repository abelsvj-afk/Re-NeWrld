import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('Fastify Application Bootstrap & Health Check', () => {
  it('should boot app and return status ok on /health', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    // Top-level status mirrors the storage state explicitly: 'ok', 'degraded',
    // or 'unknown' (mount table unreadable) — never masked as 'ok'.
    expect(['ok', 'degraded', 'unknown']).toContain(json.status);
    expect(json.timestamp).toBeDefined();
    // Storage assertion contract (ADR-017 OPS-0)
    expect(json.media_storage).toBeDefined();
    expect(json.media_storage.mountpoint).toBeDefined();
    expect(['ok', 'degraded', 'unknown']).toContain(json.media_storage.state);
    expect(typeof json.media_storage.writable).toBe('boolean');

    await app.close();
  });
});

describe('SPA Fallback (deep-link fix)', () => {
  it('should serve index.html for valid client-side deep links', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/creator/worlds/401e321f-b936-4b5f-acf1-400a619c2c3c/scenes',
    });

    // Should serve the SPA, not a 404
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('<div id="root"');

    await app.close();
  });

  it('should serve index.html for /read route', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/read',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);

    await app.close();
  });

  it('should return JSON 404 for unknown /api endpoints, not HTML', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/nonexistent-endpoint',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    const json = response.json();
    expect(json.error).toBe('Not found');

    await app.close();
  });

  it('should return 404 for missing static assets, not HTML', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-asset-12345.js',
    });

    expect(response.statusCode).toBe(404);
    // Should NOT serve index.html for asset-like paths
    expect(response.headers['content-type']).not.toMatch(/text\/html/);

    await app.close();
  });

  it('should return 404 for non-GET unmatched routes', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/creator/worlds/some-id/scenes',
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
