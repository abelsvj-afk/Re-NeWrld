# Re:NeWrld — Creator Studio and AI Assistant Vision

## 1. Creator Studio: the core creative workspace. Inspired by NovelCrafter, but designed for Re:NeWrld’s larger vision.
- A central dashboard for worlds, drafts, projects, and recent activity.
- A guided setup for creators who are starting with only an idea.
- An advanced workspace for experienced writers and worldbuilders.
- A connected World Bible that organizes canon, lore, characters, locations, factions, objects, relationships, timelines, and story structure.
- A writing editor with outlines, chapters, scenes, revisions, and writing assistance.
- Flexible planning for story arcs, scene beats, alternate possibilities, and branching narratives.
- A reader-preview mode to experience a story before releasing it.
- Validation and publication preparation, followed eventually by release management and expansion.

## 2. A persistent AI assistant built into Re:NeWrld. The AI should be more than a writing chatbot. It should act as a creative partner, project assistant, and authorized agent that can perform work inside the application.
- A persistent assistant available throughout the Creator Studio.
- Natural-language commands: creators describe the desired outcome instead of navigating every tool manually.
- Project awareness: the assistant can access relevant world information, project state, and story context through authorized application tools.
- Task planning: break complex requests into smaller, understandable steps.
- Actual execution: create, edit, organize, analyze, validate, and prepare project content using real application capabilities.
- Progress tracking and completion reports.
- Clear communication when a task fails, is blocked, or remains unverified.

Example request: “Audit my world for contradictions, fix safe structural issues, and show me the canon conflicts that need my approval.” The assistant should perform the authorized work—not merely explain how the creator could do it

## 3. Author-controlled AI and permissions. Creators should decide how much autonomy the assistant receives.
### Consult. Answer questions, analyze, explain, and suggest.
### Prepare. Draft content and stage proposed changes for review.
### Execute. Make changes within explicitly granted permissions.
### Autopilot. Complete bounded workflows independently, with checkpoints for risky actions.

Additional requirements:
- Creators control the AI provider, model selection, prompts, and context where supported.
- Support user-owned API keys where appropriate, with clear cost and privacy controls.
- Require stronger authorization for public publishing, destructive actions, major canon changes, and spending money.
- Track changes, show diffs, preserve revision history, and support rollback where technically possible.
- Never claim a change succeeded unless the application confirms it.

## 4. The World Brain: interconnected knowledge and continuity.
The World Brain serves as the intelligent connective tissue of the Creator Studio, maintaining a unified semantic graph of the story world. It links every creative asset—characters, factions, locations, lore, objects, and story structure—so that creators maintain absolute narrative coherence across complex branching narratives.

Requirements:
- Entity relationship and timeline history tracking across all world assets.
- Automatic cross-referencing between prose text and world canon definitions.
- Proactive continuity analysis flagging contradictions, logical inconsistencies, or timeline anachronisms.
- Dependency mapping identifying exactly which scenes, choices, or chapters reference specific characters, items, or lore elements.
- State change and progression tracking across chapters and drafts.
- Secure separation between private creator brainstorm notes/secrets and published canon assets.

Example: If a character dies in Chapter 3, the World Brain flags subsequent chapters or scenes that assume that character is still alive.

## 5. Interactive storytelling and world simulation.
Re:NeWrld bridges traditional literary authoring with rigorous, deterministic state management and simulation, enabling rich interactive fiction without sacrificing authorial control.

Feature bullets:
- Branching scene editors providing intuitive visual and structural narrative flow management.
- Deterministic condition evaluation and state mutation rules governing narrative progression.
- State-reactive prose and variable interpolation within scene text blocks.
- Choice gating based on player inventory, attributes, trust scores, and custom world flags.
- Multi-chapter story structuring, chapter sequencing, and structural organization.
- Terminal ending management and reachability validation ensuring every path can reach a valid conclusion.
- Creator preview simulation engine enabling safe path testing and runtime state inspection without polluting live reader sessions.
- Versioned snapshot generation creating immutable, read-only published canon versions.

Gameplay tiers:
- **Tier 1 (Foundational Simulation & Dynamics)**: Knowledge tracking, character agency & NPC autonomy, relationship networks, time/world simulation, consequences/reputation tracking, and secrets/truth mechanics.
- **Tier 2 (Emergent Mechanics & Social Systems)**: Exploration mechanics, quests/objectives, inventory/object history tracking, character development & emergent traits, death/legacy systems, and social/dialogue frameworks.
- **Tier 3 (The Living Multiverse & Overseer Layer)**: Living world engine, cross-timeline gameplay, timeline artifacts, NPC timeline travel, timeline collisions, and platform meta-narrative / Overseer layer.

## 6. The complete creator workflow. Imagine → Build the world → Write → Connect scenes → Preview → Validate → Publish → Expand. The assistant should be available throughout this journey. A creator can work manually, delegate a task, inspect the result, and continue editing without leaving the project.

## 7. Future design and engineering work. Once the current Phase D implementation has been completed and verified, the saved ideas can be translated into formal requirements and architecture.
- Define the Creator Studio functional requirements and user stories.
- Design the assistant's task-execution and tool-permission architecture.
- Define world knowledge retrieval, continuity analysis, and dependency tracking.
- Design provider integration, privacy, security, and cost controls.
- Specify approval queues, revision history, audit logs, and recovery behavior.
- Break approved designs into small, independently testable tasks.
- Update the roadmap only through an explicitly authorized design/specification change.

## Product principle. Re:NeWrld should let creators build worlds, author stories, and delegate real creative work to an AI assistant that understands their projects and respects their authority.

## Status and constraints. This document records proposed design concepts only. It does not authorize implementation, alter approved requirements or architecture, change the roadmap, or declare any feature implemented. NovelCrafter is a reference for selected authoring concepts, not a requirement to copy its implementation.
