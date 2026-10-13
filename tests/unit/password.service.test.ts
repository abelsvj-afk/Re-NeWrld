import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../src/modules/auth/infrastructure/services/password.service.js';

describe('PasswordService (scrypt)', () => {
  const service = new PasswordService();

  it('should hash and verify a password', async () => {
    const hash = await service.hashPassword('correct-horse-123');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await service.verifyPassword('correct-horse-123', hash)).toBe(true);
  });

  it('should reject the wrong password', async () => {
    const hash = await service.hashPassword('correct-horse-123');
    expect(await service.verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('should use a unique salt per hash', async () => {
    const h1 = await service.hashPassword('same-password');
    const h2 = await service.hashPassword('same-password');
    expect(h1).not.toBe(h2);
    expect(await service.verifyPassword('same-password', h1)).toBe(true);
    expect(await service.verifyPassword('same-password', h2)).toBe(true);
  });

  it('should return false (not throw) for malformed stored hashes', async () => {
    expect(await service.verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await service.verifyPassword('anything', 'scrypt$bad$params')).toBe(false);
    expect(await service.verifyPassword('anything', '')).toBe(false);
  });

  it('should enforce the password length policy on hashing', async () => {
    await expect(service.hashPassword('short')).rejects.toThrow(/at least 8 characters/);
    await expect(service.hashPassword('x'.repeat(129))).rejects.toThrow(/not exceed 128/);
  });

  it('should compare hashes in constant time (timingSafeEqual, no early exit on length)', async () => {
    const hash = await service.hashPassword('timing-test-pw');
    // Tampered hash of wrong length must not throw and must be false
    const tampered = hash.slice(0, -4);
    expect(await service.verifyPassword('timing-test-pw', tampered)).toBe(false);
  });
});
