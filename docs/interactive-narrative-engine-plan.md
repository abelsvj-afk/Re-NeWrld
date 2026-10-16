# Interactive Narrative Engine — Implementation Plan

**Source:** Jules Audit (2026-10-16) — "Interactive Narrative Engine Audit & Missing Capabilities Report"
**Status:** DRAFT — Awaiting product owner approval
**Governance:** All items classified per AI_AGENT_RULES.md change levels

---

## Overview

Six capabilities identified as missing or under-specified for world-class interactive storytelling. Ordered by recommended implementation sequence (dependency-aware, not just priority).

### Implementation Order

| Order | Capability | Level | Effort | Depends On |
|-------|-----------|-------|--------|------------|
| 1 | C. Locked Choice Display Policy | Level 2 | S | — |
| 2 | E. Reader Inventory & Status Drawer | Level 2 | S-M | — |
| 3 | F. Consequence Cues | Level 2 | S | E (shares state display) |
| 4 | B. World Variable Registry | Level 3 | M-L | — |
| 5 | A. State-Reactive Prose Engine | Level 3 | L | B (registry provides variable definitions) |
| 6 | D. Chapter Checkpoints & Rewind | Level 3 | M-L | — |

**Rationale for ordering:** C, E, F are high-value UI wins on existing backend. B provides the foundation (typed variables) that A needs for authoring-time validation. D is independent and can be parallelized.

---

## 1. C. Locked Choice Display Policy

**Level:** 2 (extends existing Choice contract)
**Effort:** Small

### Problem
Choices with unmet conditions are silently hidden. Readers never see alternative paths existed, reducing perceived agency.

### Design
Add per-choice `visibility` policy:
- `'hide'` (default, current behavior) — choice invisible when conditions unmet
- `'show_locked'` — choice rendered disabled with requirement cue

Locked display format: `🔒 Requires {human-readable requirement}`
- Example: `🔒 Requires Trust ≥ 5 with Kael`
- Human-readable labels sourced from Variable Registry (B) when available, fallback to raw expression

### Contract Changes
```typescript
// Choice entity — new field
visibility: 'hide' | 'show_locked'  // default: 'hide'

// Session DTO — locked choices included with metadata
{
  id, text, targetSceneId,
  locked: true,
  lockReason: "Requires Trust ≥ 5",  // human-readable
  lockExpression: "trust_kael >= 5"   // raw for debugging
}
```

### Backend
- [ ] Add `visibility` column to choices table (migration)
- [ ] Update Choice entity with `getVisibility()` / `setVisibility()`
- [ ] Update `toSessionJson()` to include locked choices when `visibility === 'show_locked'`
- [ ] New condition-to-human-readable formatter (uses registry labels if B is done, raw otherwise)
- [ ] Publish validator: no changes needed

### Frontend — Authoring
- [ ] Choice modal: visibility toggle (Hide / Show Locked)
- [ ] Preview of locked appearance

### Frontend — Reader
- [ ] Render locked choices as disabled with 🔒 icon and requirement text
- [ ] Locked choices not clickable, distinct visual treatment
- [ ] Accessibility: `aria-disabled`, screen reader announces requirement

### Acceptance Criteria
- [ ] Author can set visibility per choice
- [ ] Reader sees locked choices with clear requirement text
- [ ] Locked choices cannot be selected (backend rejects if attempted)
- [ ] Default behavior unchanged (hide) for existing choices

---

## 2. E. Reader Inventory & Status Drawer

**Level:** 2 (UI over existing session state)
**Effort:** Small-Medium

### Problem
State variables exist in session but readers have no visibility into inventory, stats, or relationships.

### Design
Slide-out drawer (right side on desktop, bottom sheet on mobile) showing:
- **Stats:** Numeric variables (health, gold, etc.)
- **Inventory:** Boolean/string variables flagged as items
- **Relationships:** Variables tracking NPC standing

Variable categorization: convention-based initially (`inventory_*`, `rel_*`, or explicit `displayAs` in registry when B is done).

### Backend
- [ ] Optional: `GET /sessions/:id/state` endpoint returning formatted state (if not already in session DTO)
- [ ] Session DTO already includes `variables` — may be sufficient

### Frontend — Reader
- [ ] Drawer component with tabs: Stats / Inventory / Relationships
- [ ] Toggle button in reader header (backpack icon)
- [ ] Real-time updates after each choice
- [ ] Empty states ("No items yet", "No relationships tracked")
- [ ] Mobile: bottom sheet with swipe dismiss
- [ ] Accessibility: focus trap, ESC to close, ARIA labels

