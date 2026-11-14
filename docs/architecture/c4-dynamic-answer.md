# Current answer sequence

```mermaid
sequenceDiagram
  title Actual question-to-answer flow in one app instance
  actor User
  participant UI as Browser
  participant API as Node HTTP API
  participant Agent as Agent / context
  participant DB as SQLite + FTS5
  participant Model as Azure model endpoint
  participant Search as Exa adapter + cache
  participant Exa as Exa live web
  participant Review as Era reviewer

  User->>UI: Ask with a selected viewpoint
  UI->>API: POST /api/chat, sessionId, message, tz, optional asOf
  API->>Agent: Validated input and abort signal
  Agent->>Agent: Pin effectiveAt and receivedAt
  Agent->>DB: Load visible history and recall candidates
  DB-->>Agent: Conversation records
  Agent->>Model: Trusted time + bounded context + original question
  loop At most three research rounds, twelve lookups
    Model-->>Agent: Proposed web_search calls
    Agent->>Search: Validate, apply freshness and execute in parallel
    Search->>Exa: Search or read sources through Contents
    Exa-->>Search: Live passages and metadata
    Search-->>Agent: Result observations
    Agent->>Agent: Number and bound untrusted passages
    Agent->>Model: Append tool observations
  end
  alt Factual era simulation
    Model-->>Agent: Buffered draft
    Agent->>Review: Question, viewpoint, draft and source passages
    Review->>Model: Independent editorial-review request
    Model-->>Review: Verdict and optional correction
    Review-->>Agent: Approved, needs_revision or unavailable
    opt Needs revision
      Agent->>Model: One rewrite with issues and evidence
      Model-->>Agent: Revised draft
      Agent->>Review: Recheck revised draft
      Review-->>Agent: Verdict or bounded source-based correction
    end
    Agent-->>UI: Sources and final text (currently before commit)
  else Ordinary, recall, or nonfactual task
    Model-->>Agent: Stream answer text
    Agent-->>UI: Stream provisional text; retract tool preambles if needed
  end
  Agent->>DB: Transaction: episode + cited sources + execution metadata
  DB-->>Agent: Committed episode ID
  Agent-->>UI: done with episodeId and timings
  opt Ordinary / non-buffered turn
    Agent->>Model: Queue background summary/claim extraction
    Model-->>Agent: Candidate enrichment
    Agent->>DB: Update summary, FTS and extracted claims
  end
```

An unavailable review currently returns a researched draft without full review; it does not request archive access. Invalid suggested corrections can also be classified as unavailable and lose a valid rejection, as reproduced in R1. Review is a model quality check, not proof.

`asOf` constrains the answer's viewpoint and memory visibility. The search call deliberately does **not** receive that value as a Snapshot cutoff. Publication time, event time and actual research time have separate meanings.

The intended reliability correction is to commit buffered final answers before text publication and add an idempotent turn identity. That is a recommendation, not current behaviour.
