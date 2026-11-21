# Era simulation request sequence

```mermaid
sequenceDiagram
  title Live research with a pinned era viewpoint
  actor User
  participant UI as Dashboard
  participant API as Application
  participant DB as SQLite memory
  participant LLM as Answer model
  participant Exa as Live Exa
  participant Review as Era reviewer
  User->>UI: Travel to January 1948
  UI->>API: Will India get independence? + pinned asOf
  API->>API: Pin effectiveAt, receivedAt and timezone
  API->>DB: Read conversations visible at effectiveAt
  DB-->>API: Bounded history and recalled records
  API->>LLM: Original question and selected-era instructions
  User->>UI: Change clock while this answer runs
  LLM-->>API: Focused historical research query
  API->>Exa: Ordinary live search, without a snapshot cutoff
  Exa-->>API: Modern source passages about dated historical events
  API->>LLM: Numbered passages and research timestamps
  LLM-->>API: Era-framed draft: independence already happened
  API->>Review: Check event chronology and factual support
  Review-->>API: Verdict and any specific corrections
  opt Correction needed
    API->>LLM: Revise once using evidence and review findings
    LLM-->>API: Corrected answer
  end
  API->>DB: Commit answer, citations and execution context
  API-->>UI: Complete answer for the original pinned viewpoint
```

The simulated clock keeps ticking between requests. Each request uses one fixed
reading, even if the user travels again while it is running. The same upper bound
applies to chat history, date recall, topic recall, nearby conversation suggestions
and ledger reads. Direct episode reads after the selected clock return 404.

`effectiveAt` is conversation/viewpoint time. `receivedAt` and source `retrievedAt`
are real wall time. The research source may have been published after the
viewpoint; the event being asserted must fit the viewpoint. See the
[era simulation guide](historical-evidence.md) for examples and limits.

Future selected dates are hypothetical scenarios. The model may discuss plausible
possibilities, but cannot present later events, prices or results as established
facts. Modern retrospectives are useful research, not a perfect reproduction of
what an observer could have known at the time.
