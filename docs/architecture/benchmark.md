# Private benchmark protocol

For the current era-simulation evaluation, use `npm run eval:simulation -- --live`
and the [era simulation guide](historical-evidence.md). This older general pipeline
and recorded-comparison protocol retains a legacy snapshot-provenance diagnostic;
that diagnostic is not an era-simulation quality metric or a chat requirement.

The benchmark is a CLI and local JSON artifact. It creates no dashboard page,
chart, metrics route or extra web search integration. Exa stays the only web tool.

## Tracks

| Track | Measures | Does not establish |
| --- | --- | --- |
| Synthetic pipeline replay | Temporal admission, memory visibility, abstention and source/citation handling through the real turn loop | Real model quality, Exa quality or competitor performance |
| Live foreground pipeline | Actual question-to-answer execution, first final token, lookup/model counts, cited sources and answers | Factual correctness without independent labels/review |
| Recorded engine comparison | Same-case diagnostics against imported samples from other engines | Authenticity of self-reported external recordings or exhaustive market superiority |

Run the private regression replay:

```sh
npm run eval:benchmark
# .context/benchmark.json (gitignored)
```

Run the live pipeline when model and Exa keys are configured:

```sh
npm run eval:benchmark -- --live --out .context/live-benchmark.json
```

The live seed dataset contains the six real questions used by retrieval diagnostics.
It has no fabricated answer labels. Unlabeled quality metrics remain `null`.
Background enrichment is disabled for this foreground benchmark; foreground latency
and model-call counts exclude background memory extraction. API cost is unmeasured
and stays `null`. The normal application continues to run enrichment.

## Labeled task files

For meaningful quality comparisons, supply a frozen, reviewed dataset:

```json
[
  {
    "id": "historical-question-001",
    "question": "The exact question used for every engine",
    "asOf": "2020-11-03T09:00:17.123Z",
    "sourceGrades": { "https://example.com/reviewed-source": 3 },
    "requiredFacts": ["a human-verified fact"],
    "forbiddenFacts": ["a known future-only fact"],
    "expectedAbstention": false
  }
]
```

The example above defines the file format; it is not real ground truth. Use grades
0 to 3 for source relevance. `asOf`, labels and `history` are optional. Seed history
is an array of `{at, question, answer}` records in the same conversation, allowing
repeatable time-travel trials. Every record needs an explicit ISO timezone.

```sh
npm run eval:benchmark -- --live --dataset .context/reviewed-cases.json
```

## Compare other engines without adding providers to the app

Capture the same original question, effective time and seed history on each engine.
Record the complete answer and source list, the actual collection timestamp and
measured elapsed milliseconds. Record whether the comparison is an era
reconstruction or a frozen-page experiment; these are different tasks. Leave
unknown latency as `null`.

The baseline file is an array of samples with these fields:

| Field | Requirement |
| --- | --- |
| `caseId` | A case in the task dataset |
| `engine` | An external engine label, distinct from `asof-exa` |
| `basis` | `recorded` |
| `capturedAt` | Actual ISO timestamp of collection |
| `inputHash` | Copy from the corresponding asof sample; binds question, time and history |
| `answer` | Complete recorded answer |
| `sources` | Array of `{n, url, title, ...optional evidence metadata}` |
| `latencyMs` | Actual nonnegative elapsed milliseconds, or null |

```sh
npm run eval:benchmark -- --live \
  --dataset .context/reviewed-cases.json \
  --baseline .context/recorded-baselines.json \
  --out .context/comparison.json
```

External samples are imported from disk. No competitor API is added to runtime.
Missing baseline cases are listed explicitly. Paired summaries compare only the
shared case IDs and matching input hashes; per-engine overall summaries may have
different coverage and should not be compared directly.

## Metrics and interpretation

- nDCG@5, reciprocal rank and source recall use reviewer-supplied URL grades. For
  answers they score cited-source order, not the raw Exa retrieval ranking.
- Required/forbidden fact diagnostics use normalized exact-string matching.
  Paraphrases can fail, and an included phrase can still be used incorrectly.
- Citation integrity checks referenced numbers against the supplied source list.
  It does not verify that a passage entails the adjacent claim.
- The legacy temporal-policy diagnostic counts sources lacking the exact required snapshot
  bound. This is missing/mismatched provenance, not proof of an actual future leak.
- Abstention matching checks recognizable uncertainty phrases and human labels.
- p50/p95 are measured only from samples with latency; tiny datasets do not justify
  performance SLOs or competitive claims.

The JSON includes dataset identity, input hashes, raw answer/source samples,
collection basis, label denominators, paired coverage and declared limitations.
A real competitive study needs representative held-out tasks, repeated runs,
comparable budgets and blinded human review of factuality and completeness.
No external-engine performance results have been fabricated or shipped.
