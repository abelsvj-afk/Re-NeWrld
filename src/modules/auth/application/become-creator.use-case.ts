import { AuthRepositoryPort } from '../domain/ports/auth.repository.port.js';
import { UserId } from '../domain/value-objects/user-id.value-object.js';
import { UserRole } from '../domain/value-objects/role.value-object.js';
import { NotFoundError } from '../../../shared/http/http.errors.js';

export interface BecomeCreatorResult {
  id: string;
  email: string;
  role: 'creator' | 'reader';
}

/**
 * Self-serve upgrade: any authenticated reader can become a creator.
 * Idempotent — already-creators get a 200 with their current role.
 * Takes effect immediately: sessions resolve the role from the users
 * table on every request, so no re-login is required.
 */
export class BecomeCreatorUseCase {
  constructor(private readonly authRepository: AuthRepositoryPort) {}

  public async execute(userId: UserId): Promise<BecomeCreatorResult> {
    const user = await this.authRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('Account not found');
    }

    if (!user.getRole().isCreator()) {
      user.updateRole(new UserRole('creator'));
      await this.authRepository.save(user);
    }

    return {
      id: user.getUserId().getValue(),
      email: user.getEmail().getValue(),
      role: user.getRole().getValue(),
    };
  }
}
