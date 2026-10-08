Continuing: I've diffed the new archive and now I'm reading the B2 migration, runner, tests and doc changes before writing the full review.

Still working: I've read the B2 migration, runner, tests and doc changes, and I'm now reading the requirements, user stories and intelligence design so the product review rests on the actual text.

I've finished reading the new snapshot (B2 migration, runner, tests, doc changes and the product docs), and the full review is below.

Scope and limits. I inspected all 76 files. I still could not run npm, tsc, vitest, Docker or Postgres in this sandbox, so every runtime claim is from reading code and is marked UNVERIFIED where it matters. Throughout, "agent" means the weaker model doing the implementation. The two parts you asked for are the review (A–AC) and the rules for the implementing agent (AD, paste-ready).

───

A. Executive Assessment

The product idea is coherent and the authority model (Canon, Experience, Timeline, AI optional) is unusually clear for this stage. The B1 fixes and most of the B2 contract decisions are real progress.

Three things need correcting before more code lands:

1. The "B1 and B2 complete" claim is not trustworthy as it stands.
◦ The production start script probably crashes the container.
◦ The migration test appears unable to target its own container.
◦ Unit tests probably need an ambient DATABASE_URL.
◦ PROJECT_STATE says "Technical Debt: None".
2. Migration 001 is unapplied, so editing it now costs nothing. It has several choices that get expensive after data exists (single-string scene prose, an unenforced immutability claim, a blob snapshot, a timeline table naming and branching problem, a plaintext session token, hot-path GIN indexes).
3. The MVP does not yet prove the thesis. Without AI, a reader sees authored text gated by variables, which is roughly Twine hosted with versioning. The deterministic mechanism that would make prose react to state, and the typed variable registry it needs, are not designed.

No finding is CRITICAL. Several HIGH items are cheap now and costly later.

B. Current Product Thesis

Re:NeWrld is a canon-controlled interactive-fiction platform. Creators author worlds, characters and branching scenes with deterministic conditions and mutations. Readers play through with persistent state. AI is an optional presentation layer. Versioned publishing is the only path to new Canon. The long-term vision is a multiverse where reader timelines become reusable content.

The problem it targets is the gap between exhausting manual branching (Twine, ChoiceScript) and lawless AI roleplay (Character.ai, AI Dungeon). The primary user is the creator, with the reader second.

C. What Re:NeWrld Does Exceptionally Well

• Authority separation is crisp and consistently stated: idea.md §3, architecture §1/§14, and governance agree that simulation, NPC and AI outcomes become Experience/Timeline and never Canon without a creator-authorized version.
• Optionality discipline: AI, cross-timeline and Overseer are repeatedly kept out of the MVP dependency graph.
• Design-first rigor with traceability in TASKS.md.
• B2 schema instincts are good: 
◦ composite same-world foreign keys (fk_choice_scene, fk_choice_target_scene);
◦ a unique (session_id, sequence_number), which is a natural double-write guard;
◦ a version column for optimistic concurrency;
◦ sessions bound to a snapshot;
◦ the explicit split between auth_sessions and reader_sessions.
• Migration runner basics are sound: advisory lock, transaction per migration, forward-only.

D. Missing Foundations

1. A deterministic way for prose to react to state (see H4).
2. A typed, namespaced variable/fact registry (see H5). It is the missing substrate for conditions, items/flags, the validator, knowledge and AI context filtering.
3. Enforcement of the Canon and Timeline immutability that the docs claim (H6).
4. A content-moderation and legal baseline for a public catalog of user-generated fiction.
5. A randomness and replay policy.
6. A versioning policy that says what happens to in-flight readers (H11).

E. Product Differentiation / Competitive Position

• Vs Twine, ChoiceScript and Ink: those are authoring tools and engines. Re:NeWrld's real difference is hosted distribution, governance and versioning. That is a platform differentiator, not a gameplay one.
• Vs AI roleplay and storytelling (AI Dungeon, Character.ai, NovelAI): the pitch is authorial canon and consistency. This is genuine, but only visible to readers if the experience feels more coherent than free-form chat.
• Vs visual novels and RPGs: no art, no systems depth in MVP.
• What is real differentiation: governed canon plus a structured world model plus (later) reuse of reader experiences. This is a data and network moat.
• What is only technically sophisticated: the AI-gateway boundary, the deterministic engine and the modular monolith. Readers will not perceive these.
• Likely reasons users will not care:
◦ the choice-fiction audience is small and prefers art and voice;
◦ AI-chat users want freedom, not governed rails;
◦ creators already have free tools (Twine, Ink) and need an audience the platform must supply;
◦ "book-quality" depends on author talent, not architecture.

F. Gameplay Red-Team

