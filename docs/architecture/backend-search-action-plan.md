# Backend and search improvement plan

Companion to the [15 November 2026 architecture review](backend-search-review-2026-11-15.md). Findings F01–F14 refer to that review. This is proposed work, not a list of shipped capabilities.

## Objective and sequence

Build an answer engine whose factual support, completion state, latency and cost can be explained and measured. Preserve TypeScript/Node, the Exa boundary and a single-host SQLite deployment initially. Implement small changes behind explicit policy/configuration versions; retain the existing passing tests and add regressions for confirmed defects.

The order is **correctness → visibility into performance → workload control and recovery → measured retrieval improvement → release validation**. Begin telemetry early so later decisions have a baseline. Owner isolation moves ahead of every other shared-hosting step if shared deployment is imminent.

Planning assumption: one experienced backend engineer, access to a product decision-maker and part-time human evaluation support. Allow roughly **6–8 weeks**, with substantial uncertainty in labeling and live-provider iteration. Estimates below are engineering days, overlap where indicated, and are not commitments. Calendar speed depends more on testing and labels than on writing the adapters.

| Stage | Proposed window | Deliverable | Exit gate |
| --- | --- | --- | --- |
| A | Week 1 | Correctness contract and minimal traces | Reproduced P1 cases have regression coverage and pass repaired behavior |
| B | Weeks 2–3 | Workload limits, bounded recall, durable turns/jobs | Overload, disconnect, duplicate and restart drills pass |
| C | Weeks 3–5 | Evidence allocation and task-specific retrieval experiments | Held-out quality improves within latency/cost constraints |
| D | Weeks 5–8 | Calibrated evaluation and operational release | Quality, recovery, ownership and workload gates pass |

## Ordered implementation backlog

| ID | Change and affected modules | Effort | Dependencies | Concrete acceptance |
| --- | --- | ---: | --- | --- |
| A1 | Preserve review rejection separately from correction validity; explicit review/outcome states (`agent/simulation`, `agent/run`) — F02 | 1–2d | None | Invalid `[99]`, empty/oversized correction, second-review failure and timeout cannot erase a negative verdict; supported uncertainty remains allowed |
| A2 | Enforce evidence requirements for verification; separate factual assertions from uncertainty and transformations (`agent/prepare`, `agent/run`) — F01 | 2–3d | A1 | Zero/failed/irrelevant searches cannot yield an unqualified verified answer; cited-but-unsupported claims are rejected or qualified |
| A3 | Normalize adapter completion and usage contracts; explicit output and tool-argument bounds (`llm`, `llm/responses`) — F04/F05 | 1–2d | None | EOF/length/filter/error cases do not become completed answers; successful paths work in both API modes |
| A4 | Turn IDs and bounded stage telemetry; count successes, failures, cancellations, usage and missing usage — F12 | 1–2d | A3 for full usage | Every terminal outcome has a trace; logs do not contain raw prompts/keys by default; server emission and client rendering are named separately |
| B1 | SQL-bounded recall with cutoff-aware candidates; bounded date queries and batched ledger pagination — F03/F13 | 2–3d | None | 100k-record broad-term/date tests avoid unbounded ID binding; future records cannot crowd out eligible records; measure disk-backed p95/event-loop delay |
| B2 | Turn/model admission, fair bounded queues, output/token/spend caps, deadline reserve and foreground priority — F05 | 2–3d | A3/A4 | A 100-request mock burst stays within limits; rejected work does not hit providers; queued cancellation releases capacity; final synthesis cannot starve |
| B3 | Durable turn identity, idempotency and completion recovery; EOF/backpressure handling (`server`, `agent/run`, `memory/store`, UI client) — F06 | 2–3d | A4 | Retry after commit returns the same episode; duplicate in-flight key shares/rejects consistently; same key with different input conflicts; slow clients have bounded buffers |
| B4 | Persist conversation mode/viewpoint, actual creation time and sequence; explicit request time policy — F07 | 1–2d | B3 | Independent tabs/conversations do not alter each other; backward viewpoint does not reorder conversation; concurrent same-session turns have defined sequencing |
| B5 | Transactional outbox, stable claim identity, bounded answer indexing, worker lease/retry/drain — F11 | 2–3d | B3 | Crash after answer commit resumes work once; retries preserve claim links; simulated answer-only terms are searchable as conversation, not verified facts |
| C1 | Deduplicate evidence before charging budget; round-level facet packing and reserved follow-up capacity — F08 | 1–2d | A2/A4 | Repeated observations consume only a short reference; later decisive evidence is admitted; source numbers remain stable; total budget stays bounded |
| C2 | Retrieval profiles, bounded full-text source expansion and structured freshness metadata — F09/F10 | 2–3d | C1/A4 | Complete-list/table cases improve; unsupported mode/filter combinations are rejected before HTTP; primary-source and freshness behavior is observable |
| C3 | Versioned evaluation data, retrieval/admission/citation traces, calibrated human/automated scoring — F12 | 3–5d plus labeling | A4; start data work in A | Human reference labels are hidden from generation; frozen and live tracks are separate; quality metrics are computed at the correct stage |
| D1 | Owner-scoped storage/routes/recall and local/hosted request-origin policy — F07 | 2–4d | B4; mandatory before sharing | Cross-owner ledger/detail/recall/turn recovery tests fail access; ownership comes from authenticated context, not submitted session IDs |
| D2 | CI, migration/restore drills, readiness, shutdown, retention and runtime/dependency policy — F13 | 2–3d | B3/B5 | Fresh install and upgrade pass; restore into a clean instance works; shutdown stops admission and safely recovers leased work |
| D3 | Quarantine legacy temporal contracts and annotate superseded plans; provider upper-bound contract fix — F14 | 0.5–1d | None | Active path has no accidental archive gate; upper-bound fixture is rejected; test categories and authoritative docs agree |

