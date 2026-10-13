# ADR-012: Password Reset & Account Recovery

- **Status**: Proposed
- **Date**: 2026-10-13
- **Decision Makers**: Sajacous Smith (product owner)
- **Consulted**: AI engineering agents (governance review)

---

## 1. Context and Problem Statement

Phase C (Authentication & Authorization) shipped registration, login, logout, and session management, but no account-recovery mechanism. A user who forgets their password has no self-serve path back into the platform — the only recovery is manual database intervention by an operator. The session service already exposes `revokeAllUserSessions` "e.g., password reset," showing recovery was anticipated but never specified (no FR, no user story, no roadmap task). FR-13 and US-A01 now require it for MVP.

## 2. Decision Drivers

- **Security (Level 4 change)**: Reset tokens are bearer credentials for account takeover; design must assume the email channel is the trust anchor and the token store is a high-value target.
- **Architecture fit**: Must follow the existing modular-monolith pattern (ADR-001), the ADR-004 session-token hashing precedent, and the scrypt password service.
- **Anti-enumeration**: The platform already mitigates user enumeration on login (dummy scrypt verify); the reset request endpoint must provide the same guarantee.
- **No email infrastructure exists**: Any design must isolate the delivery mechanism behind a port so the provider choice does not leak into domain logic.

## 3. Considered Options

* **Option A — Opaque random token, hashed at rest, delivered by email**: 256-bit `crypto.randomBytes` token; SHA-256 hash stored in `password_reset_tokens`; raw token sent in a reset link. Single-use, 15-minute expiry. On confirm: update password hash (scrypt), mark token used, revoke all sessions.
* **Option B — Signed JWT reset token (stateless)**: No server-side storage; token carries expiry in claims, signed with a dedicated secret. Simpler storage, but revocation before expiry is impossible (a leaked token stays valid until expiry) and secret rotation invalidates in-flight tokens.
* **Option C — Magic-link login (passwordless)**: Skip passwords entirely; email link logs the user in directly. Larger product change (alters the auth model, ADR-004); out of scope for this slice.

## 4. Decision Outcome

* **Chosen Option**: A (opaque token, hashed at rest, email delivery).
* **Justification**: Matches the ADR-004 session-token precedent already proven in this codebase (hash-at-rest, server-side revocation). Revocability and single-use semantics are non-negotiable for an account-takeover vector; Option B cannot provide them. Option C is a product-direction change requiring its own governance review.
* **Endpoints**:
  - `POST /auth/password-reset/request` `{ email }` → `202` always (registered or not; no timing oracle beyond the existing constant-time email lookup).
  - `POST /auth/password-reset/confirm` `{ token, newPassword }` → `200` on success; generic `400` for expired/reused/invalid tokens.
* **Token handling**: Raw token never persisted, never logged, never appears in API query strings (email link is opened by the Phase H frontend, which POSTs the token in the request body).
* **Password policy**: Reuses the existing password service (8–128 chars, scrypt) — no new policy invented.
* **Rate limiting**: Strict per-IP limits on both endpoints (recommended: 5/hour), registered alongside the existing auth rate limits; these endpoints are a prime abuse/enumeration target.
* **Data**: New migration `003_password_reset_tokens` — `token_hash` (PK), `user_id` (FK), `expires_at`, `used_at`, `created_at`. Expired tokens purged by the existing session-janitor pattern (extended or separate interval).
* **Email delivery**: New `EmailServicePort` in the application layer; infrastructure adapter chosen later. **Provider is an open decision (see §6)**. A log-to-console adapter serves development and tests.

## 5. Consequences & Tradeoffs

* **Positive Impact**: Closes the only account-recovery gap; reuses proven session-token patterns; provider-agnostic design keeps the domain clean.
* **Negative Impact / Tradeoffs**: Adds an external dependency (email provider) with cost and deliverability considerations; introduces a token table requiring cleanup; email becomes a critical-path trust anchor (account security now depends on email account security — standard and accepted).
* **Mitigations**: 15-minute expiry + single-use + hashed storage bound the blast radius of a leaked token; strict rate limiting and anti-enumeration bound abuse; all reset events audit-logged.

## 6. Open Decisions (require human approval before implementation)

1. **Email provider** (Resend, SES, SendGrid, other, or self-hosted): affects cost, deliverability, and which adapter gets built. Recommendation deferred — no provider invented here.
2. **Reset email template/branding**: copy and sender identity; can follow the Phase H brand work or ship plain-text first.

## 7. System Completeness Gate Evaluation (this slice)

- **Architecture & Middleware**: Fits existing modular monolith; use cases in `modules/auth/application/`, port in application layer, adapter in infrastructure. No new service boundaries. ✅
- **Security & Abuse Defense**: Rate limiting (strict), anti-enumeration, token hashing, 15-min expiry, single-use, session revocation, audit logging — all specified above. ✅
- **AI Safety**: **N/A** — deterministic auth flow with no AI involvement; no prompts, no model calls, no autonomy. Justification: the slice is pure credential lifecycle.
- **Product Completeness**: API-first; the reset form UI arrives with the Phase H frontend. Email template needed once the provider is chosen. Partial — tracked as open decision #2.
- **Reliability & Operations**: Token cleanup via janitor pattern; confirm is idempotent (reused token → generic error, no state change). ✅
- **Data Governance & Privacy**: Tokens SHA-256 hashed at rest; retention bounded by expiry + cleanup; no new PII beyond the already-stored email. ✅

## 8. Change Classification

**Level 4** (Security / Authority) per `governance/AI_AGENT_RULES.md` §5: touches the authentication boundary and introduces an account-takeover vector. Requires: formal governance review, security review of this design, and explicit human approval before implementation. No implementation code until ADR status moves to Accepted.
