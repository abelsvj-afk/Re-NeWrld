import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { WorldNotFoundError, WorldValidationError } from '../../src/modules/world/domain/errors/world.errors.js';
import { World } from '../../src/modules/world/domain/entities/world.entity.js';
import { WorldId } from '../../src/modules/world/domain/value-objects/world-id.value-object.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';

describe('Error Handler & Logging Unit Tests', () => {
  it('should return 404 for WorldNotFoundError', async () => {
    const app = await buildApp();
    app.get('/test-404', async () => {
      throw new WorldNotFoundError('World not found');
    });

    const res = await app.inject({ method: 'GET', url: '/test-404' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('World not found');
  });

  it('should return 500 and hide error message for RangeError', async () => {
    const app = await buildApp();
    app.get('/test-range-error', async () => {
      throw new RangeError('Invalid time value');
    });

    const res = await app.inject({ method: 'GET', url: '/test-range-error' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe('Internal Server Error');
    expect(body.error).not.toContain('Invalid time value');
  });

  it('should return 503 generic message for error with statusCode 503 and custom message', async () => {
    const app = await buildApp();
    app.get('/test-503', async () => {
      const err = new Error('Invalid upstream format');
      (err as any).statusCode = 503;
      throw err;
    });

    const res = await app.inject({ method: 'GET', url: '/test-503' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.statusCode).toBe(503);
    expect(body.error).toBe('Internal Server Error');
    expect(body.error).not.toContain('Invalid upstream format');
  });

  it('should return 400 with validation issues for ZodError when World.create receives invalid metadata', async () => {
    const app = await buildApp();
    app.get('/test-world-zod', async () => {
      World.create({
        worldId: WorldId.generate(),
        creatorId: new UserId('123e4567-e89b-42d3-a456-426614174000'),
        title: 'Test',
        metadata: 'x' as any,
      });
    });

    const res = await app.inject({ method: 'GET', url: '/test-world-zod' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('Validation failed');
    expect(body.issues).toBeDefined();
    expect(body.received).toBeUndefined();
    expect(body.stack).toBeUndefined();
  });

  it('should log 4xx at warn and 5xx at error, ensuring warn not called on 5xx and error not called on 4xx', async () => {
    const mockLogger4xx = {
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    const app4xx = await buildApp(mockLogger4xx as any);
    mockLogger4xx.warn.mockClear();
    mockLogger4xx.error.mockClear();
    app4xx.get('/test-warn', async () => {
      throw new WorldNotFoundError();
    });

    await app4xx.inject({ method: 'GET', url: '/test-warn' });
    expect(mockLogger4xx.warn).toHaveBeenCalled();
    expect(mockLogger4xx.error).not.toHaveBeenCalled();

    const mockLogger5xx = {
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    const app5xx = await buildApp(mockLogger5xx as any);
    mockLogger5xx.warn.mockClear();
    mockLogger5xx.error.mockClear();
    app5xx.get('/test-err', async () => {
      throw new Error('boom');
    });

    await app5xx.inject({ method: 'GET', url: '/test-err' });
    expect(mockLogger5xx.error).toHaveBeenCalled();
    expect(mockLogger5xx.warn).not.toHaveBeenCalled();
  });
});
