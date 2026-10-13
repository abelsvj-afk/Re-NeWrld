import { describe, it, expect } from 'vitest';
import {
  SessionError,
  SessionVersionConflictError,
} from '../../src/modules/session/domain/errors/session.errors.js';

// Unit coverage for the F2a conflict contract (ADR-014 D4, §10.1): a stale
// expected version surfaces as HTTP 409 carrying the current version in the
// 4xx `report` envelope — no handler changes needed. The persistence
// behavior itself is covered by the (UNVERIFIED) Testcontainers integration
// tests in tests/integration/session-persistence.test.ts.
describe('SessionVersionConflictError (F2a)', () => {
  it('maps to 409 with the current version in report', () => {
    const err = new SessionVersionConflictError(7);
    expect(err).toBeInstanceOf(SessionError);
    expect(err.statusCode).toBe(409);
    expect(err.report).toEqual({ currentVersion: 7 });
    expect(err.message).toContain('7');
  });
});
