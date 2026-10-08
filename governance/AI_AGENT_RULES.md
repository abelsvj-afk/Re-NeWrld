# AI AGENT RULES
## Project Growth Governance & Execution Standards
Version: 1.1.0

Source of Truth: [`../workflows/MASTER_AI_ENGINEERING_WORKFLOW.md`](../workflows/MASTER_AI_ENGINEERING_WORKFLOW.md)

These rules are mandatory for all AI agents, coding assistants, and automated tools operating within Project Growth. AI assistants are implementation partners; they are not autonomous product owners or independent architects.

---

### 1. Follow the Master AI Engineering Workflow
* All development must adhere to the 22-phase lifecycle defined in [`MASTER_AI_ENGINEERING_WORKFLOW.md`](../workflows/MASTER_AI_ENGINEERING_WORKFLOW.md).
* Never skip phases casually. Engineering rigor must remain proportional to the change's risk, complexity, and architectural impact.

### 2. No Implementation Code Before Approved Design
* **Master Rule**: No implementation code is written until the design is complete enough for the current approved implementation scope.
* Slices must be small, complete, and designed before coding (specifications beat code).
* Never adopt a "build now, figure out architecture later" approach.

### 3. Read Relevant Documentation Before Acting
* Before planning or executing any task, load and review required project context in order:
  1. Project purpose & Vision (`docs/idea.md`, `docs/vision.md`)
  2. Requirements (`docs/requirements.md`)
  3. User Stories & Workflows (`docs/user-stories.md`)
  4. Governance & Safety (`governance/AI_AGENT_RULES.md`, `docs/governance.md`)
  5. Architecture (`docs/architecture.md`)
  6. Technology Decisions & ADRs (`docs/decisions/`)
  7. Contracts & Schemas
  8. Detailed Design & Service Specs (`docs/detailed-design.md`, `docs/services/`)
  9. Change Impact Classification
  10. Current Task & Acceptance Criteria (`TASKS.md`)
  11. Current Project State (`PROJECT_STATE.md`)
* Never act on unverified assumptions.

### 4. Respect Architecture and Contracts
* Dependencies must strictly flow according to architecture (business logic independent of UI/infrastructure; no unauthorized circular dependencies).
* Contracts (APIs, schemas, tool interfaces, data models) are binding sources of truth. Code conforms to contracts, not vice versa.
* Never alter contracts or interfaces silently to bypass an implementation hurdle.

### 5. Classify Changes Before Implementation
Every proposed change must be formally classified before writing code:
* **Level 1 (Local Implementation)**: Typos, local refactoring, internal non-behavioral tweaks. Requires task, tests, standard review.
* **Level 2 (Feature Change)**: User-visible additions or adjustments within existing architecture. Requires story/design update, task, vertical slice, tests, documentation, state update.
* **Level 3 (Architecture / Data / Contract Change)**: Schema migrations, service boundaries, contract edits, persistent data changes. Requires impact analysis, architecture review, ADR, migration plan, tests, full review.
* **Level 4 (Security / Authority / Product-Direction Change)**: Permissions, auth boundaries, AI autonomy, sensitive data, external tool access. Requires formal governance review, security review, human approval.
* **Escalation Rule**: When uncertain between two levels, choose the higher level. If scope expands during implementation, halt immediately at the boundary.

### 6. Never Silently Change Architecture or Requirements
* If a superior architectural pattern or flaw is discovered, do not silently rewrite the system.
* Prepare an Architecture Change Proposal:
  1. Proposed change
  2. Rationale
  3. Component impact
  4. Associated risks
  5. Viable alternatives
  6. Recommendation
* Proceed only after formal human review and ADR creation.

### 7. Never Invent Missing Requirements
* If a requirement, contract, or behavior is unspecified or ambiguous, **stop and ask**.
* Do not hallucinate or invent features, business logic, default policies, or external integrations.

