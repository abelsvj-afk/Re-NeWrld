# ADR-004: Authentication and Authorization (RBAC) Architecture

- **Status**: Accepted
- **Date**: 2026-10-04
- **Decision Makers**: Architecture & Engineering Team
- **Consulted**: Project Growth Governance v1.1.0

---

## 1. Context and Problem Statement
Re:NeWrld requires a secure authentication and authorization mechanism that strictly enforces Role-Based Access Control (RBAC) separating **Creators** (authoring, publishing, world management) from **Readers** (session execution, state reading), protecting intellectual property and reader privacy.

## 2. Decision Drivers
- **Role Separation**: Zero privilege escalation between Readers and Creators.
- **Session Security**: Secure, HTTP-only, SameSite cookies or cryptographically signed session tokens resistant to XSS and CSRF.
- **Simplicity & Maintainability**: Clean middleware integration with Fastify.

## 3. Considered Options
* **Option A: JSON Web Tokens (JWT) with Stateless Verification**
  - *Pros*: Scalable across stateless microservices.
  - *Cons*: Revocation complexity requires token blacklisting or short expiration times.
* **Option B: Session-Based Authentication with Secure HttpOnly Cookies and Server-Side Store**
  - *Pros*: Immediate session revocation, zero client-side token exposure, robust CSRF protection via SameSite/anti-CSRF tokens.
  - *Cons*: Requires server-side session cache lookup.

## 4. Decision Outcome
* **Chosen Option**: **Session-Based Authentication using Secure, HttpOnly, SameSite=Strict cookies backed by server-side session validation, coupled with Fastify RBAC middleware enforcing Creator vs. Reader permissions**.
* **Justification**: Securing sessions with HttpOnly cookies prevents client-side script theft (XSS mitigation). Immediate session revocation is critical for revoking compromised creator accounts or banned users. RBAC middleware explicitly inspects the authenticated user's role on every protected route (e.g., authoring endpoints reject Reader credentials).

## 5. Consequences & Tradeoffs
* **Positive Impact**: Superior security posture against XSS and session hijacking; instant revocation capability.
* **Negative Impact / Tradeoffs**: Requires stateful session lookup on authenticated requests.
* **Mitigations**: Session store utilizes low-latency indexed storage with efficient TTL caching.
