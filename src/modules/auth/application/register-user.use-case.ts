import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import { User } from '../domain/entities/user.entity.js';
import { UserId } from '../domain/value-objects/user-id.value-object.js';
import { Email } from '../domain/value-objects/email.value-object.js';
import { UserRole } from '../domain/value-objects/role.value-object.js';
import { PasswordService } from '../infrastructure/services/password.service.js';
import { ConflictError } from '../../../shared/http/http.errors.js';
import crypto from 'node:crypto';

export interface RegisterUserCommand {
  email: string;
  password: string;
  role: 'creator' | 'reader';
}

export interface RegisteredUser {
  id: string;
  email: string;
  role: 'creator' | 'reader';
  createdAt: Date;
}

export class RegisterUserUseCase {
  constructor(
    private readonly authRepository: AuthRepositoryPort,
    private readonly passwordService: PasswordService
  ) {}

  public async execute(command: RegisterUserCommand): Promise<RegisteredUser> {
    const email = new Email(command.email);

    const existing = await this.authRepository.findByEmail(email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const passwordHash = await this.passwordService.hashPassword(command.password);
    const user = User.create({
      userId: new UserId(crypto.randomUUID()),
      email,
      passwordHash,
      role: new UserRole(command.role),
    });

    await this.authRepository.save(user);

    return {
      id: user.getUserId().getValue(),
      email: user.getEmail().getValue(),
      role: user.getRole().getValue(),
      createdAt: user.getCreatedAt(),
    };
  }
}
