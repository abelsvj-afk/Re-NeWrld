import { UserId } from '../value-objects/user-id.value-object.js';
import { Email } from '../value-objects/email.value-object.js';
import { UserRole } from '../value-objects/role.value-object.js';

export const SESSION_COOKIE_NAME = 'rene_session_id';

export interface SessionInfo {
  userId: UserId;
  email: Email;
  role: UserRole;
  expiresAt: Date;
}

export type SessionVerifier = (token: string) => Promise<SessionInfo | null>;

export function cookieSecureForEnv(appEnv: string): boolean {
  const normalized = (appEnv || '').trim().toLowerCase();
  return normalized !== 'development' && normalized !== 'test';
}

/**
 * Structural port for session lifecycle operations. SessionService implements this;
 * tests and alternative transports can substitute fakes.
 */
export interface SessionServicePort {
  createSession(userId: UserId, durationMs?: number): Promise<{ sessionId: string; expiresAt: Date }>;
  validateSession(token: string): Promise<SessionInfo | null>;
  revokeSession(token: string): Promise<void>;
  getCookieOptions(secure: boolean, expiresAt?: Date): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict';
    path: string;
    maxAge?: number;
  };
  getVerifier(): SessionVerifier;
}
