# asof

A chat agent with one tool, web search, that remembers what it told you and when, so you can ask later whether it is still true.

The design is explained in [DESIGN.md](DESIGN.md).
The [complete application architecture](docs/architecture/README.md) covers the
prompt-to-Exa-to-answer path, with [request flow](docs/architecture/request-flow.md)
and [time-travel](docs/architecture/time-travel.md) diagrams. The earlier research
is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Needs Node 22.13 or newer.

```sh
cp .env.example .env   # fill in the two keys below
npm install
npm run dev            # http://localhost:3000
```

| Variable | What it is |
| --- | --- |
| `LLM_API_KEY`, `LLM_MODEL` | Model key and deployment name. Set `LLM_BASE_URL` for Azure Foundry or other hosts, and `LLM_API_MODE=responses` for Responses tool calling. |
| `EXA_API_KEY` | Web search, from [dashboard.exa.ai](https://dashboard.exa.ai/api-keys). |

The optional variables are described in `.env.example`.

The UI preview can ask one optional multiple-choice question before open-ended
research, then apply your choice to the original request. You can also type a
detail or skip. Clear factual requests go straight to an answer. See
[optional clarifications](docs/clarifications.md) for the resume flow and limits.

Traveling to a date starts an **era simulation**. Exa researches the live web,
including modern accounts of historical events, while the answer takes the
selected date's perspective. Event dates determine what has happened; the source
page can be newer. Later outcomes stay unknown and predictions are labeled as
hypothetical. A bounded review checks the era and evidence before display. No
archive access or manual source loading is needed; see the
[implementation guide](docs/architecture/historical-evidence.md).

## Trying the date questions

Questions like "what did I ask you on 3 November?" need a history, and a fresh clone has none. Three ways to get one:

- **Move the clock.** Click the date stamp at the top right, travel to a past day, ask something, then return to now and ask about it. Starting the server with `AGENT_NOW=2026-11-03T10:00:00+05:30` does the same from the command line.
- **Replay the brief.** `npm run eval` builds a history on 3 and 9 November, then asks the three questions from the brief on 11 November and prints each answer with its trace and timings.
- **Import a history.** `npm run import -- history.json` loads a JSON array of `{ "at", "question", "answer" }`.

**Ledger**, at the top right, shows everything the agent remembers: each conversation, the claims it made, and which of them were later re-checked.

## Commands

| | |
| --- | --- |
| `npm run dev` | Start the server and the page. |
| `npm test` | Unit tests. They use no network and need no keys. |
| `npm run typecheck` | Type-check with `tsc`. |
| `npm run eval` | Replay the brief's questions against the real model and search. |
| `npm run eval:search` | Run live Exa retrieval diagnostics and save `.context/search-eval.json`. Requires `EXA_API_KEY`; makes paid API requests. Optional `-- --out path.json`. |
| `npm run eval:benchmark` | Private pipeline replay; saves `.context/benchmark.json`. Add `-- --live` for actual end-to-end samples or `--baseline file.json` for recorded comparison samples. See [protocol](docs/architecture/benchmark.md). |
| `npm run eval:models` | Live comparison of configured deployments across fixed-evidence, live-Exa and extraction tracks. See [Azure model comparison](docs/architecture/azure-models.md). |
| `npm run eval:simulation -- --live` | Private era-simulation benchmark across dates and question types, using live Exa and the configured model. Makes API requests; reports stay in `.context/`. |
| `npm run import -- file.json` | Load past conversations into memory. |
| `npm run import:corpus -- file.json` | Legacy research utility for immutable source datasets; not used by chat. |
| `npm run capture:archive -- URL --as-of ISO --selector CSS --out new.json` | Legacy archive export utility; not used by chat. |
| `npm run eval:temporal` | Regression for the legacy temporal dataset utility; no network. |
| `npm run eval:verification -- --live` | Legacy strict-evidence checker evaluation; separate from era simulation. Makes model API requests. |
| `npm run eval:historical-pilot -- --live` | Legacy curated-corpus research experiment; separate from era simulation. Makes model and Exa API requests. |

## Layout

```
src/
  clock.ts            the one source of "now"; can be moved
  time/resolve.ts     "last Tuesday" → calendar days, in code
  time/zone.ts        calendar-day arithmetic in the user's timezone
  memory/store.ts     SQLite: conversations, sources, claims
  memory/recall.ts    finds the past conversations a message refers to
  memory/enrich.ts    background step: summary, topics, claims
  search.ts           search port and public exports
  search/             Exa Search/Contents, validation, cache, concurrency
  llm.ts              the model (OpenAI-compatible)
  agent/prompt.ts     system prompt and tool definition
  agent/prepare.ts    role-separated prompt and context budgets
  agent/evidence.ts   numbered source passages and aggregate tool budget
  agent/simulation.ts era and factual-support review for simulated answers
  agent/run.ts        one turn, start to finish
  server.ts           HTTP, server-sent events, static page
public/               the page: plain HTML, CSS and JS
test/                 unit tests
eval/replay.ts        the brief's questions, replayed with a moved clock
eval/search.ts        opt-in live retrieval diagnostics
```

Search supports direct source URLs and fresh verification through the same
`web_search` tool. Cited passages and acquisition metadata are stored with each
completed answer; `GET /api/episodes/:id` returns that evidence. Simulated and
present-day requests both research live Exa results. Simulations reconstruct a
past perspective; they do not reproduce a frozen historical internet or guarantee
perfect historical knowledge. Retrieval diagnostics measure search behavior;
the separate simulation benchmark measures its declared answer criteria.
