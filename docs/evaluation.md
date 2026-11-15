# Search evaluation and release evidence

The deterministic pipeline and evaluation framework are implemented. Small real-provider development diagnostics have been collected; held-out quality, representative latency and human calibration remain unmeasured. The bundled dataset contains **200 questions, 20 in each of ten slices, with every reference capture and human label pending**. A green unit suite or frozen replay does not satisfy the production release gate.

## Offline checks

```sh
npm run typecheck
npm test
npm run eval:benchmark -- --out .context/benchmark.json
npm run eval:quality -- --validate-seed --out .context/quality-release.json
```

These commands make no live provider requests. The benchmark replays six scripted pipeline fixtures; its model answers, retrieval responses and review outcomes are fixtures, not measurements of a model's factual accuracy. The quality command validates the 200-question seed and reports the unmet release gates. It exits successfully when validation succeeds; add `--require-release` to exit nonzero while any empirical gate remains unmet.

`eval/benchmark/frozen-manifest.json` hashes each complete frozen fixture. `eval/quality/seed-manifest.json` hashes the seed and its split assignments. Runtime validation and regression tests reject manifest drift. Review fixture/seed changes, update their version and manifest together, and preserve the prior artifact when comparing experiments.

The seed covers simple and volatile facts, direct-source questions, comparisons, complete lists, conflicting sources, insufficient evidence, historical viewpoints, conversation recall, and adversarial/multilingual requests. Injected failure questions and frozen conversation records are tagged separately from live-quality questions. Related entity groups, including compared entities and their dates, stay in one split. Every slice contains held-out cases. These authored groups need human review when the dataset changes; lexical entity matching cannot discover all paraphrases or semantic overlap.

## Keep evaluation labels out of generation

`generationInput` and `projectGenerationInput` allow only the question ID, question, viewpoint, timezone and the `at/question/answer` fields of supplied history. They omit relevance grades, expected facts, acceptable-uncertainty labels, reference evidence, split assignments and human judgments. Nested history is projected as well. Input identity hashes those generation fields, including timezone, independently of reference labels.

Export a labeling file without contacting a model:

```sh
npm run eval:quality -- --annotation-template .context/quality-labels.json
```

The file contains a versioned `cases` array accepted by `--dataset`. Human adjudicators fill each case's `labels`: material required facets, acceptable uncertainty, dated reference passages with exact SHA-256 text hashes, source relevance grades, adjudicator identities, and reconciliation status. Preserve the seed's IDs, tracks and related-entity clusters. Adjudicated references require nonempty passages, facets, attribution and reconciliation; a label marked pending cannot satisfy the held-out gate. Keep the labeling artifact out of generation and ordinary application logs.

## Measure the correct stage

`eval/benchmark.ts` observes three different objects:

| Object | Capture | Meaning |
| --- | --- | --- |
| Raw retrieval | Each successful provider query batch, in returned provider order | Retrieval nDCG@5, reciprocal rank and relevant-source recall |
| Admitted evidence | Exact passages and hashes observed through the evaluation-only packing hook | What the synthesis model could use |
| Cited evidence | Sources committed with the final answer | Final evidence selection and citation integrity |

Retrieval metrics are computed per raw query batch and averaged; several query rankings are never concatenated into a fictional rank list. Unjudged URLs count as zero relevance and their count is reported. An imported answer without raw retrieval has **null retrieval metrics**. `selectedSourceNdcgAt5` and `selectedSourceRecallAt5` describe cited-source selection, not provider ranking. `retrievalInstrumented` records whether capture was enabled; `retrievalMeasured` requires an observed query batch. A no-search case has no measured provider ranking, while an observed query returning no results can score zero against positive relevance labels.

A citation ID must resolve to a saved nonempty passage. No citations yield `citationEvidencePresent: false`, rather than vacuous support. Even valid IDs and exact-string fact matches cannot establish entailment: automated benchmark `citationSupportRate` and `materialClaimCorrectness` stay null. Blind human annotations score material claims, cited-claim support, facet completeness, temporal correctness, confident false assertions and unnecessary refusal separately, with their own denominators.

Latency includes failures. `serverFirstEmissionMs` records server emission, while `clientFirstRenderMs` remains null in this terminal harness. Browser rendering must be measured in the browser. p99 remains null below 100 observations; that floor alone does not establish a stable tail estimate.

## Run an explicitly capped live campaign

