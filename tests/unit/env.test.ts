import { describe, it, expect } from 'vitest';
import { validateEnv, envSchema } from '../../src/config/env.js';

describe('Environment Configuration & Validation', () => {
  it('should validate and parse valid environment variables', () => {
    const input = {
      APP_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: '3000',
      HOST: '127.0.0.1',
    };

    const config = validateEnv(input);
    expect(config).toEqual({
      APP_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: 3000,
      HOST: '127.0.0.1',
    });
  });

  it('should use default values when optional variables are omitted', () => {
    const input = {};
    const config = validateEnv(input);
    expect(config).toEqual({
      APP_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 8080,
      HOST: '0.0.0.0',
    });
  });

  it('should throw an error for invalid environment variables without exposing raw values', () => {
    const input = {
      APP_ENV: 'invalid-env',
      LOG_LEVEL: 'verbose',
      PORT: 'not-a-number',
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
});
