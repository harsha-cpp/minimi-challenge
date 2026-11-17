# Design

**asof answers a question twice: when you first ask, and when you return to ask whether it is still true.** It has one external tool, web search, and a dated memory of its answers.

![asof architecture: Node.js backend, request admission, agent orchestration, model gateway, Exa search, SQLite storage and memory worker](docs/assets/asof-architecture-dark.png)

## How it works

For “Last Tuesday I asked about Postgres hosting. Has pricing changed?”, code resolves Tuesday in the user's timezone and retrieves the relevant answer. Missing or ambiguous history stays explicit. Other conversations enter context only through an explicit memory request or selected saved answer. Selection starts a fresh verification run inside the current chat without displaying the old transcript. Bounded follow-ups such as “what about pricing?” and “check the second option” retain that reference. Ordinal checks require an unambiguous numbered list or table; their excerpt keeps the full answer's hash and is labelled as a partial check.

One TypeScript/Node service owns dates, context boundaries, admission and persistence. Exa Search and Contents share one `web_search` tool. First answers use model-directed research. Live re-checks use deterministic, concurrent retrieval: source-specific reads retain the original amounts, dates and conditions, while discovery searches look for updates. Up to four lookups cover at most five target groups; one discovery query remains unrestricted. Previously saved page text never becomes fresh evidence.

One comparison call reports what is still correct, corrected or not confirmed. It considers the full original answer, including facts absent from background extraction. Confirmed items need valid source references and exact supporting passages. Numbered line ranges avoid fragile model-copied quotations. Missing or invalid items do not erase useful results. An unchanged announcement page cannot establish an unchanged current price, and matching a quote does not prove that the interpretation is correct.

## Speed and recovery

Standard permits fuller first-answer research; Fast uses a smaller configured deployment. Both use the faster configured model for live comparisons, without a draft/review/repair loop. Shared deadlines, concurrency and usage limits bound the work. Historical simulation retains a separate perspective check. Ordinary prose streams provisionally; checked answers commit before publication.

SQLite stores answers, source hashes and per-item outcomes atomically. Background extraction remains unverified. A recent retry can target unfinished details. Durable request keys recover lost completions; interrupted research can resume for two minutes only when owner, context and execution policy still match. Saved usage survives restart, and cancellation never resumes automatically.

## Choices and next steps

A modular service and SQLite keep transactions understandable. I rejected mandatory planning agents, provider federation and microservices before measurements justified more calls and failure paths. The tradeoffs are a single host, bounded lexical recall and provider latency. Multiple instances would need shared storage and coordination.

The Azure demo uses HTTPS, managed-identity credentials, private backups and signed visitor cookies. Best-effort page-load records are separate from chats, retain pseudonymous identifiers for at most 14 days, and allow operator-labelled tests. They cannot identify a reviewer or establish unique-person counts.

With another week, I would independently label the 25-conversation review queue and run paired real-provider quality and five-user latency trials. Deterministic HTTP diagnostics exercise behavior and contention; they do not measure model accuracy or production latency. Human factual labels remain pending. Reports retain failure counts and sample sizes, with p95 withheld below 20 samples.
