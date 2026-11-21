# Single-host backend operations

Run one application process against a local SQLite database. Owner authorization, turn/model admission and memory-worker leasing are coordinated in that process. Starting another application against the same file can interrupt the first process's active turns during startup recovery. Use a process supervisor with bounded restart backoff and start only after the prior process has exited.

SQLite WAL permits concurrent readers and one writer on the same host. A WAL database on a shared network filesystem is unsupported. Scale to multiple application hosts only after moving the storage, admission and job coordination to shared services. [SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Runtime and dependency policy

The development and deployment baseline is Node 24.22.3 LTS, pinned in `.nvmrc` and `.node-version`. It bundles SQLite 3.54.1 and includes the upstream security fixes documented in the [official Node 24.22.3 release](https://nodejs.org/en/blog/release/v24.22.3). With nvm, run `nvm install` and `nvm use` before installing dependencies or starting the application. Other version managers can read `.node-version` or select the same exact version.

The package engine range remains an API compatibility contract for Node 22 (minimum 22.16) and Node 24. The lower bound is needed by the [built-in SQLite backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options). CI names its Node 22.16 job as minimum API compatibility only and separately tests the pinned Node 24.22.3 production baseline. Passing the compatibility job is not a deployment endorsement for its older bundled SQLite. Keep the exact baseline current through reviewed patch updates and rerun the release checks when changing it.

Before deployment, verify the bundled SQLite version includes the WAL-reset fix: SQLite 3.51.3 or later, or the documented 3.50.7/3.44.6 backports. The SQLite project documents the affected concurrent WAL checkpoint/write pattern and fixed releases. [SQLite WAL-reset advisory](https://www.sqlite.org/wal.html#walreset).

Record the actual binary before deployment with `node -p 'JSON.stringify({node:process.version,sqlite:process.versions.sqlite})'`. The prior local Node 22.16.0 runtime bundled SQLite 3.49.1; its test and workload results do not establish a patched deployment runtime. No corruption was observed in those diagnostics.

Install with `npm ci`. Commit lockfile changes with dependency updates, run the full release checks, and review upstream migration notes before changing model SDK, SQLite runtime, parser or sanitizer versions. Dependabot proposes npm changes weekly and GitHub Actions changes monthly. CI audits runtime dependencies at high severity and runs tests without model/search credentials. A dependency audit covers npm advisories; it does not certify the Node binary or bundled SQLite.

```sh
npm ci
npm run typecheck
npm test
npm run eval:benchmark -- --out .context/frozen-release.json
npm audit --omit=dev --audit-level=high
```

Frozen replay is a deterministic orchestration regression gate. It does not establish live answer quality, provider capacity or production latency. Live release evidence must separately meet the architecture action plan's held-out quality, workload, ownership and recovery gates.

## Request admission and access

Local mode binds to loopback and validates Host and Origin. Hosted mode requires exact HTTPS origins in `ALLOWED_ORIGINS`, unique owner access tokens in `OWNER_TOKENS`, explicit model prices and a positive `SEARCH_MAX_ATTEMPT_DOLLARS` bound. Terminate TLS at a reverse proxy, preserve the original Host, disable response buffering for `/api/chat`, and allow SSE heartbeats through. Private owners sign in at `/login`; API clients send an owner Bearer token. Session IDs identify conversations; authenticated owner context determines access.

For a public demo, set `PUBLIC_DEMO=1` and provide a random 32-byte base64url `PUBLIC_SESSION_SECRET` through the secret manager. The homepage then issues a signed, Secure, HttpOnly cookie with a distinct guest identity, valid for one year. Guests cannot choose an owner ID or access private owner history. Keep the signing secret stable across deployments: changing it invalidates guest sessions. Clearing cookies or changing browsers loses access to that browser's history; this is not cross-device account recovery. Cookie mutations still require an allowed Origin. The existing global provider wallet, admission queues and per-turn limits apply to guests too. These bounds limit total spending, but do not prevent someone from using fresh browser identities to exhaust the shared demo allowance.

`MAX_ACTIVE_TURNS` / `MAX_QUEUED_TURNS` bound foreground turn admission. `MAX_ACTIVE_MODELS` / `MAX_QUEUED_MODELS` apply to the shared generation, review and enrichment gateway. The model pool reserves foreground capacity, rotates queued owners, and prioritizes completion/review over research. `MODEL_REQUESTS_PER_MINUTE` / `MODEL_TOKENS_PER_MINUTE` bound account requests and tokens over a sliding minute. `MODEL_COMPLETION_REQUEST_RESERVE` and `MODEL_COMPLETION_TOKEN_RESERVE` retain account headroom for synthesis/review; research and enrichment cannot consume it. They adapt to the admitted-turn limits when unset. Set account limits below the deployed provider account's quota and adjust after measuring offered-load rejection, latency and cost. Research rejected at the reserve gets one forced synthesis attempt. Actual account exhaustion returns an explicit busy state rather than bypassing the cap.

`MAX_TURN_MODEL_CALLS`, `MAX_TURN_TOKENS`, `MAX_OUTPUT_TOKENS`, `TURN_TIMEOUT_MS` and `MAX_TURN_DOLLARS` bound individual turns. Model work and paid search attempts share the dollar allowance. `SEARCH_MAX_ATTEMPT_DOLLARS` reserves a documented conservative upper bound for one complete physical Exa HTTP attempt, including requested contents. Each retry reserves separately; cache hits and shared subscribers do not incur another charge. Unknown failed-attempt costs retain the reservation. A reported bound violation is recorded and locks further paid work for that provider. `INPUT_DOLLARS_PER_MILLION`, `OUTPUT_DOLLARS_PER_MILLION` and `MODEL_PRICE_VERSION` define the shared turn/account admission envelope. `MODEL_DEPLOYMENT_PRICES_JSON` defines an envelope for each deployment in the durable provider wallet, including the fast model. Cached-input discounts are optional; reasoning usage already included in output tokens is not charged twice.

Input token reservations conservatively use UTF-8 bytes rather than assuming an English tokenizer ratio. Missing provider usage stays unknown in telemetry and consumes its full reserved budget. Admission spend calculated from an envelope is an estimate, not a provider invoice. Provider totals settle once per physical HTTP attempt, including empty results and billed failures; request-scoped cost metadata copied onto hits must never be summed. Missing search cost consumes its configured attempt bound and leaves actual external cost null. Every real provider path, including local mode and legacy CLIs, reserves the canonical wallet before HTTP and fails closed for an unpriced deployment, absent search bound or exhausted allowance. The Azure $30 / Exa $20 caps cover all remaining product work, not each process or run. Check `npm run budget:status` and reconcile provider billing before making actual-cost claims. See [provider budgeting](provider-budget.md) and the [capped HTTP workload harness](evaluation-workload.md).

A repeated `Idempotency-Key` or request `idempotencyKey` with the same normalized input identifies one logical turn. Different input conflicts. In-flight duplicates return a recovery reference; completed duplicates replay the committed episode. Clients should retain that identity across disconnects and read `/api/turns/:id` or `/api/turns/by-key/:key` if the response was lost before its ID arrived. The browser persists the canonical request and key before POST. An unknown request can be retried manually with the same key; a known failed/interrupted attempt uses a new key. They must require a `done` or clarification terminal event and must not infer success from clean SSE EOF. A new attempt after failure uses a new key.

## Backup, restore and upgrades

Create a snapshot before an application/schema upgrade and on a deployment-owned backup schedule. The CLI uses SQLite's online backup API, includes committed WAL pages, preserves the source schema, validates migrations on a private copy, and exclusively publishes a standalone snapshot with mode `0600`. It refuses existing destinations. Preserve its JSON report and SHA-256 alongside a protected off-host copy.

The provider wallet is separate from the application database: the canonical `data/provider-spend.db` records the total remaining Azure/Exa campaign allowance. Record `npm run budget:status` and preserve the current wallet before an application restore or binary rollback. Restoring `asof.db` must leave that wallet, its charges and its pending holds intact. Never restore an older wallet, delete its files, select another path or change its campaign identity to obtain a renewed allowance. Back up the wallet separately with SQLite's online backup API or tooling that includes committed WAL pages; the application migration/restore CLI is for the conversation database. If the current wallet is lost or its history cannot be reconciled, keep paid requests stopped. See [provider budget recovery](provider-budget.md#operational-backup-and-restore).

```sh
npm run db:backup -- data/asof.db backups/before-upgrade.db
npm run db:restore -- backups/before-upgrade.db .context/restore-drill.db --sha256 EXPECTED_SHA256
npm run db:check -- .context/restore-drill.db
```

Use the hash returned by backup for `EXPECTED_SHA256`. Snapshot publication uses an exclusive same-directory hard link, so the destination filesystem must support hard links. `db:check` applies current migrations just as startup does; backup and restore never open the original snapshot writable. `db:restore` requires a clean destination and refuses a live source with nonempty WAL. Copying only the main file from a running WAL database is not a backup.

A successful integrity report checks SQLite structure, foreign keys, answer-index coverage and stored cited-passage hashes, and reports episode/source/pending-job counts. Compare these counts against the backup report, check known answer-only term recall and a saved citation, then start the restored instance with its own path. Startup marks abandoned foreground turns interrupted and makes leased memory work eligible again. It does not generate replacement answers automatically. Pending enrichment resumes through the durable outbox; retries preserve claim identities and reject stale worker leases.

Migrations are additive and recorded in `schema_migrations`. Creation time remains unknown when no trustworthy prior receipt timestamp exists. Old viewpoint timestamps retain their meaning; conversation order follows durable sequence. For binary rollback, stop the service and restore the pre-upgrade snapshot into a new path. Do not attempt a schema downgrade by deleting migration rows or changing immutable records.

Initial deployment recovery objectives are RPO at most 24 hours and RTO at most one hour. These are operational objectives, not measured guarantees: an operator must schedule and verify off-host backups at least daily and time a clean-instance restore before deployment. Record the restored counts, hash checks, pending-job recovery and elapsed recovery time. More demanding recovery requirements need a revised storage/backup design and a new drill.

## Readiness, shutdown and retention

`GET /healthz` reports process liveness. `GET /readyz` becomes unavailable while draining or when provider configuration is missing. Real clients also require shared token-price envelopes, the main/fast deployment map, a price version and the Exa attempt bound before readiness passes. Missing configuration is reported by variable name without exposing values. It does not make a live paid provider call. Local `/api/metrics` exposes bounded admission counters, queues, worker states, event-loop delay and SQLite busy counts. Operational turn traces separate server first emission from browser render acknowledgement and include unknown usage explicitly. Search work shared with another subscriber can outlive the original turn; its redacted attempt-cost update is retained on the original terminal trace. A model call rejected before provider invocation is counted as admission work, not missing provider usage. Traces exclude prompt bodies, credentials and private model reasoning by default; exact cited passages stay with their answer.

On SIGTERM/SIGINT, the server stops admission, waits up to `SHUTDOWN_MS` for foreground requests, aborts remaining requests, stops the worker and checkpoints/closes SQLite. A provider that ignores abort cannot publish late output; its model capacity remains occupied until its invocation settles. A supervisor may terminate the process after its shutdown allowance; pending durable work is recovered on the next single-process startup.

`TRACE_RETENTION_DAYS` defaults to 14. Startup and the explicit prune command remove old operational traces and completed outbox rows only. Pending/leased/failed jobs, turn identities, episodes, exact evidence, claims and immutable verified statements remain available for recovery and audit.

```sh
npm run db:prune -- data/asof.db --days 14
```

Conversation/evidence deletion requires a separately designed owner-deletion and retention policy that respects statement immutability and claim references. Backups contain conversation and cited evidence; protect access and include them in the deployment's retention policy. No automatic backup deletion or cloud scheduling is configured by these scripts.
