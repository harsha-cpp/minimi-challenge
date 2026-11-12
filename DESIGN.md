# Design

## The idea

The brief's sample questions share one shape: find a past conversation by its date, look at the web again, and say what changed. A chat log can answer "what did I ask". It cannot answer "is it still correct", because it never recorded what was claimed or where the claim came from.

So an answer is stored as dated claims, not just as a message. "Neon Launch plan: $19/month, from neon.com/pricing, observed Tue 3 Nov" is one row. A follow-up a week later becomes: load the rows for that date, re-check each one, report then against now.

## How a turn works

1. **Resolve dates in code.** `time/resolve.ts` turns "last Tuesday" or "3 November" into calendar days in the user's timezone, against an injectable clock. No model call.
2. **Recall by date, then topic.** `memory/recall.ts` loads the conversations on those days from SQLite, with their claims. An ambiguous phrase returns every reading and the one that has a matching conversation wins. An empty date falls back to topic words and reports the nearest conversations.
3. **One model, one tool.** The model gets the current time and the recalled memory as context, and may call `web_search` several times in parallel, for at most three rounds.
4. **Stream the answer** with numbered citations.
5. **Enrich afterwards.** The exchange is saved at once. A background call then extracts a summary, topic words and claims, and links each re-checked claim to the one it replaces.

## Why this shape

- **Fast.** Nothing sits in front of the model. Recall is a few milliseconds of SQL, so a plain message costs one model call and a searched answer usually two. A round's searches run concurrently, and Exa returns page passages with its results, so there is no fetch-and-scrape step. Memory is written after the response.
- **Right.** Dates are computed, not guessed. Memory tells the model exactly what was found, including "nothing on that day", and the prompt forbids inventing a past conversation. Re-checks start from a list of exact claims with sources, and "could not verify" is an allowed result.
- **Testable.** The clock is injected, so a test or a reviewer can ask on one day and follow up on another. `npm test` covers date resolution, recall and the agent loop without a network. `npm run eval` replays the brief's questions end to end.

## Considered and rejected

- **Memory as a second tool.** The brief says one tool, and it would spend a model round trip on what SQL does in milliseconds.
- **A router or planner call before the main model.** It adds latency to every turn. Code does that work here, exactly and for free.
- **Embeddings and a vector store.** Once a date narrows the log to a few conversations there is little left to rank. Full-text search over model-written topic words handles different wording ("Postgres hosting" finds a question that said "managed database") with no extra key or network call.
- **The model providers' built-in web search.** It cannot filter by date and hides the sources the ledger needs.
- **Letting the model parse dates.** Not reliable, and not unit-testable.
- **An agent framework.** The loop is about a hundred lines. Owning it keeps every decision visible.
- **A native SQLite module or a database server.** `node:sqlite` ships with Node, so `npm install` has nothing to compile.

## Limits today

Date phrases are English only, there is one user, and topic recall is lexical.

## With another week

- **Nudges.** A background job that re-checks volatile claims and tells you when one changes, before you ask.
- **True then-versus-now diffs,** by reading the archived version of a page as of the original date instead of relying on the stored claim alone.
- **A shelf life per claim,** so prices are re-checked eagerly and stable facts are left alone.
- **Graded evals.** A larger question set with answer scoring, and latency budgets enforced in CI.
