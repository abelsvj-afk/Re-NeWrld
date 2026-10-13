import { PasswordResetToken } from '../entities/password-reset-token.entity.js';

export interface PasswordResetRepositoryPort {
  save(token: PasswordResetToken): Promise<void>;
  findByHash(tokenHash: string): Promise<PasswordResetToken | null>;
  markUsed(tokenHash: string): Promise<void>;
  /** Deletes expired tokens. Returns the number of rows removed. */
  deleteExpired(now?: Date): Promise<number>;
}
