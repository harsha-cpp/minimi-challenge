# Backend development plan

Scope: improve asof's Exa research backend while preserving its dated memory,
single-tool interface, streaming UI, and small self-hosted footprint.

## Codebase findings

- Node 22, strict TypeScript, native HTTP/SSE, OpenAI-compatible model port.
- SQLite/FTS5 stores episodes and extracted claims. Retrieval resolves dates in code.
- Exa `/search` already returns passages and supports historical snapshots.
- Search cache truncates snapshot timestamps to a day, has no size bound, and
  shares the first caller's cancellation signal with all concurrent callers.
- Search rounds are bounded, but calls within a round and excerpt sizes are not.
- Sources retain URLs but discard the actual passages used to answer.
- Tool arguments accept malformed dates, null JSON, and unchecked domain strings.
- Live/provider quality is not measured by the existing replay evaluation.

## Implementation sequence

1. **Architecture and research.** Compare primary sources and working open-source
   implementations. Record the chosen design and the tradeoffs in ARCHITECTURE.md.
2. **Search boundary.** Separate provider types, validation, Exa transport, cache,
   and concurrency policy. Keep `src/search.ts` as the compatibility entry point.
3. **Evidence acquisition.** Add direct source reading through Exa Contents using
   the existing `web_search` tool, fresh reads for verification, runtime response
   validation, strict filters, and bounded excerpts. Never relax historical cutoffs.
4. **Reliability and budgets.** Fix cache isolation/cancellation, bound its size,
   retry transient provider errors within one deadline, cap tool calls and
   concurrency, and propagate cancellation before saving a completed turn.
5. **Evidence ledger.** Save passages, hashes, retrieval times and requested
   snapshot cutoffs with citations using an additive SQLite migration and atomic
   writes. Retrieval time is real wall time; conversation time can be simulated.
6. **Verification and evaluation.** Add network-free regression tests and an opt-in
   live retrieval benchmark with machine-readable output, latency, source coverage
   and filter compliance. Run typecheck, tests and local HTTP smoke checks.

## Subsequent research milestones

- Claim-to-passage entailment evaluation and calibrated abstention.
- Evaluate query decomposition, reranking and deeper search against the baseline;
  adopt each only if it improves coverage at an acceptable latency/cost.
- Durable enrichment/recheck jobs, claim volatility and scheduled change detection.
- Authenticated tenant isolation and PostgreSQL when serving multiple users.

These later milestones are not represented as shipped capabilities. Beating
other search tools requires reproducible comparisons, not architecture claims.

## Completed in this change

All six implementation steps above are complete. Validation: 54 network-free
tests, TypeScript checking, browser-script syntax checking and local HTTP smoke
checks for the page/fonts, ledger, source-detail endpoint and missing-key SSE path.
The original 28 tests remain passing.

The live retrieval harness was invoked, but stopped before making requests because
this workspace has no `EXA_API_KEY`. No live quality, cost, latency or comparative
results are claimed. The broader quality and production milestones remain in
[ARCHITECTURE.md](ARCHITECTURE.md).
