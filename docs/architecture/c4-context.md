# System context  -  asof

```mermaid
C4Context
  title System context for asof  -  reviewed 14 November 2026
  Person(user, "Local user", "Asks questions, selects an era, revisits answers")
  System(asof, "asof", "Live-researched answers with dated conversation memory")
  System_Ext(azure, "Configured model endpoint", "Azure Foundry in this installation")
  System_Ext(exa, "Exa", "Sole web search and source-reading service")
  Rel(user, asof, "Selects viewpoint and submits questions", "Browser / local HTTP")
  Rel(asof, user, "Displays progress, cited answers and Ledger", "SSE / HTML")
  Rel(asof, azure, "Requests synthesis, era review and memory extraction", "HTTPS / OpenAI-compatible SDK")
  Rel(azure, asof, "Returns tool proposals, drafts and JSON judgments", "Streaming / JSON")
  Rel(asof, exa, "Searches and reads live source passages", "HTTPS")
  Rel(exa, asof, "Returns excerpts, URLs and acquisition metadata", "JSON")
```

The model proposes `web_search` calls; the server validates and executes them. It has no application-provided direct web browser, shell or second search provider. Exa remains the only search and source-reading service used by chat.

Era simulation researches modern sources and frames the answer by event dates and selected-era knowledge. Model review can request one correction; an unavailable review can currently return an unchecked draft. No Snapshot or archive acquisition service is composed into chat.

The original and UI preview are separate local application instances, described in the [container diagram](c4-containers.md). Both still use the configured cloud accounts. The current user boundary is a local single-user assumption, not implemented authentication; see R6 in the [full review](review-2026-11-14.md).