Dependency map:
• Knowledge/Information is the substrate, not a peer of Tier 1. Secrets, deception, rumors, investigation, dialogue and timeline artifacts all depend on it.
• Time underlies simulation, schedules, decay and quest deadlines.
• Entities (locations, factions, items) underlie exploration, inventory history and NPC movement. Locations and factions are Post-MVP (US-C08), but Tier 1/2 mechanics need them.
• NPC autonomy needs knowledge, relationships, goals, an action vocabulary and a location. None exist as data.
• Death/Legacy needs persistent identity across sessions, so it depends on Tier 3.
• Over-engineered (but harmless as conceptual text): Tier 3 details such as NPC timeline travel and collisions.
• Under-specified: knowledge, time and location.

Missing mechanics:
• A pacing or drama-manager concept.
• Randomness policy: seeded and recorded, or none at all.
• Fail-forward and failure states.
• A locked-choice display policy (show or hide).
• Typed variables with a visibility attribute.
• Rewind and checkpoint semantics (FR-12 is only FUTURE).

Cross-system interactions to design for:
• Autonomy × Canon: an NPC dies in one reader's simulation, but later authored scenes assume that NPC is alive. Scenes need declared state preconditions, and the validator cannot guarantee safety in simulation-heavy worlds.
• Secrets × AI presentation: if the AI sees the full state, it leaks secrets into prose. AI input must be filtered by what the reader knows, not by world truth.

G. Narrative Red-Team

• Railroad and cosmetic-choice risk is the main MVP danger. With a single scenes.prose TEXT and gating only through branches, choices change which scene comes next but never how any scene reads. Authors will converge branches, and readers will notice.
• Boring-state risk: state is invisible numbers. Readers get no "the world remembers" feedback unless the engine or text surfaces it.
• Chaos risk appears only with Tier 1+ emergence. Contain it by bounding simulation to authored vocabularies.
• Pacing: no tools. Endings: terminal nodes exist but no ending catalog or discovery metadata, so replay has no hook.
• Mystery: information gating is only boolean flags. Authors will encode knowledge as ad-hoc flag names that are painful to migrate later.

H. Character/NPC Intelligence

MVP characters are static profiles (characters has role_types, description, attributes). Nothing models knowledge, goals or relationships as data.

Minimum deterministic model before AI adds value:
1. Per-character knowledge (fact IDs with source, time, confidence) separate from truth.
2. Authored goals with priorities.
3. Relationships as typed, directed, weighted edges.
4. A finite action vocabulary with preconditions and effects (utility or goal-based selection with a recorded seed).
5. Location and schedule.
6. Forbidden-behavior constraints.

Without 1–4, an "AI NPC" is random flavored output. With them, AI has two valuable jobs: rendering dialogue for a chosen action given only known facts, and proposing candidate actions from the finite vocabulary (validated before execution).

Information propagation is graph diffusion with delay and reliability decay. Deception means an actor asserts a belief that differs from truth. Belief revision needs explicit rules.

I. World Simulation

• Where results belong: per-reader Timeline/Experience events. Never a shared world state across readers, which would be hidden Canon mutation. Promotion to Canon is an explicit creator diff into a new version.
• Rules needed to prevent hidden authorship: simulation may only select from authored or whitelisted event templates, every event carries a rule ID and provenance, and AI may only phrase.
• Cost hook: model simulation as a pure function (state, time delta, seed) → events, evaluated lazily on scene entry, with events stored rather than ticks. Tick loops over millions of readers are unaffordable.

J. Cross-Timeline/Multiverse

Treat all of this as future. These rules must exist before it is viable:
• Compatibility: canon-version and state-predicate matching. An echo from timeline B must be valid in reader A's version and state.
• Spoiler horizon: surface only content at or behind reader A's progress.
• Privacy: choices are personal data and can reveal sensitive inferences. Use opt-in, revocation semantics (including what happens to derived echoes), a minimum-population threshold against re-identification, and a pseudonymous handle separate from user_id.
• Exploits: echo farming, collusion to unlock content, injection through user-contributed text.
• Indexing: JSONB state is not queryable by similarity. Timelines need an outcome fingerprint built from variables tagged "significant", which again requires the variable registry.
• Typed, creator-whitelisted echo templates and a moderation pipeline.
• Economics: retrieval is cheaper than generation, but it creates content gravity toward popular paths.

K. Overseer/Meta-Narrative

The concept bundles two different things:
• (a) A creator-owned Director: a rule-bounded selector over authored interventions based on reader state. It has real value as a pacing and drama manager.
• (b) A platform-controlled meta-narrative: this is where the platform-backdoor, monetization-nudge and agency-destruction risks live.

Recommendation: keep (a) and defer (b) indefinitely unless product value is shown. For (a), every intervention is a registered authored object with trigger conditions, a frequency budget, diegetic reader-visible attribution and an audit trail, and AI only phrases. governance §2.11 already says opt-in, permissioned and auditable, which is the right frame.

