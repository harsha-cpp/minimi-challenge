# asof

A chat agent with one tool, web search, that remembers what it told you and when, so you can ask later whether it is still true.

The design is explained in [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22.13 or newer.

```sh
cp .env.example .env   # fill in the two keys below
npm install
npm run dev            # http://localhost:3000
```

| Variable | What it is |
| --- | --- |
| `LLM_API_KEY`, `LLM_MODEL` | Any OpenAI-compatible Chat Completions model. Set `LLM_BASE_URL` for hosts other than OpenAI (Azure Foundry, Fireworks, ...). |
| `EXA_API_KEY` | Web search, from [dashboard.exa.ai](https://dashboard.exa.ai/api-keys). |

The optional variables are described in `.env.example`.

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
| `npm run import -- file.json` | Load past conversations into memory. |

## Layout

```
src/
  clock.ts            the one source of "now"; can be moved
  time/resolve.ts     "last Tuesday" → calendar days, in code
  time/zone.ts        calendar-day arithmetic in the user's timezone
  memory/store.ts     SQLite: conversations, sources, claims
  memory/recall.ts    finds the past conversations a message refers to
  memory/enrich.ts    background step: summary, topics, claims
  search.ts           the web_search tool (Exa)
  llm.ts              the model (OpenAI-compatible)
  agent/prompt.ts     system prompt and tool definition
  agent/run.ts        one turn, start to finish
  server.ts           HTTP, server-sent events, static page
public/               the page: plain HTML, CSS and JS
test/                 unit tests
eval/replay.ts        the brief's questions, replayed with a moved clock
```
