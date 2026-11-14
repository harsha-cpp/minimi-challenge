import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceWindow } from "../src/agent/evidence.ts";
import type { SearchHit } from "../src/search.ts";
import { withHistoricalCorpus } from "../src/temporal/retrieve.ts";
import { TemporalStore } from "../src/temporal/store.ts";

// Fictional annual records test complete passage delivery, not sports fact accuracy.
test("a preserved annual-history table delivers every covered season in one evidence window", async () => {
  const store = new TemporalStore(":memory:");
  const years = Array.from({ length: 17 }, (_, i) => 2008 + i);
  const table = ["Year | Championship winner", ...years.map(year => `${year} | Club ${year}`)].join("\n");
  const cutoff = new Date("2024-11-14T06:22:08.161Z");
  try {
    const original = store.importDocument({
      sourceId: "fictional-league-2024-handbook",
      url: "https://league.example.com/editions/2024-handbook.pdf",
      title: "Fictional League 2024 handbook: complete championship winners 2008–2024",
      text: table,
      availableAt: "2024-06-01T00:00:00.000Z",
      capturedAt: "2026-11-14T00:00:00.000Z",
      provenanceKind: "primary-source",
      provenanceUrl: "https://league.example.com/editions/2024-handbook.pdf",
      reviewed: true,
    });
    store.importDocument({
      ...original,
      sourceId: "fictional-league-2025-handbook",
      url: "https://league.example.com/editions/2025-handbook.pdf",
      text: `${table}\n2025 | FUTURE_WINNER_SENTINEL`,
      availableAt: "2025-06-01T00:00:00.000Z",
      provenanceUrl: "https://league.example.com/editions/2025-handbook.pdf",
    });
    let snapshotCalls = 0;
    const retrieval = withHistoricalCorpus({ search: async query => {
      snapshotCalls++;
      assert.equal(query.asOf?.toISOString(), cutoff.toISOString());
      throw new Error("Exa responded 403.");
    } }, store);
    const query = { query: "Fictional League winners list each year", asOf: cutoff };
    const hits = await retrieval.search(query);
    assert.equal(snapshotCalls, 1);
    assert.equal(hits.length, 1);
    const admitted: SearchHit[] = [];
    const rendered = new EvidenceWindow().render(query, hits, hit => { admitted.push(hit); return admitted.length; });
    for (const year of years) assert.ok(rendered.includes(`${year} | Club ${year}`), `season ${year} must survive retrieval and passage admission`);
    assert.equal(admitted[0]!.text, table);
    assert.equal(admitted[0]!.temporal!.documentId, original.id);
    assert.doesNotMatch(rendered, /FUTURE_WINNER_SENTINEL|2025 \|/);
  } finally { store.close(); }
});
