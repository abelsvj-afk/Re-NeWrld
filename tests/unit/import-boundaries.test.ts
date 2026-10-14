import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Import boundary enforcement (STOP-3, Fix 1).
 *
 * Per docs/repository-architecture.md §B (Strict Isolation), inter-module
 * communication must occur exclusively through designated public facades.
 * Direct deep imports of `world/domain/...` from the session module are
 * prohibited for NEW code.
 *
 * The 22 pre-existing Phase F deep imports (value objects, ports, entities,
 * errors) are allowlisted below as H-facade debt (TASKS.md §4) — they predate
 * the facade and migrate separately. Any NEW deep import not on this list
 * fails the test.
 *
 * The sanctioned facade for new code is `src/modules/world/application/index.js`.
 */

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Pre-existing Phase F deep imports, allowlisted as H-facade debt.
 * Format: "relative/path/to/file.ts:imported-symbol".
 * These 22 were present before the facade existed; new code must use the facade.
 *
 * NOTE (H-facade complete 2026-10-14): All 22 have been migrated to the facade.
 * This allowlist is now empty and retained only as documentation. The test
 * enforces zero deep world/domain imports.
 */
const ALLOWLIST = new Set<string>([
]);

describe('import boundaries (STOP-3, Fix 1)', () => {
  it('session module has no NEW deep world/domain imports (allowlisted Phase F debt exempt)', () => {
    const repoRoot = join(__dirname, '../../');
    const sessionDir = join(repoRoot, 'src/modules/session');
    const files = collectTsFiles(sessionDir);
    const violations: string[] = [];

    // Broader pattern (Fix 1): ANY deep import into world/domain/.
    // The facade (world/application/index.js) is the only sanctioned path.
    const deepWorldDomain = /from\s+['"][^'"]*world\/domain\/[^'"]*['"]/;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const relPath = file.replace(repoRoot, '');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (deepWorldDomain.test(line)) {
          // Extract imported symbols for allowlist matching.
          const importMatch = line.match(/import\s*(?:type\s+)?\{([^}]+)\}/);
          const symbols = importMatch
            ? importMatch[1].split(',').map((s) => s.trim().split(' as ').pop()!.trim())
            : ['(default)'];
          for (const sym of symbols) {
            const key = `${relPath}:${sym}`;
            if (!ALLOWLIST.has(key)) {
              violations.push(`${relPath}:${idx + 1}: ${sym} — not allowlisted, use the facade`);
            }
          }
        }
      });
    }

    expect(
      violations,
      `New deep world/domain imports prohibited; use src/modules/world/application/index.js:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('world application facade exports the grammar surface', async () => {
    const facade = await import('../../src/modules/world/application/index.js');
    expect(typeof facade.ConditionSchema).toBe('object');
    expect(typeof facade.MutationListSchema).toBe('object');
    expect(typeof facade.getGrammarMarker).toBe('function');
    expect(typeof facade.validateChoiceSemantics).toBe('function');
  });
});
