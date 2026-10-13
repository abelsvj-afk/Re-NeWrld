import crypto from 'node:crypto';
import { query } from '../../../../shared/database/db.js';
import { UserId } from '../../domain/value-objects/user-id.value-object.js';
import { UserRole } from '../../domain/value-objects/role.value-object.js';
import { Email } from '../../domain/value-objects/email.value-object.js';
import { SessionInfo, SessionVerifier, SESSION_COOKIE_NAME } from '../../domain/ports/session.port.js';

export { SessionInfo, SessionVerifier, SESSION_COOKIE_NAME };

interface AuthSessionRow {
  token_hash: string;
  user_id: string;
  email: string;
  role: string;
  expires_at: string | Date;
  created_at: string | Date;
}

export { cookieSecureForEnv } from '../../domain/ports/session.port.js';

export class SessionService {
  private static readonly DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Helper to validate token format (length and base64url charset).
   */
  private isValidTokenFormat(token: unknown): token is string {
    if (!token || typeof token !== 'string') {
      return false;
    }
    const trimmed = token.trim();
    if (trimmed.length < 32 || trimmed.length > 64) {
      return false;
    }
    return /^[A-Za-z0-9_-]+$/.test(trimmed);
  }

  /**
   * Computes SHA-256 hash of a session token.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  /**
   * Creates a new persistent server-side session for the given user, storing only the SHA-256 hash.
   */
  public async createSession(userId: UserId, durationMs: number = SessionService.DEFAULT_SESSION_DURATION_MS): Promise<{ sessionId: string; expiresAt: Date }> {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + durationMs);

    await query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, userId.getValue(), expiresAt]
    );

    return {
      sessionId: rawToken,
      expiresAt,
    };
  }

  /**
   * Validates a session token against the database by hashing it and looking it up, ensuring it exists and has not expired.
   * Returns null if token format is malformed or invalid/expired. Database errors propagate as operational errors.
   */
  public async validateSession(sessionId: string): Promise<SessionInfo | null> {
    if (!this.isValidTokenFormat(sessionId)) {
      return null;
    }

    const tokenHash = this.hashToken(sessionId);

    const result = await query<AuthSessionRow>(
      `SELECT s.token_hash, s.user_id, u.email, u.role, s.expires_at, s.created_at
       FROM auth_sessions s
       JOIN users u ON s.user_id = u.user_id
       WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      userId: new UserId(row.user_id),
      email: new Email(row.email),
      role: new UserRole(row.role),
      expiresAt: new Date(row.expires_at),
    };
  }

  /**
   * Immediately revokes a session by deleting its hash from the server-side store.
   * Malformed tokens result in a safe no-op without throwing. Valid-format tokens propagate database infrastructure errors.
   */
  public async revokeSession(sessionId: string): Promise<void> {
    if (!this.isValidTokenFormat(sessionId)) {
      return;
    }

    const tokenHash = this.hashToken(sessionId);

    await query(
      `DELETE FROM auth_sessions WHERE token_hash = $1`,
      [tokenHash]
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
   * Deletes sessions past their expiry. Sessions are 7-day TTL with no
   * automatic cleanup otherwise, so this keeps auth_sessions from growing
   * unbounded. Returns the number of rows removed.
   */
  public async cleanupExpiredSessions(): Promise<number> {
    const result = await query(
      `DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP`
    );
    return result.rowCount ?? 0;
  }

  /**
   * Returns secure cookie configuration options adhering to ADR-004, taking secure as a parameter and adding maxAge in seconds from expiry.
   */
  public getCookieOptions(secure: boolean, expiresAt?: Date) {
    const options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: string;
      maxAge?: number;
    } = {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
    };

    if (expiresAt) {
      const maxAgeSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      options.maxAge = Math.max(0, maxAgeSeconds);
    }

    return options;
  }

  /**
   * Exposes a SessionVerifier function for injection (e.g., into C3 middleware).
   */
  public getVerifier(): SessionVerifier {
    return (token: string) => this.validateSession(token);
  }
}