### Acceptance Criteria
- [ ] Reader can open drawer at any point during reading
- [ ] Variables display with human-readable labels
- [ ] Updates reflect immediately after choice submission
- [ ] Works on mobile and desktop

---

## 3. F. Consequence Cues ("Will Remember That")

**Level:** 2 (UI feedback on mutations)
**Effort:** Small

### Problem
Readers don't know when a choice changed their state. No feedback loop.

### Design
Toast notifications after choice submission showing mutations:
- `+10 Honor` (increment)
- `Kael will remember that` (relationship change)
- `Acquired: Iron Key` (new item)
- `Lost: 5 Gold` (decrement)

### Backend
- [ ] `POST /sessions/:id/choices` response includes `mutationsApplied` array:
```typescript
{
  variable: "honor",
  operation: "increment",
  oldValue: 10,
  newValue: 20,
  displayText: "+10 Honor"  // human-readable, uses registry labels if available
}
```

### Frontend — Reader
- [ ] Toast system (stacked, auto-dismiss 4s)
- [ ] Icons per mutation type (⬆️ stat, 🎒 item, 💭 relationship)
- [ ] Subtle animation (slide-in from bottom)
- [ ] Accessibility: `aria-live="polite"` announcements
- [ ] Setting to disable (for immersion-focused readers)

### Acceptance Criteria
- [ ] Every state-changing choice shows feedback toast(s)
- [ ] Toasts are dismissible and auto-expire
- [ ] No toast for choices with no mutations
- [ ] Screen readers announce changes

---

## 4. B. World Variable Registry

**Level:** 3 (new entity, new API contracts)
**Effort:** Medium-Large

### Problem
Variables are ad-hoc strings. Typos fail silently. No central definition. Publishing validator can't check condition references.

### Design
Per-world registry of typed variables:

```typescript
interface WorldVariable {
  id: string;
  worldId: string;
  name: string;           // "trust_kael" — used in conditions
  type: 'boolean' | 'number' | 'string';
  defaultValue: unknown;  // initial value for new sessions
  label: string;          // "Trust with Kael" — human-readable
  description?: string;   // author notes
  category: 'stat' | 'inventory' | 'relationship' | 'flag' | 'other';
  displayAs?: string;     // custom display format, e.g. "{value} Gold"
}
```

### Backend
- [ ] New `world_variables` table (migration)
- [ ] `WorldVariable` entity with validation
- [ ] `WorldVariableRepository` port + Postgres implementation
- [ ] CRUD use cases: Create, Update, Delete, List
- [ ] API endpoints:
  - `POST /worlds/:id/variables`
  - `GET /worlds/:id/variables`
  - `PATCH /worlds/:id/variables/:varId`
  - `DELETE /worlds/:id/variables/:varId`
- [ ] Session initialization uses registry defaults
- [ ] Publish validator: warn on conditions referencing unregistered variables
- [ ] Publish validator: type-check condition expressions against registry types

### Frontend — Authoring
- [ ] Variables panel in world editor (list, add, edit, delete)
- [ ] Condition builder: dropdown of registered variables (prevents typos)
- [ ] Mutation builder: dropdown of registered variables
- [ ] Type-aware operators (boolean: is/is-not; number: </>/=; string: equals/contains)

### Migration Path
- [ ] Existing worlds: auto-register variables found in existing conditions/mutations (inferred types)
- [ ] No breaking change — unregistered variables still work (with warning)

### Acceptance Criteria
- [ ] Author can define typed variables with defaults
- [ ] Condition/mutation builders offer autocomplete from registry
- [ ] Typo in variable name produces validation warning at publish
- [ ] New sessions initialize from registry defaults
- [ ] Existing worlds migrate without data loss

---

## 5. A. State-Reactive Prose Engine

**Level:** 3 (new domain concept, new rendering contract)
**Effort:** Large

### Problem
Scene prose is static. Cannot react to reader state inline. Authors must duplicate entire scenes for minor variations.

### Design
Template syntax in scene prose:

```
You enter the chamber.
{{#if has_iron_key}}
You unlock the chest with the iron key, revealing ancient scrolls.
{{else}}
The iron-banded chest sits locked. You'll need a key.
{{/if}}
The air smells of {location_scent}.
```