Live generation, review and Exa share one per-turn `ModelBudget`, admission pool, quota and deadline. Each physical search attempt, including a retry, reserves its configured attempt bound. Returned hits do not each incur that request charge. Unknown usage retains conservative reservations and is reported as estimated; it is never billed as zero by the campaign admission logic.

Configure the provider credentials and an operator-maintained price table (`INPUT_DOLLARS_PER_MILLION`, `OUTPUT_DOLLARS_PER_MILLION`, `MODEL_PRICE_VERSION`), plus a positive `SEARCH_MAX_ATTEMPT_DOLLARS` and suitable per-turn limits. Then explicitly choose a campaign cap:

```sh
npm run eval:benchmark -- --live --dataset .context/questions.json \
  --max-campaign-dollars 5 --out .context/live-benchmark.json
```

This example spends up to the declared admission allowance; it is not run by CI. The amount must fit the actual campaign budget. Missing cap, prices or attempt bounds stop the command before provider work. If a provider exceeds an operator's stated bound, preserve the violation and stop further paid work; a local reservation cannot impose a billing contract on an upstream provider.

The benchmark disables background enrichment and reports that scope. Its cost includes failed foreground attempts; it cannot supply whole-product cost including enrichment. A release campaign's `costDollars` must include generation, search, review, repair and enrichment, and must be null if any component cannot be accounted for. Human/evaluator cost is separate. The benchmark initializes one in-memory application cache and shares it across cases in that process; declare cache conditions when collecting repeat samples. Retain outages, quota failures, rejection and elapsed failure duration instead of selectively retrying to a successful answer.

## Human calibration and paired comparisons

`Annotation` requires nonnegative consistent counts. Support is `supportedCitedClaims / citedClaims`; factual correctness is `correctClaims / materialClaims`; facet coverage is `coveredFacets / requiredFacets`. A zero denominator is unknown. The facet denominator must match the case's adjudicated facet list when checking release evidence.

Calibration pairs a reconciled, blinded human reference with an automated judgment of the **same case, engine and output hash**. Duplicate records cannot inflate the count. The release checker requires at least 20 distinct calibrated questions, a distinct declared judge configuration, mean absolute calibration error at most 0.10 for each calibrated metric, and an attributed double-labeled subset of at least five cases or 10% of held-out cases. Two distinct blinded human identities must have scored the same output for each double-label claim. Separate model calls do not themselves provide independent factual evidence.

`pairedReport` first averages repeats per question, then questions per authored cluster. It bootstraps those clusters with a deterministic seed and returns absolute change, 95% intervals, question/cluster/sample counts and per-slice results. A single independent cluster has no interval. Repeating one question does not create extra independent questions or give it more weight within a cluster. Predeclare the primary objective and quality margin before comparing policies.

## Production release gate

```sh
npm run eval:quality -- --dataset .context/quality-labels.json \
  --evidence .context/release-evidence.json --require-release \
  --out .context/release-report.json
```

The evidence schema is `ReleaseEvidence` in `eval/quality/protocol.ts`. It binds to the exact dataset hash. It contains:

- Reconciled blind human and automated annotations with case, engine and output hashes; raw first-pass labels for the double-labeled subset.
- Distinct retained live run IDs, matching input/output identities, capture times, declared warm/cold caches, success/failure and complete operational costs. At least three runs over at least two days are required for each live held-out case. Frozen records have a separate field and cannot count as live repeats.
- One aggregate for each declared live 1/4/8-user workload, with accepted non-cancelled turns, durable completions, rejected turns, latency-target result and bounded-provider-budget result. Require at least 100 accepted turns per workload and at least 99% durable completion. Mock overload tests remain a separate correctness track.
- Passing correctness, ownership, duplicate-request, crash/restart, lost-completion, restore and shutdown drills; a reconciled double-label attribution list; and a predeclared objective, model identities and explicit campaign cap.
- Paired held-out quality observations that retain the declared two-percentage-point margin overall and per measured slice. They require at least 20 questions in at least two independent clusters.

The checker rejects duplicate, foreign or mismatched records, unsupported double-label claims, inconsistent denominators, duplicate workload aggregates and unrelated dataset hashes. Missing evidence fails closed. It requires at least 20 adjudicated held-out cases, 95% cited-claim support, 90% facet coverage and zero designated confident false assertions. It reports per-slice human scores, calibration, clustered paired intervals, known operational cost and cost per human-supported completed answer. Unknown costs stay null.

