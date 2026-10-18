# System Completeness Gate — Re:NeWrld

Governed by **Project Growth v1.1.0**.

> **MASTER RULE**: No implementation code is written until every category in this gate has been evaluated for the approved scope.
> **MANDATORY N/A JUSTIFICATION**: If any category or control does not apply to this project, it must be explicitly marked **N/A with written architectural justification**.
> **ANTI-OVERENGINEERING**: Implement only project-appropriate controls. Do not add speculative technology.

---

## 1. Architecture, Perimeter & Middleware
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Network Perimeter** | Reverse proxy, CDN, or WAF considerations | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Standard web application perimeter routing for creator and reader traffic. |
| **API Gateway** | Routing, TLS termination, auth offload | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Managed in Phase 5 Architecture for web endpoints. |
| **Security Headers** | CSP, HSTS, X-Content-Type-Options, Frame-Options | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Mandatory for protecting reader and creator sessions. |
| **CORS Policy** | Explicit origin allowlist (no credentials + wildcard) | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Strict origin controls for web client access. |
| **Request Correlation** | Unique Request IDs for distributed tracing/logs | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Essential for tracing choice transitions and state mutation logs. |
| **Traffic Control** | Rate limiting, throttling, and request-body limits | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Protects against authoring spam and brute-force auth attacks. |
| **Abuse Defense** | Brute-force protection, bot/spam prevention, ATO defense | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Account protection for Creator and Reader dashboards. |

---

## 2. Core Security & Injection Defenses
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Input Validation** | Strict schema validation at all entrypoints | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Mandatory for authoring forms, choice selections, and condition rules. |
| **SQL / NoSQL Injections** | Parameterized queries, prepared statements | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Standard database security for Canon and Experience data. |
| **XSS & CSRF** | Context-aware encoding, strict CSP, SameSite cookies | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Protects authored prose and reader session state. |
| **SSRF Defenses** | URL validation, blocking private/internal IP ranges | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Applies to optional external AI/media API integrations. |
| **File Upload Safety** | Magic-byte checks, size caps, isolated non-exec storage | [x] Planned <br> [ ] Implemented <br> [ ] N/A | For future cover art, illustration assets, and story packages. |
| **Authentication & RBAC** | Password hashing (Argon2id/bcrypt), session security, least privilege | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Enforces strict role separation between Creators and Readers. |
| **Secrets & Encryption** | Zero hardcoded secrets, TLS 1.3/1.2 transit, at-rest encryption | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Mandatory for protecting creator IP and reader session data. |
| **Supply Chain Security** | Lockfiles, dependency vulnerability scanning | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Permissive open-source licenses (MIT/Apache 2.0) with dependency lockfile audits. |
| **Webhook Security** | HMAC signature verification, timestamp anti-replay | [ ] Planned <br> [ ] Implemented <br> [x] N/A | Not required for MVP (no external webhooks in deterministic core). |
| **Audit Logging** | Tamper-evident logging for auth and admin events | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Tracks publishing actions, account updates, and moderation logs. |

---

## 3. AI Safety & Authority Boundaries
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Prompt Injection** | Direct and indirect prompt injection defenses | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Enforced via AI-03 (untrusted-input isolation and bounded AI authority). |
| **Tool Permissions** | Least-privilege tool access, strict argument validation | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Mandatory for any future AI assistant or media generation tools. |
| **Data Exfiltration** | Prohibit AI transmission of secrets/PII to external sinks | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Protects reader journey state and creator IP. |
| **Memory Poisoning** | Validate provenance before writing to long-term memory | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Ensures AI presentation outputs cannot rewrite Canon or Experience state. |
| **Output Validation** | Validate AI responses against schemas/contracts | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Ensures optional presentation outputs respect creator Canon rules. |
| **Approval Gates** | Explicit human approval for destructive/financial actions | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Required for story publishing, account deletion, and monetization. |
| **Cost & Token Caps** | Per-request token caps, budget limits, quota alerts | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Governs optional AI presentation and future generative features. |
| **Source of Truth** | Data > Memory > Context > AI Reasoning > Action | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Strict adherence: Deterministic backend state is absolute authority; AI is presentation only. |

