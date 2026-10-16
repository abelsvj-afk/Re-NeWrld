/**
 * State-Reactive Prose Engine (Interactive Narrative Engine, Item A).
 *
 * Deterministic template engine for scene prose. Supports:
 *   {{#if expression}}...{{else}}...{{/if}}  — conditional blocks (nestable)
 *   {variable_name}                           — variable interpolation
 *
 * Expressions use the same condition grammar as choice conditions
 * (evaluated via the existing deterministic condition evaluator).
 *
 * Determinism guarantee: same state → same rendered output. No randomness,
 * no AI, no side effects. Parse once at scene save time; render per request.
 */

export type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'if'; condition: unknown; then: TemplateNode[]; else: TemplateNode[] };

export interface ParsedTemplate {
  nodes: TemplateNode[];
}

/** Maximum prose length accepted for template parsing (100KB). */
export const MAX_TEMPLATE_PROSE_LENGTH = 100_000;
/** Maximum {{#if}} nesting depth. */
export const MAX_TEMPLATE_NESTING_DEPTH = 10;

/**
 * Parse prose template into an AST. Throws on syntax errors.
 */
export function parseProseTemplate(prose: string): ParsedTemplate {
  if (prose.length > MAX_TEMPLATE_PROSE_LENGTH) {
    throw new Error(`Prose exceeds maximum template length of ${MAX_TEMPLATE_PROSE_LENGTH} characters`);
  }
  const nodes: TemplateNode[] = [];
  let pos = 0;

  while (pos < prose.length) {
    // Check for {{#if ...}}
    const ifMatch = prose.slice(pos).match(/^\{\{#if\s+([^}]+)\}\}/);
    if (ifMatch) {
      const conditionStr = ifMatch[1].trim();
      const condition = parseConditionExpression(conditionStr);
      pos += ifMatch[0].length;
      const { then, else: elseNodes, endPos } = parseBlock(prose, pos);
      nodes.push({ kind: 'if', condition, then, else: elseNodes });
      pos = endPos;
      continue;
    }

    // Check for {variable}
    const varMatch = prose.slice(pos).match(/^\{([a-z][a-z0-9_]*)\}/);
    if (varMatch) {
      nodes.push({ kind: 'var', name: varMatch[1] });
      pos += varMatch[0].length;
      continue;
    }

    // Plain text until next { or end
    const nextBrace = prose.indexOf('{', pos);
    if (nextBrace === -1) {
      nodes.push({ kind: 'text', text: prose.slice(pos) });
      break;
    }
    if (nextBrace > pos) {
      nodes.push({ kind: 'text', text: prose.slice(pos, nextBrace) });
    }
    pos = nextBrace;
    // The full tag matchers at the top already failed, so this { cannot
    // start a valid tag (e.g. incomplete "{{#if " or "{a"). Treat it as
    // literal text and always advance to guarantee loop termination.
    nodes.push({ kind: 'text', text: '{' });
    pos += 1;
  }

  return { nodes };
}

function parseBlock(prose: string, startPos: number, depth: number = 1): { then: TemplateNode[]; else: TemplateNode[]; endPos: number } {
  if (depth > MAX_TEMPLATE_NESTING_DEPTH) {
    throw new Error(`Template nesting exceeds maximum depth of ${MAX_TEMPLATE_NESTING_DEPTH}`);
  }
  const then: TemplateNode[] = [];
  const elseNodes: TemplateNode[] = [];
  let current = then;
  let pos = startPos;
  let currentDepth = 1;

  while (pos < prose.length && currentDepth > 0) {
    // Check for nested {{#if}}
    const ifMatch = prose.slice(pos).match(/^\{\{#if\s+([^}]+)\}\}/);
    if (ifMatch) {
      const condition = parseConditionExpression(ifMatch[1].trim());
      pos += ifMatch[0].length;
      const inner = parseBlock(prose, pos, depth + 1);
      current.push({ kind: 'if', condition, then: inner.then, else: inner.else });
      pos = inner.endPos;
      continue;
    }

    // Check for {{else}} at current depth
    if (prose.slice(pos).startsWith('{{else}}') && currentDepth === 1) {
      current = elseNodes;
      pos += '{{else}}'.length;
      continue;
    }

    // Check for {{/if}}
    if (prose.slice(pos).startsWith('{{/if}}')) {
      currentDepth -= 1;
      if (currentDepth === 0) {
        pos += '{{/if}}'.length;
        break;
      }
      // Nested close — treat as text (shouldn't happen with correct parsing)
      current.push({ kind: 'text', text: '{{/if}}' });
      pos += '{{/if}}'.length;
      continue;
    }

    // Check for {variable}
    const varMatch = prose.slice(pos).match(/^\{([a-z][a-z0-9_]*)\}/);
    if (varMatch) {
      current.push({ kind: 'var', name: varMatch[1] });
      pos += varMatch[0].length;
      continue;
    }

    // Plain text
    const nextTag = findNextTag(prose, pos);
    if (nextTag === -1) {
      if (currentDepth > 0) {
        throw new Error(`Unclosed {{#if}} block starting at position ${startPos}`);
      }
      current.push({ kind: 'text', text: prose.slice(pos) });
      break;
    }
    if (nextTag > pos) {
      current.push({ kind: 'text', text: prose.slice(pos, nextTag) });
      pos = nextTag;
      continue;
    }
    // pos === nextTag: we're at a { that didn't match any full tag above
    // (incomplete tag). Emit it as literal and advance to guarantee termination.
    current.push({ kind: 'text', text: prose[pos] });
    pos += 1;
  }

  if (currentDepth > 0) {
    throw new Error(`Unclosed {{#if}} block`);
  }

  return { then, else: elseNodes, endPos: pos };
}

function findNextTag(prose: string, from: number): number {
  const patterns = ['{{#if', '{{else}}', '{{/if}}', '{'];
  let earliest = -1;
  for (const p of patterns) {
    const idx = prose.indexOf(p, from);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

/**
 * Parse a condition expression string into the condition payload format.
 * Supports:
 *   - Bare variable: "has_key" → truthiness check
 *   - Comparison: "trust_kael >= 5", "name == 'Ari'"
 * For complex expressions, authors should use the structured condition builder.
 */
function parseConditionExpression(expr: string): unknown {
  // Bare variable → truthiness check
  const bareMatch = expr.match(/^([a-z][a-z0-9_]*)$/);
  if (bareMatch) {
    return { op: 'truthy', var: bareMatch[1] };
  }

  // Comparison: variable operator value
  const match = expr.match(/^([a-z][a-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    throw new Error(`Invalid condition expression: "${expr}". Expected format: variable operator value (e.g. "trust_kael >= 5")`);
  }
  const [, variable, operator, rawValue] = match;
  let value: unknown = rawValue.trim();

  // Try to parse as number
  if (/^-?\d+(\.\d+)?$/.test(value as string)) {
    value = Number(value);
  } else if ((value as string).toLowerCase() === 'true') {
    value = true;
  } else if ((value as string).toLowerCase() === 'false') {
    value = false;
  } else if (/^["'].*["']$/.test(value as string)) {
    value = (value as string).slice(1, -1);
  }

  const opMap: Record<string, string> = {
    '==': 'eq',
    '!=': 'ne',
    '>': 'gt',
    '<': 'lt',
    '>=': 'gte',
    '<=': 'lte',
  };

  return { op: opMap[operator], var: variable, value };
}

export interface RenderContext {
  variables: Record<string, unknown>;
  evaluateCondition: (condition: unknown, state: Record<string, unknown>) => boolean;
}

/**
 * Render a parsed template against session state.
 * Deterministic: same template + same state = same output.
 */
export function renderProseTemplate(parsed: ParsedTemplate, ctx: RenderContext): string {
  return parsed.nodes.map((node) => renderNode(node, ctx)).join('');
}

function renderNode(node: TemplateNode, ctx: RenderContext): string {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'var': {
      const value = ctx.variables[node.name];
      if (value === undefined || value === null) return '';
      return String(value);
    }
    case 'if': {
      const result = ctx.evaluateCondition(node.condition, ctx.variables);
      const branch = result ? node.then : node.else;
      return branch.map((n) => renderNode(n, ctx)).join('');
    }
  }
}

/**
 * Quick check if prose contains any template syntax.
 * Used to skip parsing for plain prose (performance).
 */
export function hasTemplateSyntax(prose: string): boolean {
  return prose.includes('{{#if') || /\{[a-z][a-z0-9_]*\}/.test(prose);
}

/**
 * Validate template syntax without rendering. Returns error message or null.
 */
export function validateProseTemplate(prose: string): string | null {
  if (!hasTemplateSyntax(prose)) return null;
  try {
    parseProseTemplate(prose);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid template syntax';
  }
}
