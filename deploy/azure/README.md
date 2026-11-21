# Azure deployment

Status: the hosted demo was deployed on 15 November 2026 in subscription ending `838b`, resource group `minimi-challenge`, tagged `owner=harsha`. [Open the public demo](https://asof-f2gl2x6yvy64q.centralindia.cloudapp.azure.com/) without signing in. Each browser gets a separate signed guest cookie; private owner history remains available through `/login`. The VM now owns the authoritative conversation database and provider wallet. Local provider credentials have been disabled to avoid competing spending histories. This is a functioning demo; the latency and independent quality release gates below remain open.

## Deployed footprint and estimate

One non-zonal `Standard_B2als_v2` VM (2 burstable vCPUs, 4 GiB RAM) in Central India, Ubuntu 24.04, one 64 GiB Standard SSD OS disk holding code and SQLite, one Standard IPv4, Key Vault with VM managed identity, and private Hot LRS Blob backups. All resources belong to `minimi-challenge` and carry `owner=harsha`. Use a free Azure public-IP hostname initially rather than purchasing a domain.

Retail USD rates retrieved on 15 November 2026 from the [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices). Raw pricing, SKU and quota responses are retained privately in `.context/azure-plan/`. The VM row is Linux consumption for Virtual Machines, not Windows, Cloud Services, Spot or a reservation.

| Item | Assumption | Monthly USD |
| --- | --- | ---: |
| VM | $0.0246/hour, 744 hours | 18.3024 |
| OS/data disk | E6 LRS, 64 GiB | 5.2800 |
| Public IPv4 | $0.005/hour, 744 hours | 3.7200 |
| Backup capacity | 10 GiB Hot LRS at $0.02/GiB-month | 0.2000 |
| Backup requests | Allowance, roughly 10k writes plus reads | 0.1000 |
| Key Vault | 10k standard operations at $0.03/10k | 0.0300 |
| SSD transactions | Allowance for 1 million operations | 0.2000 |
| Monitoring/alerts | Allowance; no paid log ingestion by default | 0.5000 |
| Egress | Small-demo allowance; measure actual traffic | 0.5000 |
| **Estimated total** | **31-day month, before tax** | **28.8324** |

This fits $30 only under these assumptions. Taxes, exchange rates, extra traffic/operations, paid log ingestion and provider inference/search are additional. It is not a hard billing ceiling. VM is burstable, so CPU credits must be observed under sustained load. Standard platform metrics and local bounded journal logs are the initial monitoring choice; do not enable unbounded Log Analytics ingestion. The subscription bills in INR. The matching Retail Prices API rate is INR 2.3426/hour, implying about INR 95.23/USD for this quote. The monthly infrastructure budget is INR 2,850, with 80%, 90% and 100% email alerts. This is approximately the $30 pre-tax envelope, not a fixed exchange-rate guarantee. Alerts do not stop consumption. Resource-health and sustained CPU alerts route to the operator; no paid Log Analytics ingestion is enabled. Daily backup failures remain visible in systemd and require operator inspection; they do not yet have a separate email alert.

The subscription SKU response permits the regional SKU but restricts zones 2 and 3. This template is deliberately non-zonal. After registering Microsoft.Compute, the usage API reported 65 regional and 65 Basv2-family vCPUs available. Allocation succeeded. The VM uses Ubuntu image version `24.04.202610250`; recheck availability before a future deployment. Do not substitute a more expensive SKU automatically.

[VM specifications](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series) and [managed identity authentication](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token).

## Files and preparation

- `main.bicep`: VM, restricted SSH, HTTP/HTTPS, private network, public IP, Key Vault, private Blob container and scoped identity roles. Port 3000 is not opened to the internet. The managed disk is retained on VM deletion.
- `plan.sh`: compile, inspect SKU restrictions and show a resource-group what-if. Requires explicit subscription, SSH public key, restricted admin CIDR and image version. It creates nothing.
- `install.sh`: target-VM bootstrap for pinned Node, locked npm dependencies, Caddy and a hardened systemd service. It does not start chat or migrate databases.
- `start.mjs`: obtain a managed-identity token, fetch `asof-config` from Key Vault and launch Node with configuration in memory. No credentials are written to an environment file.
- `asof.service`, `Caddyfile`: one process supervisor, bounded restart policy and HTTPS reverse proxy with streaming enabled.
- `operations.bicep`: operator secret/backup roles, 30-day Blob retention, resource-health and CPU alerts.
- `budget.bicep`: monthly budget in the subscription billing currency with 80/90/100% notifications.
- `backup.mjs`, `asof-backup.service`, `asof-backup.timer`: daily SQLite snapshots, integrity checks, SHA-256 manifest and managed-identity Blob upload. A prefix without a manifest is incomplete. Backup files expire after 30 days, with seven-day Blob soft deletion.

The Azure CLI on the development machine has a stale default group named `elliptic`. Every mutating command must specify the subscription and `minimi-challenge` explicitly. Do not change global defaults as part of this deployment.

After the infrastructure deployment, apply `operations.bicep` with the operator's Entra object ID and notification email. Apply `budget.bicep` separately with a start date at the beginning of the current month and an amount in the confirmed billing currency. The current deployment uses INR 2,850. Granting the operator secret access does not grant the VM permission to change secrets.

After confirming the subscription, quota, estimate and deployment authorization, create the group and review what-if:

```sh
az group create --subscription "$AZURE_SUBSCRIPTION_ID" --name minimi-challenge --location centralindia --tags owner=harsha
# Resolve an exact image version and inspect the result; do not put 'latest' in the deployment.
az vm image show --subscription "$AZURE_SUBSCRIPTION_ID" --location centralindia --urn Canonical:ubuntu-24_04-lts:server:latest
export AZURE_IMAGE_VERSION='24.04.202610250'
export SSH_PUBLIC_KEY_FILE='PATH_TO_PUBLIC_KEY'
export ADMIN_CIDR='YOUR_PUBLIC_IP/32'
bash deploy/azure/plan.sh
```

Only after reviewing the resulting resource changes:

```sh
az deployment group create --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group minimi-challenge \
  --template-file deploy/azure/main.bicep \
  --parameters "sshPublicKey=$(cat "$SSH_PUBLIC_KEY_FILE")" "adminCidr=$ADMIN_CIDR" "imageVersion=$AZURE_IMAGE_VERSION"
```

Stage the reviewed code at `/opt/asof/app`, excluding `.env`, `.context`, `data`, `.git` and `node_modules`. Keep this physical path fixed: the provider wallet is resolved relative to application code. Do not deploy each release to a new directory with a fresh wallet. Keep code root-owned and only `data/` writable by the `asof` service user.

Grant the operator permission to set secrets through a deliberate least-privilege role assignment; the VM has read-only secret access. Upload a private JSON object of environment-name/string-value pairs as the Key Vault secret `asof-config` using `az keyvault secret set --file PRIVATE_JSON_PATH --name asof-config --vault-name VAULT_NAME -o none`. Never place the values in command arguments, Git, deployment parameters or cloud-init. Include hosted owner tokens, exact HTTPS origins, both provider credentials, deployment names and the existing documented price envelopes. The startup wrapper rejects fields outside its allowlist. Configuration/read failures stop startup rather than falling back to blank or public credentials.

On the VM, run the installer with non-secret `ASOF_VAULT`, `ASOF_DOMAIN` and `ASOF_STORAGE` values. It installs the pinned runtime from nodejs.org and verifies the archive checksum. The installed VM passed all 428 tests, type checking and six frozen fixtures. The service loads credentials through managed identity and refuses to start without all three reconciled databases. Caddy obtained a public certificate and passed an authenticated SSE request over HTTPS.

## Five-user baseline and target result

The existing HTTP workload now accepts `--loads 5`. A local live baseline on the pinned runtime offered 20 mixed turns to five virtual users with four admitted foreground slots:

| Measure | Observed |
| --- | ---: |
| Durable completions | 20/20 |
| Rejections / terminal errors | 0 / 0 |
| Completion p50 / p95 | 3,272 / 12,397 ms |
| Client final-text onset p50 / p95 | 2,889 / 12,397 ms |
| Answer states | 13 non-factual, 4 supported, 3 explicitly unverified |
| Provider accounting, including worker | $0.703142 charged/held combined |

Report: `.context/azure-plan/five-user-baseline/report.json`. Run caps were $2 Azure and $0.15 Exa, within the existing durable project wallet. This is a small closed-loop diagnostic, not sustained five-user capacity, independent factual correctness or browser rendering. Unverified answers must not count as independently correct.

The matching VM diagnostic also completed 20/20 turns with zero errors or rejections and the same answer-state counts. Completion p50 was **3,657 ms**, p95 **20,001 ms**. The slower tail included an 11.2-second search and repeated model review/repair. This does **not** pass a same-or-better latency claim. The two runs were several hours apart and are too small to isolate host effects from provider variability. Repeat paired per-class measurements before changing capacity.

The workload uses its own loopback server and isolated conversation DB while charging the authoritative provider wallet. A separate public HTTPS test completed a cited SQLite verification in **12,756 ms**, with one search and three model calls. Anonymous memory access was rejected, cross-owner turn access returned 404, and replaying the idempotency key returned the saved answer. These are functional checks, not independent factual adjudication. Private target artifacts are retained in `.context/azure-plan/target-report.json` and `.context/azure-plan/public-smoke.json`.

A real browser signed in through the access-token form, submitted a short response request, displayed the answer and showed it saved to the ledger. The service also passed readiness after a supervised restart. The restore drill downloaded all three backup files, checked their hashes and SQLite integrity, then restored the conversation snapshot with the application CLI: 26 episodes, 52 sources, no integrity issues and no interrupted turns.

The subsequent public-access change passed 432 tests and type checking locally, plus 13 access/server tests in an isolated directory on the VM. `PUBLIC_DEMO=1` and a random `PUBLIC_SESSION_SECRET` in Key Vault enable automatic guest sessions. Keep that secret stable across releases so visitors can return to their own history. Private owner tokens continue to work, and all guests share the existing provider spending ceiling. Guest cookies isolate data; they are not an abuse-prevention or per-person spending system.

## Routine operations

On the VM:

```sh
sudo systemctl status asof caddy
curl --fail http://127.0.0.1:3000/readyz
sudo systemctl list-timers asof-backup.timer
sudo systemctl start asof-backup
sudo journalctl -u asof-backup -n 20 --no-pager
```

The daily timer runs at 02:00 UTC with up to 15 minutes of jitter. Journals are bounded to 128 MiB on disk and 32 MiB at runtime. An application restore is rehearsed; a timed full-machine recovery and separate backup-failure alert are still follow-up work. Before changing the source, stop the service, preserve the newest databases, stage only reviewed source at the fixed application path, install dependencies and validate, then restart and check readiness. Keep database files outside any source replacement operation.

## Completed cutover and future rollback

1. Confirm which preview/database is authoritative, hosted owner identities, domain, subscription, quota, exact image and expected tax-inclusive spend. Local and Wi-Fi previews must not both become competing production writers.
2. Install and test VM networking, TLS and service configuration without enabling a second funded worker against a copied ledger. Use mocks for the initial smoke.
3. Announce maintenance and stop/drain **all** local processes and CLIs that can call providers. Confirm no unsettled reservations; retain them conservatively if present. Save the current budget status privately.
4. Use SQLite's online backup API for each application database and the canonical provider wallet. Record hashes, schema/integrity and source paths. Do not copy only a live WAL main file. Store a protected local/off-host recovery copy.
5. Transfer snapshots over SSH, verify hashes, install them at the configured app path and `/opt/asof/app/data/provider-spend.db`, and preserve service ownership and restrictive file modes. Never initialize a replacement empty wallet. Account for any provider activity since the snapshot.
6. Run integrity/readiness checks; verify owner mapping and memory visibility. Start `asof` and Caddy, then run the bounded VM workload and external SSE/recovery checks. Local previews remain stopped during provider-enabled target testing to keep one authoritative wallet.
7. Enable service startup and the backup timer only after data, authentication and recovery checks. The current deployment is advertised as a demo with its failed latency comparison stated explicitly, not as a production performance release. Daily private backups, retention and platform alert routing are enabled. A downloaded three-database snapshot passed SHA-256 and SQLite integrity checks. Full host rebuild RTO and alert delivery during an actual incident remain unmeasured.
8. Rollback stops/drains the target first. Reconcile and transfer the **latest target wallet** and post-cutover conversation data back before restarting local service. Rolling back code must never roll back spending history or discard newly committed conversations.

Do not run a blue/green pair against the same SQLite file. Do not stop the current previews, provision paid resources or perform cutover merely by running the read-only plan script.

At cutover, 26 episodes across 16 conversations were preserved. The deployment copy maps the `local` owner to `harsha` across all owner-scoped tables, while the original protected snapshot retains its original ownership. A separate `reviewer` token cannot access that history. The provider wallet was copied unchanged, with zero pending reservations; all subsequent paid checks charge that same campaign on the VM. The first off-host backup and a post-validation backup both completed. Do not reactivate the archived local credentials without reconciling the newest remote wallet and conversation data.

### Website activity

Successful `GET /` responses now record page-load timestamps separately from chat turns. The record contains a salted browser-credential pseudonym, not an IP address, user agent, cookie, query string or question. Reloads and bots count as page requests. A pseudonym is not a unique person and cannot identify a Minimi reviewer. No activity API is exposed publicly.

Read the last day without modifying the database:

```sh
node --import tsx --disable-warning=ExperimentalWarning scripts/activity.ts report data/asof.db --tz Asia/Kolkata
```

Use explicit-offset timestamps for a different interval, for example `--since 2026-11-16T18:00:00+05:30 --until 2026-11-17T06:00:00+05:30`. `--limit 200` bounds displayed rows; totals still include the entire requested retained interval. The report separates page loads, completed chats, waiting for input, cancellation and provider failures. Three failed/interrupted turns within the interval's last 15 minutes produce a local report alert. Three completed answers marked could-not-confirm produce a separate alert, without treating them as provider failures. These are local report alerts, not external notifications.

After identifying a deployment test's browser ID in that report, an operator can label it:

```sh
node --import tsx --disable-warning=ExperimentalWarning scripts/activity.ts mark-test data/asof.db v_REPLACE_WITH_REPORTED_ID release-smoke
```

These labels are operator assertions, retained for 14 days, and test traffic remains included in totals. Public request headers cannot label traffic as tests. Page records retain at most 14 days or 20,000 loads, whichever is smaller. An hourly cleanup also runs while the server is idle, and read-only reports always exclude page records outside the current retention window. Chat totals are aggregated in SQLite and displayed rows are bounded by `--limit`. A bounded queue writes after the response and drops telemetry on SQLite contention instead of delaying chat. Reports therefore describe best-effort recorded activity, not complete access logs; they cannot reconstruct visits before this feature was deployed. The local metrics endpoint exposes in-process written/dropped counters, and startup logs `visit_logging_unavailable` if instrumentation could not initialize. The existing database backup includes these tables; no API key or external analytics service is required.
