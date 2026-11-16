# Architecture development results, 17 November 2026

Baseline: `6edefdc`. Measurements below use Fast mode, identical requested questions and the same seeded previous answer for re-check. Sources and provider timing remain uncontrolled. This is a development comparison, not held-out human adjudication, a representative average or p95. [Machine-readable observations](../eval/results/architecture-2026-11-17.json) retain the unsuccessful intermediate candidate as well as the final results.

| Check | Baseline | Updated |
| --- | --- | --- |
| Official HTTP 404 re-check | 25.493 s, remained unverified | 10.671 s, supported by evidence review |
| Model calls for that re-check | 5, including two reviews | 2, including one review |
| Source retrievals for that re-check | 1 search | 1 fresh source read |
| Simple official HTTP 404 lookup | 7.978 s | 10.105 s, slower in this sample |
| Ordinary lookup quality label | Explicitly unverified | Explicitly unverified |
| Automated tests | 454 passing at pinned baseline | 575 passing |
| Frozen pipeline fixtures | Six scripted cases | Six passing; these are not live factual scores |
| Interrupted synthesis | Restart research | Explicit resume reuses saved evidence; crash regression starts zero new searches |
| Original-claim coverage | Answer-level review | Supported, corrected or unresolved per requested claim |
| Reviewed memory | Separate background extraction | Foreground-reviewed claims reused directly |
| Starter questions | Fixed three suggestions | Rotating sets and a Refresh suggestions control |
| Ambiguous past-answer verification | Could become an unresolved answer | Dated saved-topic choices before any paid research |
| Long direct-source documents | First 12k characters | Up to 400k acquired; at most 12k relevant paragraph context admitted |

The first candidate re-check took 25.937 s and remained unverified. Investigation showed that the RFC definition was around character 328,000, outside the old opening excerpt. Query-focused provider highlights also missed it. Bounded full-text acquisition with local paragraph selection found the actual definition and its nearby qualifications. The first post-fix re-check took 8.101 s and passed review; the final guarded version took 10.671 s and also passed. The latter is approximately 58% shorter than the baseline attempt, with a different completion outcome. It is not a general speedup estimate.

The change also adds owner-scoped, policy-bound two-minute research checkpoints, cumulative resumed usage, progressive reviewed findings, explicit unfinished-claim retries, bounded concept-assisted recall, durable operator allocation reconciliation, and versioned operational traces. Reviewed findings remain model judgments against supplied excerpts. Ordinary first answers are still provisional, and external qualifications can remain outside selected context.

Validation includes type checking, 575 tests, six frozen fixtures, dependency audit, desktop/mobile rendering, real process termination and restart, owner isolation, cancellation, disconnect recovery and budget contention. The 20-conversation focused set has routing expectations but still awaits independent factual labels. Representative concurrent-provider latency and human quality measurements remain outstanding.

## First-read integration follow-up

The initial deployed Fast request for a full RFC read still received highlights because its reduced tool schema did not expose the content selector. It returned a partially supported explanation of the evidence gap, rather than the requested definition. The follow-up exposes the existing bounded full-read control. The same explicit full-source question then passed review locally in 13.090 s with one source read and three model calls. This is a different question from the simple lookup above and is not a paired speed comparison.

The website topic chooser considers up to 100 recent owner-scoped episodes and displays at most six matches. It preserves the selected date and response mode, pins the chosen original answer, and leaves concrete verification, dated recall, clarification, retry and resume paths intact. Plain recall remains recall. New-chat navigation invalidates late selection responses. Empty history shows guidance without starting a model or search call.