The checker validates the structure and consistency of supplied measurements. Collect and retain the underlying run, labeling and workload artifacts so reviewers can audit their provenance. The repository supplies the protocol, pending seed and development diagnostics; completed human adjudication and production release evidence remain outstanding. The [HTTP workload harness](evaluation-workload.md) measures delivery, durable storage and worker behavior under the same project wallet, separately from answer quality.

## Small real-provider development pilot

`eval/pilot.ts` prepares nine focused questions and a separate official-reference queue without starting a provider or a server:

```sh
npm run eval:pilot -- --out-dir .context/live-pilot
```

The questions cover current SQLite release verification, a complete BIPM SI table, a 1970 Apollo landing table, an explicit 2035 Olympic scenario, insufficient private evidence, conversation recall, a supplied-text transformation, NIST tungsten data and a SQLite/PostgreSQL writer comparison. The four-case initial subset exercises recall and transformation before a simple source lookup and current verification. Official excerpts were captured on 15 November 2026 through read-only browsing, with exact hashes of the retained factual excerpts. They are not complete preserved HTTP pages. Proposed checks and references stay outside generation; all human labels remain pending. The pilot overlaps development topics and does not count as an independent held-out study.

After the durable provider-spend ledger, deployment price envelopes and tests are ready, the initial provider command is:

```sh
npm run eval:benchmark -- --live \
  --dataset .context/live-pilot/initial-questions.json --policy baseline \
  --max-campaign-dollars 2 --max-search-dollars 0.50 \
  --out .context/live-pilot/initial-baseline.json
```

The combined allowance conservatively bounds Azure use to at most $2 within this run. The additional search allowance reserves the adapter's complete retry bound per logical lookup, limiting Exa to $0.50 under the configured attempt envelope. Cached/error results retain these local reservations, since the last result cannot prove that an earlier attempt was free. These per-run allowances complement the durable **user-total** provider ledger; restarting a process or changing an output filename must not reset the total remaining allowance. Check `npm run budget:status` before extending a campaign.

The exported `run-plan.json` contains structured baseline/candidate argument arrays, with distinct output filenames. `--policy profiles-v1` enables the candidate default-profile selection while preserving the same generation inputs and explicit model-supplied tool controls. Review the initial answers and retained failures before selecting more cases. Do not present an unmatched, single-run policy comparison as a measured improvement. Frozen regression replay and policy-wrapper tests run without providers before spending on a candidate.

Reports contain deployment identity, adapter mode, reasoning setting, retrieval policy, price-table version and deployment-envelope hash. The implementation hash includes the model adapters/gateway, durable spend guards, telemetry, configuration, retrieval profiles and limits; it is frozen with `sourceSnapshotAt` before provider work begins. Bounded stage traces separate model queue/call, search attempts/cache, evidence packing, review/repair and commit; raw/admitted/cited evidence remains separate. Review spans and committed episode summaries retain the review kind, status, failure-reason enum, calls and elapsed time, including bounded attempt summaries, without storing raw review issues or prompts in that metadata. Priced model usage and retained reservations use conservative operator envelopes and remain estimates rather than invoice amounts. Browser rendering and human adjudication still require separate observations.

The first diagnostic collection contains four baseline cases, nine candidate cases and nine matched-input baseline cases: **22 completed answers, no terminal errors**. One candidate review timed out; its answer remained explicitly unverified and the full unknown-usage reservation was charged. Offline reference checks found the expected table rows, historical boundaries and uncertainty in these samples. These are machine-reviewed development observations, not human accuracy scores. The paired runs have different source hashes, and the earlier candidate predates the pre-provider source timestamp, so they do not establish a retrieval-profile benefit. Exact reports and the confounded comparison are retained under `.context/live-pilot/`. These CLI runs used in-memory conversation stores without enrichment; HTTP workload and disk-recovery evidence are separate.

## Context visibility in frozen replay

`pipeline-regression-v3` keeps the six-case frozen track while correcting the conversation/memory
contract. Seed history can declare `scope: "conversation"` (the default) or `scope: "memory"` for
another conversation. Scope participates in the input hash and is applied when seeding storage. The
visibility fixture retains a later-viewpoint current-thread quote while excluding a future other-chat
record. A quoted prior statement is an object of recall, not evidence that a world event had happened.

The user-reported model-to-IPL substitution also has HTTP, UI, reviewer and real-worker regressions.
A capped live protected-copy replay maintained the pinned AI answer and excluded unrelated memory;
its review timed out, so the answer remained explicitly unverified. No factual-quality pass is claimed.
