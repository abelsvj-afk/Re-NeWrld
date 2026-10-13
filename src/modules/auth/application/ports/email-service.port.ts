import { Email } from '../../domain/value-objects/email.value-object.js';

/**
 * Outbound email delivery (password reset links, and later: welcome emails,
 * notifications). The provider (Resend, console-log for dev/test) is chosen
 * in infrastructure; application code only knows this contract (ADR-012).
 */
export interface EmailServicePort {
  /**
   * Sends a password-reset email containing a single-use link embedding the
   * raw token. Implementations build the link from their configured base URL;
   * the raw token is never persisted or logged by the application.
   */
  sendPasswordResetEmail(to: Email, rawToken: string): Promise<void>;
}
