# Evaluation commands

The evaluation tracks answer different questions. Do not use scripted fixtures as evidence of model accuracy or production response time.

## Current comparison pipeline

```sh
npm run eval:comparison -- --users 5 --turns 25 --out .context/comparison-candidate.json
```

This command starts an ephemeral loopback server and uses the real `/api/chat` path, admission queues, one-pass comparison, source validation, durable completion and SQLite persistence. Model and search providers are deterministic substitutes. It never reads provider credentials, opens a provider wallet or contacts external providers. The temporary application database is in memory.

The report separates eight behavioral regressions from a homogeneous 25-request comparison workload with five closed-loop users. Regressions cover unchanged facts, corrections, the hosting billing gap, an invalid supporting quotation, an omitted original item, facts outside extracted records, no source results, and provider failure. Expected canonical coverage is compared with the records actually committed. Useful-fact loss and unexpected confirmation are counted separately. A durable explanatory response to a provider failure remains visible as `comparisonUnavailable`; it is not a successful factual check.

P50, first text and all-terminal latency retain their sample counts. P95 is withheld below 20 samples in each group, including completed and failed groups. Timings include application overhead and the declared injected provider delay, not real model/search latency. Browser render time and independent factual accuracy remain unknown. Background enrichment is outside this diagnostic; use `workload.ts` for worker contention and wallet behavior.

For before/after checks, run the same harness, fixture version, arguments and Node version against both revisions, with distinct output filenames. Compare the behavior denominators first. The report records source, dependency, harness and fixture hashes. Do not compare this synthetic latency with the live-hosting request measurements.

## Reference review queue

```sh
npm run eval:quality -- --dataset eval/quality/review-cases.json --out .context/review-queue.json
```

The focused queue contains 25 conversations, including hosting billing, an unfinished retry, an invalid support quotation, full-answer coverage and an ordinal follow-up. All factual labels remain pending independent human review. Required facets are evaluation instructions, not established factual answers. The generation projection removes labels. Machine-captured source excerpts can support review preparation but cannot be relabelled as independent human adjudication.

## Real provider latency

`eval/workload.ts` already accepts `--loads 5`. It defaults to a dry plan. A live workload requires explicit Azure and Exa caps and uses the existing durable provider wallet. Inspect remaining funds and retain failure/cancellation records before running it. Do not reset wallets or present a small diagnostic sample as a representative p95.

```sh
node --import tsx --disable-warning=ExperimentalWarning eval/workload.ts --loads 5 --turns-per-load 25
```

That command prints a plan only. The standard live benchmark and quality gates remain separate from the comparison diagnostic.