### 8. Keep Scope Strictly Controlled
* Implement only what is explicitly approved for the active task or slice.
* Do not add speculative libraries, frameworks, abstraction layers, mock microservices, or unrequested features ("vibe coding" without guardrails is forbidden).
* Future ideas belong in `docs/vision.md` or `ROADMAP.md` under future scope.

### 9. Test All Implementation Changes
* Every functional change must include verification proportional to its impact (unit, integration, e2e, edge cases, error handling).
* Verify failure paths, rate limits, empty states, and invalid inputs.
* Code that has not been tested or cannot be verified is incomplete.

### 10. Synchronize Documentation and Project State
* Documentation must accurately describe the system as it currently exists.
* Update `docs/architecture.md`, `docs/requirements.md`, and relevant ADRs when approved changes occur.
* Keep `PROJECT_STATE.md` updated with phase, completed items, active tasks, blocked items, and known technical debt.
* Never leave undocumented technical debt.

### 11. Enforce Authority Limits & Escalate Immediately
* AI agents operate under bounded autonomy (defaulting to read/prepare or bounded execution).
* AI agents must never silently expand their own tool permissions, file access, or execution authority.
* **Stop and request human review immediately** whenever:
  - A Level 4 change is encountered.
  - A security, authentication, or permission boundary is touched.
  - An unexpected destructive action or policy conflict is identified.
  - A task exceeds the agent's defined scope or role boundaries.

### 12. Satisfy the System Completeness Gate Before Implementation
* Before writing implementation code, evaluate every relevant engineering category (Architecture & Middleware, Security & Abuse Defense, AI Safety, Product Completeness, Reliability & Operations, Data Governance & Privacy).
* **Mandatory N/A Justification**: Any category or control that does not apply to the current project or slice must be explicitly marked **N/A with written architectural justification** in project specifications (e.g., `docs/system-completeness.md`). Casual omission is prohibited.
* **Proportional Implementation**: Implement only project-appropriate controls to avoid speculative technology or premature over-engineering.

### 13. Evaluate Security, Abuse Defense & Middleware
* System design must evaluate and specify applicable defenses:
  - Network perimeter, reverse proxy, CDN, WAF, and API gateway routing.
  - Security middleware: Request IDs, CORS policies, CSP, HSTS, and security headers.
  - Traffic controls: Rate limiting, request/body-size limits, brute-force throttling, and bot/spam abuse prevention.
  - Input & injection defenses: Strict schema validation, parameterized SQL/NoSQL queries, XSS encoding, SSRF IP blocking, and malicious file-upload validation (magic bytes, size limits, storage isolation).
  - Access & identity: Robust password hashing, secure session cookies (HttpOnly, Secure, SameSite), RBAC, and least-privilege permissions.
  - Cryptography & secrets: Encryption in transit (TLS 1.3/1.2) and at rest, zero hardcoded secrets, and automated scanning.
  - Supply chain & operations: Dependency vulnerability scanning, HMAC webhook signatures, audit logging of security events, and disaster recovery procedures.
* **Security Realism**: Acknowledge that security cannot guarantee zero attacks; design to minimize attack surface, prevent attacks, limit privileges, detect anomalies, contain breaches, and recover safely.

### 14. Enforce AI Security, Prompt Injection & Autonomy Guardrails
* **Prompt Injection Defenses**: Defend against direct and indirect prompt injection; treat all retrieved external content and tool outputs as untrusted data.
* **Tool Validation & Least Privilege**: Enforce strict schema validation on all AI tool arguments; assign only the minimum necessary tools.
* **Data Exfiltration & Memory Poisoning**: Prohibit AI from transmitting secrets or PII externally; verify provenance before persisting into long-term memory.
* **Output & Hallucination Containment**: Validate all AI responses against contracts; ground facts in verified retrieval; provide fallback uncertainty states.
* **Cost Controls & Rate Limits**: Enforce token limits, budget caps, quota alerts, and model selection discipline.
* **Human Approval Gates**: Autonomous destructive, financial, or irreversible actions are strictly forbidden without explicit human review.
* **Source of Truth Hierarchy**: Authoritative Data → Stored Memory → Retrieved Context → AI Reasoning → Recommendation → Authorized Action.