The estimates total more than a single short sprint. Do not bundle the entire table into one architectural rewrite. Each row should be a reviewable change with its own validation evidence.

## Contracts to settle in Stage A

**Evidence requirement.** Classify an answer outcome as supported, supported partial, explicitly unverified, or non-factual. Explicit verification of a changing fact cannot finish as supported solely because the model asserts it. A valid citation ID only proves the referenced passage exists. Coverage checks must ask whether the material claim follows from that passage and is applicable to the requested date/entity/units.

**Publication.** Ordinary low-risk streaming may remain provisional. Buffered simulation and verification paths validate before publishing factual prose; persist their final accepted result before releasing it. `done` means committed, and includes durable turn/episode identity plus quality status. On lost completion, the client reads status rather than regenerating automatically. A rejected claim cannot be made safe merely by retracting text after it was visible.

**Time.** Keep real creation/receipt time, viewpoint time, source publication time, acquisition time and any provider-reported fetch time distinct. Historical simulation can use modern sources for events already known in the selected era. It must not silently become a frozen-web product. Resolve conversation order by durable sequence, not simulated dates.

**Budget.** A turn owns one remaining deadline and one token/cost allowance across generation, search, review and repair. Before starting another lookup, reserve enough time for final synthesis and commit. A bounded, useful partial answer is preferable to using the entire deadline on research and losing the response.

**Failure.** Infrastructure failure, empty evidence, insufficient support and a known false draft are different states. Preserve specific internal error codes, return suitable user messages, and avoid revealing raw provider error payloads. Review outages must not erase earlier findings.

## Retrieval strategy experiments

Use the existing Exa adapter as the baseline. Keep one application tool; profiles and internal policy can evolve behind it. Increase complexity only after paired evaluation demonstrates a benefit.

| Workload | Initial policy experiment | Escalation trigger | Stop condition |
| --- | --- | --- | --- |
| Conversation or supplied-text edit | One model call, no mandatory retrieval | User also requests external facts | Task answered |
| Exact URL / known source | Contents highlights for requested facts | Required table/definition omitted | Exact supporting passage or explicit gap |
| Simple factual lookup | One focused query, existing `auto` baseline | Missing relevant primary evidence | Material question answered with support |
| Current-fact verification | Fresh applicable source read; compare against prior claim | Stale/unknown age, contradictory values, entity/units mismatch | Supported current value or clearly unresolved fact |
| Multi-part comparison | At most two initial complementary queries; facet map | One or more required facets missing | All essential facets supported or gaps enumerated |
| Complete table/list | Target authoritative list; bounded full-text expansion | Missing rows/qualifications | Row coverage matches requested scope |
| Historical perspective | Event dates and contemporary knowledge checked separately | Ambiguous same-day event or hindsight conflict | Supported era-appropriate response |
| Complex research | Explicit larger budget/profile | Requires iterative synthesis beyond normal profile | Declared budget or supported coverage reached |

