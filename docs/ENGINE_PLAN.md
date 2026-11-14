# End-to-end architecture implementation

Exa is the only web search tool. Its adapter and API contract are unchanged by
this work. This plan addresses the application before and after Exa.

1. Pin each turn to an immutable request time and timezone. Apply that cutoff to
   history, topic recall, nearest conversations, ledger reads and search policy.
2. Compile prompts with a stable instruction prefix, explicit temporal authority,
   bounded conversation history and bounded memory. Determine verification
   freshness in code without adding a planning model call to the fast path.
3. Bound evidence passed back to the model across all search rounds, preserve the
   exact admitted passage with citations, and fail closed on historical evidence
   that does not carry the request's cutoff. Keep Exa acquisition unchanged.
4. Record the turn's time context and prompt/evidence budgets with the episode.
   Stream promptly, cancel work when disconnected, and keep enrichment off the
   response path with bounded concurrency.
5. Produce system-context, container and request-flow diagrams, plus a temporal
   sequence diagram with concrete file mappings and declared limitations.
6. Add private offline pipeline benchmarks and opt-in live end-to-end evaluation.
   Compare externally recorded search-engine baselines from files; do not add
   other search services to the app or show benchmark data in the dashboard.
7. Verify backward time travel, same-day boundaries, clock changes during a turn,
   evidence exhaustion, prompt limits, database migration and benchmark scoring.

Commercial-engine scores require real runs or supplied baseline recordings.
Synthetic fixtures are labeled as pipeline regression results, never presented as
competitive performance measurements. See architecture/README.md for the design.

## Validation

All seven steps are implemented. Exa's acquisition adapter and cache implementation
were not changed in this extension. No additional web provider was added.

- 70 automated tests pass, including recorded-baseline import and input-identity rejection.
- TypeScript, browser-script syntax and whitespace checks pass.
- All four Mermaid diagrams parse successfully.
- Local HTTP checks pass for invalid JSON/dates, historical ledger visibility,
  episode visibility and restoring the current clock.
- The private synthetic pipeline benchmark ran successfully and produced
  `.context/benchmark.json` with raw samples and explicit scope/limitations.
- Live evaluation was attempted but made no requests: this workspace lacks
  `LLM_API_KEY`, `LLM_MODEL` and `EXA_API_KEY`. No comparative engine results,
  live latency improvements or semantic accuracy scores are claimed.
