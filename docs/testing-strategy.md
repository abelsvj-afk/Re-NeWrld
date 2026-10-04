# Testing Strategy — Re:NeWrld

Governed by **Project Growth v1.1.0**.

---

## 1. Testing Philosophy
* Proportional rigor matching change risk and complexity.
* No untested implementation code is considered complete.

## 2. Test Pyramid & Scope
* **Unit Tests**: Pure business logic, helpers, data transformations in `tests/unit/`.
* **Integration Tests**: Boundary interactions, API/database contracts in `tests/integration/`.
* **E2E / Workflow Tests**: Critical user paths (introduced when justified).

## 3. Failure & Edge Case Scenarios
* Invalid inputs & validation errors
* Network timeouts & service unavailability
* Empty datasets and boundary numbers

## 4. AI-Specific Evaluation (if applicable)
* Evaluation against prompt drift, regression, and unauthorized tool calls.
