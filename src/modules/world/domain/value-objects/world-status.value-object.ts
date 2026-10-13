export type WorldStatusType = 'draft' | 'published';

export class WorldStatus {
  private readonly value: WorldStatusType;

  constructor(value: string) {
    if (!value || typeof value !== 'string') {
      throw new Error('WorldStatus cannot be empty');
    }
    const trimmed = value.trim().toLowerCase() as WorldStatusType;
    if (trimmed !== 'draft' && trimmed !== 'published') {
      throw new Error(`Invalid WorldStatus: ${value}. Must be 'draft' or 'published'`);
    }
    this.value = trimmed;
  }

  public getValue(): WorldStatusType {
    return this.value;
  }

  public equals(other: WorldStatus | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.value === other.getValue();
  }
}