---

## 4. Product & Platform Completeness
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Responsive UI/UX** | Mobile, tablet, desktop viewport adaptability | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Clean, distraction-free reading and authoring interfaces. |
| **Accessibility (a11y)** | WCAG 2.1 AA, keyboard access, color contrast | [x] Planned <br> [ ] Implemented <br> [ ] N/A | High contrast modes, font scaling, and keyboard navigation. |
| **Branding & Assets** | Vector logos, favicons, Apple touch icons, OG cards | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Standard platform branding assets. |
| **PWA & Manifest** | `manifest.json`, theme colors, offline strategy | [ ] Planned <br> [ ] Implemented <br> [x] N/A | Deferred to Post-MVP mobile reader apps. |
| **Mobile & App Store** | Adaptive/notification icons, splash screen, deep links | [ ] Planned <br> [ ] Implemented <br> [x] N/A | Deferred to Future mobile platform integration. |
| **Edge States** | Offline behavior, permission-denied flows | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Handled via atomic persistence error handling and rollback protection. |

---

## 5. Reliability & Operations
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Error & Resilience** | Structured errors, retries with backoff/jitter, timeouts | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Ensures resilient choice evaluation and storage persistence. |
| **Idempotency** | Idempotency keys for mutations/webhooks | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Prevents duplicate state mutations on reader choice selection. |
| **Health Checks** | Distinct liveness (`/healthz/live`) and readiness (`/healthz/ready`) | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Standard operational monitoring endpoints. |
| **Observability** | Structured JSON logs with request IDs, metrics, alerts | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Correlation IDs for tracing reader sessions and authoring actions. |
| **Database Migrations** | Forward/backward compatible zero-downtime migrations | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Ensures safe evolution of Canon and Experience data schemas. |
| **Environments & CI/CD**| Strict dev/staging/prod isolation, automated tests | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Mandatory testing pipeline for deterministic state engine and authoring validation. |
| **Disaster Recovery** | Off-site backups, restore testing, rollback procedures | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Protects published creator worlds and reader session progress. |

---

## 6. Data Governance & Privacy
| Category | Requirement / Control | Status | Architectural Justification / Notes |
| :--- | :--- | :---: | :--- |
| **Data Ownership** | Explicit owner for every persistent entity | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Creators own Canon data; Readers own Experience runtime data. |
| **Data Minimization** | Collect and retain only necessary fields | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Strict adherence to privacy and minimal telemetry. |
| **Retention & Deletion**| Lifecycle schedules, soft/hard deletion workflows | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Supports account deletion and right-to-be-forgotten workflows. |
| **User Data Portability**| Standardized data export capabilities (JSON/CSV) | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Allows creators to export story projects and readers to export journey logs. |
| **Third-Party Vendors** | Inventory of data processors and compliance verification | [x] Planned <br> [ ] Implemented <br> [ ] N/A | Oversight of hosting providers and optional AI presentation APIs. |

---

## 7. System Completeness Gate Evaluation Summary
- **Overall Gate Result**: **PASS (CONDITIONAL PENDING SYSTEM ARCHITECTURE & CONTRACTS)**
- **Audit Findings**: All required specifications (Idea, Vision, Requirements, User Stories, Future Vision, Governance) are fully documented, internally consistent, and strictly adhere to MVP scope boundaries, the 11 authority tiers, Canon vs. Experience separation, and the Backend Determinism principle.
- **Unresolved Items**: Two administrative governance questions remain open (Moderation SLA and Cross-Timeline opt-out granularity), but these do not block Phase 5 System Architecture or MVP core engineering.

---

## 8. Scope Evaluation: ADR-016 Scene Narration via ElevenLabs TTS (2026-10-15)

Scope: server-side ElevenLabs proxy, content-addressed permanent audio cache, per-scene lazy generation, creator voice picker, reader playback UI. Level 3 change, Phase 21 pull-forward of H-UI-tts.

