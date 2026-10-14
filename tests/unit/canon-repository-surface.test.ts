import { describe, it, expect } from 'vitest';
import { PostgresCanonRepository } from '../../src/modules/world/infrastructure/persistence/postgres-canon.repository.js';

// Supplementary regression guard for Task E2c (refinement 2): the repository
// must stay append-only at the application layer. This does NOT prove the
// database guard works — the Testcontainers integration tests in
// tests/integration/canon-immutability.test.ts are authoritative.
//
// Note (F1b, ADR-014 D1): findLatestByWorldId is a read method — reads do not
// violate append-only. The guard remains: no update or delete methods.
// Note (G2c, ADR-015 D3 step 5): findById is likewise a read (pinned snapshot).
describe('PostgresCanonRepository append-only surface', () => {
  it('exposes only reads and inserts — no update or delete', () => {
    const methods = Object.getOwnPropertyNames(PostgresCanonRepository.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect(methods.sort()).toEqual(['findById', 'findLatestByWorldId', 'insert', 'nextVersion']);
  });
});