L. AI Authority and Safety

Paths to hidden Canon authority:
1. Invented lore: AI prose adds names, abilities or backstory, and the reader treats it as fact. Constrain with an entity allowlist and a diff against the authored baseline.
2. Phantom state: AI text implies a debt or promise the state engine never recorded.
3. Secret leakage through full-state input.
4. Memory poisoning by caching or reusing AI output across readers or timelines.
5. Prompt injection through creator prose, reader-chosen names or free text. Creator content is untrusted to the platform.
6. Cache cross-leak if the cache key includes personal state.
7. Unreproducible history:reader_timelines has no field for rendered text or provenance, so reloading history could silently change what the reader "read".
8. Creator-assist output entering Canon without provenance.

Prompt-injection "scrubbing" alone (architecture §9) is not a control; structural isolation is. Keep AI optional everywhere in the MVP. The thesis leans on personalization, so build deterministic state-reactive text first (H4).

M. Creator UX

Missing pages and workflows:
• A world overview with a health panel (validation status, orphans, ending coverage).
• A variable and items registry page (H5).
• An outline (chapters, scenes, per-scene inbound references). This is MVP-critical because choices.target_scene_id is ON DELETE RESTRICT and creators will hit FK errors when deleting targeted scenes.
• A scene editor with conditional blocks and variable interpolation.
• A condition and mutation builder. Hand-typed JSON is not acceptable, so the condition AST design drives the UI.
• Preview with a state inspector and "jump to scene with this state". US-C06 is [MVP] and has no task.
• A validation report with clickable errors.
• A publish dialog with version notes and a diff.
• Version history.

Confusing mental models:
• "Canon" jargon: label it "Published version".
• After publishing, draft edits are live in draft tables but readers are unaffected. Show "unpublished changes".
• Typo fixes cannot reach readers mid-story (H11).

N. Reader UX

• Discovery: genres, content warnings, length estimates, continue-reading.
• Onboarding: who am I, what do I know, "previously on" recap on return (deterministic from the timeline first).
• Reading: typography, pacing, progressive reveal.
• Choices: diegetic locks instead of "requires trust ≥ 3"; "she will remember that" cues.
• State: the character sheet is only a SHOULD (FR-11). A minimal journal is where the product starts to feel distinct.
• Endings: ending screen, alternate endings found, restart-from-chapter. Rewind is the most-requested feature in this genre, and FR-12 is FUTURE.
• Friction: forcing registration before reading (a guest or sample mode lowers drop-off), stat overload and immersion-breaking gating text.
• What makes it different from a VN, a book or AI chat: persistent, perspective-specific consequences in a coherent canon. It only shows up if state visibly changes the text.

O. Knowledge/Information Architecture

The repo has Canon prose (unstructured) and boolean flags. It has no "fact" entity, so none of the following can be separated:

• objective world truth;
• Canon truth versus truth within one timeline;
• character knowledge, which may be false belief with provenance;
• reader knowledge (discovered facts);
• secrets with reveal conditions;
• rumors and misinformation;
• timeline-specific versus cross-timeline knowledge.

In the MVP the risk is contained, because no AI means no leak. But authors will encode knowledge as ad-hoc flags. Before any AI or Tier 1 work: a fact registry (fact_id, truth, visibility) referenced by scenes (reveals) and by reader state (known facts), with source and time attached to each knowing. The simplest MVP form is a "knowable" variable kind inside the registry in H5.

P. Database and State Architecture

Relational versus bounded JSONB versus immutable snapshot:
• Relational: users, auth sessions, worlds, chapters, scenes, choices (draft), session headers, timeline events, snapshot headers.
• Bounded, validated JSONB: scene metadata, character attributes, state_variables, state_diff, conditions, mutations.
• Immutable snapshot: the published world.

Painful to migrate after millions of sessions:
1. A single JSONB snapshot blob with no schema_version.
2. prose TEXT versus structured blocks.
3. A timeline table without rendered-text and provenance fields.
4. State and snapshot size without caps.
5. The random UUID primary key on the largest table (reader_timelines; composite (session_id, sequence_number) is smaller and better for access).
6. Immutability and referential integrity (see H6/H7).

Good: the unique (session_id, sequence_number) plus version gives double protection for F2.

Transaction ownership: correctly deferred (F2), but the docs still disagree (see section U).

Q. Security/Privacy/Trust

• Authored content as an attack surface: never render raw HTML, use a sanitized subset, and treat creator text as untrusted for AI and for readers.
• Moderation and legal for UGC: reporting, takedown, ToS, minors, DMCA, in the MVP because the catalog is public. No document exists.
• Deletion and export:reader_sessions.reader_id, worlds.creator_id and the snapshot FKs are RESTRICT, so deleting a user needs an explicit anonymization procedure. Decide soft-delete or tombstone semantics (H9).
• Session security: see H9.
• Operator authority:architecture §10 already requires an audit justification. Add break-glass logging.
• Least-privilege DB roles: the app role should not run DDL or modify immutable tables.
• Future social: a pseudonymous handle and consent model before any marketplace or cross-timeline sharing.

