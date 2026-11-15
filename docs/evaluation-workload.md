# HTTP workload validation

`eval/workload.ts` drives the actual loopback HTTP server, streamed answer protocol, disk-backed conversation storage and normal background memory worker. It uses the configured model and Exa adapters for a live run. The default command is a dry run that starts no server and makes no provider requests.

The declared mix contains eight deterministic conversation, supplied-text transformation, conversation recall, lookup, verification and historical-perspective tasks. The database includes a known Project Cedar conversation and bounded synthetic planning records. These are conversation history, not hidden scoring labels. No human reference answers or adjudication labels are sent to generation. This harness measures workload and protocol behavior; answer correctness, citation entailment and completeness require separate evaluation.

The harness also accepts `--loads 5` for a five-user deployment comparison. Defaults remain 1/4/8.

## Planning and preflight

```sh
npx tsx --disable-warning=ExperimentalWarning eval/workload.ts
npx tsx --disable-warning=ExperimentalWarning eval/workload.ts --preflight \
  --loads 1,4,8 --turns-per-load 8 \
  --max-azure-dollars 1 --max-exa-dollars 0.1 \
  --out .context/workload-http-smoke
```

Preflight loads the local configuration, validates both model deployment price envelopes and the Exa attempt bound, and checks that the requested caps fit the remaining canonical product wallet. It starts no server, creates no campaign wallet and sends no provider HTTP. It records a timestamped SHA-256 manifest of every `src/**/*.ts` file plus the workload implementation, and a separate dependency-lock hash before provider calls. The live report reuses its own preflight snapshot; price-envelope identity and effective bounds are recorded without credentials. Region metadata defaults to `unknown`; supply `--azure-region` only when the deployment region is actually known. The configured endpoint alone does not establish it.

## Explicit paid run

After reviewing preflight and the current product allowance, use the same options with `--live`:

```sh
npx tsx --disable-warning=ExperimentalWarning eval/workload.ts --live \
  --loads 1,4,8 --turns-per-load 8 --think-ms 100 \
  --max-azure-dollars 1 --max-exa-dollars 0.1 \
  --out .context/workload-http-smoke
```

The two caps are absolute for the entire invocation, including all load levels, warmups, failed attempts, review/repair, search retries and background enrichment. They do not reset between loads or virtual users. A separate durable wallet under the output directory tightens the canonical Azure $30 / Exa $20 product-completion wallet. Each physical attempt reserves in both ledgers before HTTP. If the narrower wallet rejects admission, its unstarted global hold is cancelled. Started attempts cannot refund their holds; unknown billing retains the full bound. Settlement attempts both ledgers even when one records a billing-bound violation.

Budget refusal remains in the report. A small cap can limit how much of an offered workload completes, particularly because simultaneous requests reserve their full upper bounds. Do not remove rejected samples, retry until a desirable run appears or reset a wallet. The output directory must be a new path under `.context/`; a new workload wallet never creates new product allowance.

Each load level gets a fresh disk database, a fresh Exa application cache and an ephemeral loopback listener. The listener always shuts down in cleanup. Virtual users issue turns sequentially with the declared think time; different users run concurrently. `--turns-per-load 8` means eight total offered turns at each load, not eight per user. This is a closed-loop concurrency experiment. It does not establish a sustainable open-loop arrival rate or the saturation knee. Each fresh load also starts a new local quota window; upstream provider quotas and unrelated account traffic do not reset. Separate larger phases sufficiently to avoid carrying unmeasured account exhaustion between them.

The finite cohort assigns case indices to users by stride (`user`, `user + load`, and so on).
At eight users, each session repeats one of the eight tasks. Faster sessions finish before slower
verification/historical sessions, so eight virtual users are not continuously active for the entire
phase. Repeated prompts and shared session history make observations correlated. Declare this
assignment when interpreting the report; it cannot establish steady eight-user capacity or
independent question-level quality. Do not change scheduling, quotas or caps during a recorded run.

