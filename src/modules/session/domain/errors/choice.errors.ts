import { SessionError } from './session.errors.js';

/**
 * Choice-execution error taxonomy (Task G2b, ADR-015 D4 + B24/B37/B38).
 *
 * Each class maps to exactly one HTTP status. The route's error mapper must
 * preserve the distinction — a broad catch that collapses parse failures
 * into 422 would silently violate the D1a two-phase policy.
 */

/**
 * Marked-snapshot parse failure: unknown operator, malformed shape, or
 * non-finite operand in a snapshot that carries the v1 grammar marker.
 * Publish validation should have caught it — server-side invariant violation.
 * Maps to HTTP 500 (generic message to the client; diagnostics logged server-side).
 */
export class CanonInvariantError extends SessionError {
  constructor(message: string = 'Canon invariant violated') {
    super(message, 500);
  }
}

/**
 * Legacy fail-closed rejection: a condition/mutation payload from a snapshot
 * that predates G1 validation and does not parse as v1 grammar.
 * Maps to HTTP 422. Nothing is written.
 */
export class LegacyPayloadRejectedError extends SessionError {
  constructor(message: string = 'Legacy payload rejected') {
    super(message, 422);
  }
}

/**
 * Well-formed mutation that cannot apply to the current state
 * (missing/non-numeric inc target, non-boolean toggle, non-finite result…).
 * Maps to HTTP 422. Complete rollback, nothing written.
 */
export class MutationApplicationError extends SessionError {
  constructor(message: string = 'Mutation cannot be applied') {
    super(message, 422);
  }
}

/**
 * The mutation applier produced state that fails SessionStateSchema —
 * a server bug, not a canon or client problem. Thrown in memory before
 * any persistent write. Maps to HTTP 500.
 */
export class StateInvariantError extends SessionError {
  constructor(message: string = 'Computed state failed validation') {
    super(message, 500);
  }
}

/**
 * A stored idempotency response failed the response schema on replay.
 * Never served to the client. Maps to HTTP 500, logged server-side.
 */
export class StoredResponseCorruptError extends SessionError {
  constructor(message: string = 'Stored response failed validation') {
    super(message, 500);
  }
}

/**
 * The requested choice id does not exist in the session's pinned canon.
 * (Existence is checked pre-transaction — canon is immutable. Scene
 * attachment is a separate in-transaction check.) Maps to HTTP 404.
 */
export class ChoiceNotFoundError extends SessionError {
  constructor(message: string = 'Choice not found') {
    super(message, 404);
  }
}

/**
 * The selected choice is not attached to the session's current scene
 * (checked in-transaction, after the authoritative version check — B30).
 * Maps to HTTP 422.
 */
export class ChoiceNotAttachedError extends SessionError {
  constructor(message: string = 'Choice is not available in the current scene') {
    super(message, 422);
  }
}

/**
 * The session is in a terminal state (`completed` or `abandoned`) and
 * cannot accept a choice submission. Terminal states are absorbing.
 * Maps to HTTP 409 (ADR-015 D3 steps 4/9; distinct from 400 — the request
 * is well-formed but conflicts with the session's lifecycle state).
 */
export class SessionTerminalError extends SessionError {
  constructor(message: string = 'Session is in a terminal state') {
    super(message, 409);
  }
}

/**
 * An idempotency key was reused with a different request fingerprint or
 * for a different session. Keys are globally unique; a stored key replays
 * only for its original session + fingerprint. Maps to HTTP 409.
 */
export class IdempotencyConflictError extends SessionError {
  constructor(message: string = 'Idempotency key conflict') {
    super(message, 409);
  }
}

/**
 * The selected choice's conditions evaluated to false against the locked
 * state, or a legacy unparsable condition made it unavailable (fail closed).
 * Maps to HTTP 422.
 */
export class ChoiceNotAvailableError extends SessionError {
  constructor(message: string = 'Choice is not currently available') {
    super(message, 422);
  }
}
