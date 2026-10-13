const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorldId {
  private readonly value: string;

  constructor(value: string) {
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('WorldId cannot be empty');
    }
    const trimmed = value.trim();
    if (!UUID_V4_REGEX.test(trimmed)) {
      throw new Error(`Invalid WorldId UUID v4 format: ${value}`);
    }
    this.value = trimmed;
  }

  public static generate(): WorldId {
    return new WorldId(crypto.randomUUID());
  }

  public getValue(): string {
    return this.value;
  }

  public equals(other: WorldId | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