Use `--turns-per-load 100` or more for a larger declared campaign only when its cost fits the remaining allowance. The default eight samples per load are a smoke diagnostic. Small samples cannot support stable tail-latency or reliability claims; p99 is left null below 1,000 measured samples in a reported group.

## Cache, worker and measurement policy

The default `--cache cold` starts each load with a new application cache. Cache hits can occur later in that load. `--cache warm --warmup-turns 8` declares paid sequential warmup turns before the measured cohort; every warmup remains in the report and both wallets. Warming is attempted, not guaranteed: generated queries can differ, and freshness-sensitive lookups bypass the application cache. Cache-hit/miss trace counts show actual behavior.

The normal worker shares the application's model gateway, quota and both spend ledgers. `--worker-drain-ms` defaults to 5,000; remaining pending/retry work is reported and retained in that load's database. Shutdown follows the same bounded application drain as normal operation. Unsettled provider holds remain reserved after cleanup; if a load leaves such holds, later load levels are marked not run rather than starting additional provider work. Do not reopen these databases with a provider-enabled worker outside their campaign policy.

Success requires the real SSE `done` event. A stream ending without `done` is a protocol failure even if the status endpoint subsequently recovers its durable episode. Recovery is recorded separately, without automatically generating another answer. The observer adds bounded status/trace GETs after each turn; these are local instrumentation requests and make no provider calls.

The report separates:

- Offered, accepted, rejected, completed, clarification, error and client-deadline cancellation counts; durable completion and delivery are distinct. This harness does not deliberately cancel users, so client deadlines remain in the accepted-turn reliability denominator.
- Server first emission, first text observed by the Node HTTP client, and final text onset after a retraction. Browser rendering is unmeasured and always null. These are not human judgments of first useful content.
- Success and failure durations, per-load p50/p95 with sample counts, declared mix, limits, cache policy, model, API mode and known/unknown region.
- Bounded foreground/background stage traces, model usage and missing usage, worker state, event-loop statistics and both wallets before/after the campaign.

Artifacts are `report.json`, `turns.csv`, `stages.csv`, the workload wallet and one retained application database per load. JSON and CSV contain bounded/redacted operational observations, not raw model prompts, provider keys or private reasoning. Stored conversation/evidence remains in the protected `.context/` databases. Financial totals are conservative price-envelope bookings including held bounds, not provider invoices. Cost per engine-reported supported completion is explicitly separated from independently adjudicated support.

No release gate is automatically declared passed by this harness. Human-calibrated quality, representative failures, browser rendering, proxy behavior, open-loop load and recovery objectives remain separate evidence.

## Collected development evidence

On 15 November 2026 the original smoke completed 24/24 turns, followed by 104/104 accepted and
durable completions at each 1/4/8-user load in `.context/workload-http-312/`. That finite cohort had
zero terminal errors, rejections or cancellations, all jobs completed, 117 valid cited hashes, and
exact wallet reconciliation. Azure bookings were $11.339258 including worker calls and two
unknown-usage review timeouts; Exa reported $0.194. Both review timeouts returned visibly unverified
answers. The cohort ran on Node 22.16.0 / SQLite 3.49.1 and is compatibility/development evidence.

The pinned Node 24.22.3 / SQLite 3.54.1 runtime then passed a separate 24/24-turn smoke under
`.context/workload-http-node24-smoke/`. It booked $0.847817 Azure and $0.027 Exa, with no new unknown
usage or pending work. No causal runtime-speed comparison is claimed from these unmatched cohorts.

The larger cohort did **not** satisfy all proposed class latency targets. Verification completion
p95 was 20.160s and 22.577s at 1/4 users (13 samples each); eight-user conversation/transformation
p95 exceeded 6s. Browser rendering remains null. Overall completion p95, successful delivery and
engine-reported support labels cannot establish independent accuracy, stable tails or release readiness.
