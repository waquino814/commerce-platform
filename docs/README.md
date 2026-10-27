# Documentation index

Start with the [project README](../README.md): what the project is, how to run it, and screenshots.

## Understand the system

| Document                                             | Read it for                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)                   | Components, runtime view and ports, order processing, storage, security boundaries, the bundle contract                  |
| [incidents-and-handoff.md](incidents-and-handoff.md) | The five scenarios, the bundle format and variants, how to get a bundle safely, the handoff to Engineering Operations AI |
| [roadmap.md](roadmap.md)                             | Milestone status (the source of truth) and acceptance criteria                                                           |
| [decisions/](decisions/)                             | ADRs 0001 to 0008 (0008, the project order, is proposed)                                                                 |

## Use and verify it

| Document                           | Read it for                                                             |
| ---------------------------------- | ----------------------------------------------------------------------- |
| [ui-visual-qa.md](ui-visual-qa.md) | Every UI route and state, the screenshot index, defects found and fixed |
| [../CLAUDE.md](../CLAUDE.md)       | Engineering rules, including which operations need the owner's approval |
| [images/](images/)                 | Screenshots of the storefront and the incident dashboard                |

## Design records

Milestone designs and their acceptance criteria are in [prompts/](prompts/): [initial implementation](prompts/initial-implementation.md), [M2 commerce flow](prompts/m2-design.md), [M3 observability](prompts/m3-design.md), [M4 load generation](prompts/m4-design.md), [M5 fault scenarios](prompts/m5-design.md), [M5c incident CLI](prompts/m5c-design.md). The bundle JSON Schemas are in [schemas/incident-bundle/](schemas/incident-bundle/).

## Reading order for a new engineer

1. README, then [architecture.md](architecture.md).
2. Run the stack, then `pnpm web` and `pnpm commerce:preview` and click through.
3. [incidents-and-handoff.md](incidents-and-handoff.md) before running anything under `pnpm incident`.
4. [roadmap.md](roadmap.md) for what is done and what is open.
