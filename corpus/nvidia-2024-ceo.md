# NVIDIA historical CEO attribution pilot

`nvidia-2024-ceo.json` contains one seven-word, contiguous attribution excerpt
from NVIDIA's original earnings release, furnished as Exhibit 99.1 of its
20 November 2024 Form 8-K. The original punctuation, including the final period,
was checked against the SEC-preserved exhibit during this implementation session.
The excerpt has no generated joining text or modern biographical additions.

Primary evidence:

- [Original SEC Exhibit 99.1](https://www.sec.gov/Archives/edgar/data/1045810/000104581024000315/q3fy25pr.htm).
- [Parent Form 8-K and exhibit link](https://www.sec.gov/Archives/edgar/data/1045810/000104581024000315/nvda-20241120.htm).
- [Complete original SEC submission](https://www.sec.gov/Archives/edgar/data/1045810/000104581024000315/0001045810-24-000315.txt).
- [SEC issuer submissions metadata](https://data.sec.gov/submissions/CIK0001045810.json),
  accession `0001045810-24-000315`.

The SEC submissions metadata identifies the filing date as 20 November 2024
and the acceptance timestamp as `2024-11-20T21:21:20.000Z`. Acceptance is an
operational filing timestamp; it is not presented as a measurement of the first
instant every reader could access the exhibit.

The manifest therefore uses `2024-11-21T05:00:00.000Z` as a deliberately
conservative admission bound: midnight immediately after the reported filing
day in US Eastern Standard Time. It excludes queries earlier on the actual
publication day. There is no invented exact `publishedAt` value.

`capturedAt` records this session's modern acquisition/curation time, separately
from the historical admission bound. `primary-source` denotes the preserved
original filing exhibit, rather than a current company biography carrying an
old publication label. The document title is a curator label; the manifest's
`text` is the exact excerpt.

`reviewed: true` records session curation of the literal excerpt, original
filing provenance and conservative admission bound. It is an explicit
attestation, not software proof of authenticity or universal historical truth.
An operator adopting the pilot should independently review this attestation.

The excerpt supports a dated statement that the original release identifies
the named person as NVIDIA's CEO. **It does not independently establish that
the role continued through 13 January 2025 or any other later date.** An answer
about a later viewpoint must preserve that evidence gap rather than silently
convert the older attribution into verified continuous tenure. It also does
not establish appointment or departure dates, ownership, financial results,
or later changes in leadership.

This is a narrow real-source retrieval pilot, not comprehensive company
leadership coverage. Exa remains the application's only runtime web-search
provider; this file is an explicitly curated local source.

For isolated import without modifying the application's configured database:

```sh
npx tsx scripts/import-corpus.ts corpus/nvidia-2024-ceo.json --db .context/nvidia-ceo-pilot.temporal.db
```
