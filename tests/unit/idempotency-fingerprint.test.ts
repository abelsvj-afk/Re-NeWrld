import { describe, it, expect } from 'vitest';
import { computeRequestFingerprint } from '../../src/modules/session/domain/services/idempotency-fingerprint.js';

// STOP-1: fingerprint now binds readerId (per-reader key namespace).
const READER = '33333333-3333-4333-8333-333333333333';
const OTHER_READER = '44444444-4444-4434-8444-444444444444';

describe('computeRequestFingerprint (ADR-015 B35 normative vectors)', () => {
  it('vector 1', () => {
    expect(
      computeRequestFingerprint(
        '22222222-2222-4222-8222-222222222222',
        3,
        '11111111-1111-4111-8111-111111111111',
        READER
      )
    ).toBe('aa4f30ed886db1d84f3e9c2635412c9e9b321256f2643bd58b6b7afd94d3845d');
  });
  it('vector 2 (expectedVersion=42)', () => {
    expect(
      computeRequestFingerprint(
        '22222222-2222-4222-8222-222222222222',
        42,
        '11111111-1111-4111-8111-111111111111',
        READER
      )
    ).toBe('57efef3f3189105ac6fff3ea52397cc701daf92573ccf6c9268ce01cb2dd5b38');
  });
  it('vector 3 (uppercase normalized)', () => {
    expect(
      computeRequestFingerprint(
        'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
        3,
        '11111111-1111-4111-8111-111111111111',
        READER
      )
    ).toBe('1f3bb985fa0de866ce292ed65e404cb2edcfe1e4517f2d7bf365610d3bc37921');
  });
  it('is deterministic and sensitive to every field (incl. readerId)', () => {
    const a = computeRequestFingerprint('22222222-2222-4222-8222-222222222222', 3, '11111111-1111-4111-8111-111111111111', READER);
    expect(computeRequestFingerprint('22222222-2222-4222-8222-222222222222', 3, '11111111-1111-4111-8111-111111111111', READER)).toBe(a);
    expect(computeRequestFingerprint('22222222-2222-4222-8222-222222222223', 3, '11111111-1111-4111-8111-111111111111', READER)).not.toBe(a);
    expect(computeRequestFingerprint('22222222-2222-4222-8222-222222222222', 4, '11111111-1111-4111-8111-111111111111', READER)).not.toBe(a);
    expect(computeRequestFingerprint('22222222-2222-4222-8222-222222222222', 3, '11111111-1111-4111-8111-111111111112', READER)).not.toBe(a);
    // STOP-1: different reader → different fingerprint (per-reader namespace).
    expect(computeRequestFingerprint('22222222-2222-4222-8222-222222222222', 3, '11111111-1111-4111-8111-111111111111', OTHER_READER)).not.toBe(a);
  });
});
