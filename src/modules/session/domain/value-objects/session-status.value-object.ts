export type SessionStatusType = 'active' | 'completed' | 'abandoned';

export class SessionStatus {
  private readonly value: SessionStatusType;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('SessionStatus cannot be empty');
    }
    const trimmed = value.trim().toLowerCase() as SessionStatusType;
    if (trimmed !== 'active' && trimmed !== 'completed' && trimmed !== 'abandoned') {
      throw new Error(`Invalid SessionStatus: ${value}. Must be 'active', 'completed' or 'abandoned'`);
    }
    this.value = trimmed;
  }

  public getValue(): SessionStatusType {
    return this.value;
  }

  public isActive(): boolean {
    return this.value === 'active';
  }

  public isTerminal(): boolean {
    return this.value === 'completed' || this.value === 'abandoned';
  }

  public equals(other: SessionStatus | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
