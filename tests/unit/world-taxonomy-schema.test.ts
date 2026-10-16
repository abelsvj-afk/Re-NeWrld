import { describe, it, expect } from 'vitest';
import { WorldMetadataSchema, WorldTaxonomyInputSchema, WORLD_GENRES } from '../../src/modules/world/domain/value-objects/world-schemas.js';

describe('World taxonomy schema', () => {
  it('accepts valid genre values', () => {
    for (const g of WORLD_GENRES) {
      const parsed = WorldMetadataSchema.parse({ genre: g });
      expect(parsed.genre).toBe(g);
    }
  });

  it('tolerates unknown legacy genre on read (drops key, never throws)', () => {
    const parsed = WorldMetadataSchema.parse({ genre: 'cyberpunk', title: 'x' });
    expect(parsed.genre).toBeUndefined();
    expect((parsed as Record<string, unknown>).title).toBe('x');
  });

  it('tolerates invalid legacy tags on read (drops key, never throws)', () => {
    const parsed = WorldMetadataSchema.parse({ tags: ['has space'] });
    expect(parsed.tags).toBeUndefined();
  });

  it('accepts valid tags and normalizes', () => {
    const parsed = WorldMetadataSchema.parse({ tags: ['Dark-Fantasy', '  slow-burn  '] });
    expect(parsed.tags).toEqual(['dark-fantasy', 'slow-burn']);
  });

  it('strict write schema rejects invalid genre', () => {
    expect(() => WorldTaxonomyInputSchema.parse({ genre: 'western' })).toThrow();
  });

  it('strict write schema rejects invalid tags', () => {
    expect(() => WorldTaxonomyInputSchema.parse({ tags: ['has space'] })).toThrow();
    expect(() => WorldTaxonomyInputSchema.parse({ tags: ['has_underscore'] })).toThrow();
  });

  it('strict write schema rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    expect(() => WorldTaxonomyInputSchema.parse({ tags })).toThrow();
  });

  it('strict write schema rejects tags over 30 characters', () => {
    expect(() => WorldTaxonomyInputSchema.parse({ tags: ['a'.repeat(31)] })).toThrow();
  });

  it('keeps genre/tags optional for backward compatibility', () => {
    const parsed = WorldMetadataSchema.parse({ someOtherKey: 'value' });
    expect(parsed.genre).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect((parsed as Record<string, unknown>).someOtherKey).toBe('value');
  });

  it('genre enum has 10 values plus other', () => {
    expect(WORLD_GENRES).toHaveLength(10);
    expect(WORLD_GENRES).toContain('other');
  });
});
