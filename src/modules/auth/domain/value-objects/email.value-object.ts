export class Email {
  private readonly value: string;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('Email cannot be empty');
    }
    const trimmed = value.trim().toLowerCase();
    // Basic standard email format validation regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      throw new Error(`Invalid email format: ${value}`);
    }
    this.value = trimmed;
  }

  public getValue(): string {
    return this.value;
  }

  public equals(other: Email | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
