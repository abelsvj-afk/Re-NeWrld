# CHANGELOG — Re:NeWrld

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased]

### Added
- Initialized repository structure with Project Growth v1.1.0 governance foundation.
- **Task A2**: Implemented centralized Zod environment validation (`src/config/env.ts`) enforcing strict fail-fast startup checks and comprehensive unit tests (`tests/unit/env.test.ts`).
- **Task A3**: Configured Pino structured JSON logging (`src/shared/logger/pino.logger.ts`) with env-based log level (`env.LOG_LEVEL`), secret redaction, Fastify request ID correlation tracking (`x-request-id`), bounded validation of incoming request IDs, and unit tests (`tests/unit/logger.test.ts`).
- **Task B1**: Established PostgreSQL connection pool infrastructure (`src/shared/database/db.ts`) with `pg`, required PostgreSQL `DATABASE_URL` validation (no credentialed default), `PORT` integer constraint (1–65535), staging `APP_ENV` reconciliation, Node built-in `--env-file` support for development scripts, engines node constraint `>=20.6.0`, testcontainers integration tests (`tests/integration/database.test.ts`) exercising the real B1 pool, explicit failure on Docker/database unavailability unless intentional skip enabled (`SKIP_DB_TESTS=true`), and strengthened logger tests verifying `LOG_LEVEL`.
