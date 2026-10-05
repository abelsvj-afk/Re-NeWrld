# ADR-003: API Style, Validation, and AI/Media Integration Boundaries

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a standardized API communication style, rigorous input validation, and secure integration boundaries for optional AI presentation layers and future media pipelines, ensuring prompt injection defense and strict separation between core deterministic logic and generative enhancements.

## 2. Decision Drivers
- **Deterministic Reliability**: Core engine APIs must be lightning-fast, schema-validated, and completely decoupled from external LLM latencies or failures.
- **Type Safety & Contract Enforcement**: End-to-end type safety between client and server.
- **Security & Prompt Injection Defenses**: Isolation of untrusted inputs before reaching AI wrappers (AI-03).
- **Pluggable Abstraction**: Ability to swap or disable AI providers without affecting core gameplay.

## 3. Considered Options
* **Option A: REST / JSON APIs with TypeBox / Zod Schema Validation**
  - *Pros*: Simple, universally supported, highly cacheable for static catalog assets, strict runtime validation via Zod/TypeBox schemas.
  - *Cons*: Requires multiple endpoints for complex graph traversals.
* **Option B: GraphQL**
  - *Pros*: Flexible client queries.
  - *Cons*: Overly complex for simple discrete choice progression trees; caching and rate-limiting are harder to secure.

## 4. Decision Outcome
* **Chosen Option**: **REST / JSON APIs protected by strict runtime schema validation (Zod/TypeBox) for core engine and authoring operations, coupled with a pluggable adapter pattern for optional AI presentation gateways**.
* **Justification**: REST APIs provide predictable request/response caching and rate limiting. Strict runtime schema validation at the API boundary ensures invalid authoring payloads or malformed state mutations are rejected before reaching database transactions. The AI integration boundary uses a provider abstraction interface (IntfAIGateway) ensuring AI models are strictly optional and isolated.

## 5. Consequences & Tradeoffs
* **Positive Impact**: High security and input validation rigor; clean separation between deterministic engine endpoints and optional AI enhancement endpoints.
* **Negative Impact / Tradeoffs**: Additional boilerplate for DTO/schema definitions.
* **Mitigations**: Shared TypeScript schema packages between API server and web client.

---

## 6. Deferred Technology Decisions
The following technology decisions remain deferred until Phase 7 Contracts & Schemas and Phase 8 Detailed Design:
1. Exact SQL indexing strategy for high-frequency reader state writes.
2. Specific third-party LLM provider SDKs for optional AI presentation layers (pluggable abstraction is decided; specific vendor choice is deferred).
3. Background job queue infrastructure (deferred until Post-MVP simulation and automated test bot requirements are scheduled).
