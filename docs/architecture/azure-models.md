# Azure model connection and private comparison

The configured model adapter supports `LLM_API_MODE=responses` for Azure Foundry
reasoning models. `LLM_MODEL` and `LLM_FAST_MODEL` contain deployment names from
Foundry, which can differ from model family names. Secrets stay in the gitignored
`.env`; the Azure resource URL ends in `/openai/v1/`.

## Tool-call continuation

Every Responses request sets `store: false`. Output messages, function calls and
opaque encrypted reasoning are preserved in their original order on the turn-local
assistant record. The next request replays those items followed by the matching
`function_call_output` records using `call_id`, not the output item ID.

No previous-response ID or mutable global conversation is used. Parallel user
requests cannot share reasoning state. These native output items are not sent to
the browser or written into episode memory. The application continues to own its
bounded historical context in SQLite.

Text deltas and refusals stream to the existing UI. Function calls execute only
from a completed response, after application validation. Failed, incomplete or
truncated model streams cannot execute partially streamed function arguments.
The fast deployment uses the Responses JSON output format for memory extraction.
Chat Completions mode remains available for compatible existing hosts.

Sources: [Azure Responses API](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses),
[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).

## Live deployment comparison

```sh
npm run eval:models -- \
  --models MAIN_DEPLOYMENT,OTHER_MAIN_DEPLOYMENT,THIRD_MAIN_DEPLOYMENT \
  --extraction-models FAST_DEPLOYMENT,OTHER_FAST_DEPLOYMENT \
  --repeats 3 --live-repeats 2 --concurrency 3 \
  --out .context/model-comparison.json
```

The command performs real model requests and makes Exa requests for the live
track. Default repetition counts produce 108 trials with three answer deployments
and two extraction deployments:

| Track | Trials | Purpose |
| --- | --- | --- |
| Controlled real model | 8 tasks × 3 repeats × 3 deployments = 72 | Isolate model/application behavior with identical fictional evidence |
| Live Exa | 4 tasks × 2 repeats × 3 deployments = 24 | Measure complete model, retrieval and citation workflow |
| Memory extraction | 3 tasks × 2 repeats × 2 deployments = 12 | Measure JSON extraction and claim linking |

Controlled tasks cover changed/unchanged prices, publication cutoffs, missing
historical evidence, source prompt injection, conflicting sources, historical
creative writing, and history omitted by the prompt budget. They use fictional
Orbit Cloud facts, never claim to measure Exa retrieval quality, and are not a
comprehensive reasoning benchmark. Failed required-answer checks can represent
cautious abstentions; inspect the raw answer before treating a failure as a false
fact or unsafe behavior.

Live tasks use official SQLite and Node.js documentation, including one historical
source read at a pinned cutoff seven days before the run. Local completed-result
caching is disabled for fairer cross-model measurements; Exa's own content cache
and freshness rules still apply. Model order rotates across tasks/repeats. Worker
queue time is excluded; deployed-model capacity and concurrent load can still
affect latency. These results describe this deployment and run conditions.

All answer deployments use `low` reasoning effort. Background memory extraction
is disabled during answer trials and measured in its own track. The reports include
raw answers, the final answer after application safeguards, source URLs, per-check
outcomes, measured foreground latency and final-answer first token, and actual
Azure-reported input/cached-input/output/reasoning token counts. Reasoning tokens
are already included in output tokens and must not be added again.

The script writes partial reports as trials finish, then marks the final report
`complete: true`. Reports, logs and subsequent summaries stay in `.context/` and
are not exposed in the dashboard. No competing web provider is added to the app.

A pass rate here means explicit task/lexical/policy checks, not independently
human-graded factual accuracy. Application-forced abstentions are reported separately
from model drafts. p95 is an empirical small-sample statistic, especially in the
live and extraction tracks. Monetary Azure billing is not available to this
benchmark and is left unmeasured. Do not infer global model rankings or billing
from the small task set and token counts alone.
