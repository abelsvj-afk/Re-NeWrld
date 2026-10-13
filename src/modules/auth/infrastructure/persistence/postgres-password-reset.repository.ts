import { PasswordResetRepositoryPort } from '../../domain/ports/password-reset.repository.port.js';
import { PasswordResetToken } from '../../domain/entities/password-reset-token.entity.js';
import { UserId } from '../../domain/value-objects/user-id.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface PasswordResetTokenRow {
  token_hash: string;
  user_id: string;
  expires_at: string | Date;
  used_at: string | Date | null;
  created_at: string | Date;
}

export class PostgresPasswordResetRepository implements PasswordResetRepositoryPort {
  public async save(token: PasswordResetToken): Promise<void> {
    await query(
      `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        token.getTokenHash(),
        token.getUserId().getValue(),
        token.getExpiresAt(),
        token.getUsedAt(),
        token.getCreatedAt(),
      ]
    );
  }

  public async findByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    const result = await query<PasswordResetTokenRow>(
      `SELECT token_hash, user_id, expires_at, used_at, created_at
       FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRowToToken(result.rows[0]);
  }

  public async markUsed(tokenHash: string): Promise<void> {
    await query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL`,
      [tokenHash]
    );
  }

  public async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await query(
      `DELETE FROM password_reset_tokens WHERE expires_at <= $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }

  private mapRowToToken(row: PasswordResetTokenRow): PasswordResetToken {
    const token = PasswordResetToken.rehydrate({
      tokenHash: row.token_hash,
      userId: new UserId(row.user_id),
      expiresAt: new Date(row.expires_at),
      usedAt: row.used_at ? new Date(row.used_at) : null,
      createdAt: new Date(row.created_at),
    });
    return token;
  }
}