| # | Category | Applies | Evaluation / Justification |
|---|---|---|---|
| 1 | Security & Middleware | Yes | API key in env/Secure Vault only, never client-side. SSRF: ElevenLabs hostname allowlisted, no user-controlled URLs. Rate limiting on generation endpoints (creator-only). Request IDs on synthesis calls for tracing. |
| 2 | AI Safety & Governance | Yes | Cost controls are the primary gate: pre-generation quota check, 5k char/scene cap, monthly spend ledger with 80% alert, circuit breaker after 3 failures (graceful degradation — reading never blocked). Approval: creator explicitly triggers each generation (no autonomous spend). |
| 3 | Product Completeness | Yes | Reader playback UI (play/pause, waveform progress, dark-cinematic theme), creator voice picker with preview, quota bar, per-scene narration status icons. Live UX Verification Gate (AGENTS.md §6) applies before sign-off. WCAG: player keyboard-accessible. |
| 4 | Reliability & Operations | Yes | 120s synthesis timeout, retry-once, idempotent generation (DB row lock on cache key — one synthesis per content hash even under concurrent first-reads). Health: narration marked degraded on circuit-breaker, serving continues from cache. Audio on persistent volume; included in backup scope. |
| 5 | Data Governance & Privacy | Yes | New `scene_narrations` table (world_id, canon_version, scene_id, prose_hash, voice_id, model_id, audio_path, character_count, created_at). Owner: creator (tied to world). Retention: published-version audio permanent (canon immutability); draft audio deleted with scene/world deletion. Third-party vendor: ElevenLabs receives scene prose text (creator-authored content, no PII by design — prose is fiction). No reader data sent to ElevenLabs. |
| 6 | AI Security (prompt injection etc.) | N/A | TTS input is creator-authored prose, not LLM prompts. No prompt construction, no tool use, no memory writes. Injection surface is limited to SSRF/validation, covered in #1. |

**Gate result for this scope**: PASS — all applicable categories evaluated with controls defined in ADR-016 §§3,4,7. No implementation until TASKS.md task is created with acceptance criteria.

---

## 9. Scope Evaluation: ADR-017 Asset Lifecycle & Publication Integrity (2026-10-18)

**Status:** Merged 2026-10-18 — evaluation complete; gate result CONDITIONAL PASS (see prerequisites below).
**Baseline:** ADR-017 rev 26 (approved 2026-10-18; Design Gate open), migration plan + implementation breakdown (PROPOSAL).
**Scope:** Server-side media asset lifecycle machinery: storage reservations, quota admission, upload path rework, asset deletion state machine T1/T2, world deletion T1–T5, shared assets + snapshot references + serving layer, maintenance fence + recovery authorization, backfill runner + re-verification, drift-conflict resolution, Fly volume provisioning. Level 3 change (Architecture / Data / Contract).

