import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import { PasswordResetRepositoryPort } from '../domain/ports/password-reset.repository.port.js';
import { PasswordResetToken } from '../domain/entities/password-reset-token.entity.js';
import { SessionServicePort } from '../domain/ports/session.port.js';
import { PasswordService } from '../infrastructure/services/password.service.js';
import { BadRequestError } from '../../../shared/http/http.errors.js';

export interface ConfirmPasswordResetCommand {
  token: string;
  newPassword: string;
}

/** Raw tokens are 32 bytes rendered base64url (43 chars). Reject garbage early. */
const RAW_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const GENERIC_FAILURE = 'Invalid or expired reset token';

/**
 * Consumes a reset token: sets the new password, marks the token used, and
 * revokes every session for the account (a password reset implies the old
 * credentials may be compromised).
 */
export class ConfirmPasswordResetUseCase {
  constructor(
    private readonly authRepository: AuthRepositoryPort,
    private readonly resetRepository: PasswordResetRepositoryPort,
    private readonly sessionService: SessionServicePort,
    private readonly passwordService: PasswordService
  ) {}

  public async execute(command: ConfirmPasswordResetCommand): Promise<void> {
    const rawToken = (command.token || '').trim();
    if (!RAW_TOKEN_FORMAT.test(rawToken)) {
      throw new BadRequestError(GENERIC_FAILURE);
    }

    const tokenHash = PasswordResetToken.hashRawToken(rawToken);
    const token = await this.resetRepository.findByHash(tokenHash);
    if (!token || !token.isConsumable()) {
      // Same message for missing/used/expired: no oracle for token validity.
      throw new BadRequestError(GENERIC_FAILURE);
    }

    const user = await this.authRepository.findById(token.getUserId());
    if (!user) {
      throw new BadRequestError(GENERIC_FAILURE);
    }

    const newHash = await this.passwordService.hashPassword(command.newPassword);
    user.updatePasswordHash(newHash);
    await this.authRepository.save(user);

    token.markUsed();
    await this.resetRepository.markUsed(tokenHash);

    await this.sessionService.revokeAllUserSessions(user.getUserId());
  }
}
