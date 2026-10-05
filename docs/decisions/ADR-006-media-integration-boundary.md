# ADR-006: Media Integration Boundary Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a secure, pluggable architecture for optional media integration (creator-uploaded cover art, future AI-generated illustrations, dynamic audio, voice, and sound effects) that maintains strict separation from core deterministic narrative logic.

## 2. Decision Drivers
- **Pluggability & Style Consistency**: Support for creator-selected art styles and third-party media generation APIs without binding the core engine to any single vendor.
- **Security & Storage Safety**: Safe file upload handling and non-executable media storage.
- **Optionality**: Core reading and authoring must function fully without media integrations enabled.

## 3. Considered Options
* **Option A: Pluggable Media Provider Abstraction (`IntfMediaGateway`) + Object Storage (S3-compatible object store)**
  - *Pros*: Decouples media generation/storage from application runtime; secure object storage with pre-signed URLs.
  - *Cons*: Requires cloud object storage configuration.

## 4. Decision Outcome
* **Chosen Option**: **Pluggable Media Gateway Interface (`IntfMediaGateway`) backed by S3-compatible object storage with strict MIME-type validation, size caps, and non-executable storage boundaries**.
* **Justification**: Satisfies file upload safety requirements without coupling the core state machine to media vendors. Pre-signed URLs ensure secure, direct-to-storage uploads for creator assets.

## 5. Consequences & Tradeoffs
* **Positive Impact**: Robust security for asset uploads; complete decoupling of media generation from core narrative execution.
* **Negative Impact / Tradeoffs**: Requires managing object storage credentials and bucket policies.
* **Mitigations**: Standard managed S3-compatible object storage with least-privilege IAM roles.
