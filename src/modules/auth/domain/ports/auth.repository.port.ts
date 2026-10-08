import { User } from '../entities/user.entity.js';
import { UserId } from '../value-objects/user-id.value-object.js';
import { Email } from '../value-objects/email.value-object.js';

export interface AuthRepositoryPort {
  findById(userId: UserId): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  save(user: User): Promise<void>;
}
