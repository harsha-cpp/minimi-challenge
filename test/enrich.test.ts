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

test("background extraction concurrency is bounded without blocking raw episode persistence", async () => {
  const store = new MemoryStore(":memory:");
  let active = 0, peak = 0;
  const release: Array<() => void> = [];
  const llm: Llm = { stream: async () => ({ text: "", toolCalls: [] }), json: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(r => release.push(r));
    active--; return { summary: "summary", topics: [], claims: [] };
  } };
  const enricher = new Enricher(llm, store);
  for (let i = 0; i < 4; i++) {
    const id = store.saveEpisode({ sessionId: "s", askedAt: i, tz: "UTC", question: "q", answer: "answer", sources: [] });
    enricher.schedule(id, { question: "q", answer: "answer", sources: [{ n: 1, title: "Source", url: "https://example.com" }], priorClaims: [] });
  }
  assert.equal(store.count(), 4);
  await new Promise<void>(r => setImmediate(r));
  assert.equal(active, 2);
  release.splice(0).forEach(r => r());
  await new Promise<void>(r => setImmediate(r));
  assert.equal(active, 2);
  release.splice(0).forEach(r => r());
  await enricher.idle();
  assert.equal(peak, 2);
  assert.equal(store.episode(4)!.summary, "summary");
  store.close();
});
