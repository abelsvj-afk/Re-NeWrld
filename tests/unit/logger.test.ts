import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import { buildApp } from '../../src/app.js';
import { logger, createLogger } from '../../src/shared/logger/pino.logger.js';
import { env } from '../../src/config/env.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Pino Structured Logger & Correlation ID Tracking', () => {
  it('should initialize Pino logger with correct level from environment', () => {
    expect(logger).toBeDefined();
    expect(logger.level).toBeTypeOf('string');
    expect(logger.level).toBe(env.LOG_LEVEL);
  });

  it('should propagate valid incoming x-request-id correlation ID header unchanged', async () => {
    const app = await buildApp();
    const validCorrelationId = 'valid-req-id_123.test:col';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': validCorrelationId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(validCorrelationId);
  });

  it('should reject invalid or unbounded incoming x-request-id headers and generate a secure UUIDv4 fallback', async () => {
    const app = await buildApp();
    const invalidCorrelationId = 'malicious<script>alert(1)</script> or spaces exceed limit 1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': invalidCorrelationId,
      },
    });

    expect(response.statusCode).toBe(200);
    const assignedId = response.headers['x-request-id'];
    expect(assignedId).toBeDefined();
    expect(assignedId).not.toBe(invalidCorrelationId);
    expect(UUID_V4_REGEX.test(assignedId as string)).toBe(true);
  });

  it('should generate a secure UUIDv4 request ID when x-request-id header is omitted', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const assignedId = response.headers['x-request-id'];
    expect(assignedId).toBeDefined();
    expect(UUID_V4_REGEX.test(assignedId as string)).toBe(true);
  });

  it('should capture and verify real Fastify request JSON log output containing correlationId during route execution', async () => {
    const logChunks: string[] = [];
    const writableStream = new Writable({
      write(chunk, encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger(writableStream);
    const app = await buildApp(testLogger);
    const testCorrelationId = 'fastify-request-log-test-id-777';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': testCorrelationId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(logChunks.length).toBeGreaterThan(0);

    const parsedLogs = logChunks.map((chunk) => {
      try {
        return JSON.parse(chunk);
      } catch {
        return null;
      }
    }).filter(Boolean);

    const healthLog = parsedLogs.find((log) => log.msg === 'Health check accessed');
    expect(healthLog).toBeDefined();
    expect(healthLog).toHaveProperty('correlationId', testCorrelationId);
  });
});