R. Scalability/Economics

All numbers are order-of-magnitude assumptions: about 5% daily active, 40 choices per active reader per day, 10x peak.

• 100K readers: about 2M choices a day. One small Postgres and one or two app instances are fine. The risks are correctness, not scale.
• 1M readers: about 20M choices a day (~230/s average, ~2.3K/s peak). 
◦ reader_timelines grows ~700M rows a year. It needs monthly or hash partitioning and an archive policy.
◦ A connection pooler is needed.
◦ The snapshot read path needs an in-process cache.
• 10M readers: about 10x that. 
◦ Rewriting a multi-KB TOASTed state_variables JSONB on every choice is heavy WAL and bloat, and the GIN index on it makes it worse (H10).
◦ Plan read replicas, archival and an analytics export that does not query OLTP.
◦ Timeline storage is ~2TB a year.
• AI: if every scene were AI-rendered at roughly 1.2K tokens, a cheap model costs a few thousand dollars a day at 10M readers; a frontier model costs ten times that.
• Media: images at a few cents each, per reader, is dangerous.
• Hooks needed now: per-session and per-world AI budgets, a cost-owner decision, a content-addressed presentation cache keyed without personal state, spend ceilings, kill switches.
• Architectural, not optimization: timeline keying and partitionability, the snapshot read path, state size caps, a presentation provenance field.
• Later optimization: partitioning mechanics, replicas, archival tooling.

S. Testing/Observability

testing-strategy.md is the same four-section outline as before. The docs I searched do not mention property-based testing, deterministic replay, golden fixtures or invariant tests. Needed before F2/G1:
• Property-based tests (fast-check) for the condition evaluator and mutation engine: determinism, idempotence of replay, no mutation of the input.
• Golden-scenario tests: a fixture world with scripted choice sequences and expected final state.
• Deterministic replay: replay reader_timelines from the snapshot's initial state and assert it reproduces state_variables.
• Invariant tests against Postgres: snapshot and timeline immutability, same-world FKs, optimistic-concurrency conflicts.
• Publishing-validator corpus: valid, orphaned, unreachable-ending and dead-end graphs.
• AI boundary tests: output is validated, falls back deterministically, never mutates state, never receives unknown facts.
• Observability: the correlation-ID logging is good. Add event IDs and rule IDs to state transitions now so provenance exists when simulation arrives.

T. Long-Term Failure Analysis

• Over-flexible JSON that becomes unqueryable:state_variables, canon_data, conditions and mutations without a registry.
• Overly rigid schema:prose TEXT, one role per user, single linear timeline per session.
• State explosion: no size caps and no version tag on state.
• AI cost explosion: no budget hooks.
• Privacy traps:RESTRICT deletes, personal data in cacheable keys.
• Moderation trap: a public UGC catalog without any moderation design.
• Creator bottlenecks: no outline view and no hotfix path to live readers.
• Canon and versioning problems: no change classes, no migration of in-flight sessions (DATA-03).
• Governance: a "platform Overseer" that ambiguously overlaps the creator.
• Process: completion claims that do not match the repo, repeated by weaker agents until nobody trusts the status docs.

U. Overengineering / Underengineering

Overengineered or premature:
• Five GIN indexes (H10).
• The IntfJobQueue and BullMQ naming.
• Tier 3 detail text.

The simulated service split of eight services over four modules adds documentation weight but no code cost. I withdrew that complaint before and still do.

Underdesigned:
• State-reactive text, the variable registry and the condition/mutation grammar.
• Immutability enforcement.
• Versioning change classes.
• Moderation and legal.
• Transaction ownership: service-spec, detailed-design and runtime-design still describe three different owners (section V).

Complexity such as the Canon/Experience split is justified by the thesis. Do not simplify it.

V. Required Design Corrections (not already in HIGH findings)

1. Reconcile service-specifications §2.8 (relational inventory, relationships, flags tables) with the §14 hybrid decision (JSONB state_variables).
2. Specify who owns transactions (one paragraph; F2 and E2 need it).
3. Resolve detailed-design §8.2 (POST /api/v1/sessions) versus runtime-design (POST …/worlds/{id}/sessions).
4. Decide whether Operator is an RBAC role.
5. Add presentation/ to the module tree.
6. Pick /health or /healthz/live and /healthz/ready.
7. Define the draft-side source of entry_scene_id (a worlds column or a metadata key).
8. Define worlds.status semantics (add "has unpublished changes" and an unpublished or retired state).

