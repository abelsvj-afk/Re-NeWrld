# GEMINI.md — Antigravity Workspace Instructions
<!-- Project Growth Governance: v1.1.0 -->
<!-- Template-Source: Project-Growth -->

This document defines the Antigravity (`agy`) instruction layer for **Re:NeWrld**. Antigravity agents operating in this repository must strictly adhere to the following governance and workflow requirements.

---

## 1. Mandatory Reading Order

Before initiating any task, generating plans, or proposing changes, Antigravity **MUST** read and load project context in the following sequence:

1. [`AGENTS.md`](./AGENTS.md) — Cross-tool workspace foundations and role boundaries.
2. [`governance/AI_AGENT_RULES.md`](./governance/AI_AGENT_RULES.md) — Mandatory governance rules, change classifications, System Completeness Gate, and execution guardrails.
3. [`workflows/MASTER_AI_ENGINEERING_WORKFLOW.md`](./workflows/MASTER_AI_ENGINEERING_WORKFLOW.md) — Authoritative 22-phase lifecycle and security/completeness frameworks.

---

## 2. Core Operational Constraints

* **Follow Approved Specifications & Active Tasks**: Work strictly within the scope of approved requirements (`docs/requirements.md`), architecture (`docs/architecture.md`), and the active task in `TASKS.md`.
* **Design Gate & System Completeness Gate**: Application source code is blocked until the design is complete and approved for the current scope. Evaluate every relevant engineering category in `docs/system-completeness.md`. Any non-applicable category must be explicitly marked **N/A with written architectural justification**.
* **Security Realism & Abuse Defense**: Minimize attack surface, limit privileges, detect anomalies, contain breaches, and recover safely. Evaluate rate limiting, request IDs, CORS/CSP, injection defenses, authentication/RBAC, and secrets management proportional to project scope.
* **AI Security Guardrails**: Defend against direct/indirect prompt injection; validate all tool arguments against strict schemas; guard against memory poisoning and data exfiltration; enforce token caps; obtain human approval before executing any destructive, financial, or autonomous action.
* **Product & Platform Completeness**: Evaluate responsive UX, accessibility (WCAG 2.1 AA), branding (logos, favicons, OG social cards), PWA manifests, mobile adaptive/notification icons, splash screens, deep links, and store compliance.
* **Prohibition of Silent Changes**: Never silently alter requirements, architecture, system contracts, security boundaries, authority models, or project scope. All structural or directional adjustments require an explicit Architecture Change Proposal, human review, and ADR documentation.
* **Never Invent Requirements**: If requirements, interfaces, or expected behaviors are missing or ambiguous, stop and ask the user.
* **Mandatory Testing & Documentation**:
  * Every implementation change must include automated tests verifying functionality, error paths, and edge cases.
  * Synchronize all relevant documentation and update [`PROJECT_STATE.md`](./PROJECT_STATE.md) upon completing tasks.
* **Immediate Escalation & Review**:
  * AI authority is strictly bounded. Never expand your own tool or operational permissions.
  * Stop execution and request human review whenever change impact is ambiguous, a Level 4 change (security/authority/direction) is encountered, or an operation exceeds your defined role.

---

## 3. Current Phase Reminder

* Governed by **Project Growth v1.1.0**.
* Application source code is blocked until the required design and System Completeness Gate evaluation are complete and approved for the current scope.
