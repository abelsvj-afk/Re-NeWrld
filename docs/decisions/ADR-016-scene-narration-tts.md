# ADR-016: Scene Narration via ElevenLabs TTS (H-UI-tts Pull-Forward)

- **Status**: Draft (product-owner review pending)
- **Date**: 2026-10-15
- **Decision Makers**: Sajacous Smith (product owner)
- **Consulted**: AI engineering agents (design gate)
- **Classification**: Level 3 (new external integration + new persistent data)
- **Process**: Phase 21 (Iteration & Expansion) pull-forward of deferred item H-UI-tts (TASKS.md §5)

---

## 1. Context

TASKS.md §5 defers **H-UI-tts** ("Audio TTS narration and dynamic generated scene illustrations") to Future. The product owner has pulled it forward and connected an ElevenLabs starter plan (40,000 characters/month) via the `custom.elevenlabs` connector.

Binding requirements from existing docs:

- **future-vision.md §6.2**: "Dynamic Audio (Music, Voice, & SFX)" — ambient soundtracks, dynamic voice flavoring, and sound effects tied to narrative events.
- **future-vision.md Layer 7**: "AI/Media Presentation" — optional generative enhancement layers (dynamic audio, voice) driven by creator and platform APIs.
- **future-vision.md §3.3**: "Cost & Richness Optimization via Outcome Reuse" — the system draws upon existing generated outcomes before triggering new AI/media generation runs; fallback generation only when no compatible outcome exists.
- **vision.md §4**: TTS narration listed as post-MVP capability.
- **AGENTS.md**: enforce token/cost budgets; human approval gates for financial actions. API keys via Secure Vault / env only, never committed.
- **Product owner's explicit requirements** (2026-10-14):
  1. Multi-voice: narrator voice + per-character voices (21 ElevenLabs voices available).
  2. Generate-once-available-forever: one person generates audio for a scene, every future reader gets it free — no per-reader quota burn.
  3. Lazy per-scene generation: narrate on first read, not all upfront (quota efficiency for branching books).
  4. Bulletproof persistence: audio survives app updates, version changes preserve old audio for in-progress readers.
  5. UX bar: same as Phase H — "super professional, super clean," visible interactive components, never vibe-coded.

Current state: no narration infrastructure exists. The reader UI (`ReaderPage.tsx`) presents prose + choices with no audio. The `custom.elevenlabs` connector is verified (account, quota, voices, models all readable).

---

## 2. D1 — Narration architecture: server-side proxy with content-addressed permanent cache

**Decision**: All ElevenLabs calls go through a backend narration service. The API key never leaves the server (env var / Secure Vault). Audio is cached permanently, keyed by content hash.

**Cache key**: `sha256(world_id + canon_version + scene_id + prose_text + voice_id + model_id)` → stored as MP3 on persistent volume.

**Why this shape**:
- §3.3's outcome-reuse pattern maps 1:1 — the cache *is* the "compatible existing outcome" check; generation is the fallback.
- Published canon is immutable → published scenes' prose never changes → cache entries for published versions are permanent by construction.
- New world versions produce new hashes → new audio; old versions keep old audio for readers mid-journey (no broken playback).
- Readers never trigger spend: `GET /worlds/:id/scenes/:sceneId/narration` serves cached audio; only a cache miss on an authorized path triggers generation.

**Alternatives rejected**:
- *Client-side direct ElevenLabs calls*: exposes the API key, no shared cache, every reader burns quota. Rejected on security + cost.
- *Pre-generate all scenes at publish*: wastes quota on unreachable branches. Lazy generation + permanent cache strictly dominates.

---

## 3. D2 — Voice model: v1 single narrator, v2 character voices

**Decision**: Ship in two stages.

**v1 (this ADR)**: One narrator voice per world, chosen by the creator from the ElevenLabs voice list. The entire scene is narrated in that voice. Simple, predictable quota math.

**v2 (future, depends on character codex)**: Creator assigns voices to characters. The narration service splits scene prose into narration vs. dialogue segments (quoted text attributed via dialogue parsing), synthesizes each segment in the appropriate voice, and stitches into one MP3 per scene. Character voice mapping lives with character profiles (US-C03), which is why v2 waits on the codex.

**Why staged**: v1 delivers the user's core ask (realistic voice for books) with bounded complexity. v2's dialogue attribution needs character identity infrastructure that doesn't exist yet. Building v2 now would be speculative.

