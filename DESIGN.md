# Design

**asof answers a question twice: when you first ask, and when you return to ask whether it is still true.** It has one external tool, web search, and a dated memory of answers and evidence.

![asof architecture: Node.js backend, request admission, agent orchestration, model gateway, Exa search, SQLite storage and memory worker](docs/assets/asof-architecture-dark.png)

## How it works

For “Last Tuesday I asked about Postgres hosting. Has pricing changed?”, code resolves Tuesday in the user's timezone and retrieves the relevant conversation. The earlier answer identifies claims to investigate; it never counts as current evidence. Missing or ambiguous history stays explicit. Other conversations enter context only through an explicit personal-memory request.

One TypeScript/Node service owns admission, dates, conversation boundaries, validation and persistence. The model proposes lookups and writes answers. Exa Search and Contents share one `web_search` tool. Independent lookups run concurrently. Long-document reads select whole, relevant paragraphs locally, with explicit omissions; admitted evidence stays bounded and deduplicated. Re-check pins the saved answer and reads its cited URLs fresh before broader research. An unchanged announcement page cannot establish an unchanged current price.

Review and memory share structured claim records: assertion, conditions, effective date, source hashes, viewpoint and review version. Unknown fields stay unknown. Each original claim is supported, corrected or unresolved; omission never implies approval. A short, same-context retry can target unresolved claims. Reviewed records go directly into memory, avoiding a second model's interpretation. Ordinary background extraction remains explicitly unverified. Recall combines exact matches with bounded concept aliases, retaining owner, conversation and date filters.

## Speed and recovery

Standard allows fuller research. Fast uses the smaller configured deployment, shorter output and one model-planned search batch, with four tool calls including source reuse. Lookup deadlines reserve time for synthesis, review and correction. Both modes share concurrency, token, deadline and spending controls; Fast retains the main model's evidence review and repair.

Ordinary answers stream provisionally. Verification checks event versus publication dates, billing conditions and availability. Only independently approved findings can appear before completion, after a durable checkpoint; final answers commit before publication. If repair fails, approved complete passages can survive as partially supported. Review timeout, invalid output and insufficient evidence remain distinct. Model review reduces errors; it does not prove truth.

SSE and durable request keys recover lost completions without duplicate generation. Failed or interrupted research can explicitly resume for two minutes using saved evidence, draft and review. Owner, context, model policy and source-code identity must match; cumulative usage survives restart. Cancellation never auto-resumes. Clarifications persist as waiting for input. A trusted local budget allocator reserves parent capacity before issuing a child allowance, then seals the child before reconciliation; it is not a distributed lease service.

## Choices and next steps

A modular service and SQLite keep transactions and recovery understandable. The public demo uses one Azure VM, HTTPS, managed-identity credentials and private backups. Signed cookies isolate visitor memory. The tradeoffs are a single host, bounded lexical recall and external-provider latency. Multiple instances would need shared storage and coordination.

I rejected mandatory planning agents, provider federation and microservices before evidence justified more calls and failure paths. Historical simulation uses retrospective sources while checking for hindsight leakage. New re-checks still require fresh evidence and review; only a valid interrupted attempt reuses its verdict.

With another week, I would independently label the focused 20-conversation set, test held-out paraphrases and run paired Standard/Fast trials under concurrent load. Versioned traces separate completion, first text, failures and answer quality. Automated regressions and small development comparisons establish behavior, not representative p95 or independently adjudicated accuracy.
