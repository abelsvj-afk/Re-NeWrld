import 'fastify';
import { SessionInfo } from '../modules/auth/infrastructure/services/session.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionInfo;
  }
}
