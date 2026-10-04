# AGENTS.md — Re:NeWrld Agent Guidelines
<!-- Project Growth Governance: v1.1.0 -->
<!-- Template-Source: Project-Growth -->

Welcome to **Re:NeWrld**. This file provides cross-tool operational instructions for all AI coding assistants (including Antigravity / `agy`, Gemini CLI, Claude Code, Cursor, Codex, and custom autonomous agents).

---

## 1. Mandatory Prerequisites

Before proposing changes, executing tasks, or generating code within this workspace, you **MUST** read and adhere to:

1. **Master AI Engineering Workflow**: [`workflows/MASTER_AI_ENGINEERING_WORKFLOW.md`](workflows/MASTER_AI_ENGINEERING_WORKFLOW.md)
   * The authoritative, 22-phase lifecycle governing all technical design, implementation, and review.
2. **AI Agent Governance Rules**: [`governance/AI_AGENT_RULES.md`](governance/AI_AGENT_RULES.md)
   * Mandatory operational guardrails, change classifications, authority boundaries, and the System Completeness Gate.

---

## 2. Core Operating Principles

* **Specification Before Implementation**: Never write implementation code before the design, contracts, and acceptance criteria for the current scope are complete and approved.
* **Proportional Engineering**: Calibrate the depth of planning, testing, and documentation to the risk and complexity of the change.
* **System Completeness Gate**: Before implementation, evaluate every relevant engineering category (Security & Middleware, AI Safety & Governance, Product Completeness, Reliability & Operations, Data Governance & Privacy). Any non-applicable category must be explicitly marked **N/A with written architectural justification** in `docs/system-completeness.md`.
* **Security & Abuse Defense Realism**: Evaluate perimeter/WAF, rate limiting, request IDs, CORS/CSP, injection defenses, authentication/RBAC, secrets management, encryption, supply chain security, and audit logging. Design to minimize attack surface, limit privileges, detect anomalies, contain breaches, and recover safely.
* **AI Security & Guardrails**: Defend against direct/indirect prompt injection; validate tool arguments against strict schemas; guard against memory poisoning and data exfiltration; enforce token/cost budgets; strictly require human approval gates for autonomous, destructive, or financial actions.
* **Product & Platform Completeness**: Evaluate responsive UX, accessibility (WCAG 2.1 AA), branding (logos, favicons, OG social cards), PWA manifests, mobile adaptive/notification icons, splash screens, deep links, and store compliance.
* **Reliability, Operations & Privacy**: Enforce explicit error handling, retries with exponential backoff/jitter, idempotency, health checks, structured JSON logging, safe database migrations, data ownership, retention schedules, deletion workflows, and user data export capabilities.
* **Context Loading Order**: Always review project context in the defined sequence (Vision → Requirements → Stories → Governance → Architecture → ADRs → Contracts → Detailed Design → System Completeness Gate → Change Classification → Task → Project State).
* **Controlled Scope**: Do not create application source code, speculative infrastructure, or unrequested features without an approved design and task. Design-document templates may be populated before implementation.
* **No Silent Drift**: Never invent missing requirements or silently alter architecture. If information is ambiguous, stop and ask.
* **Change Classification**: Explicitly classify every change (Level 1 Local, Level 2 Feature, Level 3 Architecture/Data/Contract, Level 4 Security/Authority/Direction).
* **Escalate When Bounded**: Stop and request human review whenever approaching a Level 4 change or exceeding your authorized tool boundaries.
* **Maintain Project State**: Ensure all active work, completed tasks, and technical debt are kept current in `PROJECT_STATE.md`.

---

## 3. Agent Roles & Collaboration Model

* **Architect**: Focuses on problem discovery, requirements analysis, system architecture, contracts, ADRs, threat models, system completeness evaluation, and platform readiness. *Does not write implementation code.*
* **Builder**: Implements approved slices strictly matching specs, adheres to contracts, writes tests, and maintains file/function size limits.
* **Reviewer**: Inspects implementations for architecture fidelity, contract conformity, security vulnerabilities, edge-case handling, and test coverage. Rejects unauthorized scope additions.

---

## 4. Current Workspace Status

* Governed by **Project Growth v1.1.0**.
* Application source code is blocked until the required design and System Completeness Gate evaluation are complete and approved for the current scope.
