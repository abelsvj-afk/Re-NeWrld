# Phase 1: Vision & Scope Lock — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Product Mission
To build a canon-controlled interactive narrative platform across **arbitrary genres and hybrid narrative formats** where creators author rich, structured story worlds and readers experience personalized, book-quality journeys powered by persistent state choices and governed presentation, uniting authorial intent with meaningful player agency.

## 2. Primary Users & Beneficiaries
- **Creators / Authors**: Writers, world-builders, and narrative designers across any genre (e.g., sci-fi, fantasy, historical fiction, thriller, mystery, romance, horror, literary, or cross-genre hybrids) who require tools to define canonical worlds, flexible character roles (protagonists, antagonists, companions, rivals, villains, factions, and custom roles), lore, chapters, and branching narrative conditions without combinatorial explosion.
- **Readers / Players**: Interactive fiction enthusiasts who want to immerse themselves in deep, authored literature where their decisions matter and permanently reshape character relationships, world status, and story outcomes.

## 3. Core Principles & Architecture Boundary
- **Canon vs. Experience**: Canon (world history, immutable lore, core characters, major plot milestones) is absolute and creator-authored. Experience (reader-specific events, relationship shifts, inventory, and resolutions) is derivative and state-driven.
- **AI-Independent Core Engine**: The MVP must function fully using authored deterministic narrative content and state tracking without requiring an AI model. 
- **AI Presentation Layer**: AI functions strictly as an optional enhancement and linguistic flavoring layer (rendering prose, adapting tone, generating contextual character reactions) and never owns story logic or canon authority.

## 4. Scope Boundary
### In-Scope (MVP)
- **World & Character Authoring**: Creator tools to define world metadata, character profiles (identities, personalities, goals, relationships), and chapters/scenes.
- **Scene & Choice Authoring Engine**: Tools to author prose and attach structured choices with conditional requirements and state-mutation effects.
- **Immersive Reader UI**: A clean, book-reading interface presenting narrative prose followed by meaningful choice selection.
- **Persistent State & Variable Engine**: Tracking reader variables (inventory, trust/relationship scores, custom flags) across scenes.
- **Governed Prose Presentation**: Rendering scene text and tailored dialogue reflecting current reader state under strict canon boundaries.

### Post-MVP (Future Capabilities)
- Multi-author collaborative world-building and lore wikis.
- Creator publishing marketplace and monetization tools.
- Advanced procedural side-events governed by AI within creator safety bounds.
- Audio text-to-speech (TTS) narration and dynamic generated scene illustrations.
- Companion mobile apps with offline reading support and sync.

### Explicitly Excluded (Non-Goals)
- Re:NeWrld is **not** an open-world generic AI sandbox where readers can invent arbitrary non-canon plotlines.
- Re:NeWrld is **not** a general-purpose e-reader for standard EPUB/PDF books without interactivity.
- Re:NeWrld is **not** a low-level code-based visual novel game engine (like Ren'Py).

## 5. Measurable Success Metrics
- **Creator Onboarding & Authoring Velocity**: A creator can successfully define a world, 3 characters, 2 chapters, and 5 interactive scenes within 60 minutes.
- **Reader Engagement & Immersion**: Readers complete structured reading sessions with an average session length > 30 minutes and a completion rate > 70%.
- **State Fidelity & Canon Integrity**: Deterministic state transitions and conditional requirement evaluations are 100% testable and verified, while optional AI enhancement outputs are validated against established canon rules.

## 6. Resolved MVP Product Decisions
1. **Protagonist Identity**: MVP readers step into the authored protagonist defined by the creator; custom protagonist creation is deferred to Post-MVP/Future.
2. **Choice Structure**: MVP choices are strictly discrete authored options (explicit choices); free-text input evaluation is excluded from MVP.
3. **Relationship/Condition Mechanics**: MVP conditions use a deterministic, explicitly defined rule system (comparisons, boolean AND/OR, inventory checks, relationship thresholds) rather than AI judgment. Formal grammar syntax is finalized during Contracts & Schemas.
4. **Ending Criteria**: MVP stories require explicit authored terminal/ending nodes. Reaching a terminal node completes the reader's journey.
5. **Publishing Validation**: MVP publishing validation is explicitly REQUIRED for MVP (validate referenced targets, detect unreachable/orphaned scenes, verify paths reach at least one valid ending, validate condition/mutation references). Advanced graph visualizers and automated simulation remain Post-MVP.
