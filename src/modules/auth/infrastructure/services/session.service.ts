import { query } from '../../../../shared/database/db.js';
import { UserId } from '../../domain/value-objects/user-id.value-object.js';
import { UserRole } from '../../domain/value-objects/role.value-object.js';
import { Email } from '../../domain/value-objects/email.value-object.js';

export interface SessionInfo {
  sessionId: string;
  userId: UserId;
  email: Email;
  role: UserRole;
  expiresAt: Date;
}

interface AuthSessionRow {
  session_id: string;
  user_id: string;
  email: string;
  role: string;
  expires_at: string | Date;
  created_at: string | Date;
}

export const SESSION_COOKIE_NAME = 'rene_session_id';

export class SessionService {
  private static readonly DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Creates a new persistent server-side session for the given user.
   */
  public async createSession(userId: UserId, durationMs: number = SessionService.DEFAULT_SESSION_DURATION_MS): Promise<{ sessionId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + durationMs);

    const result = await query<{ session_id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at)
       VALUES ($1, $2)
       RETURNING session_id`,
      [userId.getValue(), expiresAt]
    );

    const sessionId = result.rows[0].session_id;

    return {
      sessionId,
      expiresAt,
    };
  }

  /**
   * Validates a session ID against the database, ensuring it exists and has not expired.
   * Returns user and session details if valid, or null if invalid/expired.
   */
  public async validateSession(sessionId: string): Promise<SessionInfo | null> {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return null;
    }

    const result = await query<AuthSessionRow>(
      `SELECT s.session_id, s.user_id, u.email, u.role, s.expires_at, s.created_at
       FROM auth_sessions s
       JOIN users u ON s.user_id = u.user_id
       WHERE s.session_id = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
      [sessionId.trim()]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      sessionId: row.session_id,
      userId: new UserId(row.user_id),
      email: new Email(row.email),
      role: new UserRole(row.role),
      expiresAt: new Date(row.expires_at),
    };
  }

  /**
   * Immediately revokes a session by deleting it from the server-side store.
   */
  public async revokeSession(sessionId: string): Promise<void> {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }

    await query(
      `DELETE FROM auth_sessions WHERE session_id = $1`,
      [sessionId.trim()]
    );
  }

  /**
   * Revokes all active sessions for a given user (e.g., password reset or security revocation).
   */
  public async revokeAllUserSessions(userId: UserId): Promise<void> {
    await query(
      `DELETE FROM auth_sessions WHERE user_id = $1`,
      [userId.getValue()]
    );
  }

  /**
   * Returns secure cookie configuration options adhering to ADR-004 (HttpOnly, SameSite=Strict, Secure).
   */
  public getCookieOptions(isProduction: boolean = process.env.APP_ENV === 'production') {
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict' as const,
      path: '/',
    };
  }
}
