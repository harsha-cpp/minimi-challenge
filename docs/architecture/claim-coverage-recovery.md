# Claim coverage and research recovery

The agent distinguishes an assertion, its supporting passages, and a review of those passages. These are saved records, not facts established by citation presence alone.

## Claim lifecycle

`agent/claims.ts` defines a canonical assertion with optional entity, attribute, value, conditions and effective date. Each record carries its viewpoint, timezone, source passage hashes, origin and reviewer policy. Unknown normalized fields are null. Foreground evidence review can create supported records; background extraction creates unverified records and cannot grant approval.

A pinned re-check loads the exact original answer and its claims. Review returns coverage for each requested original claim: supported, changed or unresolved. The UI calls `changed` **corrected** because this describes a correction to the earlier answer, not proof of when the world changed. A missing decision stays unresolved. Coverage requires a reviewed assertion linked to the original claim and valid final citations. The store validates owner, conversation, order and the original answer hash before committing the relation.

A normal re-check examines all original claims. An explicit unfinished retry can select unresolved claims from a recent check with the same viewpoint, timezone and reviewer policy. Live continuation is limited to two minutes; a later check cannot silently inherit a stale approval. Legacy answers without canonical claims still receive full-answer verification. Explicit cross-conversation recall does not automatically establish a claim-level relation.

Ordinary answers remain provisional. They receive unverified canonical records through the existing background queue. Reviewed answers reuse foreground records and do not undergo a second extraction. The concept alias dictionary expands lexical candidates only; it is not an embedding service. Exact matches, bounded candidate pools and visible ambiguity preserve predictable recall.

## Long-document evidence

Direct full-content reads can acquire up to 400,000 characters per URL, with at most two explicit URLs and the existing 2 MB HTTP response limit. A local selector scores query terms, retains whole paragraphs with adjacent context, and admits at most 12,000 characters. It marks omitted gaps, discards a paragraph cut at the acquisition boundary, and records the bounded-document hash and selection limits. Candidate windows are capped to bound CPU work. These are excerpts, not a claim to have read the entire page. The reviewer still decides whether the selected evidence supports the answer. This avoids sending only the first pages of a long specification without adding a model call.

## Durable checkpoints

A research checkpoint contains bounded model messages, admitted evidence, search counters, draft/review state and cumulative model usage. It lives in the application SQLite database and expires two minutes after the original attempt started. Every accepted checkpoint is tied to its owner, conversation, request, context, model configuration and implementation fingerprint.

The client sends only a predecessor turn ID and optional matching conversation ID to resume. The server reconstructs the trusted original request. Running, completed and cancelled turns cannot resume; failed and interrupted turns can when their checkpoint remains valid. A new request key identifies the resume, while replay of that key returns the same result. The predecessor checkpoint is consumed before provider work. Conservative in-flight usage is persisted before starting a model call, so a crash cannot reset the attempt's allowance.

A `claim_review` progress event is emitted only after saving its reviewed checkpoint and validating supported claims. The browser shows these as checked findings, then replaces them with the committed answer. The main answer still commits before publication. If a connection is lost after commit, ordinary turn recovery retrieves the answer without repeating providers.

Checkpoint reuse applies to one interrupted attempt. New re-checks still retrieve fresh evidence and invoke review. The strict claim-reuse guard is not a general cross-request verdict cache.

## Delegated operator allowances

`runtime/budget-allocation.ts` supports trusted operators who can access both parent and child ledger files on the same filesystem. It reserves parent capacity before issuing the child, journals the allocation, validates child identity, and seals the child before settling parent holds. If any child reservation remains unresolved for a provider, reconciliation conservatively consumes that provider's full parent allocation. It accepts no caller-authored spending receipt.

```sh
node --import tsx scripts/budget-allocation.ts provision PARENT_DB ALLOCATION_ID CHILD_DB AZURE_CAP EXA_CAP
node --import tsx scripts/budget-allocation.ts status PARENT_DB ALLOCATION_ID
node --import tsx scripts/budget-allocation.ts reconcile PARENT_DB ALLOCATION_ID
```

The parent must already exist. Repeating provision with the same identity and limits is idempotent; changing the path or allowance is rejected. `abandon` closes an unissued preparation. Child credentials and runtime configuration remain operator responsibilities. Reconciliation is terminal: a sealed child cannot admit new reservations; already-reserved work remains accounted for. This is not a cross-host lease system and cannot defend against a trusted operator restoring an old ledger or editing SQLite directly. Existing independently funded or manually reserved ledgers are not automatically migrated.

## Validation and remaining limits

Regression tests cover forged coverage, changed source hashes, stale retries, owner boundaries, lost completion, actual process termination and restart, resumed usage limits, allocation contention and unknown charges. Runtime traces include execution, review, retrieval and memory policy versions plus an implementation fingerprint. The benchmark source identity includes these modules.

Use the existing paired-quality protocol in [evaluation](../evaluation.md) for release comparisons. Keep failures and incomplete checks in the result set. Small developer examples cannot establish general latency or factual accuracy; reference labeling and representative concurrent workloads remain outstanding.
