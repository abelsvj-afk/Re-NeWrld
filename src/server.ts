import { buildApp } from './app.js';
import { env } from './config/env.js';
import { SessionService } from './modules/auth/infrastructure/services/session.service.js';

// Hourly cleanup of expired sessions (keeps auth_sessions from growing
// unbounded). In-process interval — not the Phase L BullMQ queue, which is
// reserved for simulation/analytics workloads.
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function startSessionJanitor(app: { log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void } }): void {
  const sessionService = new SessionService();

  const run = async () => {
    try {
      const removed = await sessionService.cleanupExpiredSessions();
      if (removed > 0) {
        app.log.info({ removed }, 'Cleaned up expired sessions');
      }
    } catch (err) {
      app.log.error({ err }, 'Expired session cleanup failed');
    }
  };

  void run();
  const timer = setInterval(run, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
}

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
    startSessionJanitor(app);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