W. Recommended New Design Documents

1. Narrative Content Model: scene text blocks, conditional text, interpolation, dialogue.
2. World Variable & Fact Registry + Condition/Mutation Contract: types, namespaces, scopes, visibility, the AST, ordered operations, semantics (this supersedes the unresolved detailed-design §11).
3. Canon Versioning & Reader Migration Policy.
4. Timeline & Session Model: identity, fork and rewind, event provenance.
5. Knowledge & Information Model (before Tier 1).
6. Simulation Rules & Determinism Policy: seeds, lazy evaluation, event vocabulary.
7. Content Moderation & Legal Baseline.
8. Privacy & Data Lifecycle: deletion, export, anonymization, retention.
9. AI Provenance & Cost Governance.
10. Performance & Capacity Plan.

X. Recommended ADRs

• Snapshot representation and immutability enforcement.
• State-reactive text approach.
• Session token storage and lifecycle (including CSRF).
• Timeline identity and branching.
• Deletion and anonymization semantics.
• Transaction ownership.
• Randomness and replay policy.
• Index policy ("only for queries that exist").
• Zod-to-Fastify wiring.
• Fastify major version (verify the support status of 4.x).

Y. Recommended Roadmap Changes

• Add A4 (lint) and a minimal CI before C1. TASKS and ROADMAP are unchanged since the first snapshot, so the missing tasks remain: auth use cases, error envelope, creator preview, catalog, character sheet, idempotency, gateway hardening, D0 (variable and condition contract).
• Insert a "migration 001 correction" task before C1 (while it is unapplied).
• Add narrative-text and registry tasks before D1.
• Add a moderation baseline before the public catalog.
• Keep Tier 1+, cross-timeline and the Overseer out of the MVP roadmap.

Z. Top 10 Highest-Priority Findings

1. H1 Production start crash.
2. H2 Migration test cannot target its container.
3. H12 Status docs overclaim.
4. H4 No state-reactive prose.
5. H5 No typed registry or condition grammar.
6. H6 Immutability not enforced.
7. H7 Single-blob snapshot.
8. H9 Plaintext session bearer ID, case-sensitive email, RESTRICT deletes.
9. H8 Timeline identity and provenance.
10. H10 GIN indexes on hot-path tables.

AA. Top 10 Highest-Value Product Opportunities

1. Deterministic state-reactive text. This is the single biggest improvement to the MVP's value without AI.
2. A typed variable and fact registry, which doubles as the AI context filter.
3. A creator-owned Director for pacing.
4. A reader journal and recap (deterministic first).
5. Ending catalog and replay hooks.
6. Version change classes, so typo fixes reach live readers.
7. An outline view with inbound-link counts for creators.
8. Preview with a state inspector, as a deterministic playtest tool.
9. An immutable-snapshot cache. Immutability makes this a free performance win.
10. Presentation provenance as groundwork for AI and later cross-timeline reuse.

AB. Previous Audit Delta

• C-1 (test did not exercise db.ts): partially fixed. It now imports query, getClient and closePool, but swaps in the pool via the new setPool(), so the env-configured pool is never exercised, and one import (pool) is unused.
• C-2 (silent pass): fixed.SKIP_DB_TESTS / SKIP_DOCKER are explicit, and a failed startup throws.
• H-1a (DATABASE_URL default): fixed. Now required and validated, but see H1 and H3 for the regressions it caused.
• N-1 (.env never loaded): fixed, with a regression.--env-file .env is added to start and dev.
• M-2, L-1, M-3a, M-3d, M-6c, H-5a, DC-1 (Testcontainers in dev deps, @types/pino, PORT, staging, level assertion, shared/database authorized, JWT line): fixed.
• H-2a (query&lt;R> constraint): addressed (R extends QueryResultRow). Compilation is still UNVERIFIED.
• M-1c (ADR TypeBox and Next.js text): fixed in ADR-001 and ADR-003.
• H-3a, H-3b (lint, CI): still present.
• H-4b (EXPOSE 3000 vs 8080; fly.tomlmemory + memory_mb): still present.
• H-7a–i (missing tasks) and DC-2, DC-3, DC-4, DC-5, DC-12 (ADR-005) : still present.TASKS, ROADMAP, threat-model and testing-strategy are unchanged.
• DG-1, DG-2, DG-3, DG-4, DG-6, DG-7: decided in detailed-design §14. New concerns on DG-2 (H7), DG-3 (draft side) and DG-1 (the service-spec §2.8 contradiction remains).
• DG-5 (items/flags): still open. FR-02 [MUST] says "…and world items/flags", and the contract is silent.
• DG-10 (condition and mutation grammar): still open.
• DC-15/16 (gate truthfulness): partially fixed. "Zero remaining gaps" became "PASS (pending B2)", which is now stale. system-completeness.md is untouched.
• PROJECT_STATE:got worse. "Phase B (Completed)" and "Technical Debt: None identified within current B2 persistence scope" are not supported (see H12).

