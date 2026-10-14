import { createHash } from 'node:crypto';

/**
 * Idempotency request fingerprint (Task G2a, ADR-015 D3 step 2, B35).
 *
 * Canonicalization — exact byte sequence, no implementer discretion:
 *   canonical = '{"choiceId":"<choiceId>","expectedVersion":<n>,"readerId":"<readerId>","sessionId":"<sessionId>"}'
 * - `<choiceId>`, `<readerId>`, `<sessionId>`: UUIDs lowercased (input casing
 *   normalized before hashing).
 * - `<n>`: expectedVersion as a bare JSON integer — no quotes, no decimal
 *   point, no whitespace anywhere in the payload.
 * - Key order fixed: choiceId, expectedVersion, readerId, sessionId (alphabetical).
 * - Bytes: UTF-8 encoding of the canonical string.
 * - Fingerprint: lowercase hex of SHA-256 over those bytes.
 *
 * The readerId binds the key to the requesting reader (STOP-1 security fix):
 * the key namespace is per-reader, eliminating the cross-reader existence
 * oracle and making the stored response safe even if the ownership check
 * were bypassed. Reader identity comes from the authenticated session, never
 * from client input.
 *
 * One shared function used by the route handler and all test helpers.
 * Normative test vectors live in ADR-015 and in the unit test.
 */
export function computeRequestFingerprint(
  choiceId: string,
  expectedVersion: number,
  sessionId: string,
  readerId: string
): string {
  const canonical =
    `{"choiceId":"${choiceId.toLowerCase()}","expectedVersion":${expectedVersion},"readerId":"${readerId.toLowerCase()}","sessionId":"${sessionId.toLowerCase()}"}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
