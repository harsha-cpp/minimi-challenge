# Submission readiness

The working tree contains the application, tests, frozen evaluation fixtures, CI configuration and operating guides. Provider credentials, conversation databases, the provider wallet and private diagnostic artifacts are excluded from the source handoff. Commit messages can be reviewed separately before any staging or commit.

## Install and validate without paid providers

Use the exact Node version pinned in `.nvmrc` and `.node-version`: **24.22.3**. With nvm:

```sh
nvm install
nvm use
npm ci
npm run typecheck
npm test
npm run eval:benchmark -- --out .context/submission-frozen.json
npm run eval:quality -- --validate-seed --out .context/submission-quality.json
```

The tests and these two evaluation commands use mock providers or frozen evidence; they make no paid provider requests. Tests use temporary application/wallet databases. The quality command validates the seed and reports unmet empirical release gates. Its successful exit means the protocol is valid. Adding `--require-release` intentionally fails until the required evidence is supplied. Other evaluation commands can use live providers; consult their documentation before running them.

For a fresh checkout, copy `.env.example` to `.env` and leave its credential fields blank to inspect the interface with `npm run dev` at `http://localhost:3000`. The interface reports missing configuration and cannot generate answers in this state. `/healthz` reports liveness; `/readyz` remains unavailable until real provider configuration is complete. This is a configuration preview, with no simulated provider answers.

## Configure a funded demonstration deliberately

Set credentials and deployment settings in a private `.env`, using `.env.example` as the schema. Keep credentials out of source files, screenshots, shell history and shared artifacts.

| Configuration | Purpose |
| --- | --- |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_MODE` | Select the compatible model endpoint and adapter. The supported modes are `responses` and `chat_completions`. |
| `LLM_FAST_MODEL` | Optional enrichment deployment; its price envelope is also required when configured. |
| `EXA_API_KEY` | Authorize web discovery and selected-source reads. |
| `INPUT_DOLLARS_PER_MILLION`, `OUTPUT_DOLLARS_PER_MILLION` | Positive shared rates for turn/account spend admission. |
| `MODEL_PRICE_VERSION`, `MODEL_DEPLOYMENT_PRICES_JSON` | Identify documented conservative envelopes for every allowed deployment. Unknown or unpriced deployments fail before HTTP. |
| `SEARCH_MAX_ATTEMPT_DOLLARS` | Positive documented upper bound for one complete physical Exa attempt. Retries reserve separately. |
| `MAX_TURN_DOLLARS`, `MAX_TURN_TOKENS`, `MAX_TURN_MODEL_CALLS`, `TURN_TIMEOUT_MS` | Bound an individual turn alongside shared admission and account quotas. |

Real-client readiness checks validate these budgeting requirements without making provider calls or reserving wallet funds. Missing requirements are reported by configuration name. A readiness response does not test upstream credentials, availability or capacity.

Before any funded request, inspect `npm run budget:status` and follow [provider budgeting](provider-budget.md). The development campaign's Azure $30 and Exa $20 values are **total original remaining authorizations**, shared by foreground generation, review, repair, enrichment and live evaluation. They are not new allowances on each process start. Token-derived Azure bookings use conservative price envelopes and are not invoice totals. Unknown usage retains a conservative charge.

The private wallet is intentionally absent from a source handoff. Continuing this project's funded work requires the original canonical wallet or the newest reconciled protected recovery snapshot. Running a copied checkout with the same funded account must not be treated as a renewed allowance. A separate evaluator must arrange its own authorized credentials and budget. If the original campaign accounting cannot be established, keep its provider work stopped.

## Review the application behavior

- Verify a changing fact using an explicit subject, then inspect the cited passages and quality status.
- Follow up with “verify your claims now” in the same conversation, including after moving the viewpoint backward. The target remains the selected prior answer in that conversation; it is not a source of verified facts.
- Use an empty conversation for that same follow-up. The application asks which claims to check without calling a model or search provider.
- Request personal memory explicitly, such as “What did I ask last Tuesday?” Cross-conversation recall is separate from ordinary follow-up context.
- Inspect the recovery tests for lost streams and lost completion events. A committed answer is retrievable by turn ID or idempotency key; clean SSE EOF alone does not mean success.

The offline tests exercise these boundaries without spending. Ordinary era answers no longer receive a blanket unverified-warning paragraph. Their own specific uncertainty and the interface's quality badges remain. Explicit verification failures still return an unresolved check, and partially checked references identify the remaining unverified scope. Current evidence supports implementation and development diagnostics, rather than an independently measured accuracy guarantee.

## Operate within the supported deployment

Run one service process on one host with local SQLite WAL storage. Local mode binds to loopback. Hosted mode additionally requires exact HTTPS origins and unique owner access tokens; terminate TLS at a proxy that passes SSE through without response buffering. Owners, conversation IDs and idempotency keys have separate roles. Do not run multiple application processes against the same database or place its WAL on a shared network filesystem.

Follow [operations](operations.md) for shutdown, backups, integrity checks, restore drills and retention. Preserve the provider wallet separately from conversation backups. The recovery objectives - 24-hour RPO and one-hour RTO - require scheduled off-host backups and a timed deployment restore drill; they are objectives, not measured guarantees. Automatic retention removes operational traces and completed jobs while retaining immutable conversation evidence and pending work.

## Evidence and remaining release gates

The [evaluation guide](evaluation.md) and [HTTP workload record](evaluation-workload.md) distinguish frozen tests, real-provider development observations and release requirements. The finite 312-turn cohort completed all accepted turns durably, and the patched Node 24 runtime passed a separate 24-turn smoke. Those runs do not establish sustained open-loop throughput, independent factual quality or browser rendering latency, and the larger cohort missed some proposed class latency targets. They predate the context-boundary repair. A capped replay against a protected copy of the reported conversation preserved the AI-answer reference and excluded unrelated IPL memory. The replay reviewer timed out, so verification remained explicitly unresolved; this is subject-isolation evidence, not a factual-accuracy pass. Later retry/paraphrase changes were validated offline, without another paid replay.

All reference captures and human labels in the **200-question seed remain pending**. Held-out adjudication, an independent calibrated judge, the double-labeled subset, representative failure/load tests and all declared latency gates remain necessary before claiming production release readiness. Keep automatic task-specific retrieval profile selection disabled until paired quality evidence supports enabling it. Required verification/historical behavior remains available.

## Shareable working-tree checks

Include the source, public assets, tests, scripts, evaluation fixtures/manifests, documentation, package lockfile, runtime pins, `.github` configuration and blank `.env.example`. Exclude every other `.env*` file, private keys, `data/`, backups, SQLite files and WAL/SHM sidecars, `.context/`, private reports, `node_modules/` and `.git/`. The evaluator installs dependencies with `npm ci`.

Inspect tracked and nonignored untracked files as well as ordinary diffs: new implementation files are part of this submission. Run `git diff --check` and repeat the secret/private-path check after final edits. The working tree can be reviewed without staging, committing or pushing it.