AC. Final Gate

DESIGN FOUNDATION NEEDS CORRECTIONS

───

HIGH findings

H1 — Production start crash (UNVERIFIED by execution, mechanism certain)
• Evidence:package.jsonstart is node --env-file .env dist/server.js. .dockerignore excludes .env. Dockerfile ends CMD ["npm","run","start"]. Node treats a missing --env-file as an error and exits.
• Why: The container exits at startup. B1/B2 changes broke the production path that the earlier version supported.
• Affects:package.json, Dockerfile, K1.
• Direction: Keep the flag on dev only. Production reads real environment variables. --env-file-if-exists exists only on newer Node versions and is not needed. Also confirm tsx --env-file .env watch … argument order against tsx --help (UNVERIFIED).
• Blocks implementation: No, but it must be fixed before any deploy. Human decision: No.

H2 — Migration test cannot target its container
• Evidence:migration.test.ts:3 statically imports runMigrations from scripts/migrate.ts, which imports env. env.ts ends export const env = validateEnv();, which is evaluated once at import. The test sets process.env.DATABASE_URL in beforeAll, after that import. runMigrations() reads the frozen env.DATABASE_URL.
• Why: The migrations run against whatever URL the shell had (or the import fails if none is set), while assertions query the container. The "tested idempotency" claim in PROJECT_STATE and CHANGELOG cannot be true as written. Possible side effect: migrating a developer's real local database.
• Affects:scripts/migrate.ts, tests/integration/migration.test.ts, B2 acceptance.
• Direction:runMigrations(connectionString) takes the connection as a parameter. The CLI wrapper passes env.DATABASE_URL. The library function never reads the frozen singleton. Confirm by running the test.
• Blocks implementation: B2 acceptance. Human decision: No.

H3 — Unit tests need an ambient DATABASE_URL (UNVERIFIED)
• Evidence:app.test.ts imports buildApp, which imports the logger and env; env now throws without DATABASE_URL. There is no vitest.config.*, and Vitest does not populate process.env from .env. No CI exists.
• Why: A clean checkout's npm test likely fails at import. This breaks the agent's own feedback loop.
• Direction: Provide a harmless test DATABASE_URL through Vitest's test.env or a setup file. Split unit and integration scripts. Add a minimal CI that runs both.
• Blocks: no. Human decision: no.

H4 — No deterministic state-reactive prose
• Evidence:001_initial_schema.sql:63scenes.prose TEXT NOT NULL. idea.md §9.3 and vision §3 require scenes that reflect state "without hallucinating".
• Why: Without AI, state affects only which scene comes next. This is the core product-value gap, and the column type is cheapest to change now.
• Direction: Decide a deterministic mechanism (conditional blocks and variable interpolation inside scene content, validated like conditions) and its storage shape.
• Blocks: D1/D2 and the migration shape. Human decision: yes.

H5 — No typed variable and fact registry; grammar unresolved; items/flags homeless
• Evidence: FR-02 [MUST] "…and world items/flags". choices.conditions and mutations default to '{}' (an object cannot represent ordered operations). detailed-design §11 and architecture §15 still list the grammar as unresolved. The draft tables have no entry-point source. FR-05 requires validating condition and mutation references against something.
• Why: The validator, the creator UI, the Zod schemas and any future AI context filter all need it. After content exists, changing variable names is a content migration.
• Direction: A minimal typed registry (type, namespace, scope, visibility, domain), stored with the world draft and copied into the snapshot, plus the AST and ordered mutation list.
• Blocks: D1, E1, G1. Human decision: yes.

H6 — Immutability claimed, not enforced
• Evidence:PROJECT_STATE, CHANGELOG and detailed-design §14.1 say "immutable published Canon snapshots" and timeline scene integrity "strictly validated". The migration has no trigger, revoked privilege or constraint, and current_scene_id, from_scene_id, to_scene_id and choice_id have no FK.
• Why: This is the platform's central invariant. One buggy UPDATE by an agent silently rewrites every reader's history.
• Direction: A BEFORE UPDATE OR DELETE trigger on snapshots and timelines (additive migration is also fine), an integration test that proves it, and an application-level reference check with tests.
• Blocks: E2, F2. Human decision: no (the invariant is already approved).

H7 — Single-JSONB snapshot on the hot path

• Evidence:published_canon_snapshots.canon_data JSONB NOT NULL, no schema_version, no size cap.
• Why: Every choice needs one scene's choices from a multi-MB blob, and Postgres detoasts the whole value for a path read. There is also no DB-level referential integrity from sessions and timelines to scenes (H6).
• Direction: Since a snapshot never changes, either an in-process LRU keyed by snapshot_id plus publish-time size caps, or a header row plus per-scene rows (published_scenes(snapshot_id, scene_id, payload)) that give PK lookups and real FKs. Add schema_version either way.
• Blocks: E2 design, B2 shape. Human decision: yes, a trade-off.

