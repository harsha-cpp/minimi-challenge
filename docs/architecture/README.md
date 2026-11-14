# Complete asof architecture

**Latest backend/search review:** [15 November 2026 findings, workload analysis and target architecture](backend-search-review-2026-11-15.md), with a [prioritized implementation and evaluation plan](backend-search-action-plan.md). This review covers the active working tree and includes isolated correctness and recall-scale reproductions. The [14 November review](review-2026-11-14.md) also covers the separate UI preview.

Exa remains the only web search tool. This architecture describes everything
around it: how a prompt is accepted, grounded in a date, researched, answered,
streamed and remembered. Both present-day and simulated questions research the
live web through Exa.

Read the [complete request flow](request-flow.md) first, then the
[historical sequence](time-travel.md). The [system context](c4-context.md) and
[runtime containers](c4-containers.md) establish deployment boundaries.

## Architecture decision

Use a modular TypeScript/Node application with a deterministic preparation layer,
a bounded model/tool loop, an era-and-source review, and a relational ledger.
Keep decisions that must be exact in code: clock reading, memory visibility,
input limits, tool argument validation, freshness policy, budgets and persistence.
Use the model for language understanding, focused query proposals and synthesis.

The system is an answer engine built on Exa's retrieval, rather than an independent
web crawler or internet-scale index. That makes prompt/context policy and evidence
quality the useful optimization surfaces for this project.

## Before Exa: request and prompt preparation

The HTTP boundary accepts the user's original text, browser timezone, session ID
and an optional explicit historical instant. It validates the request before
opening a stream. Time is pinned exactly once, down to milliseconds. A separate
wall-clock timestamp records when the request actually arrived.

The memory layer applies the pinned cutoff to every route into model context.
Only then does the prompt compiler select the most recent bounded history,
reference-only memory, and the untouched current user message. Trusted time
metadata is a separate system message. The fixed instruction prefix stays
identical across turns, allowing compatible model hosts to reuse it in their
prompt cache; reuse depends on the configured host.

A cheap intent hint distinguishes conversation, memory recall, creative writing,
text transformations, verification and lookup. Creative tasks and supplied-text
transformations are exempt from historical web citations; mixed factual research
still follows temporal policy. It is deliberately a hint, not a complete semantic classifier. Verification
and volatile-fact searches receive forced fresh policy at the tool boundary.
The same answer model decides which focused searches to perform. A greeting still
needs one model call and no search; there is no extra planner model in front of it.

## At Exa: preserve the acquisition boundary

The application validates tool proposals before passing them to the existing
search layer. The pinned time frames the answer, rather than requiring a page
captured before that time. Three search rounds, twelve
valid lookup attempts, four concurrent lookups and the existing Exa HTTP deadline
bound the turn. A disconnect cancels queued and active work.

Search and direct source reads continue through the existing single `web_search`
tool. There are no extra search providers, runtime federation or ranking service.
Freshness and execution budgets are enforced around the existing Exa implementation.
Modern retrospective pages can establish dated historical facts. No snapshot,
archive lookup or manually curated corpus is required by chat.

## After Exa: evidence and answer preparation

A per-turn evidence window owns a shared 32,000-character tool-output budget,
including metadata and JSON escaping. Passages are capped at 6,000 characters
before the model sees them; the ledger hashes and stores exactly that admitted
text. The prompt separates source publication and retrieval dates from the dates
of the events described. Missing or omitted passages do not receive citation
numbers.

Independent searches execute concurrently. Numbering and evidence assembly are
deterministic in requested-call order. Exa's result order is retained. A new local
reranker should only be added after the private benchmark shows a quality gain;
additional ranking is not automatically an improvement for a small evidence set.

The model receives numbered, explicitly untrusted passages and can issue another
round if essential evidence is absent. At completion, the application checks
citation references. Simulated factual drafts receive a bounded independent
review for event chronology and factual support, with one correction when needed.
An unavailable review does not trigger the retired archive-access response.
Thin evidence calls for a specific uncertainty and a supported partial answer,
rather than an invented historical price or future result.

History is selected before recall. Only retained turn IDs are excluded from recall,
so answers omitted by the history budget remain retrievable by topic or date.

Citation extraction runs the same Markdown and DOMPurify sanitization as the
browser, using a reusable jsdom environment on the server. A shared text-node
selector excludes code, preformatted text and links on both sides. HTML blocks and
entities therefore receive the same citation handling as rendered text.

The answer, cited passages and execution context are committed together. SSE
completion then lets the UI finish rendering. Background extraction is limited to
two active jobs with a queue bound of 128. A missing source or unknown verdict
cannot silently become a changed/unchanged claim; the ledger supports `unverified`.
The extraction queue remains in-process; crash-resilient jobs are future work.

## Current context and execution budgets

| Resource | Bound |
| --- | --- |
| User message | 8,000 characters at HTTP boundary |
| Recent history | Up to 8 turns and 18,000 content characters |
| Recalled memory | 12,000 content characters |
| Search-result messages | 32,000 content characters across all rounds |
| Admitted passage | 6,000 characters |
| Tool proposals in one model response | 16, then fail the turn |
| Search rounds / valid lookups | 3 / 12 |
| Whole turn | 120 seconds |
| Active background extraction jobs | 2 |

Character limits are deterministic safety budgets, not exact tokenizer counts.
Tool errors also consume the shared output budget; protocol framing is additional.
Latency uses a monotonic clock and remains independent of simulated
time. Source acquisition times remain real wall-clock timestamps.

## Research rationale

Modern retrieval systems use cheap early stages and reserve expensive processing
for a bounded candidate set. Vespa explicitly documents phased retrieval/ranking
and reranking bounds. For asof, the corresponding application decision is to keep
recall and policy deterministic, bound evidence before synthesis, and evaluate any
extra reranking/planning cost before adopting it.
[Primary source: Vespa phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html).

Retrieval score fusion can combine independently ranked lists; it is useful when a
system owns multiple retrievers. It does not itself establish evidence correctness.
As Exa is this project's sole web tool, the application does not introduce an RRF
layer or a parallel web retrieval stack.
[Primary source: Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion).

Frozen-web evaluation separates changes in an agent from changes in the web.
That motivates two private evaluation tracks: deterministic temporal/prompt
regression fixtures, and live end-to-end answer samples saved for review.
[Primary source: FutureSearch Deep Research Bench](https://arxiv.org/abs/2506.06287).

The [earlier research](../ARCHITECTURE.md) compares GPT Researcher, STORM and other
answer/report engines. The design here adopts bounded context, explicit evidence
and iterative research without importing their entire orchestration frameworks.

## Private benchmarking

The [era simulation guide](historical-evidence.md) describes the current
simulation benchmark and the distinction between event time and research time.
See also [the benchmark protocol](benchmark.md). The older CLI can compare saved samples from
other engines using the same labeled questions, without adding those engines to
this application's search stack. It creates no dashboard elements or API routes.
Synthetic fixture scores are never labeled as commercial-engine measurements.

## Remaining accuracy and operations work

- Establish human-labeled factual correctness and claim-to-passage entailment on
  representative held-out questions. Numeric citation validity is insufficient.
- Measure p50/p95 end-to-end latency, final-answer first token, actual API cost,
  completeness and abstention before changing model/search strategies.
- Persist enrichment jobs transactionally if extraction must survive process exit.
- Add authentication and owner-scoped storage before serving multiple users;
  current session IDs are conversation identifiers, not authorization.

These are declared limits, not hidden claims of completed capabilities.
