export class SessionError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(message: string = 'Reader session not found') {
    super(message, 404);
  }
}

export class SessionValidationError extends SessionError {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * Thrown when a session lifecycle transition or mutation is attempted from a
 * state that does not permit it — e.g. completing an already-completed
 * session, or mutating a terminal session. Terminal states are absorbing:
 * they never transition back to active, silently or otherwise.
 * Maps to HTTP 400 (malformed state-changing request), distinct from 409
 * (optimistic-locking version conflict, Phase F2a).
 */
export class IllegalSessionTransitionError extends SessionError {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * Thrown when a state-changing persistence operation is attempted with a
 * stale expected version (Task F2a, ADR-014 D4). Maps to HTTP 409. Carries
 * `report.currentVersion` so the client can re-synchronize — surfaced by the
 * existing 4xx `report` envelope (E2b precedent; no handler changes).
 */
export class SessionVersionConflictError extends SessionError {
  public readonly report: { currentVersion: number };

  constructor(currentVersion: number) {
    super(
      `Session version conflict: expected version does not match current version ${currentVersion}`,
      409
    );
    this.report = { currentVersion };
  }
}

/**
 * Thrown when session initialization is requested for a world that has no
 * published canon snapshot. The world exists, but the precondition "has a
 * published snapshot" fails — hence 409 Conflict, not 404.
 */
export class NoPublishedSnapshotError extends SessionError {
  constructor(message: string = 'World has no published snapshot') {
    super(message, 409);
  }
}