Test `auto` against an eligible low-latency mode on stable-fact queries only; build requests according to provider capabilities. Keep live fetching for tasks that require it. Exa's current `lite` mode does not support live-fetch freshness controls, so it cannot accept this adapter's current request unchanged. [Exa Search reference](https://exa.ai/docs/reference/search).

Prioritize exact passage deduplication and facet coverage before adding a reranker. Then compare provider order, lightweight diversity/primary-source selection, and a bounded reranker on the same candidate set. If evidence is absent from the candidate set, reranking cannot recover it. Repeated syndicated pages should not count as independent corroboration. One authoritative source may be sufficient for a direct fact; disputed claims require stronger corroboration.

Treat extra query rounds, full-text reads, reranking and more expensive models as separate experiments. Keep a change only if it improves the predeclared quality objective within its time/cost envelope. An exploratory second-provider benchmark may test coverage later, but is not required for the initial architecture and should remain offline until justified.

## Measurement and evaluation protocol

### Instrument the actual critical path

Record a bounded trace with `turn_id`, policy version, deployment/model identity, mode, outcome and these spans: admission wait, history/recall, each model call (first delta and completion), search cache lookup, slot wait, provider attempts, evidence packing, review, repair, commit and delivery. Track active/queued work, aborted work, upstream 429s, retries, dropped jobs, event-loop delay and SQLite busy events.

Keep token usage per model request and provider-reported search cost when supplied. Track price-table version separately if calculating cost from tokens. Report unknown usage rather than zero. Include enrichment and unsuccessful attempts in operational cost; separate evaluator cost. Report **cost per supported completed answer**, not just cost per attempted request. Do not double-count reasoning tokens already included in output usage.

Retain only bounded/redacted diagnostic material by default. Store exact cited evidence with the answer; sampled deeper traces require explicit retention/access policy. Do not log keys, full raw HTTP payloads or private model reasoning.

### Establish a useful test set

Start with 200 versioned questions, approximately 20 each: simple facts, volatile facts, direct-source tasks, multi-part comparisons, complete lists, conflicting sources, insufficient evidence, historical perspectives, conversation recall, and adversarial/multilingual/mixed-intent requests. Expand weak slices rather than presenting this seed as representative of every search workload. Include realistic long documents, ambiguous dates, changing prices/units, repeated sources and facts absent from retrieved text.

Split development and held-out evaluation by topic/entity/time; paraphrases of one case must stay in one split. Each case has question, viewpoint, acceptable uncertainty, material claims/facets, dated authoritative reference evidence and relevance labels where applicable. Separate injected failure cases from ordinary quality scoring. Human adjudicators should assess correctness and passage support blind to engine identity; double-label a subset and reconcile disagreements.

Use four complementary tracks:

1. **Deterministic regression:** protocol, budgets, admission, cancellation, persistence, review states and evidence invariants. Run on every change.
2. **Frozen evidence:** fixed provider responses isolate orchestration, packing and model synthesis. Version and hash inputs. Run paired baseline/candidate comparisons.
3. **Live retrieval and answers:** repeat each selected case at least three times across times/days, with warm and cold application caches declared. Retain failures and quota conditions; do not retry selectively until a passing sample appears.
4. **Workload and recovery:** controlled mocks for overload/failure mechanisms; disk-backed realistic memory fixtures; then a cost-capped live validation at declared load. Test SSE/proxy behavior, restart and restore separately.

Frozen-web evaluation can control web changes while live tests measure current behavior; neither substitutes for the other. [Deep Research Bench](https://arxiv.org/abs/2506.06287).

### Score the correct objects

| Dimension | Metric and denominator |
| --- | --- |
| Retrieval | nDCG@5 and relevant-source recall on raw ranked candidates with declared relevance labels; treat unjudged sources explicitly |
| Passage selection | Fraction of required supported facts present in admitted evidence; duplicate token share; omitted decisive facts |
| Answer quality | Material-claim correctness; required-facet completeness; temporal correctness; contradiction handling |
| Citation quality | Fraction of cited claims supported by their cited passages; fraction of material factual claims with adequate evidence |
| Abstention | Unjustified confident assertions on unanswerable cases, and unnecessary refusal on answerable cases |
| Freshness | Applicable source age/status and dated-reference agreement; unknown age is its own category |
| Reliability | Durable completions / accepted turns, separately reporting errors, timeouts, user cancellation, admission rejection and supported partials |
| Speed | p50/p95/p99 by class for server emission, browser first useful answer, and durable completion; include failure duration and deadline-hit rates |
| Efficiency | Actual calls, tokens, provider cost and enrichment cost per supported completed answer |

Citation evaluation should separate factual correctness from citation quality. [ALCE](https://arxiv.org/abs/2305.14627). Automated judges assist triage; calibrate them against human judgments and use a separate judge configuration to reduce correlated errors. A separate model call alone is not independent evidence.

For paired experiments, report absolute change, per-slice regressions and query-clustered uncertainty intervals. Three repeats do not make three independent questions. Predeclare the primary objective and hold-out set. A competitor comparison must use matched input/time/history, declared access and budgets, collected outputs and blinded judging; synthetic fixtures and provider marketing numbers cannot supply competitor scores.

## Initial performance and quality gates

These are **proposed engineering targets**, not observed results or provider promises. Calibrate feasibility after Stage A measurements; freeze the agreed targets before evaluating candidate changes.

| Profile | Proposed p95 first useful answer | Proposed p95 durable completion |
| --- | ---: | ---: |
| Conversation / supplied-text transform | 2s | 6s |
| Simple supported fact | 6s | 12s |
| Explicit current-fact verification | 15s | 20s |
| Multi-part comparison | 20s | 30s |
| Factual historical simulation | 30s | 35s |

An activity indicator is not a first useful answer. Buffered modes intentionally approach completion latency. Longer research belongs to an explicit larger-budget profile rather than silently violating interactive expectations.

Evaluate these gates at declared **1, 4 and 8 active-user workloads**, with think time, question mix, model, region and cache state recorded. Find the saturation knee before choosing admission settings. Then test overload at 16/32 offered concurrent turns with mocks first; the goal is bounded rejection/degradation, not unlimited acceptance. For a stable rate test, use open-loop arrivals and count rejected requests so queue growth is visible. Do not infer a sustainable request rate from a concurrency-only test.

Proposed release gates:

- All confirmed correctness regressions pass; no known rejected draft is published as accepted; malformed/unsupported citations never pass as supported evidence.
- At least 95% of cited material claims are supported and 90% of required facets are covered on the declared held-out set, with per-slice results and uncertainty intervals. These thresholds are starting objectives and do not imply universal accuracy.
- No unacceptable confident fabrication in the designated critical regression set; low false-assertion rate on unanswerable cases without inflating unnecessary refusal. Zero failures in a small sample is not proof of a low population error rate.
- At least 99% durable completion for accepted, non-user-cancelled turns in the declared load test, with failure/degradation rates separately visible; overload does not exhaust process memory or provider budget.
- Zero cross-owner access in isolation tests before shared hosting; duplicate-request, crash/restart and lost-completion drills preserve one logical answer.
- A claimed latency improvement retains quality within a predeclared margin (initial suggestion: no more than 2 percentage points overall and no material critical-slice regression). Cost per supported answer must stay within an explicit campaign/product budget.

Do not publish p99 estimates from 16 cases. Collect enough representative observations for stable tails and show intervals/sample counts. Report failure duration alongside success latency so a system that quickly fails difficult requests does not appear faster.

## Migration, rollout and rollback

Add schema changes incrementally: turn identities/status, conversation sequence/viewpoint, real creation timestamp, quality state, evidence observations and outbox jobs. Backfill real creation time from existing `execution.time.receivedAt` where available; retain unknown where it is absent. Preserve legacy `asked_at` meaning. Use ID order as a documented ordering fallback, not fabricated wall-clock time.

Build new FTS content/indexes in a versioned migration and compare old/new recall results before switching reads. Keep episode and evidence integrity checks. Design retention/deletion behavior deliberately around existing immutable verified-statement triggers; do not assume ordinary row deletion is already supported.

Introduce retrieval profiles and evidence packing behind configuration flags with recorded policy versions. Replay fixed failures, run paired held-out tests, then opt in a small live sample. Roll back by selecting the prior policy; retain traces and additive data so results remain explainable. Do not automatically fall back from a grounded policy to an unsupported answer policy.

Before deployment, restore a backup into a fresh instance and validate counts, foreign keys, FTS recall, cited hashes and pending-job recovery. Set recovery objectives for the intended deployment and test them. Graceful shutdown stops new admission, drains within a fixed deadline, aborts remaining provider calls, and leaves durable jobs recoverable.

Keep one service and local SQLite until measurements justify moving CPU/database work off the event loop or adopting a shared database. Multiple application hosts require coordinated ownership, admission, durable jobs and cache policy as well as shared storage; copying a WAL database to a network filesystem is not that design. [SQLite WAL](https://www.sqlite.org/wal.html).

## First reviewable delivery

Start with A1–A4 and the F03 SQL-bound failure: preserve negative findings, enforce verification evidence policy, reject truncated output, capture stage/usage data, and remove unbounded recall candidates. Include before/after diagnostic outputs and the unchanged ordinary-chat fast path's measurements. The next delivery establishes recovery and workload controls. Retrieval experiments begin once their benefit and cost can be measured.
