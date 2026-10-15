import { describe, it, expect } from 'vitest';
import { WorldMetadataSchema, WorldGenreSchema, WorldTagSchema, WORLD_GENRES } from '../../src/modules/world/domain/value-objects/world-schemas.js';

describe('World taxonomy schema', () => {
  it('accepts valid genre values', () => {
    for (const g of WORLD_GENRES) {
      const parsed = WorldMetadataSchema.parse({ genre: g });
      expect(parsed.genre).toBe(g);
    }
  });

  it('rejects invalid genre', () => {
    expect(() => WorldMetadataSchema.parse({ genre: 'western' })).toThrow();
  });

  it('accepts valid tags and normalizes', () => {
    const parsed = WorldMetadataSchema.parse({ tags: ['Dark-Fantasy', '  slow-burn  '] });
    expect(parsed.tags).toEqual(['dark-fantasy', 'slow-burn']);
  });

  it('rejects tags with invalid characters', () => {
    expect(() => WorldMetadataSchema.parse({ tags: ['has space'] })).toThrow();
    expect(() => WorldMetadataSchema.parse({ tags: ['has_underscore'] })).toThrow();
  });

  it('rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    expect(() => WorldMetadataSchema.parse({ tags })).toThrow();
  });

  it('rejects tags over 30 characters', () => {
    expect(() => WorldMetadataSchema.parse({ tags: ['a'.repeat(31)] })).toThrow();
  });

  it('keeps genre/tags optional for backward compatibility', () => {
    const parsed = WorldMetadataSchema.parse({ someOtherKey: 'value' });
    expect(parsed.genre).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.someOtherKey).toBe('value');
  });

  it('genre enum has 10 values plus other', () => {
    expect(WORLD_GENRES).toHaveLength(10);
    expect(WORLD_GENRES).toContain('other');
  });
});
