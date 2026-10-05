# ADR-005: Background Jobs and Event Processing Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires an architectural strategy for background jobs and event processing. While MVP core deterministic execution is synchronous and atomic, future Post-MVP capabilities (automated path simulation bots, batch publishing validations, asynchronous AI media generation, and cross-timeline outcome pooling) require asynchronous task processing.

## 2. Decision Drivers
- **MVP Simplicity**: Zero unnecessary queue infrastructure complexity for MVP.
- **Future Extensibility**: Seamless evolution toward asynchronous worker queues for Post-MVP Tiers 1–3.
- **Reliability & Idempotency**: At-least-once or exactly-once execution semantics with dead-letter queue support.

## 3. Considered Options
* **Option A: Synchronous In-Process Execution (MVP) with Abstracted Queue Interface**
  - *Pros*: Zero infrastructure overhead for MVP.
  - *Cons*: Will not scale for heavy batch simulations.
* **Option B: Redis + BullMQ (or similar Node.js Job Queue)**
  - *Pros*: Mature, feature-rich, supports delayed jobs, retries, concurrency limits, and persistence on Redis.
  - *Cons*: Requires running a Redis instance.

## 4. Decision Outcome
* **Chosen Option**: **Defer dedicated external background worker queue infrastructure for MVP (utilizing synchronous execution for MVP publishing validation and state writes), while introducing an abstracted task dispatcher interface (`IntfJobQueue`) preparing for Redis + BullMQ in Post-MVP**.
* **Justification**: MVP authoring scale and single-user publishing validation complete well within HTTP timeout thresholds (<100ms for state writes, <1000ms for publishing checks). Adding Redis for MVP violates anti-overengineering mandates. Abstracting the dispatcher ensures zero code rewrites when Post-MVP simulation and media pipelines are introduced.

## 5. Consequences & Tradeoffs
* **Positive Impact**: Zero idle infrastructure cost for MVP; clean architectural boundary for future asynchronous workers.
* **Negative Impact / Tradeoffs**: Long-running publishing validations on massive worlds could eventually timeout if not offloaded.
* **Mitigations**: Publishing validation optimization and deferred background worker onboarding in Post-MVP.
