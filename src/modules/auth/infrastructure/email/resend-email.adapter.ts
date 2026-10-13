import { Email } from '../../domain/value-objects/email.value-object.js';
import { EmailServicePort } from '../../application/ports/email-service.port.js';

export interface ResendEmailConfig {
  apiKey: string;
  from: string;
  baseUrl: string;
}

/**
 * Resend transactional-email adapter (ADR-012: free tier 3,000 emails/month).
 * Uses the plain REST API via global fetch — no SDK dependency.
 * The reset link carries the raw token in the query string; the Phase H
 * frontend extracts it and POSTs it in the request body (never logged).
 */
export class ResendEmailAdapter implements EmailServicePort {
  constructor(private readonly config: ResendEmailConfig) {}

  public async sendPasswordResetEmail(to: Email, rawToken: string): Promise<void> {
    const resetUrl = `${this.config.baseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(rawToken)}`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.from,
        to: to.getValue(),
        subject: 'Reset your Re:NeWrld password',
        text: [
          'You requested a password reset for your Re:NeWrld account.',
          '',
          `Reset your password here (expires in 15 minutes): ${resetUrl}`,
          '',
          "If you didn't request this, you can safely ignore this email.",
        ].join('\n'),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend email delivery failed (status ${response.status}): ${detail.slice(0, 200)}`);
    }
  }
}
