import { AuthRepositoryPort } from '../../domain/ports/auth.repository.port.js';
import { User, UserProps } from '../../domain/entities/user.entity.js';
import { UserId } from '../../domain/value-objects/user-id.value-object.js';
import { Email } from '../../domain/value-objects/email.value-object.js';
import { UserRole } from '../../domain/value-objects/role.value-object.js';
import { query } from '../../../../shared/database/db.js';
import { ConflictError } from '../../../../shared/http/http.errors.js';

/** PostgreSQL unique-violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

function isPgUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

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

    try {
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
    } catch (error) {
      // Race with the findByEmail pre-check in RegisterUserUseCase: two
      // concurrent registrations can both pass it, and the loser violates the
      // users.email unique constraint. Surface it as 409, not 500.
      // (user_id conflicts are handled by ON CONFLICT above, so any 23505
      // here is the email.)
      if (isPgUniqueViolation(error)) {
        throw new ConflictError('An account with this email already exists');
      }
      throw error;
    }
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