---

## 4. D3 — Cost controls (System Completeness Gate requirement)

**Decision**: The workflow mandates AI cost controls (budget limits, quota alerts, circuit breakers). Implementation:

1. **Pre-generation quota check**: before any synthesis, read `/v1/user` for remaining characters. If the scene's character count exceeds remaining quota → 402 with a clear creator-facing message, no partial spend.
2. **Per-scene character cap**: scenes over 5,000 characters are rejected for narration (prevents runaway spend on a single scene; creator can split the scene).
3. **Monthly spend ledger**: persist `characters_synthesized` per month; expose in creator UI as a quota bar. Alert at 80%.
4. **Circuit breaker**: 3 consecutive ElevenLabs failures → narration marked degraded, serving continues without audio (graceful, never blocks reading).
5. **Idempotent generation**: concurrent first-reads for the same uncached scene converge on one synthesis (DB row lock on the cache key, mirroring G2's D3a pattern).

---

## 5. D4 — API contracts

**New endpoints** (creator-only for generation, public for serving):

- `POST /worlds/:id/scenes/:sceneId/narration` (creator-only): trigger generation. Body: `{ voiceId: string, modelId?: string }`. Returns `202` with `{ status: 'generating' | 'cached', audioUrl }`.
- `GET /worlds/:id/scenes/:sceneId/narration`: serve cached MP3 (or `404` with `{ status: 'not_generated' }`). No auth beyond session — any reader of a published world can fetch.
- `GET /worlds/:id/narration/quota`: creator-only, returns `{ used, limit, resetAt }` for the quota bar.

**New persistent data**: `scene_narrations` table: `(world_id, canon_version, scene_id, prose_hash, voice_id, model_id, audio_path, character_count, created_at)`. Unique on the content-hash key.

---

## 6. D5 — UX/UI requirements (Phase H quality bar)

**Decision**: Narration UI meets the same bar as the Phase H reader — dark cinematic, professional, interactive. Not a bare `<audio>` tag.

**Reader**:
- Per-scene narration control: play/pause button with waveform progress, styled to the dark-cinematic theme, placed above the prose (visible, not buried).
- Playback state persists per session (pause on choice, resume on next scene is v2).
- Graceful no-audio state: scenes without narration show no control (not a broken player).

**Creator**:
- Voice picker in the scene editor: dropdown of ElevenLabs voices with preview playback.
- "Generate narration" per scene with visible progress; quota bar showing monthly usage.
- Regenerate option when prose changes (new hash → new audio, old preserved for published versions).

**Visibility**: narration status is visible in the scene list (icon per scene: narrated / generating / none).

---

## 7. Security considerations

- API key in env / Secure Vault only; never in client bundle, logs, or repo.
- SSRF defense: ElevenLabs hostname allowlisted; no user-controlled URLs in synthesis requests.
- Timeouts: 120s synthesis timeout with retry-once; circuit breaker per D3.
- Audio files served with content-type validation; no user upload path (generation only).

---

## 8. Consequences

**Positive**:
- Delivers H-UI-tts's core value (voice narration) with bounded scope.
- §3.3 reuse pattern honored: one-time global cost, free forever after.
- v1/v2 staging keeps the change proportional (AGENTS.md).

**Negative / risks**:
- Monthly quota is a hard ceiling (40k chars). A long book + regenerations can exhaust it; the quota bar + caps mitigate, not eliminate.
- Audio storage grows monotonically (never deleted for published versions). Volume sizing must account for this.
- v1's single voice is a simplification; creators wanting full cast audio wait for v2.

**Acceptance criteria**:
1. Creator picks a voice, generates narration for a scene, hears it in the reader.
2. Second reader of the same scene triggers zero ElevenLabs calls (cache hit).
3. Prose edit → new audio generated; published version's old audio still serves.
4. Quota exhausted → clear 402, reading unaffected.
5. UI meets Phase H bar (product-owner visual sign-off).

---

## 9. Open decisions (product owner)

1. Default narrator voice for *Shadowborn* (recommendation: George — "Warm, Captivating Storyteller").
2. Whether v1 ships per-scene generation only, or also a "narrate all" batch action (batch risks quota exhaustion; recommendation: per-scene only in v1).
3. Audio retention policy for draft (unpublished) scenes when deleted.
