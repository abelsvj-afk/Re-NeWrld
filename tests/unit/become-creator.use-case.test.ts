import { describe, it, expect, vi } from 'vitest';
import { BecomeCreatorUseCase } from '../../src/modules/auth/application/become-creator.use-case.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import crypto from 'node:crypto';

function makeUser(role: 'creator' | 'reader') {
  return User.create({
    userId: new UserId(crypto.randomUUID()),
    email: new Email('test@example.com'),
    passwordHash: 'hashed',
    role: new UserRole(role),
  });
}

describe('BecomeCreatorUseCase', () => {
  it('upgrades a reader to creator', async () => {
    const user = makeUser('reader');
    const repo = {
      findById: vi.fn().mockResolvedValue(user),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const uc = new BecomeCreatorUseCase(repo as any);
    const result = await uc.execute(user.getUserId());
    expect(result.role).toBe('creator');
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(user.getRole().getValue()).toBe('creator');
  });

  it('is idempotent for existing creators (no write)', async () => {
    const user = makeUser('creator');
    const repo = {
      findById: vi.fn().mockResolvedValue(user),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const uc = new BecomeCreatorUseCase(repo as any);
    const result = await uc.execute(user.getUserId());
    expect(result.role).toBe('creator');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('throws NotFound for unknown user', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    };
    const uc = new BecomeCreatorUseCase(repo as any);
    await expect(uc.execute(new UserId(crypto.randomUUID()))).rejects.toThrow();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
