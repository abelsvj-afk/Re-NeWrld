import { SessionRepositoryPort } from '../domain/ports/session.repository.port.js';
import { ReaderSession } from '../domain/entities/reader-session.entity.js';
import { SessionId } from '../domain/value-objects/session-id.value-object.js';
import { UserId } from '../../auth/domain/value-objects/user-id.value-object.js';
import { SessionNotFoundError } from '../domain/errors/session.errors.js';

export interface GetReaderSessionCommand {
  sessionId: SessionId;
  /**
   * Derived exclusively from the authenticated request at the route layer —
   * never accepted from client input, so ownership cannot be spoofed.
   */
  readerId: UserId;
}

export interface GetReaderSessionResult {
  session: ReaderSession;
}

/**
 * Reads one reader session (Task F1c). The 404-not-403 ownership check lives
 * here — in exactly one use-case boundary — so routes stay thin and no
 * authorization logic is duplicated: a missing session and a session owned
 * by another reader produce the same 404 (no existence oracle).
 */
export class GetReaderSessionUseCase {
  constructor(private readonly sessions: SessionRepositoryPort) {}

  public async execute(command: GetReaderSessionCommand): Promise<GetReaderSessionResult> {
    const session = await this.sessions.findById(command.sessionId);
    if (session === null || !session.getReaderId().equals(command.readerId)) {
      throw new SessionNotFoundError();
    }
    return { session };
  }
}
