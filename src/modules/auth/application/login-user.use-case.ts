import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import { SessionServicePort } from '../domain/ports/session.port.js';
import { Email } from '../domain/value-objects/email.value-object.js';
import { PasswordService } from '../infrastructure/services/password.service.js';
import { UnauthorizedError } from '../../../shared/http/http.errors.js';

export interface LoginUserCommand {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: {
    id: string;
    email: string;
    role: 'creator' | 'reader';
  };
}

// Generic message used for every login failure so attackers cannot
// distinguish "unknown email" from "wrong password" (no user enumeration).
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// Valid-format scrypt hash of a throwaway value. When the email is unknown we
// still burn ~100ms of scrypt work verifying against this dummy hash, so
// "unknown email" and "wrong password" are indistinguishable by timing too.
const DUMMY_HASH =
  'scrypt$16384$8$1$4d095cb0b759d8454f2b133e0a2f2077$947c6a80b8159ff83ed829e78f838e72f1fe9fcbc1ba09a80cda033d20e6071cc310c80ccd2ce4a7c5858f4eb6d503859f4c8293e0d659c8d34919c0261b29bb';

export class LoginUserUseCase {
  constructor(
    private readonly authRepository: AuthRepositoryPort,
    private readonly sessionService: SessionServicePort,
    private readonly passwordService: PasswordService
  ) {}

  public async execute(command: LoginUserCommand): Promise<LoginResult> {
    let email: Email;
    try {
      email = new Email(command.email);
    } catch {
      throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const user = await this.authRepository.findByEmail(email);
    if (!user) {
      // Burn the same scrypt work as a real password check so the timing
      // doesn't reveal whether the email exists. Result discarded.
      await this.passwordService.verifyPassword(command.password, DUMMY_HASH);
      throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const valid = await this.passwordService.verifyPassword(command.password, user.getPasswordHash());
    if (!valid) {
      throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const { sessionId, expiresAt } = await this.sessionService.createSession(user.getUserId());

    return {
      token: sessionId,
      expiresAt,
      user: {
        id: user.getUserId().getValue(),
        email: user.getEmail().getValue(),
        role: user.getRole().getValue(),
      },
    };
  }
}