H8 — Timeline identity, branching and provenance
• Evidence:reader_timelines rows are single events yet timeline_id is per row. A "Timeline" is actually the session. There is no fork reference, no rendered-text or presentation record, and a random UUID PK on the largest table.
• Why: Rewind, save slots (FR-12), replays and cross-timeline features need timeline identity and forks. History displayed after AI rendering must be reproducible.
• Direction: Rename to events, use (session_id, sequence_number) as the PK, add nullable forked_from_session_id and forked_at_sequence, and reserve a nullable presentation JSONB for provenance later.
• Blocks: F2. Human decision: yes (naming and fork semantics).

H9 — Auth schema and data lifecycle
• Evidence:auth_sessions.session_id is a plaintext UUID that will become the cookie secret. There is no revoked_at, no last-seen or idle expiry. users.email is a case-sensitive UNIQUE. reader_sessions.reader_id, worlds.creator_id and the snapshot FKs are RESTRICT.
• Why: A DB leak means session takeover; A@x.com and a@x.com become two accounts; user deletion needs a designed procedure.
• Direction: Store a hash of a 256-bit random token. Unique index on lower(email) (or citext). Add revoked_at and last_seen_at. Decide soft-delete or anonymization.
• Blocks: C1/C2. Human decision: yes (session lifecycle, deletion semantics).

H10 — Hot-path GIN indexes
• Evidence:001_initial_schema.sql:139-144; detailed-design §14.3 #4 justifies them for "condition evaluation". service-spec §2.8 says condition evaluation is a pure in-memory step.
• Why: A GIN index on a column updated every choice (reader_sessions.state_variables) adds write amplification and disables HOT updates for the whole row. No query uses any of the five.
• Direction: Remove them from 001 (and fix the doc); idx_reader_timelines_session_id is redundant with the unique constraint. Add indexes when a real query exists.
• Blocks: B2 before deployment. Human decision: no.

H11 — Versioning policy for live readers
• Evidence: Sessions bind permanently to a snapshot, and DATA-03 is only SHOULD. Nothing classifies versions.
• Why: A creator fixing a typo cannot reach existing readers. That will feel broken fast.
• Direction: Version change classes (text-only versus structural) applied lazily by stable scene_id, recorded as snapshot metadata.
• Blocks: E2. Human decision: yes.

H12 — Status documents overclaim
• Evidence:PROJECT_STATE "Phase B (Completed)", "Technical Debt: None identified" and the "tested idempotency" claim, against H1–H3. "PASS (pending Phase B2 implementation execution)" is stale. system-completeness.md, TASKS.md and ROADMAP.md are unchanged.
• Why: Weaker agents treat the status docs as truth and build on them. A false completion claim is the most expensive recurring mistake.
• Direction: Replace absolute claims with "what ran, what did not, what is open"; close the conditional completeness gate with a dated re-evaluation.
• Blocks: nothing technically, but it undermines every later phase. Human decision: no.

Medium and Low (one line each)

