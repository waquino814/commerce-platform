# 0004: Frontend sequencing and API-first design

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

The portfolio has two repositories, and both will eventually have a React UI.

- The Commerce Platform UI will let users create orders, view order history and status, and run predefined demo scenarios.
- The Engineering Operations AI UI will show incident investigations, evidence, citations, recommendations, approval workflows, and evaluation results.

The agent UI shows most of the portfolio's value, so it should come first. Building a commerce UI early would spread effort thin and tempt business logic into presentation code.

## Decision

- The Engineering Operations AI UI is built first, after that repository's backend and investigation workflow are functional.
- The Commerce Platform UI is built afterwards, as milestone M7 in `apps/web`.
- Until M7, this repository has no frontend code, frontend package, or frontend dependency.
- The backend API is designed now so that it can serve a future UI. It follows the "Frontend readiness" rules in `docs/architecture.md`: business rules stay in the backend, contracts are presentation-neutral, errors are machine-readable, and lists are paginated.
- The frontend build tooling, CORS, and how the UI is served are decided at M7.

## Consequences

- **Positive:** M2 to M6 stay focused on backend behavior and incident generation.
- **Positive:** The UI becomes a thin client, so the incidents it triggers come from the same code paths as API traffic.
- **Negative:** Until M7, the system is demonstrated through curl, logs, and the agent repository rather than a visual interface.
- **Negative:** Gaps in the API that only a UI would reveal, such as listing order history, may only be found at M7. M7 adds them with tests.
- **Revisit if:** the commerce flow needs a visual demo before the agent UI is ready.