### 15. Deliver Product & Platform Completeness
* Features must not stop at raw backend endpoints or unstyled screens. Design must evaluate:
  - Responsive UI/UX and accessibility (WCAG 2.1 AA, keyboard navigation, contrast, screen readers).
  - Web branding: Vector logos, light/dark variants, `favicon.ico`, apple touch icons, and Open Graph/social preview cards.
  - Progressive Web Apps (PWA): Web app manifests (`manifest.json`), display modes, theme colors, and offline handling.
  - Mobile & platform assets (when applicable): Android adaptive and notification icons, iOS icon catalogs, splash screens, notification permissions, deep links/universal links, and store compliance declarations.
  - Desktop identity (when applicable): Window icons, dock behavior, native menus, and shortcuts.

### 16. Enforce Reliability, Operational Readiness & Data Privacy
* **Resilience**: Explicit error types, retries with exponential backoff and jitter, timeouts, and idempotency keys for mutable operations.
* **Observability**: Health check endpoints (`/healthz/live`, `/healthz/ready`), structured JSON logging with correlation IDs, metrics, and alerting.
* **Database & Release Safety**: Forward/backward compatible schema migrations, zero-downtime deployments, and fast rollback procedures.
* **Data Governance & Privacy**: Clear ownership for every data entity, data minimization, defined retention schedules, deletion workflows (right to be forgotten), standardized data export, and third-party data processor oversight.

### 17. Red-Team-Derived Engineering Guardrails (Audit Advisory Standards)
*Note: The following guardrails originate from the independent red-team audit (`REPOSITORY-RED-TEAM-AUDIT-001-CLAUDE.md`, Section AD) and serve as mandatory execution standards to prevent recurring implementation anti-patterns:*
* **Rule 0 — Only Claim What You Ran**: Never write "tests pass", "verified", "complete", or "no debt" unless you executed the command and inspected its output. If unable to verify, mark **UNVERIFIED** and explain why. Before marking any task done, verify compilation, build, and test execution.
* **Rule 1 — Test Integrity**: Every test file must import the module/code under test. Tests must fail if the underlying code is broken. Prohibit placeholder assertions (`expect(true).toBe(true)`) or bypassing failures. Skips must be explicit and reasoned.
* **Rule 2 — Configuration Isolation**: Library and utility code must not read environment configuration (e.g., `validateEnv()`) at module import time, preventing frozen singletons. Pass configuration parameters explicitly.
* **Rule 3 — No Test-Only Hooks in Production**: Prohibit mutable globals or test seams (`setPool()`, `setX()`) in production modules. Use proper dependency injection or factory patterns.
* **Rule 4 — Chain Verification**: When modifying build scripts, environment variable handling, or Docker configurations, verify the entire lifecycle (local dev, test runner, container build, container start).
* **Rule 5 — Strict File Scope**: Stay strictly within the approved file scope of the active task. Do not commit or introduce unrequested tool-generated files or dependencies.
* **Rule 6 — Never Invent Requirements**: Cite specific documentation and line references for every behavior. Stop and ask immediately when specifications conflict or requirements are ambiguous.
* **Rule 7 — Status Truthfulness**: Status documents (`PROJECT_STATE.md`) must reflect verified reality. Never claim zero technical debt or complete implementation without rigorous execution evidence.
* **Rule 8 — Database & Migration Rigor**: Enforce immutability invariants; create indexes only for verified existing queries; hash sensitive session secrets; handle email case explicitly; do not modify applied migrations.
* **Rule 9 — Library & Flag Precision**: Verify library APIs and CLI flags against exact version documentation before usage.
* **Rule 10 — Security & Input Hygiene**: Prohibit hardcoded secrets or `.env` files in artifacts; use parameterized SQL queries exclusively; treat all creator- and reader-submitted text as untrusted input.
