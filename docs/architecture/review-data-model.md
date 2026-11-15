# Stored data model  -  reviewed implementation

```mermaid
erDiagram
  EPISODES ||--o{ SOURCES : cites
  EPISODES ||--o{ CLAIMS : extracts
  CLAIMS o|--o{ CLAIMS : supersedes
  EPISODES ||--o{ VERIFIED_STATEMENTS : legacy_audit
  VERIFIED_STATEMENTS ||--|{ VERIFIED_STATEMENT_SOURCES : supports
  SOURCES ||--o{ VERIFIED_STATEMENT_SOURCES : links
  EPISODES {
    integer id PK
    text session_id
    integer asked_at "simulated viewpoint; also used for ordering"
    text tz
    text question
    text answer
    text summary
    text topics
    text execution_json "real receivedAt and current review status"
  }
  SOURCES {
    integer episode_id PK,FK
    integer n PK
    text url
    text title
    text published_date
    text evidence_json "exact passage, hash, method, retrieval time"
  }
  CLAIMS {
    integer id PK
    integer episode_id FK
    text entity
    text attribute
    text value
    text kind
    text source_url
    integer observed_at
    integer prior_claim_id FK
    text verdict
  }
  VERIFIED_STATEMENTS {
    integer id PK
    integer episode_id FK
    text text
    integer viewpoint_at
    integer verified_at
  }
  VERIFIED_STATEMENT_SOURCES {
    integer statement_id PK,FK
    integer episode_id FK
    integer source_n PK,FK
  }
```

`episodes_fts` is a separate FTS5 virtual index with `question`, `summary`, `topics` and `entities`, linked by row ID in application code. It is not a source-of-truth facts table and has no declared episode foreign key. New factual simulation turns currently index their question only, because they bypass enrichment and do not write legacy verified statements.

The verified-statement tables and immutability triggers support the retired strict historical workflow. Current era simulation writes answers/citations/review metadata, not new verified statements. Ordinary extracted claims are model interpretations and can carry an `unverified` verdict.

There is currently no users/owners table, conversations/settings table, durable turns/idempotency table, or outbox table. Recommended additions in the review are explicitly future work. In particular, actual creation order and selected historical viewpoint should become separately indexed fields.
