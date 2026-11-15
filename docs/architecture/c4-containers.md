# Runtime containers  -  original and isolated preview

```mermaid
C4Container
  title Runtime containers for asof  -  actual local deployment
  Person(user, "Local user", "Browses the original or UI preview")
  System_Boundary(main, "Original application") {
    Container(mainBrowser, "Main browser UI", "HTML / CSS / JavaScript", "Chat, era picker and Ledger")
    Container(mainAPI, "Main backend", "Node / TypeScript, port 3000", "HTTP, bounded agent loop and in-process jobs")
    ContainerDb(mainDB, "Main ledger", "SQLite WAL + FTS5", "data/asof.db")
  }
  System_Boundary(preview, "Isolated UI preview copy") {
    Container(previewBrowser, "Preview browser UI", "HTML / CSS / JavaScript", "Source inspector and local session recovery")
    Container(previewAPI, "Preview backend", "Node / TypeScript, port 3001", "Same agent plus read-only session-history route")
    ContainerDb(previewDB, "Preview ledger", "SQLite WAL + FTS5", ".context/ui-preview/data/asof.db")
  }
  System_Ext(azure, "Azure Foundry model endpoint", "Generation, editorial review and memory roles")
  System_Ext(exa, "Exa Search / Contents", "Only web retrieval service")
  Rel(user, mainBrowser, "Opens original", "Browser")
  Rel(user, previewBrowser, "Opens preview", "Browser")
  Rel(mainBrowser, mainAPI, "Submits questions and reads records", "JSON / SSE")
  Rel(previewBrowser, previewAPI, "Submits questions and restores sessions", "JSON / SSE")
  Rel(mainAPI, mainDB, "Reads and writes main records", "SQL")
  Rel(previewAPI, previewDB, "Reads and writes preview records", "SQL")
  Rel(mainAPI, azure, "Requests model work", "HTTPS")
  Rel(previewAPI, azure, "Requests model work", "HTTPS")
  Rel(mainAPI, exa, "Acquires live passages", "HTTPS")
  Rel(previewAPI, exa, "Acquires live passages", "HTTPS")
```

Each application is one backend process and one SQLite file. Prompt preparation, model orchestration, search cache, concurrency limiters and background enrichment are **components inside that process**, not separately deployed services. SQLite is a local data store, not another application server.

The preview has its own source files, copied dependencies, database, clock object and browser-origin storage. Its only server-route addition is `GET /api/sessions/:id` for reopening saved conversations. The original application has not been merged with these UI changes. Cloud account quotas and billing remain shared.

Original composition root: `src/server.ts`. Preview root: `.context/ui-preview/src/server.ts`. The agent and search implementation files are identical between the reviewed copies. The [component diagram](c4-components-agent.md) applies to either backend instance.

The private benchmark is a separate command-line program with isolated in-memory stores and private output files. It has no dashboard route and is not a production dependency.
