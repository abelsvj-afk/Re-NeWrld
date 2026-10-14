import { defineConfig } from 'vitest/config';

// STOP-2: integration tests load database config from .env.test (gitignored).
// Unit tests use a dummy URL via the package.json script and never connect.
if (process.env.APP_ENV === 'test') {
  try {
    process.loadEnvFile('.env.test');
  } catch {
    // .env.test is optional — CI may inject via environment instead.
  }
}

export default defineConfig({
  test: {
    // No global setup; integration tests manage their own containers/DB.
  },
});
