# Historical corpus pilot

`us-founding-pilot.json` contains exactly three short original-document
transcription excerpts. It is a real-source integration pilot, not a general
historical knowledge base or a complete constitutional-law corpus.

The excerpts were reviewed against the National Archives pages during this
implementation session, acquired on 13 November 2026 UTC. The document titles
are curator labels; the `text` fields are exact contiguous transcription
excerpts, without modern editorial introductions, amendment annotations,
navigation, biographies, or later legal analysis.

| Source | Reviewed original excerpt | Conservative admission bound |
| --- | --- | --- |
| [Constitution, Article II](https://www.archives.gov/founding-docs/constitution-transcript) | Presidential term clause | 1 January 1800 |
| [Bill of Rights, First Amendment](https://www.archives.gov/founding-docs/bill-of-rights-transcript) | Establishment/free-exercise clauses | 1 January 1800 |
| [Thirteenth Amendment, Section 2](https://www.archives.gov/founding-docs/amendments-11-27) | Congressional enforcement clause | 1 January 1866 |

The National Archives describes the Constitution transcription as reproducing
the original parchment, and the Bill of Rights transcription as reproducing the
original resolution. Its amendments page identifies the Thirteenth Amendment
as ratified on 6 December 1865. These original U.S. government texts are public
domain. The modern web-page capture date is separate from the attested
availability of the quoted historical edition.

`availableAt` deliberately admits these excerpts later than their original
creation or ratification. **1800 and 1866 are conservative admission bounds,
not claims about exact first-publication timestamps.** Queries before those
bounds cannot use these entries. There is no invented `publishedAt` timestamp.
The pilot consequently excludes some dates on which the original texts were
already available.

`reviewed: true` records explicit curation of the excerpt, its original-edition
provenance and the admission bound during this session. It does not mean the
software authenticated the original artifact, proved historical truth, or
established that a provision remains the applicable law at every later date.
An operator adopting this corpus should independently review that attestation.
Content hashes detect later modification; they do not establish authenticity.

The collection is not automatically imported. To inspect an isolated local
copy without modifying the application's ledger or corpus database:

```sh
npx tsx scripts/import-corpus.ts corpus/us-founding-pilot.json --db .context/us-founding-pilot.temporal.db
```

To validate the pilot manifest without API calls:

```sh
npx tsx eval/historical-pilot.ts --out .context/historical-pilot-preflight.json
```

To run three real-model, end-to-end historical turns with the configured Azure
model and Exa credentials:

```sh
npx tsx eval/historical-pilot.ts --live --out .context/historical-pilot-live.json
```

The evaluator uses the production `runTurn` and `withHistoricalCorpus` paths,
but creates fresh in-memory corpus and conversation stores. Exa remains the only
web-search provider. The model's raw drafts remain private to the verifier;
only the application's released answer is scored. Reports include evidence,
verification status, timings, labeled checks and reproducibility hashes. A
three-case pass is an integration result, not a general accuracy estimate.
