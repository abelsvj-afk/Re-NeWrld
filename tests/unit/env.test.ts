import { describe, it, expect } from 'vitest';
import { validateEnv, envSchema } from '../../src/config/env.js';

describe('Environment Configuration & Validation', () => {
  it('should validate and parse valid environment variables', () => {
    const input = {
      APP_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: '3000',
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/rene_wrld',
    };

    const config = validateEnv(input);
    expect(config).toEqual({
      APP_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: 3000,
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/rene_wrld',
    });
  });

  it('should use default values when optional variables are omitted', () => {
    const input = {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/rene_wrld',
    };
    const config = validateEnv(input);
    expect(config).toEqual({
      APP_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 8080,
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/rene_wrld',
    });
  });

  it('should throw an error for invalid environment variables without exposing raw values', () => {
    const input = {
      APP_ENV: 'invalid-env',
      LOG_LEVEL: 'verbose',
      PORT: 'not-a-number',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/rene_wrld',
    };

    try {
      validateEnv(input);
      expect.fail('Expected validateEnv to throw');
    } catch (err: any) {
      expect(err.message).toMatch(/Invalid environment variables configuration/);
      // Verify that validation error message reports structural error formatting (field errors)
      // and explicitly does NOT leak unvalidated raw arbitrary plaintext values or secrets.
      expect(err.message).toContain('APP_ENV');
      expect(err.message).toContain('LOG_LEVEL');
      expect(err.message).toContain('PORT');
      expect(err.message).not.toContain('invalid-env');
      expect(err.message).not.toContain('verbose');
      expect(err.message).not.toContain('not-a-number');
    }
  });

  it('should reject invalid PostgreSQL URL in DATABASE_URL without exposing raw values', () => {
    const input = {
      DATABASE_URL: 'mysql://user:secretpass@localhost:3306/db',
    };

    try {
      validateEnv(input);
      expect.fail('Expected validateEnv to throw');
    } catch (err: any) {
      expect(err.message).toMatch(/Invalid environment variables configuration/);
      expect(err.message).toContain('DATABASE_URL');
      expect(err.message).not.toContain('mysql://user:secretpass@localhost:3306/db');
    }
  });

  it('should reject DATABASE_URL with invalid port number', () => {
    const input = {
      DATABASE_URL: 'postgresql://localhost:99999/db',
    };

    try {
      validateEnv(input);
      expect.fail('Expected validateEnv to throw');
    } catch (err: any) {
      expect(err.message).toMatch(/Invalid environment variables configuration/);
      expect(err.message).toContain('DATABASE_URL');
    }
  });
});
