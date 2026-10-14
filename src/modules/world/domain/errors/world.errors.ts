export class WorldError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class WorldNotFoundError extends WorldError {
  constructor(message: string = 'World not found') {
    super(message, 404);
  }
}

export class WorldValidationError extends WorldError {
  constructor(message: string) {
    super(message, 400);
  }
}

import type {
  GraphValidationError,
  DanglingReference,
  SemanticBlocker,
} from '../services/graph-validator.js';

export interface PublishingValidationReport {
  /** Blocking conditions that prevented publication. */
  blockers: Array<GraphValidationError | DanglingReference | SemanticBlocker>;
  /** Unreachable-scene warnings; preserved for the caller, never blockers. */
  warnings: string[];
}

/**
 * Thrown when a publish request is syntactically valid but the world's
 * draft graph fails the publishing-validation contract (Task E2a, ADR-013).
 * Maps to HTTP 422 (semantic failure), distinct from 400 (malformed
 * request). Carries the full validation report — every blocker and every
 * warning — so callers can diagnose without re-running validation.
 */
export class PublishingValidationError extends WorldError {
  public readonly report: PublishingValidationReport;

  constructor(report: PublishingValidationReport) {
    super(
      `World failed publishing validation with ${report.blockers.length} blocking error(s)`,
      422
    );
    this.report = report;
  }
}

/**
 * Thrown when the latest published canon snapshot for a world fails
 * `CanonDataSchema` validation on read (Task F1b, ADR-014 D1). The E2c
 * trigger makes snapshots immutable, so a corrupt latest snapshot means
 * deep data corruption or a schema version newer than this code understands.
 * Maps to HTTP 500 (server-side invariant violation). Never silently falls
 * back to an older snapshot version.
 */
export class CorruptCanonSnapshotError extends WorldError {
  constructor(worldId: string) {
    super(`Published canon snapshot for world ${worldId} failed schema validation`, 500);
  }
}
