import crypto from 'node:crypto';
import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import { PasswordResetRepositoryPort } from '../domain/ports/password-reset.repository.port.js';
import { PasswordResetToken } from '../domain/entities/password-reset-token.entity.js';
import { Email } from '../domain/value-objects/email.value-object.js';
import { EmailServicePort } from './ports/email-service.port.js';
import { PasswordService } from '../infrastructure/services/password.service.js';

export interface RequestPasswordResetCommand {
  email: string;
}

/**
 * Issues a password-reset token and emails the reset link.
 *
 * Anti-enumeration: the result is identical whether or not the email is
 * registered. For unknown emails we burn comparable work (a dummy scrypt
 * hash) so the timing oracle is no better than the strict rate limit already
 * allows (ADR-012).
 */
export class RequestPasswordResetUseCase {
  constructor(
    private readonly authRepository: AuthRepositoryPort,
    private readonly resetRepository: PasswordResetRepositoryPort,
    private readonly emailService: EmailServicePort,
    private readonly passwordService: PasswordService
  ) {}

  public async execute(command: RequestPasswordResetCommand): Promise<void> {
    const email = new Email(command.email);
    const user = await this.authRepository.findByEmail(email);

    if (!user) {
      // Burn ~equal work to the email-send path below so unknown emails don't
      // resolve noticeably faster. Never reveals registration status.
      await this.passwordService.hashPassword(crypto.randomBytes(16).toString('hex'));
      return;
    }

    const { rawToken, token } = PasswordResetToken.issue(user.getUserId());
    await this.resetRepository.save(token);
    await this.emailService.sendPasswordResetEmail(email, rawToken);
  }
}
