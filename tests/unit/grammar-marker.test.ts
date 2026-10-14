import { describe, it, expect } from 'vitest';
import { getGrammarMarker } from '../../src/modules/world/domain/services/grammar-marker.js';

describe('getGrammarMarker', () => {
  it('detects a present marker', () => {
    expect(getGrammarMarker({ condition_grammar_version: 1 })).toEqual({
      hadMarker: true,
      effectiveVersion: 1,
    });
  });
  it('detects an absent marker (B12)', () => {
    expect(getGrammarMarker({})).toEqual({ hadMarker: false, effectiveVersion: 1 });
    expect(getGrammarMarker({ canon_schema_version: 1 })).toEqual({
      hadMarker: false,
      effectiveVersion: 1,
    });
  });
  it('handles null, undefined, and non-objects', () => {
    expect(getGrammarMarker(null)).toEqual({ hadMarker: false, effectiveVersion: 1 });
    expect(getGrammarMarker(undefined)).toEqual({ hadMarker: false, effectiveVersion: 1 });
    expect(getGrammarMarker('nope')).toEqual({ hadMarker: false, effectiveVersion: 1 });
    expect(getGrammarMarker(42)).toEqual({ hadMarker: false, effectiveVersion: 1 });
  });
});
