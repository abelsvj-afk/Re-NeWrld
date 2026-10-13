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
