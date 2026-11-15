# Agent component diagram  -  current runtime

```mermaid
flowchart TD
  Browser["Browser UI<br/>HTML / CSS / JavaScript"]
  Azure["Azure Foundry model endpoint<br/>Answer, review and memory roles"]
  Exa["Exa Search / Contents<br/>Sole web retrieval service"]
  DB[("SQLite WAL + FTS5<br/>Episodes, citations, claims, search index")]
  subgraph Backend["One Node / TypeScript process  -  main OR preview instance"]
    HTTP["HTTP boundary<br/>Validate JSON; establish SSE; cancel on disconnect"]
    Context["Context compiler<br/>Pin time; retain history; recall dated records"]
    Agent["Agent loop<br/>3 research rounds / 12 lookups"]
    Search["Search adapter<br/>LRU cache; single-flight; concurrency; retries"]
    Evidence["Evidence window<br/>Bound passages; assign citation numbers"]
    Model["Model adapter<br/>Responses or Chat Completions"]
    Review["Era reviewer<br/>Factual simulations; one repair + recheck"]
    Finish["Finalization<br/>Publish text; commit episode; emit done"]
    Jobs["Background enrichment<br/>Ordinary turns only; in-process queue"]
  end
  Browser -->|"POST question / viewpoint"| HTTP
  HTTP -->|"Validated request"| Context
  DB -->|"Return visible conversation records"| Context
  Context -->|"Compile bounded messages"| Agent
  Agent -->|"Request synthesis or tool proposals"| Model
  Model -->|"Call configured model"| Azure
  Agent -->|"Execute validated web_search"| Search
  Search -->|"Request live source passages"| Exa
  Exa -->|"Return evidence and metadata"| Evidence
  Evidence -->|"Append numbered tool results"| Agent
  Agent -->|"Review factual era draft"| Review
  Review -->|"Request editorial judgment and correction"| Model
  Review -->|"Return approved, corrected or unchecked draft"| Finish
  Agent -->|"Finalize ordinary streamed answer"| Finish
  Finish -->|"Write answer and cited observations"| DB
  Finish -->|"Emit progress, text and completion"| Browser
  Finish -->|"Schedule ordinary-turn summary and claims"| Jobs
  Jobs -->|"Request extraction"| Model
  Jobs -->|"Update summary, claims and FTS rows"| DB
```

This is a component/dataflow view, not a statement that every edge executes in strict diagram order. Ordinary text streams while generation runs. Factual simulation text is buffered for review but currently published before the SQLite commit; `done` follows commit. See the [actual sequence](c4-dynamic-answer.md) and findings R1/R5 in the [review](review-2026-11-14.md).

The exact same engine files run in the isolated preview. Preview-only UI source inspection and session restoration do not add a second search service. No archive retrieval or Snapshot gate is in the composed chat path.
