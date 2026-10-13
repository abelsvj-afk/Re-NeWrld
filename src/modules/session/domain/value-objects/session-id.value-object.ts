const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SessionId {
  private readonly value: string;

  constructor(value: string) {
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('SessionId cannot be empty');
    }
    const trimmed = value.trim();
    if (!UUID_V4_REGEX.test(trimmed)) {
      throw new Error(`Invalid SessionId UUID v4 format: ${value}`);
    }
    this.value = trimmed;
  }

  public static generate(): SessionId {
    return new SessionId(crypto.randomUUID());
  }

  public getValue(): string {
    return this.value;
  }

  public equals(other: SessionId | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
