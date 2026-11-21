# Backend/search implementation record

This records the implementation of the [action plan](backend-search-action-plan.md), following the
[pre-fix review](backend-search-review-2026-11-15.md). The code retains one TypeScript/Node service,
Exa and local SQLite. No deployment or production release is implied by these changes.

## Delivered contracts

| Item | Implementation | Regression evidence |
| --- | --- | --- |
| A1 / F02 | Rejection survives malformed corrections, invalid review fields, repair failures and unavailable second reviews. Repairs require approval before publication. | `grounded-turn`, `simulation-review`, `historical-turn` |
| A2 / F01 | Current verification requires acquired passages and material-claim applicability checks. Missing, irrelevant or unsupported evidence produces explicit uncertainty. Verification and factual simulation commit before prose publication. | `grounded-turn`, `server-recovery` |
| A3 / F04 | Both model adapters require terminal completion and reject truncation, filtering, refusal, malformed tools, oversized output and interrupted transport. Usage is retained when available. | `llm`, `model-gateway` |
| A4 / F12 | Durable turn identity and bounded stage traces cover admission, model, search/cache/attempts, evidence packing, review/repair, commit and outcomes. Browser render acknowledgement and server emission are distinct. | `server`, `memory-recovery`, `model-gateway` |
| B1 / F03/F13 | SQL filters owner and viewpoint before bounded candidate selection, uses no unbounded ID binding, bounds date queries, and batches paginated ledger details. | `memory-recovery`, `recall` including disk-backed 100k fixture |
| B2 / F05 | Turn and shared-model admission are bounded, cancellable and owner-fair. Completion work has priority over research; foreground capacity is reserved from enrichment. Account quotas, output, request, token, deadline and configured monetary allowances constrain work. | `model-gateway`, `server`, `search` |
| B3 / F06 | Request key/input conflicts are durable. Completed retries return the same episode; in-flight retries return status. IDs and request keys recover lost completion. SSE has bounded buffers, backpressure, heartbeat and slow-client cancellation. | `server`, `server-recovery`, `clock-ui` |
| B4 / F07 | Owner/conversation mode, viewpoint and durable sequence are separate from actual creation time. Same-conversation active turns conflict. Browser tabs use separate session storage. | `memory-recovery`, `server`, `clock-ui` |
| B5 / F11 | Answer text is synchronously indexed as untrusted conversation. Answer/evidence/outbox commit atomically. Durable jobs use owner-fair leases, retries, dead-letter state and drain/restart recovery. Claim identities remain stable. | `memory-recovery`, `enrich`, `server-recovery` |
| C1 / F08 | Exact observations are charged once and repeated as short references. Round packing interleaves query ranks, preserves source numbering, and reserves capacity for later evidence. | `evidence`, `grounded-turn` |
| C2 / F09/F10 | Retrieval profiles, explicit bounded full-text expansion, capability validation, complete cache keys, publication bounds and structured freshness/provenance are implemented. | `search`, `evidence` |
| C3 / F12 | Versioned frozen inputs, raw/admitted/cited stage separation, 200 pending-label seed cases, label projection, cluster splits, human/automated calibration, paired uncertainty and fail-closed release evaluation. | `benchmark`, `quality-protocol`; human/live evidence still required |
| D1 / F07 | Authenticated owners scope ledger, detail, history, recall, clarification, turn/key recovery and trace routes. Local Host/Origin validation and hosted HTTPS-origin/token policy precede request handling. | `server`, `memory-recovery` |
| D2 / F13 | Versioned transactional migrations, future-schema refusal, backup/restore/hash/FTS drills, readiness, bounded shutdown, operational retention, runtime/dependency policy and CI are implemented. | `operations`, `memory-recovery`, `server-recovery` |
| D3 / F14 | Publication upper bounds are enforced without snapshot mode. Legacy eligibility is documented separately; active era chat never requests a snapshot or archive-access gate. | `search`, `historical-turn`; [capability matrix](README.md) |

Review quality states are `supported`, `supported_partial`, `explicitly_unverified`, and `non_factual`.
They describe the pipeline's evidence decision. Semantic model review remains probabilistic; a
`supported` state is not a certificate of truth. Ordinary chat may stream provisional deltas; its
`done` event requires a durable commit. The saved result and exact cited passages are recoverable by
owner-scoped turn ID or request key. Recovery never automatically regenerates an answer.

Ordinary era answers no longer receive a blanket unverified-warning prefix. Their own wording and
specific uncertainty remain, with evidence status shown by the quality badge. Explicit verification
and anchored-review failures still return an unresolved check; rejected drafts cannot publish, and
partially checked references still identify the remaining unverified scope.

