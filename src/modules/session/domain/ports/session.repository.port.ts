import type pkg from 'pg';
import { ReaderSession } from '../entities/reader-session.entity.js';
import { SessionId } from '../value-objects/session-id.value-object.js';
import { UserId } from '../../../auth/domain/value-objects/user-id.value-object.js';

/**
 * Persistence port for reader sessions (Task F1a).
 *
 * The optional transaction client follows the `WorldRepositoryPort`
 * convention: F2a's atomic state+timeline persistence will pass the
 * transaction client; callers without a transaction use a pooled connection.
 */
export interface SessionRepositoryPort {
  findById(sessionId: SessionId): Promise<ReaderSession | null>;
  findByReaderId(readerId: UserId): Promise<ReaderSession[]>;
  save(session: ReaderSession, tx?: pkg.PoolClient): Promise<void>;
}