• M1setPool() is a test seam in production code: mutable exported pool, un-awaited pool.end() (the try/catch won't catch async errors), duplicated pool config.
• M2 Migration runner: no checksum of applied files, IF NOT EXISTS everywhere hides drift, CREATE EXTENSION pgcrypto is unnecessary on PostgreSQL 13+ and can fail on managed databases, schema_migrations DDL is duplicated, scripts/ and tsx are not in the pruned production image.
• M3choices.target_scene_id ON DELETE RESTRICT plus cascades from worlds may fail on world or chapter deletion (UNVERIFIED; no test covers it).
• M4 No updated_at trigger; agents will forget to set it.
• M5worlds.status is only draft or published; no unpublished state.
• M6.env (a copy of the template) is inside the archive; make sure it is never committed.
• M7 No content-moderation and legal baseline for a public UGC catalog.
• M8 No size caps on world (scene count) or on state JSONB.
• M9 No randomness and replay policy.
• L1EXPOSE 3000, fly.toml memory conflict, Node version pin mismatch, README details.

───

AD. Guidance for the Implementing Agent (paste-ready)

This is written for a weaker model. Give it to Gemini or ChatGPT at the start of each task.

Rule 0 — Only claim what you ran.
• Never write "tests pass", "verified", "complete" or "no debt" unless you ran the command and can paste its output.
• If you could not run something, write UNVERIFIED and say why. A claim you did not check is a bug in the documentation.
• Before marking a task done, run, in order: npm ci, npx tsc --noEmit, npm run build, npm test, and (when Docker is relevant) docker build and docker run. Paste the results.

Rule 1 — Tests must touch the code they claim to test.
• Every test file must import the module it is about.
• Self-check: if you deleted or broke the function under test, would the test fail? If not, the test is fake.
• Never write expect(true).toBe(true). Never catch an error just to let a test pass.
• A skip must be explicit (an env flag) and show as "skipped", never as "passed".

Rule 2 — Do not read configuration at import time in library code.
• export const env = validateEnv() freezes the value at the first import, so later changes to process.env are ignored. This is why the migration test targets the wrong database.
• Library and script functions take their config (for example a connection string) as a parameter. Only the top-level entry file reads env.

Rule 3 — No test-only hooks in production modules.
• Do not export mutable globals or setX() helpers so a test can swap things. Use a factory or dependency injection.
• Never leave a promise un-awaited (pool.end() must be awaited).

Rule 4 — After changing scripts, env handling or Docker, run the whole chain.
• You changed start to node --env-file .env and the container can no longer start, because .dockerignore excludes .env.
• Check every place a change can reach: package.json scripts, Dockerfile, .dockerignore, CI.

Rule 5 — Stay inside the task's file scope.
• Do not commit tool-generated files (such as fly launch output) unless the task asked for them. If you must, list them under "Out-of-scope changes".
• No new dependency without a documented approval.

Rule 6 — Never invent requirements.
• For every behavior, cite the doc and line it comes from. If you cannot find one, do not code it. Add it under "Open questions" and stop.
• When two documents disagree, stop and ask the human. Do not pick one silently.

Rule 7 — Update docs to match reality, not plans.
• "PASS" or "zero gaps" must be followed by the list of checks that were run.
• Do not write "Technical Debt: None". Write the actual known issues.

Rule 8 — Database rules.
• If you say "immutable", enforce it (trigger or privilege) and test it.
• Add an index only for a query that exists. Do not index frequently updated JSONB.
• IF NOT EXISTS hides mistakes; version tracking already makes migrations safe.
• Maintain updated_at deliberately. Never store a bearer secret in plaintext (store its hash). Treat email case explicitly.
• Do not edit an applied migration; add a new one. An unapplied migration can still be edited.

Rule 9 — Do not guess library behavior.
• Read --help or the docs for the exact version before using a flag or API (for example the Node --env-file behavior, or tsx argument order). If you cannot check, mark it UNVERIFIED.

Rule 10 — Security hygiene.
• Never include .env or secrets in an archive or a commit. Use parameterized queries only. Redact secrets in logs, including nested paths.
• Treat creator and reader text as untrusted input everywhere it is rendered or sent to AI.

Rule 11 — Report format for every task.
1. What I changed (files).
2. What I ran, with the exact commands and their output.
3. What I could not verify (UNVERIFIED) and why.
4. What is out of scope or still open.
5. Questions for the human.

Rule 12 — Stop and ask when: two docs conflict, a requirement is missing, a task needs a new dependency, or you want to touch a file outside the task.

Mistakes already made here, with the rule that prevents each:
• A "database test" that never used the pool code → Rule 1.
• A test that could pass without a database → Rule 1.
• "Successfully executed" with no evidence → Rule 0.
• Config frozen at import broke the migration test → Rule 2.
• A swap-the-pool hook in production code → Rule 3.
• A start script that cannot run in the container → Rule 4.
• Deployment files added outside the task → Rule 5.
• "Technical Debt: None" → Rule 7.
• Five unneeded GIN indexes → Rule 8.

───

What the team should do NEXT

1. Correct B1/B2 (small patch, with real output pasted):
◦ Fix the start and dev scripts (H1).
◦ Make runMigrations take a connection string, and re-run migration.test.ts against the container (H2).
◦ Provide a test DATABASE_URL through Vitest config (H3).
◦ Replace setPool with a factory or injection (M1).
◦ Re-run tsc, build and tests.
2. Edit migration 001 now, while it is unapplied.
◦ Drop the GIN indexes (H10).
◦ Rename timeline events and decide the key and fork fields (H8).
◦ Store a token hash, add lower(email) uniqueness, add revoked_at (H9).
◦ Add a trigger plus test for immutability (H6).
◦ Add schema_version to snapshots and the draft entry-point source (H5/H7).
◦ Remove pgcrypto and the redundant indexes.
3. Hold one decision session on four items: state-reactive prose (H4), the variable registry and condition grammar (H5), snapshot shape (H7), and version change classes (H11). Record each as a short ADR.
4. Truthfulness pass on the docs:PROJECT_STATE, the completeness gate, the stale "PASS (pending B2)" lines, the remaining contradictions (section V), and the missing tasks in TASKS.md.
5. Add minimal lint and CI, then start C1.

Everything in Tier 1–3, the Overseer and cross-timeline can wait. No files were modified.