## Budgets and retrieval policy

A turn has one deadline and model budget across research, synthesis, review and repair. Foreground
and enrichment share account admission/quota controls; background job attempts record separate
usage and outcomes. Operator-configured prices and per-search-attempt bounds permit combined spend
admission. Unknown usage is explicitly unknown and charged conservatively for admission; a token
price estimate is distinct from a provider bill. Provider overruns are recorded and stop further paid
work; a client cannot guarantee a provider will honor an operator's bound. Every paid entry point also
uses the same persistent Azure $30 / Exa $20 product-completion wallet. Per-run wallets can tighten
that allowance and never renew it. See [provider budgeting](../provider-budget.md) and [operations](../operations.md).

Exa `auto` remains the search mode. Required verification/historical policy and explicitly requested
bounded full reads are available; `RETRIEVAL_PROFILES=1` opts into automatic task-specific profile
selection for comparisons, complete lists and direct-source tasks. The flag does not waive correctness
requirements. No reranker, additional provider, or automatic switch to `lite` is enabled.

Packing considers up to eight eligible candidates per query, covering the comparison and research
profiles without discarding ranks six through eight before the budget check. It interleaves provider
ranks across query batches, charges exact observations once, and keeps follow-up capacity. Question
facets, primary-source preference, contradiction handling and decisions to deepen a lookup remain
prompt-guided. There is no structured semantic facet map or guaranteed facet-coverage stop rule;
those behaviors require separate measured experiments and must not be inferred from fair packing.

