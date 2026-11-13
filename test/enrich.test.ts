import assert from "node:assert/strict";
import { test } from "node:test";
import type { Llm } from "../src/llm.ts";
import { buildEnrichment, Enricher } from "../src/memory/enrich.ts";
import { MemoryStore, type Claim } from "../src/memory/store.ts";

const prior: Claim = { id: 1, episodeId: 1, entity: "Fictional Cloud", attribute: "price", value: "$19", kind: "price", sourceUrl: "https://example.com", observedAt: 0, priorClaimId: null, verdict: "new" };

test("a recheck without a valid cited source cannot become changed or unchanged", async () => {
  const llm: Llm = { stream: async () => ({ text: "", toolCalls: [] }), json: async () => ({ summary: "Recheck failed", topics: [], claims: [{ entity: prior.entity, attribute: prior.attribute, value: "$19", prior_id: 1, source: 99, verdict: "unchanged" }] }) };
  const result = await buildEnrichment(llm, { question: "Still correct?", answer: "Could not verify.", sources: [], priorClaims: [prior] });
  assert.equal(result.claims[0]!.verdict, "unverified");
  assert.equal(result.claims[0]!.sourceUrl, null);
});

