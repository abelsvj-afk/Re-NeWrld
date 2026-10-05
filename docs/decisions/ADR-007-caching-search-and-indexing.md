# ADR-007: Caching, Search, and Indexing Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a caching, search, and indexing strategy to ensure fast catalog discovery, sub-100ms state evaluations, and efficient retrieval of published story worlds without premature infrastructure over-engineering.

## 2. Decision Drivers
- **Query Performance**: Fast retrieval of published story catalogs and active reader session state.
- **MVP Simplicity**: Leverage PostgreSQL's native indexing and caching capabilities before introducing distributed caching layers.

## 3. Considered Options
* **Option A: PostgreSQL Native Indexing (B-Tree/GIN) + Application-Level In-Memory Caching**
  - *Pros*: Zero additional database infrastructure; robust relational indexing; JSONB GIN indexing for condition payloads.
  - *Cons*: Single-node cache invalidation limits distributed scaling.
* **Option B: Redis Distributed Cache + Elasticsearch**
  - *Pros*: Extreme high-throughput caching and full-text search.
  - *Cons*: Unnecessary operational overhead for MVP scale.

## 4. Decision Outcome
* **Chosen Option**: **PostgreSQL native indexing (B-Tree indices on foreign keys and tenant IDs, GIN indices on JSONB condition payloads) supplemented by Fastify in-memory caching for static catalog metadata**.
* **Justification**: Avoids operational complexity of distributed search/cache clusters for MVP while fully satisfying performance targets (NFR-01: <100ms state evaluations, NFR-02: <500ms load times).

## 5. Consequences & Tradeoffs
* **Positive Impact**: Low operational complexity; high utilization of PostgreSQL built-in optimization.
* **Negative Impact / Tradeoffs**: Full-text fuzzy search across thousands of community stories will eventually require dedicated search indexing in Post-MVP.
* **Mitigations**: Planned migration path to Elasticsearch or Postgres Full-Text Search in Future platform phases.
