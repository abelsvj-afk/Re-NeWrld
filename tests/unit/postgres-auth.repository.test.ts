import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../src/shared/database/db.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/shared/database/db.js';
import { PostgresAuthRepository } from '../../src/modules/auth/infrastructure/persistence/postgres-auth.repository.js';
import { ConflictError } from '../../src/shared/http/http.errors.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';

const mockedQuery = vi.mocked(query);

function makeUser(email = 'racer@example.com'): User {
  return User.create({
    userId: new UserId(crypto.randomUUID()),
    email: new Email(email),
    passwordHash: 'hashed',
    role: new UserRole('reader'),
  });
}

function pgUniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    code: '23505',
    constraint: 'users_email_key',
  });
}

describe('PostgresAuthRepository.save', () => {
  let repository: PostgresAuthRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    repository = new PostgresAuthRepository();
  });

  it('maps a duplicate-email unique violation to ConflictError (409)', async () => {
    mockedQuery.mockRejectedValueOnce(pgUniqueViolation());

    const promise = repository.save(makeUser('taken@example.com'));

    await expect(promise).rejects.toThrow(ConflictError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 409,
      message: 'An account with this email already exists',
    });
  });

  it('rethrows non-unique database errors unchanged', async () => {
    const dbError = Object.assign(new Error('connection terminated'), { code: '57P01' });
    mockedQuery.mockRejectedValueOnce(dbError);

    await expect(repository.save(makeUser())).rejects.toBe(dbError);
  });

  it('resolves when the insert succeeds', async () => {
    mockedQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);

    await expect(repository.save(makeUser())).resolves.toBeUndefined();
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});
