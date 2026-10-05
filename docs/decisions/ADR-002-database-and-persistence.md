# ADR-002: Database and Persistence Architecture for Canon vs. Experience

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a persistent storage architecture that strictly separates authoritative creator assets (**Canon Data**) from runtime reader session states (**Experience Data**) while guaranteeing atomic state mutations, rollback protection on persistence failure, and strict cross-tenant isolation.

## 2. Decision Drivers
- **Data Isolation & Security**: Absolute tenant separation between different story worlds and reader accounts.
- **Atomic State Mutations & Durability**: Reader state persistence must be atomic and durable with zero risk of silent data corruption (NFR-03).
- **Flexible Authoring Schema**: Creator-authored worlds involve hierarchical structures (worlds, characters, chapters, scenes, choices, conditions).
- **Cost & Simplicity**: Low operational complexity and managed cost for MVP.

## 3. Considered Options
* **Option A: PostgreSQL (Relational + JSONB support for dynamic schemas)**
  - *Pros*: ACID transactional guarantees, robust foreign key constraints (crucial for publishing validation checks), excellent multi-tenant row-level security (RLS), mature indexing, and JSONB flexibility for flexible condition rules and state variables.
  - *Cons*: Requires careful schema migration management.
* **Option B: MongoDB / Document Store**
  - *Pros*: Flexible document nesting for chapters and scenes.
  - *Cons*: Weaker relational consistency guarantees for cross-scene publishing validation (e.g., detecting orphaned scenes or missing target references).

## 4. Decision Outcome
* **Chosen Option**: **PostgreSQL with structured relational tables for Canon publishing constraints and JSONB document columns for flexible runtime reader state variables and scene node payloads**.
* **Justification**: PostgreSQL provides strict ACID compliance for atomic reader state transitions and guarantees foreign key referential integrity during publishing validation checks (verifying that choice target scene IDs exist). JSONB fields allow flexible authoring metadata and condition rule payloads without schema migrations for every new authoring attribute.

## 5. Consequences & Tradeoffs
* **Positive Impact**: Strong transactional integrity; robust publishing validation queries; secure multi-tenant isolation via database constraints.
* **Negative Impact / Tradeoffs**: High-frequency reader state writes require proper indexing to maintain sub-100ms response targets (NFR-01).
* **Mitigations**: Experience session state tables are indexed by `reader_id` and `world_id`, utilizing connection pooling and optimized UPSERT operations.
