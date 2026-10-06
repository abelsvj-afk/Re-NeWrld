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
    expect(json.status).toBe('ok');
    expect(json.timestamp).toBeDefined();

    await app.close();
  });
});