**Supported constructs:**
- `{{#if expression}}...{{else}}...{{/if}}` — conditional blocks (nestable)
- `{variable_name}` — variable interpolation
- Expressions use existing condition grammar (same as choice conditions)

**Deterministic:** Same state → same rendered output. No randomness. No AI.

### Backend
- [ ] Template parser (produces AST)
- [ ] Template renderer (evaluates against session state)
- [ ] Parse at scene save time, cache AST
- [ ] Render at session read time (start/get/submit responses)
- [ ] `sceneText` in session DTO contains rendered prose
- [ ] Publish validator: check template syntax, variable references (uses B)
- [ ] Performance: AST caching, render < 5ms per scene

### Frontend — Authoring
- [ ] Prose editor with template syntax highlighting
- [ ] "Preview with state" mode — author sets test variable values, sees rendered output
- [ ] Variable autocomplete in editor (uses B)
- [ ] Syntax error indicators (unclosed blocks, invalid expressions)

### Frontend — Reader
- [ ] No changes needed — receives pre-rendered `sceneText`
- [ ] (Optional) subtle indicator when prose was conditionally rendered

### Security
- [ ] Template expressions are sandboxed (existing condition evaluator only)
- [ ] No arbitrary code execution
- [ ] Output escaped to prevent injection

### Acceptance Criteria
- [ ] Author can write conditional blocks in prose
- [ ] Reader sees different text based on their state
- [ ] Same state always produces same output (deterministic)
- [ ] Invalid syntax caught at save/publish time, not read time
- [ ] Performance: no perceptible delay in scene rendering

---

## 6. D. Chapter Checkpoints & Rewind

**Level:** 3 (new session mechanics)
**Effort:** Medium-Large

### Problem
Readers who reach a bad ending must restart from Scene 1. No way to explore "what if" from earlier chapters.

**Note:** This is FR-12 (deferred). Check existing spec before implementation.

### Design
- **Automatic checkpoints:** Session snapshots at each chapter boundary
- **Manual rewind:** Reader can return to any checkpoint
- **Branch exploration:** After rewind, new choices create a divergent path (original path preserved in history)

```typescript
interface SessionCheckpoint {
  id: string;
  sessionId: string;
  chapterId: string;
  sceneId: string;
  stateVariables: Record<string, unknown>;
  createdAt: Date;
  label: string;  // "Chapter 3: The Crossing"
}
```

### Backend
- [ ] New `session_checkpoints` table (migration)
- [ ] Auto-create checkpoint on chapter transition
- [ ] `POST /sessions/:id/rewind` — restore to checkpoint
- [ ] `GET /sessions/:id/checkpoints` — list available checkpoints
- [ ] Rewind creates a branch record (original timeline preserved)
- [ ] Optimistic locking handles concurrent rewind

### Frontend — Reader
- [ ] "Checkpoints" button in reader UI
- [ ] Checkpoint list with chapter titles and timestamps
- [ ] Confirmation dialog before rewind ("Your progress after this point will branch")
- [ ] Visual indicator when on a branched timeline
- [ ] (Future) Branch map visualization

### Acceptance Criteria
- [ ] Checkpoints auto-created at chapter boundaries
- [ ] Reader can rewind to any checkpoint
- [ ] Original path preserved (can return to it)
- [ ] State correctly restored (variables, scene, choices)
- [ ] No data loss or corruption on rewind

---

## ADR Requirements

| Item | ADR Needed | Topic |
|------|-----------|-------|
| A | Yes | Template syntax choice, determinism guarantees, security model |
| B | Yes | Registry schema, type system, migration strategy |
| C | No | Extension of existing choice contract |
| D | Yes | Checkpoint model, branching semantics, storage strategy |
| E | No | UI-only, no architectural decision |
| F | No | UI-only, extends existing mutation response |

## System Completeness Impact

All six items require System Completeness Gate review:
- **C, E, F:** Likely "N/A — UI extension" or minimal new surface
- **B, A, D:** New domain concepts requiring full completeness analysis

## Estimated Sequencing

```
Phase 1 (Weeks 1-2):  C + E + F  — Quick wins, immediate reader value
Phase 2 (Weeks 3-5):  B          — Foundation for A
Phase 3 (Weeks 6-10): A          — Flagship differentiator
Phase 4 (Weeks 8-11): D          — Parallel with A (independent)
```

---

**Next Step:** Product owner approval to proceed with Phase 1 planning (detailed tasks, acceptance criteria refinement, contract specs).
