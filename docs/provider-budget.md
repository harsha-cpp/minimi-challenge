# Product-completion provider budget

The user authorized a **total remaining maximum of $30 for Azure Foundry and $20 for Exa** until
product completion. These are project totals, not per-turn, per-run, daily or monthly allowances.
The initial live diagnostic is limited to a much smaller campaign; unused funds remain reserved
for subsequent implementation and validation.

`data/provider-spend.db` is the shared durable accounting boundary for the stable
`minimi-product-completion-v1` campaign. Generation, review, repair, enrichment and legacy/live
CLI entry points must use the same ledger. Persist reservations before HTTP; retain unknown or
crashed in-flight work conservatively. Do not delete/reset/copy away this database to obtain a new
allowance. Paid requests must fail closed if a deployment has no configured budgeting rates, a
required request bound is absent, or remaining provider capacity is insufficient.

## Price references and conservative accounting

The configured deployments are `gpt-6.1-sol-1` and `gpt-6-luna-1`. Azure management credentials were
not available to verify the account's deployment SKU or agreement. Public Microsoft material lists
Global Standard Sol-family prices and higher long-context/data-zone/cache-write categories.
The published pricing page also notes account-dependent terms. [Microsoft pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/),
[Microsoft token-weight/pricing table](https://learn.microsoft.com/th-th/azure/foundry/openai/how-to/provisioned-throughput-sizing),
[GPT-6 Standard deployment table](https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/).

For safe admission, the local configuration deliberately uses the following **budgeting envelopes**,
not claimed invoice prices:

| Deployment | Input/cached input, USD per million tokens | Output, USD per million tokens |
| --- | ---: | ---: |
| gpt-6.1-sol-1 | 6.00 | 20.00 |
| gpt-6-luna-1 | 0.30 | 1.00 |

These envelopes exceed the published Standard tier amounts used for this comparison, including
long-context and zone premiums. Cached-input discounts are not assumed. Exact deployment billing,
cache-write accounting and account charges must be reconciled against Azure before claiming actual
cost; the ledger's token-derived charges are conservative estimates. Provider output tokens already
include reasoning tokens, so do not count reasoning again.

Exa's published Auto price is $7 per 1,000 requests for up to ten results, with page text/highlights
included. Standalone Contents costs $1 per 1,000 pages per content type. This adapter requests at
most eight search results, or a bounded selected-URL read, without paid summaries/other products.
The configured **$0.02 per physical HTTP attempt** is a conservative reservation. Retries reserve
again; returned hits and cache subscribers are not each billed as another request. Record Exa's
reported request cost once when supplied. [Exa pricing](https://exa.ai/pricing).

The price-table identifier is `azure-standard-envelope-2026-11-15`. The ledger prevents additional
application-controlled work beyond reserved provider capacity; it cannot control unrelated account
traffic or impose a price contract on an upstream provider. Stop and record unexpected charges or
unrecognized deployments rather than inventing a rate or resetting the budget.

## Validation record

Concurrency, restart, unknown-usage, cancellation-before-HTTP and cap-exhaustion tests passed before
the first paid pilot. The initial 22 development answers booked $1.026187 against the Azure envelope
and $0.023 in reported Exa charges; one Azure review timeout retained its full unknown-usage bound.
Those figures describe that collection, not the current remaining balance. Read the live canonical
balance with `npm run budget:status` before any further work. Pilot reports and subsequent capped
HTTP workload reports remain under `.context/`. Human reference adjudication remains distinct from
machine-authored diagnostic expectations and automated reviews.

The HTTP workload harness adds a separate durable campaign wallet without renewing the project
allowance. Foreground calls, warmups, reviews, retries and background enrichment reserve both
wallets before HTTP. See [workload validation](evaluation-workload.md).

After the 24-turn smoke, 312-turn finite cohort and patched-runtime 24-turn smoke, the earlier recorded
project totals were Azure **$14.056040 booked / $15.943960 remaining** and Exa **$0.271 reported /
$19.729 remaining**. All worker calls and three unknown-usage review bounds are included; no
unsettled holds or violations remain. These are the 15 November 2026 validation balances, not a
fresh allowance. The protected final wallet snapshot and hash are recorded in
`.context/provider-wallet-backup.json`. Future paid work must read the current canonical wallet.

## Operational backup and restore

Keep the canonical wallet independent of conversation backups, test databases and release artifacts.
An application database restore or binary rollback does not restore spending capacity: retain the
current `data/provider-spend.db` and the `minimi-product-completion-v1` campaign. The configured
caps can decrease; changing environment settings cannot increase them or select a fresh wallet.

Before maintenance, save `npm run budget:status` alongside a protected, current wallet snapshot.
Use SQLite's online backup API or equivalent WAL-aware tooling with a new destination; copying
only the live main database can omit committed charges and holds. Preserve wallet snapshots
separately from application snapshots, including their creation time and integrity/hash evidence.
Do not run the conversation database migration/restore procedure against the wallet.

After recovery, reconcile the newest wallet snapshot, any later provider activity and the saved
status before allowing paid work. An older snapshot cannot establish the remaining allowance.
Started or abandoned reservations remain held, and unknown billing consumes its full reservation;
neither process restart nor an application restore releases them automatically. If the latest
accounting cannot be established, leave provider work stopped rather than resetting the ledger
or increasing a cap. A recorded billing-bound violation keeps its provider locked for review.

## Context-repair validation update

The later protected-copy replay of the reported context failure booked $0.367252 Azure and $0.021
Exa under a separate $1/$0.10 child cap. It kept the original AI-answer reference and excluded IPL
memory, but review timed out and verification remained unresolved. Including intervening user
activity, the recorded canonical totals are Azure $15.309816 booked / $14.690184 remaining and Exa
$0.355 reported / $19.645 remaining. There are six conservatively charged unknown Azure attempts
and no outstanding holds, locks or bound violations. These are historical observations within the
same original $30/$20 allowance; use `npm run budget:status` for the current balance.
