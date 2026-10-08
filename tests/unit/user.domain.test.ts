import { describe, it, expect } from 'vitest';
import { UserId } from '../../src/modules/auth/domain/value-objects/user-id.value-object.js';
import { Email } from '../../src/modules/auth/domain/value-objects/email.value-object.js';
import { UserRole } from '../../src/modules/auth/domain/value-objects/role.value-object.js';
import { User } from '../../src/modules/auth/domain/entities/user.entity.js';

describe('Auth Domain: Value Objects & User Entity', () => {
  describe('UserId Value Object', () => {
    it('should create a valid UUID v4 UserId and retrieve its value', () => {
      const uuidStr = '123e4567-e89b-42d3-a456-426614174000';
      const id = new UserId(uuidStr);
      expect(id.getValue()).toBe(uuidStr);
    });

    it('should throw an error for empty, whitespace, or malformed/non-UUID v4 strings', () => {
      expect(() => new UserId('')).toThrowError(/UserId cannot be empty/);
      expect(() => new UserId('   ')).toThrowError(/UserId cannot be empty/);
      expect(() => new UserId('not-a-uuid')).toThrowError(/Invalid UserId UUID v4 format/);
      expect(() => new UserId('123e4567-e89b-12d3-a456-426614174000')).toThrowError(/Invalid UserId UUID v4 format/); // version 1/3/5 instead of 4
    });

    it('should correctly compare UserIds for equality', () => {
      const id1 = new UserId('123e4567-e89b-42d3-a456-426614174000');
      const id2 = new UserId('123e4567-e89b-42d3-a456-426614174000');
      const id3 = new UserId('987fcdeb-5022-42d3-a456-426614174000');

      expect(id1.equals(id2)).toBe(true);
      expect(id1.equals(id3)).toBe(false);
      expect(id1.equals(null)).toBe(false);
    });
  });

  describe('Email Value Object', () => {
    it('should create a valid normalized Email and retrieve its value', () => {
      const email = new Email('  CREATOR@Example.COM ');
      expect(email.getValue()).toBe('creator@example.com');
    });

    it('should throw an error for invalid email formats', () => {
      expect(() => new Email('invalid-email')).toThrowError(/Invalid email format/);
      expect(() => new Email('creator@')).toThrowError(/Invalid email format/);
      expect(() => new Email('')).toThrowError(/Email cannot be empty/);
    });

    it('should correctly compare Emails for equality', () => {
      const email1 = new Email('test@example.com');
      const email2 = new Email('TEST@EXAMPLE.COM');
      const email3 = new Email('other@example.com');

      expect(email1.equals(email2)).toBe(true);
      expect(email1.equals(email3)).toBe(false);
      expect(email1.equals(undefined)).toBe(false);
    });
  });

  describe('UserRole Value Object', () => {
    it('should create valid creator and reader roles with correct helpers', () => {
      const creatorRole = new UserRole('creator');
      expect(creatorRole.getValue()).toBe('creator');
      expect(creatorRole.isCreator()).toBe(true);
      expect(creatorRole.isReader()).toBe(false);

      const readerRole = new UserRole(' READER ');
      expect(readerRole.getValue()).toBe('reader');
      expect(readerRole.isCreator()).toBe(false);
      expect(readerRole.isReader()).toBe(true);
    });

    it('should throw an error for invalid roles', () => {
      expect(() => new UserRole('admin')).toThrowError(/Invalid user role/);
      expect(() => new UserRole('')).toThrowError(/UserRole cannot be empty/);
    });

    it('should correctly compare roles for equality', () => {
      const r1 = new UserRole('creator');
      const r2 = new UserRole('CREATOR');
      const r3 = new UserRole('reader');

      expect(r1.equals(r2)).toBe(true);
      expect(r1.equals(r3)).toBe(false);
      expect(r1.equals(null)).toBe(false);
    });
  });

  describe('User Entity', () => {
    it('should successfully create a valid User entity with generated defensive timestamps', () => {
      const userId = new UserId('123e4567-e89b-42d3-a456-426614174000');
      const email = new Email('author@rene.wrld');
      const role = new UserRole('creator');
      const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$salt$hash';

      const user = User.create({ userId, email, passwordHash, role });

      expect(user.getUserId().equals(userId)).toBe(true);
      expect(user.getEmail().equals(email)).toBe(true);
      expect(user.getPasswordHash()).toBe(passwordHash);
      expect(user.getRole().equals(role)).toBe(true);
      expect(user.getCreatedAt()).toBeInstanceOf(Date);
      expect(user.getUpdatedAt()).toBeInstanceOf(Date);

      // Verify defensive copies prevent external mutation of internal entity Date state
      const createdAt1 = user.getCreatedAt();
      createdAt1.setFullYear(2000);
      expect(user.getCreatedAt().getFullYear()).not.toBe(2000);
    });

    it('should throw an error if passwordHash is empty', () => {
      const userId = new UserId('123e4567-e89b-42d3-a456-426614174000');
      const email = new Email('author@rene.wrld');
      const role = new UserRole('creator');

      expect(() => User.create({ userId, email, passwordHash: '   ', role })).toThrowError(
        /User passwordHash cannot be empty/
      );
    });

    it('should support updating email, role, and passwordHash while updating updatedAt timestamp', () => {
      const user = User.create({
        userId: new UserId('123e4567-e89b-42d3-a456-426614174000'),
        email: new Email('old@rene.wrld'),
        passwordHash: 'hash1',
        role: new UserRole('reader'),
      });

      const initialUpdatedAt = user.getUpdatedAt();

      const newEmail = new Email('new@rene.wrld');
      user.updateEmail(newEmail);
      expect(user.getEmail().equals(newEmail)).toBe(true);

      const newRole = new UserRole('creator');
      user.updateRole(newRole);
      expect(user.getRole().equals(newRole)).toBe(true);

      user.updatePasswordHash('hash2');
      expect(user.getPasswordHash()).toBe('hash2');
      expect(user.getUpdatedAt().getTime()).toBeGreaterThanOrEqual(initialUpdatedAt.getTime());
    });

    it('should correctly compare users for equality based on userId', () => {
      const u1 = User.create({
        userId: new UserId('123e4567-e89b-42d3-a456-426614174000'),
        email: new Email('a@rene.wrld'),
        passwordHash: 'h1',
        role: new UserRole('reader'),
      });

      const u2 = User.create({
        userId: new UserId('123e4567-e89b-42d3-a456-426614174000'),
        email: new Email('b@rene.wrld'),
        passwordHash: 'h2',
        role: new UserRole('creator'),
      });

      const u3 = User.create({
        userId: new UserId('987fcdeb-5022-42d3-a456-426614174000'),
        email: new Email('a@rene.wrld'),
        passwordHash: 'h1',
        role: new UserRole('reader'),
      });

      expect(u1.equals(u2)).toBe(true);
      expect(u1.equals(u3)).toBe(false);
      expect(u1.equals(null)).toBe(false);
    });
  });
});
