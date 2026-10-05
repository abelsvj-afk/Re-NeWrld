# Phase 0: Problem Discovery — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Project Name
Re:NeWrld

## 2. Problem Statement
Traditional books and visual novels offer rich, deeply authored narratives but lack player agency—readers are passive observers unable to influence the outcome. Conversely, open-ended AI roleplaying or generative text games offer freedom but suffer from narrative collapse, loss of authorial intent, logical inconsistencies, and lack of canon control. Creators lack a platform where they can author rich, canonical story worlds (complete with characters, lore, branching paths, and rules) while allowing readers to experience personalized, butterfly-effect narrative outcomes through meaningful choices without destroying the author's canon.

## 3. Foundational Product Principles: Canon vs. Experience
- **Canon (Creator-Established Truth)**: The immutable foundation authored by the creator—including world history, fundamental lore, core characters, immutable backstories, universal rules, and major milestone plot events. Canon is absolute and cannot be rewritten by reader choices.
- **Experience (Reader-Specific Journey)**: The unique sequence of events, emotional tone, relationship shifts, inventory, discoveries, state variables, and resolution experienced by one specific reader through their choices. The Experience is derivative of and constrained by Canon.

## 4. Architectural Separation: AI as Enhancement, Not Authority
- **AI-Independent Core Engine**: The core narrative and state engine (branching logic, conditional checks, variable tracking, state mutations, and progression rules) must be conceptually and architecturally capable of functioning entirely without AI. Deterministic logic dictates whether paths open or close.
- **AI Presentation Layer**: Artificial Intelligence serves strictly as an enhancement, presentation, and linguistic flavoring layer (e.g., dynamically adapting prose tone, generating contextual character reactions based on state, and smoothing narrative transitions). AI never owns story logic, state authority, or canon validity.

## 5. Target User
- **Primary Creators / Authors**: Writers, world-builders, and narrative designers who want to craft deep, branching story worlds, characters, and canon without writing infinite combinatorial text manually.
- **Primary Readers / Players**: Fans of interactive fiction, tabletop RPGs, and immersive storytelling who want to step inside a deeply crafted book, make meaningful choices, and experience personalized narrative journeys influenced by persistent character states.

## 6. Current Alternatives
- **Linear Books & E-Books**: High authorial quality, but zero interactivity or personal agency.
- **Choose-Your-Own-Adventure / Branching Visual Novels (e.g., ChoiceScript, Twine)**: Author-controlled, but creating massive branching trees manually is exponentially exhausting and rigid.
- **Open-Ended AI Roleplay / Chatbots (e.g., Character.ai)**: High interactivity, but lacks canon structure, structured story progression, plot pacing, and authorial control, leading to repetitive or hallucinated loops.
- **Novel Crafter / AI Writing Assistants**: Focused on helping authors *write* novels, not on delivering an interactive reader platform where readers experience the story with persistent state.

## 7. Consequences of Not Solving
Without Re:NeWrld, creators remain trapped between exhaustive manual graph-building (rigid branching) and lawless AI generation (loss of story quality). Readers are forced to choose between passive reading or ungrounded sandbox chatting. There is no unified medium for canon-controlled interactive literature.

## 8. Core Value Proposition
Re:NeWrld bridges authored narrative and reader agency by providing a platform where creators author canonical worlds, characters, and structured paths, and readers experience a personalized, book-quality narrative where choices persistently alter character state, relationships, world lore, and future outcomes via governed AI presentation without breaking authorial canon.

## 9. Success Criteria
- Creators can successfully define a world, characters, lore, chapters, and scenes with structured choices and conditions.
- Readers can read through authored chapters, encounter meaningful decision points, and make choices that modify persistent reader state (inventory, trust, reputation, flags).
- Subsequent scenes dynamically reflect reader state changes and choice history without hallucinating contradictions to established canon.
- Preservation of reading immersion (feels like reading a book rather than clicking endless menus or chatting with a generic bot).

## 10. MVP Definition & Scope
### MVP Requirements (In-Scope)
- **Creator World-Building Core**: Define basic world setting, characters (with identities, personalities, goals, and relationships), chapters, and narrative scenes.
- **Authoring Engine**: Ability to write scene prose (narration/dialogue) and attach structured choices with conditional requirements and state-mutation effects.
- **Reader Experience Engine**: Immersive reading interface presenting authored prose followed by meaningful choices.
- **Persistent State & Variable Tracking**: Tracking reader variables (inventory, relationships, reputation, custom flags/counters) across scenes.
- **Dynamic Prose Presentation**: Rendering scene text and tailored dialogue/reactions respecting current reader state under strict canon rules.

### Future Ideas (Post-MVP / Out of Scope for MVP)
- Multi-author collaborative world building and lore wikis.
- Marketplace and monetization for published creator stories.
- Advanced procedural side-events governed by AI within strict creator-defined safety bounds.
- Audio narration (TTS) and dynamic generated illustrations for scenes.
- Companion mobile apps with offline reading and push notifications.

## 11. Important Unresolved Product Questions (Post-MVP & Future Considerations)
1. **First-Reader Profile**: Who is the exact initial target reader segment for validating the platform's reading-to-agency balance?
2. **Degree of Reader Freedom**: Beyond discrete MVP choices, how might open-ended natural language input be safely supported in future post-MVP iterations?
3. **Branch-Explosion Management**: For complex post-MVP branching worlds, what advanced visualization tools will assist creators beyond basic publishing checks?
4. **Creator Path Simulation & Testing**: How will automated bot simulation be designed for post-MVP continuity testing?

## 12. Explicit Non-Solutions
- Re:NeWrld is **not** an open-world generic AI sandbox where readers can invent arbitrary non-canon plotlines out of nowhere.
- Re:NeWrld is **not** a general-purpose e-reader for standard EPUB/PDF books without interactivity.
- Re:NeWrld is **not** a code-based visual novel game engine (like Ren'Py).
