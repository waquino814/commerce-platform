# 0008: Project order across the portfolio

- **Status:** Proposed, not approved. When accepted, it supersedes the sequencing decision in ADR 0004 only.
- **Date:** 2026-10-25

## Context

ADR 0004 decided two things. First, a sequence: the Engineering Operations AI UI would be built first, after that repository's backend and investigation workflow worked, and the Commerce Platform UI would follow as M7. Second, a set of API-first rules: no frontend code before M7, presentation-neutral contracts, and frontend tooling, CORS and serving decided at M7.

The repository owner has since agreed a different order for the portfolio. In it, this repository is finished, including its UI, before the separate Engineering Operations AI repository is started. The README, `docs/architecture.md` and `docs/roadmap.md` described ADR 0004's order, so they disagreed with the agreed one.

## Decision

The portfolio is built in this order:

1. **Commerce backend and infrastructure,** in this repository: M0, M1 and M2.
2. **Observability and incidents,** in this repository: M3, M4 and M5.
3. **Commerce Platform UI,** in this repository: M7, `apps/web`.
4. **Engineering Operations AI backend,** in a new, independent Git repository. It reads incident bundles through the contract in ADR 0007, and neither repository depends on the other's code, packages or build output.
5. **AI investigation UI,** in the Engineering Operations AI repository.

- **What is superseded in ADR 0004:**
  - the first decision bullet, that the Engineering Operations AI UI is built first;
  - the word "afterwards" in the second bullet, which placed M7 after that UI;
  - the matching rationale in its context and its "Revisit if" condition.
- **What stays in force from ADR 0004:**
  - the Commerce Platform UI is milestone M7 in `apps/web`;
  - there is no frontend code, frontend package or frontend dependency before M7;
  - the API-first "Frontend readiness" rules in `docs/architecture.md`;
  - frontend tooling, CORS and serving are decided at M7.
- **Two different UIs.** The Commerce Platform UI (stage 3) places orders, shows order history and status, and runs demo scenarios through M5's scenario endpoints. The AI investigation UI (stage 5) shows incident investigations and belongs to the other repository. Neither replaces the other.
- **M6, portfolio polish,** keeps its place after M5. This order does not place it.
- **Milestone status is unchanged by this ADR.** In particular, M5's design and ADR 0007 stay proposed until the repository owner approves them.

## Consequences

- **Positive:** this repository is completed end to end, including a visual demo of orders and scenarios, before a second repository is started. Work stays in one repository at a time.
- **Positive:** the Engineering Operations AI repository starts with the incident bundle contract and real bundles already available.
- **Positive:** the M7 scenario screens test M5's control endpoints with a real client before another repository depends on the bundles.
- **Negative:** the portfolio's AI work, the part ADR 0004 called the most valuable, starts later.
- **Negative:** M7 is built before any agent exists to consume what it triggers, so its demo shows incidents being produced, not diagnosed.
- **Revisit if:** the agent work becomes more urgent than a visual commerce demo, or M7 turns out to need agent features.
