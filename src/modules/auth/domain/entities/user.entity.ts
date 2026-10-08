import { UserId } from '../value-objects/user-id.value-object.js';
import { Email } from '../value-objects/email.value-object.js';
import { UserRole } from '../value-objects/role.value-object.js';

export interface UserProps {
  userId: UserId;
  email: Email;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export class User {
  private readonly userId: UserId;
  private email: Email;
  private passwordHash: string;
  private role: UserRole;
  private readonly createdAt: Date;
  private updatedAt: Date;

  private constructor(props: UserProps) {
    if (!props.passwordHash || typeof props.passwordHash !== 'string' || props.passwordHash.trim().length === 0) {
      throw new Error('User passwordHash cannot be empty');
    }
    this.userId = props.userId;
    this.email = props.email;
    this.passwordHash = props.passwordHash.trim();
    this.role = props.role;
    this.createdAt = new Date(props.createdAt.getTime());
    this.updatedAt = new Date(props.updatedAt.getTime());
  }

  public static create(params: {
    userId: UserId;
    email: Email;
    passwordHash: string;
    role: UserRole;
  }): User {
    const now = new Date();
    return new User({
      userId: params.userId,
      email: params.email,
      passwordHash: params.passwordHash,
      role: params.role,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static reconstitute(props: UserProps): User {
    return new User(props);
  }

  public getUserId(): UserId {
    return this.userId;
  }

  public getEmail(): Email {
    return this.email;
  }

  public getPasswordHash(): string {
    return this.passwordHash;
  }

  public getRole(): UserRole {
    return this.role;
  }

  public getCreatedAt(): Date {
    return new Date(this.createdAt.getTime());
  }

  public getUpdatedAt(): Date {
    return new Date(this.updatedAt.getTime());
  }

  public updateEmail(newEmail: Email): void {
    this.email = newEmail;
    this.updatedAt = new Date();
  }

  public updatePasswordHash(newPasswordHash: string): void {
    if (!newPasswordHash || typeof newPasswordHash !== 'string' || newPasswordHash.trim().length === 0) {
      throw new Error('New passwordHash cannot be empty');
    }
    this.passwordHash = newPasswordHash.trim();
    this.updatedAt = new Date();
  }

  public updateRole(newRole: UserRole): void {
    this.role = newRole;
    this.updatedAt = new Date();
  }

  public equals(other: User | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.userId.equals(other.getUserId());
  }
}
