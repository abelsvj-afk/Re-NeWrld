import { FastifyRequest, FastifyReply } from 'fastify';
import { SessionVerifier, SessionInfo, SESSION_COOKIE_NAME } from '../../modules/auth/domain/ports/session.port.js';

export { SessionVerifier, SessionInfo, SESSION_COOKIE_NAME };

/**
 * Extracts the raw session token from the request's session cookie, if present.
 * Exported so route handlers (e.g. logout) can revoke the exact token presented.
 */
export function getRequestToken(request: FastifyRequest): string | null {
  return parseCookieHeader(request.headers.cookie, SESSION_COOKIE_NAME);
}

/**
 * Helper to parse cookies from the request headers.
 */
function parseCookieHeader(cookieHeader?: string, name: string = SESSION_COOKIE_NAME): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.trim().split('=');
    if (cookieName === name) {
      return rest.join('=');
    }
  }
  return null;
}

/**
 * Fastify preHandler hook to authenticate incoming requests via session cookie and SessionVerifier.
 * Attaches validated SessionInfo to request.user.
 * Returns 401 Unauthorized if session token is missing or invalid/expired.
 * Propagates unexpected verifier/database errors to Fastify's error handler (500) rather than incorrectly turning them into 401 responses.
 */
export function authenticate(verifier: SessionVerifier) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const cookieHeader = request.headers.cookie;
    const token = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);

    if (!token) {
      reply.code(401).send({ error: 'Unauthorized: Missing session token' });
      return;
    }

    const sessionInfo = await verifier(token);

    if (!sessionInfo) {
      reply.code(401).send({ error: 'Unauthorized: Invalid or expired session' });
      return;
    }

    request.user = sessionInfo;
  };
}

/**
 * Fastify preHandler guard ensuring the authenticated user has the Creator role.
 * Returns 401 if unauthenticated, or 403 Forbidden if user is not a creator.
 */
export function requireCreator() {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      reply.code(401).send({ error: 'Unauthorized: Authentication required' });
      return;
    }

    if (!request.user.role.isCreator()) {
      reply.code(403).send({ error: 'Forbidden: Creator permissions required' });
      return;
    }
  };
}

/**
 * Fastify preHandler guard ensuring the authenticated user has Reader permissions.
 * Creators also have reader permissions (they need to test-read books).
 * Returns 401 if unauthenticated, or 403 Forbidden if user is neither reader nor creator.
 */
export function requireReader() {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      reply.code(401).send({ error: 'Unauthorized: Authentication required' });
      return;
    }

    if (!request.user.role.isReader() && !request.user.role.isCreator()) {
      reply.code(403).send({ error: 'Forbidden: Reader permissions required' });
      return;
    }
  };
}

/**
 * Fastify preHandler guard ensuring the authenticated user has the specified role.
 */
export function requireRole(allowedRole: 'creator' | 'reader') {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      reply.code(401).send({ error: 'Unauthorized: Authentication required' });
      return;
    }

    if (request.user.role.getValue() !== allowedRole) {
      reply.code(403).send({ error: `Forbidden: ${allowedRole} permissions required` });
      return;
    }
  };
}
