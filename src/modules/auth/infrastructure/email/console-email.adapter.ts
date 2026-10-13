import { Email } from '../../domain/value-objects/email.value-object.js';
import { EmailServicePort } from '../../application/ports/email-service.port.js';
import { logger } from '../../../../shared/logger/pino.logger.js';

/**
 * Development/test email adapter: logs the reset link instead of sending.
 * Default EMAIL_PROVIDER (ADR-012). Never use in production — the point of
 * the reset email is an out-of-band channel the operator cannot see.
 */
export class ConsoleEmailAdapter implements EmailServicePort {
  constructor(private readonly baseUrl: string) {}

  public async sendPasswordResetEmail(to: Email, rawToken: string): Promise<void> {
    const resetUrl = `${this.baseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(rawToken)}`;
    logger.info({ to: to.getValue(), resetUrl }, '[console-email] Password reset link (dev only)');
  }
}