| # | Category | Applies | Evaluation / Justification |
|---|---|---|---|
| 1 | Security & Middleware | Yes | **Input validation:** strict schema validation at all entrypoints; upload path validates mimetype by magic bytes (415 on invalid), 10 MB/file cap (413), deterministic server-side temp paths from `reservation_id` (no user-controlled path components — path traversal impossible by construction); serving `GET /media/{filename}` resolves filename → registry row, never a filesystem path join on raw input. **SQL injection:** all ADR SQL is parameterized; no dynamic SQL outside DDL. **SSRF:** N/A — no server-side fetching of user-supplied URLs; uploads are multipart bodies, not URL imports; snapshot references are content scans of creator-authored canon, not fetches. **File upload safety:** magic-byte checks, size caps, isolated non-executable storage (`/data/media` on Fly volume), quarantine path for suspect files. **Auth & RBAC:** world-ownership checks on upload/delete; shared-asset serving authorized under the context world's access policy; recovery authorization requires an admin operator session + explicit scope (`repair` vs `restore-reconcile`, enforced in-transaction). **Rate limiting / request IDs:** upload and mutation endpoints require rate + body-size limits (error contracts 413/507 defined); request IDs on all mutating paths for tracing. **Audit logging:** fence activation/release, recovery-authorization establishment/revocation, drift-conflict rows, and deletion decisions are all durable DB rows — tamper-evident via append-only history. |
| 2 | AI Safety & Governance | N/A | ADR-017 is deterministic storage machinery: no LLM prompts, no tool use, no AI authority, no generative behavior. The recovery authorization is human-operator-driven (admin session, explicit reason/scope, 4h expiry). No prompt construction, no memory writes, no autonomous spend. **Justification:** there is no AI component in this scope for safety controls to govern; AI Safety re-applies if a future slice adds AI-assisted media handling. |
| 3 | Product Completeness | Partial | **Applies:** error contracts are product surface — 404/409/413/415/422/503/507 with stable codes; published-snapshot serving guarantees are reader-visible correctness. **N/A:** no new UI in this scope — the work is API + backend + operator runbooks. Creator/reader media UI integration is outside ADR-017 (frontend Assets tabs are a separate product track). **Justification:** marking UI controls N/A is architectural, not an omission — the ADR's contract is the HTTP + DB surface; the Live UX Verification Gate (repo `AGENTS.md` §6) applies when UI work consumes these APIs. |
| 4 | Reliability & Operations | Yes | **Errors/resilience:** structured error codes; retries with backoff on transient failures; timeouts on fence-release waits and drain paths. **Idempotency:** reservation state machine (no double-count), deletion retry on `pending_deletion`, idempotent repair transactions. **Health:** `/health` reports `media_storage` status (OPS-0 acceptance); fence state queryable. **Observability:** structured JSON logs with request IDs on all mutating paths; reservation/drift/fence/recovery state is DB-resident and dashboard-queryable. **Migrations:** forward-compatible, idempotent, one transaction per file; replay safety tested separately from runner skip behavior. **Disaster recovery:** restore runbook (stop-all-machines → fence → diagnose/repair under recovery authorization → release gate); Fly volume snapshots are an operator prerequisite — the migration plan must record the snapshot schedule before backfill. **Capacity:** `STORAGE_CAPACITY_BYTES` + per-world quota with 507 `STORAGE_FULL` / `QUOTA_EXCEEDED` distinction; capacity monitoring job in OPS-1. |
| 5 | Data Governance & Privacy | Yes | **Ownership:** every row has an explicit owner — assets → world → creator; `shared_with_worlds` grants are explicit per-file; unattributed rows → operator-owned; recovery authorizations → establishing operator. **Minimization:** deterministic filenames (`reservation_id`-derived), no PII in the storage layer; metadata limited to what serving/deletion/quota need. **Retention & deletion:** this ADR *is* the deletion workflow — asset T1/T2, world deletion T1–T5, snapshot-retention rules; right-to-be-forgotten is served by world deletion + unattributed-row operator review. **Portability:** N/A — no new portable data surface; media travels with existing world export, which is unchanged. **Third-party vendors:** no new processors — Fly.io volumes (existing hoster); no AI/media vendor involved in this scope. |
| 6 | AI Security (prompt injection etc.) | N/A | No prompts are constructed, no tools are invoked, no model output is acted on. The only "untrusted input" in scope is file bytes and creator-authored metadata, handled under #1 (validation, magic bytes, isolation). **Justification:** identical to #2 — no AI attack surface exists in this scope. |

**Prerequisites before implementation:** migration plan approved; owner decisions recorded (migration plan §7.2 — quota value, volume size/region, file-size limit, capacity constant, machine retention); TASKS.md task(s) created with acceptance criteria per slice.

**Gate result for this scope**: CONDITIONAL PASS — all applicable categories evaluated with controls defined in ADR-017 rev 26 and owned by specific implementation slices (MIG-0, FENCE-1, RECOV-1, OPS-0, OPS-1, API-1). No implementation until the prerequisites above are satisfied and the breakdown + migration plan are product-owner approved.
