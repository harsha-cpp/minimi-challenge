# Azure deployment candidate

Status: prepared and locally validated, not deployed. Existing previews remain in place. No resource group, VM or provider credential has been created or migrated by this work.

## Proposed footprint and estimate

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

This fits $30 only under these assumptions. Taxes, exchange rates, extra traffic/operations, paid log ingestion and provider inference/search are additional. It is not a hard billing ceiling. VM is burstable, so CPU credits must be observed under sustained load. Standard platform metrics and local bounded journal logs are the initial monitoring choice; do not enable unbounded Log Analytics ingestion. Configure Cost Management budget alerts at $24/$27/$30 and operational alert routing before release. Alerts do not stop consumption. The template does not yet configure those notification destinations.

The subscription SKU response permits the regional SKU but restricts zones 2 and 3. This template is deliberately non-zonal. The usage API returned an empty list, so family/regional quota is **unverified**; catalog eligibility does not guarantee allocation capacity. The image lookup resolved Ubuntu version `24.04.202610250`; recheck its availability before deployment. Do not substitute a more expensive SKU automatically.

[VM specifications](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series) and [managed identity authentication](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-to-use-vm-token).

## Files and preparation

- `main.bicep`: VM, restricted SSH, HTTP/HTTPS, private network, public IP, Key Vault, private Blob container and scoped identity roles. Port 3000 is not opened to the internet. The managed disk is retained on VM deletion.
- `plan.sh`: compile, inspect SKU restrictions and show a resource-group what-if. Requires explicit subscription, SSH public key, restricted admin CIDR and image version. It creates nothing.
- `install.sh`: target-VM bootstrap for pinned Node, locked npm dependencies, Caddy and a hardened systemd service. It does not start chat or migrate databases.
- `start.mjs`: obtain a managed-identity token, fetch `asof-config` from Key Vault and launch Node with configuration in memory. No credentials are written to an environment file.
- `asof.service`, `Caddyfile`: one process supervisor, bounded restart policy and HTTPS reverse proxy with streaming enabled.

The Azure CLI on the development machine has a stale default group named `elliptic`. Every mutating command must specify the subscription and `minimi-challenge` explicitly. Do not change global defaults as part of this deployment.

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

On the VM, run the installer with non-secret `ASOF_VAULT` and `ASOF_DOMAIN` values. It installs the pinned runtime from nodejs.org and verifies the archive checksum. Installation and service/proxy behavior have not yet been exercised on an actual Azure VM.

## Five-user baseline and comparison gate

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

Repeat the same fixed mix, runtime, policy, cache state, limits and model configuration on the VM, with a separately recorded bounded campaign and the authoritative wallet. The harness starts its own loopback server, so it does not by itself validate public TLS/proxy delivery. Add an external authenticated SSE smoke through Caddy and record first/final events, interruption and recovery. Compare repeated paired per-class results, errors, support states, CPU credits, memory and event-loop delay. Do not declare same-or-better latency from these 20 local samples alone.

## Controlled cutover and rollback

1. Confirm which preview/database is authoritative, hosted owner identities, domain, subscription, quota, exact image and expected tax-inclusive spend. Local and Wi-Fi previews must not both become competing production writers.
2. Install and test VM networking, TLS and service configuration without enabling a second funded worker against a copied ledger. Use mocks for the initial smoke.
3. Announce maintenance and stop/drain **all** local processes and CLIs that can call providers. Confirm no unsettled reservations; retain them conservatively if present. Save the current budget status privately.
4. Use SQLite's online backup API for each application database and the canonical provider wallet. Record hashes, schema/integrity and source paths. Do not copy only a live WAL main file. Store a protected local/off-host recovery copy.
5. Transfer snapshots over SSH, verify hashes, install them at the configured app path and `/opt/asof/app/data/provider-spend.db`, and preserve service ownership and restrictive file modes. Never initialize a replacement empty wallet. Account for any provider activity since the snapshot.
6. Run integrity/readiness checks; verify owner mapping and memory visibility. Start `asof` and Caddy, then run the bounded VM workload and external SSE/recovery checks. Local previews remain stopped during provider-enabled target testing to keep one authoritative wallet.
7. Switch the advertised live URL only after the comparison/recovery checks pass. Enable startup and schedule protected Blob backups of both databases, retention and restore drills before calling the deployment operational. Backup scheduling and alert routing remain release tasks, not capabilities supplied by the template alone.
8. Rollback stops/drains the target first. Reconcile and transfer the **latest target wallet** and post-cutover conversation data back before restarting local service. Rolling back code must never roll back spending history or discard newly committed conversations.

Do not run a blue/green pair against the same SQLite file. Do not stop the current previews, provision paid resources or perform cutover merely by running the read-only plan script.
