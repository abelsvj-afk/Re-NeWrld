import { describe, it, expect } from 'vitest';
import {
  parseProseTemplate,
  renderProseTemplate,
  hasTemplateSyntax,
  validateProseTemplate,
} from '../../src/modules/world/domain/services/prose-template.js';
import { evaluateCondition } from '../../src/modules/session/domain/services/condition-evaluator.js';

const ctx = (variables: Record<string, unknown>) => ({
  variables,
  evaluateCondition: (c: unknown, s: Record<string, unknown>) => evaluateCondition(c as any, s as any),
});

describe('hasTemplateSyntax', () => {
  it('detects if blocks', () => {
    expect(hasTemplateSyntax('Hello {{#if x}}world{{/if}}')).toBe(true);
  });
  it('detects variable interpolation', () => {
    expect(hasTemplateSyntax('Hello {name}')).toBe(true);
  });
  it('returns false for plain prose', () => {
    expect(hasTemplateSyntax('Just plain text.')).toBe(false);
  });
});

describe('parseProseTemplate', () => {
  it('parses plain text', () => {
    const parsed = parseProseTemplate('Hello world');
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toEqual({ kind: 'text', text: 'Hello world' });
  });

  it('parses variable interpolation', () => {
    const parsed = parseProseTemplate('Hello {name}!');
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[1]).toEqual({ kind: 'var', name: 'name' });
  });

  it('parses if/else blocks', () => {
    const parsed = parseProseTemplate('A{{#if gold > 5}}B{{else}}C{{/if}}D');
    expect(parsed.nodes).toHaveLength(3);
    const ifNode = parsed.nodes[1];
    expect(ifNode.kind).toBe('if');
    if (ifNode.kind === 'if') {
      expect(ifNode.then).toHaveLength(1);
      expect(ifNode.else).toHaveLength(1);
    }
  });

  it('throws on unclosed if', () => {
    expect(() => parseProseTemplate('A{{#if x}}B')).toThrow();
  });

  it('throws on invalid condition', () => {
    expect(() => parseProseTemplate('{{#if 123invalid}}x{{/if}}')).toThrow();
    expect(() => parseProseTemplate('{{#if }}x{{/if}}')).toThrow();
  });
});

describe('renderProseTemplate', () => {
  it('renders variables', () => {
    const parsed = parseProseTemplate('Hello {name}, you have {gold} gold.');
    const out = renderProseTemplate(parsed, ctx({ name: 'Ari', gold: 10 }));
    expect(out).toBe('Hello Ari, you have 10 gold.');
  });

  it('renders if true branch', () => {
    const parsed = parseProseTemplate('{{#if gold >= 5}}Rich{{else}}Poor{{/if}}');
    expect(renderProseTemplate(parsed, ctx({ gold: 10 }))).toBe('Rich');
  });

  it('renders if false branch', () => {
    const parsed = parseProseTemplate('{{#if gold >= 5}}Rich{{else}}Poor{{/if}}');
    expect(renderProseTemplate(parsed, ctx({ gold: 2 }))).toBe('Poor');
  });

  it('renders missing variables as empty', () => {
    const parsed = parseProseTemplate('Hello {missing}!');
    expect(renderProseTemplate(parsed, ctx({}))).toBe('Hello !');
  });

  it('is deterministic', () => {
    const prose = '{{#if has_key}}Open{{else}}Locked{{/if}} — {name}';
    const parsed = parseProseTemplate(prose);
    const a = renderProseTemplate(parsed, ctx({ has_key: true, name: 'Ari' }));
    const b = renderProseTemplate(parsed, ctx({ has_key: true, name: 'Ari' }));
    expect(a).toBe(b);
    expect(a).toBe('Open — Ari');
  });
});

describe('validateProseTemplate', () => {
  it('returns null for valid templates', () => {
    expect(validateProseTemplate('Hello {name}')).toBeNull();
    expect(validateProseTemplate('{{#if x > 1}}a{{/if}}')).toBeNull();
  });
  it('returns error for invalid templates', () => {
    expect(validateProseTemplate('{{#if x}}unclosed')).not.toBeNull();
  });
  it('returns null for plain prose', () => {
    expect(validateProseTemplate('No templates here.')).toBeNull();
  });
});
