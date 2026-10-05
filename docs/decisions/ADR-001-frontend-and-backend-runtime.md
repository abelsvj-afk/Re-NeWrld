# ADR-001: Frontend Framework and Backend Runtime Selection

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a robust, type-safe, performant technology stack for both the Creator/Reader web client (frontend) and the deterministic core engine / API server (backend runtime) that respects MVP simplicity, low hosting costs, and strong developer ergonomics without over-engineering for speculative future scale.

## 2. Decision Drivers
- **Type Safety & Maintainability**: Strict compile-time safety across frontend and backend state definitions.
- **Deterministic Execution**: Predictable runtime behavior for state machine evaluation and condition checks.
- **Developer Ergonomics**: Rapid iteration speed for building creator authoring dashboards and distraction-free reader interfaces.
- **Cost & Hosting Efficiency**: Low idle resource footprint to ensure near-zero costs when operating without AI features (CST-01).
- **Ecosystem Maturity**: Robust tooling for accessibility, routing, state management, and testing.

## 3. Considered Options
* **Option A: TypeScript / Node.js (Express or Fastify) + React / Next.js (SPA/SSR)**
  - *Pros*: Unified language (TypeScript) across full stack, massive ecosystem, excellent type sharing for state schemas, rapid UI component integration, lightweight runtime.
  - *Cons*: Single-threaded JS event loop requires careful handling of heavy deterministic calculations (though MVP deterministic state checks are sub-100ms).
* **Option B: Python (FastAPI) + React (Vite)**
  - *Pros*: Excellent for AI integrations and data science libraries.
  - *Cons*: Slower frontend type synchronization; Node.js preferred for shared state/validation schemas.
* **Option C: Go (Backend) + Svelte/React (Frontend)**
  - *Pros*: High concurrency throughput and raw CPU performance.
  - *Cons*: Duplication of schema definitions across Go structs and TypeScript interfaces.

## 4. Decision Outcome
* **Chosen Option**: **TypeScript / Node.js (Fastify) for Backend Runtime** and **React (Vite or Next.js) with TypeScript for Frontend**.
* **Justification**: TypeScript sharing between backend state evaluation engines and frontend UI forms eliminates serialization mismatch risks. Fastify provides high-performance schema-based routing (JSON Schema / TypeBox) that aligns perfectly with deterministic state validation. React offers an extensive ecosystem for accessible, responsive reading and authoring interfaces (WCAG 2.1 AA compliance).

## 5. Consequences & Tradeoffs
* **Positive Impact**: Shared types across state schemas; rapid frontend/backend development; excellent JSON Schema validation integration.
* **Negative Impact / Tradeoffs**: Heavy computational simulations in future Post-MVP Tiers 1–3 (Living World Engine) may eventually require background worker offloading.
* **Mitigations**: MVP architecture isolates the deterministic core engine, allowing future CPU-bound simulation workloads to be safely offloaded to dedicated worker processes or microservices without altering frontend contracts.