Local acquisition time never proves page freshness. Requested freshness, provider acquisition status,
reported fetch time and unknown age are separate fields. Lite requests omit live fetching and reject
incompatible verification/freshness controls before HTTP. This follows the [Exa Search contract](https://exa.ai/docs/reference/search)
and [Contents contract](https://exa.ai/docs/reference/get-contents).

## Validation scope

The reproducible evidence consists of unit/HTTP/browser-model regressions, frozen provider/model
fixtures, disk-backed scale tests, overload/admission tests, actual socket disconnects, process crash
and restart, and clean restore drills. Local mock latency measurements describe those fixtures and
this machine. They do not establish Exa/model latency or sustainable live throughput.

Run the engineering gates with:

```sh
npm ci
npm run typecheck
npm test
npm run eval:benchmark -- --out .context/frozen-release.json
npm run eval:quality -- --out .context/quality-release.json
```

The quality command reports missing evidence by default. Its report-generation success is not a
production-release pass; enforce the release gate with the command documented in [evaluation](../evaluation.md).
Tests keep temporary servers private and close them afterwards. The normal development servers
remain stopped unless explicitly started by an operator.

## Verified engineering results

The initial 370-test architecture suite passed on both supported runtimes. After the context-boundary
repair, the same **428 tests**, TypeScript checking and six versioned frozen fixtures pass on Node
22.16.0 and pinned Node 24.22.3. Node 22.16 is an API-compatibility check; Node 24.22.3 bundles SQLite 3.54.1 and is the
deployment baseline. The 200-case seed and its manifest validate; dependency audit reports no known
runtime advisories at the configured high-severity gate; `git diff --check` passes. CI is configured
for the named compatibility and pinned production-baseline jobs, but no hosted CI/deployment result is claimed.

The suite includes an HTTP burst of 100 offered turns: with two active-turn slots, three queue slots
and one model slot, five complete and 95 are rejected before provider work. Disk-backed recall tests
cover 100k eligible matches, cutoff filtering, date bounds and exact score ordering. Local five-sample
storage timings are diagnostic, not stable production percentiles. Actual socket-loss, SIGKILL/restart,
owner isolation, idempotent replay, output truncation, bounded shutdown, legacy upgrade and clean
restore/cited-hash drills pass.

Reproducible logs and JSON reports are retained under `.context/backend-search-*`; the release
report remains `ready: false`, as expected without external evidence. Temporary validation listeners
were closed after the checks; the user-requested local preview is running on port 3000. Changes are
saved locally and uncommitted.

Real-provider development diagnostics completed 22 answers with no terminal errors, including a
matched-input nine-case baseline/candidate pair. One review timed out and the answer stayed
explicitly unverified; its unknown usage was charged at the full reservation. The pair has different
source snapshots and does not establish a profile improvement or human accuracy score. A separate
24-turn HTTP smoke test completed all turns durably across 1/4/8-user loads with the normal memory
worker, booking $0.842778 Azure and $0.027 Exa. Its small samples do not establish stable tails.
Reports and limitations are in [evaluation](../evaluation.md) and the [HTTP workload guide](../evaluation-workload.md).

The larger finite HTTP cohort completed **104/104 accepted turns at each 1/4/8-user load**:
312 durable answers, no terminal errors, rejections or cancellations. All 117 cited hashes passed,
all answer jobs completed, and global/campaign ledgers reconciled including 78 worker calls. It
booked $11.339258 Azure and $0.194 Exa. Two review timeouts produced explicitly unverified answers
and retained their full unknown-usage bounds. This cohort used the old Node 22.16 compatibility
runtime with SQLite 3.49.1; it is retained as development evidence, not qualification of that runtime
for deployment. A final **24/24 HTTP smoke** on pinned Node 24.22.3 also passed, booking $0.847817
Azure and $0.027 Exa. Across all HTTP cohorts, 360/360 turns delivered and committed successfully.

Class latency targets are **not all met**. Verification completion p95 was 20.160s/22.577s/18.343s
at 1/4/8 users (13 repeated cases per load); conversation and transformation completion p95 at eight
users exceeded the proposed 6s target. Browser first useful content remains unmeasured. Repeated
prompts, differing session histories and finite cohorts prevent independent question-level or
sustainable-rate claims. Overall latency aggregates cannot waive class-specific targets.

At the end of those original workload campaigns, recorded project bookings were **$14.056040 Azure**
and **$0.271 Exa**, leaving **$15.943960**
and **$19.729**, respectively, inside the original total caps. No holds, locks or bound violations
remain. Azure amounts use conservative envelopes, including three unknown-usage review attempts;
they are not invoice totals. The canonical wallet has a separately verified WAL-aware snapshot.
Those temporary validation listeners were closed. The user subsequently requested the local preview,
which remains running on port 3000.

## Subsequent context-boundary repair

The reported AI-model-to-IPL topic switch exposed a gap in the original transcript cutoff contract.
Current-thread messages now survive viewpoint changes, implicit verification is pinned to an exact
same-conversation answer/hash, and unrelated memory is excluded. Explicit recall has strict owner,
conversation and date scope; empty/ambiguous dates cannot select a different topic. Missing references
and their background jobs ask for scope without model/search work. The full contract and legacy-retry
behavior are documented in [conversation/memory boundaries](context-memory-boundaries.md).

The final engineering checks pass 428 tests on both Node runtimes, type checking, frozen fixture v3,
and the runtime dependency audit. A single live replay against a protected copy of the actual reported
conversation selected the original AI answer, excluded the saved IPL response and completed durably.
Its review timed out, so it returned explicitly unverified text rather than publishing an unchecked
draft. This validates subject isolation and safe degradation, not factual accuracy. Actual user rows
were independently confirmed unchanged. The replay booked $0.367252 Azure and $0.021 Exa within
$1/$0.10 campaign caps.
Subsequent unresolved-retry and verification-wording changes are covered by offline regressions;
no additional paid replay is claimed for those changes.

At the protected-copy replay's finish on 15 November 2026 at 09:41:29 UTC, the canonical wallet was
**$15.309816 Azure booked / $14.690184 remaining**, and **$0.355 Exa reported / $19.645 remaining**.
That historical snapshot included six unknown Azure attempts and no unknown Exa attempts.

The latest recorded read-only snapshot, at 10:27:03 UTC on the same date, includes subsequent app
activity: **$15.757558 Azure booked / $14.242442 remaining**, and **$0.430000 Exa booked /
$19.570000 remaining**. Seven unknown Azure settlements and three unknown Exa settlements retain
their full bounds. Exa's booked total therefore includes unknown-attempt bounds, not just
provider-reported costs. No unsettled holds, pending reservations, locks or violations remain.
These are budgeting-envelope/accounting figures, not invoice totals. Read the current wallet before future work.
Real-provider readiness now also checks the required price envelopes and search bound before
advertising readiness; no paid check is used for this preflight.

## Empirical release gates still outstanding

The 200-case seed is a labeling queue, not an adjudicated quality benchmark. No human judgments,
calibration pass, representative latency improvement, competitor result or production deployment is
claimed. Before enabling a broader retrieval policy or releasing a hosted service:

- Capture dated authoritative references and reconcile blinded human labels on the held-out groups.
- Calibrate the separate automated judge and compare baseline/candidate on identical frozen and live inputs, reporting slice regressions and cluster uncertainty.
- Collect held-out cross-day warm/cold runs and representative browser/proxy/open-loop workload evidence within the remaining allowance; retain failures and overload rejections.
- Verify the agreed latency, supported-claim/facet, reliability and cost targets, and the deployment's off-host backup/restore objectives.

The release evaluator fails closed when these records are absent, mismatched, duplicated or below
target. These gates require external evidence; deterministic fixtures cannot honestly replace it.
