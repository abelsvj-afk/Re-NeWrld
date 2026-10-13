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
