import { AuthRepositoryPort } from '../../domain/ports/auth.repository.port.js';
import { User, UserProps } from '../../domain/entities/user.entity.js';
import { UserId } from '../../domain/value-objects/user-id.value-object.js';
import { Email } from '../../domain/value-objects/email.value-object.js';
import { UserRole } from '../../domain/value-objects/role.value-object.js';
import { query } from '../../../../shared/database/db.js';

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export class PostgresAuthRepository implements AuthRepositoryPort {
  public async findById(userId: UserId): Promise<User | null> {
    const result = await query<UserRow>(
      `SELECT user_id, email, password_hash, role, created_at, updated_at
       FROM users WHERE user_id = $1`,
      [userId.getValue()]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRowToUser(result.rows[0]);
  }

  public async findByEmail(email: Email): Promise<User | null> {
    const result = await query<UserRow>(
      `SELECT user_id, email, password_hash, role, created_at, updated_at
       FROM users WHERE email = $1`,
      [email.getValue()]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRowToUser(result.rows[0]);
  }

  public async save(user: User): Promise<void> {
    const userId = user.getUserId().getValue();
    const email = user.getEmail().getValue();
    const passwordHash = user.getPasswordHash();
    const role = user.getRole().getValue();
    const createdAt = user.getCreatedAt();
    const updatedAt = user.getUpdatedAt();

    await query(
      `INSERT INTO users (user_id, email, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at`,
      [userId, email, passwordHash, role, createdAt, updatedAt]
    );
  }

  private mapRowToUser(row: UserRow): User {
    const props: UserProps = {
      userId: new UserId(row.user_id),
      email: new Email(row.email),
      passwordHash: row.password_hash,
      role: new UserRole(row.role),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    return User.reconstitute(props);
  }
}
