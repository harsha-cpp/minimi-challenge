# Backend capabilities

The [implementation record](backend-search-implementation.md) tracks delivery of the
[search action plan](backend-search-action-plan.md). The [review](backend-search-review-2026-11-15.md)
is a record of pre-fix defects, not the current behavior. [Operations](../operations.md) documents deployment and restore.

Current architecture overview: [editable Excalidraw](asof-architecture-dark.excalidraw)
and [dark SVG](../assets/asof-architecture-dark.svg), with the main modules grouped inside one Node app.
The [conversation/memory contract](context-memory-boundaries.md) defines reference selection across date changes.

| Capability | Active contract | Validation category |
| --- | --- | --- |
| Current verification | Fresh applicable passage research; semantic claim review; supported/partial/unverified outcome | `grounded-turn`, `simulation-review` |
| Era simulation | Live retrospective web research; historical event-time review; commit before factual publication | `historical-turn` |
| Conversation/transform | Single-call path; provisional streaming; committed `done`; no mandatory lookup | `agent`, `clock-ui` |
| Recall | Owner/cutoff-scoped bounded SQL and untrusted answer index | `recall`, `memory-recovery` |
| Recovery | Owner-scoped idempotency, turn status, one conversation writer, durable outbox | `server`, `server-recovery`, `memory-recovery` |
| Exa profiles | Baseline auto; opt-in profiles/full reads; capability validation; unknown source age explicit | `search`, `evidence` |
| Legacy snapshots | Provider/research utility only; never enabled by an era chat date | Legacy subset in `search`, `evidence` |
| Evaluation | Frozen orchestration regression distinct from live/human held-out quality | `benchmark`, `quality-protocol` |

Documents and archived plans under `.context/` are historical working material. They do not enable
snapshot requirements, establish live quality, or supersede this capability matrix. Active chat never
passes a snapshot cutoff to Exa. A publication-date upper bound is enforced independently by the provider adapter.
