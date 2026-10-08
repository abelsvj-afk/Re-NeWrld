export type UserRoleType = 'creator' | 'reader';

export class UserRole {
  private readonly value: UserRoleType;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('UserRole cannot be empty');
    }
    const normalized = value.trim().toLowerCase() as UserRoleType;
    if (normalized !== 'creator' && normalized !== 'reader') {
      throw new Error(`Invalid user role: ${value}. Allowed roles are 'creator' or 'reader'.`);
    }
    this.value = normalized;
  }

  public getValue(): UserRoleType {
    return this.value;
  }

  public isCreator(): boolean {
    return this.value === 'creator';
  }

  public isReader(): boolean {
    return this.value === 'reader';
  }

  public equals(other: UserRole | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
