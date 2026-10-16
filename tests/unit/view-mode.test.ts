import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage for node environment
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
});

import { getViewMode, setViewMode, clearViewMode } from '../../src/web/src/lib/view-mode.js';

describe('view-mode', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it('returns null when nothing stored', () => {
    expect(getViewMode()).toBeNull();
  });

  it('round-trips creator and reader', () => {
    setViewMode('creator');
    expect(getViewMode()).toBe('creator');
    setViewMode('reader');
    expect(getViewMode()).toBe('reader');
  });

  it('rejects corrupted values', () => {
    store['renewrld:view-mode'] = 'admin';
    expect(getViewMode()).toBeNull();
    store['renewrld:view-mode'] = '';
    expect(getViewMode()).toBeNull();
    store['renewrld:view-mode'] = '{"mode":"reader"}';
    expect(getViewMode()).toBeNull();
  });

  it('clear removes the preference', () => {
    setViewMode('reader');
    clearViewMode();
    expect(getViewMode()).toBeNull();
  });

  it('survives localStorage throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(getViewMode()).toBeNull();
    expect(() => setViewMode('reader')).not.toThrow();
    expect(() => clearViewMode()).not.toThrow();
  });
});
