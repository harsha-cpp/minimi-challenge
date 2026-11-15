import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createExaSearch, normalizeQuery, withCache, withConcurrency, type SearchHit, type SearchProvider } from "../src/search.ts";

const hit = (url = "https://example.com/pricing", text = "Pro plan costs $25/month"): SearchHit => ({ url, title: "Pricing", text });
const json = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers });
const result = { url: "https://example.com/pricing", title: "Pricing", highlights: ["Pro plan costs $25/month"] };

function httpMock(responses: Response[]) {
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const http = (async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    assert.ok(responses.length, "Unexpected provider request");
    return responses.shift()!;
  }) as typeof fetch;
  return { http, requests };
}

for (const freshness of ["standard", "fresh"] as const) {
  test(`Exa ${freshness} uses the documented search contract and stores passage provenance`, async () => {
    const { http, requests } = httpMock([json({ requestId: "req-1", results: [result] })]);
    const hits = await createExaSearch("secret", { spendPolicy: null, fetch: http }).search({ query: "pricing", freshness, domains: ["example.com"] });
    assert.equal(requests[0]!.url, "https://api.exa.ai/search");
    assert.equal(requests[0]!.body.contents.maxAgeHours, freshness === "fresh" ? 0 : 24);
    assert.deepEqual(requests[0]!.body.includeDomains, ["example.com"]);
    assert.equal(hits[0]!.contentHash, createHash("sha256").update(hits[0]!.text).digest("hex"));
    assert.equal(hits[0]!.requestId, "req-1");
    assert.ok(Date.parse(hits[0]!.retrievedAt!));
  });
}

test("historical Contents requests never include live freshness or fall back to discovery", async () => {
  const { http, requests } = httpMock([json({ results: [result] })]);
  const asOf = new Date("2026-11-03T09:30:17Z");
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "pricing", urls: [result.url], asOf, freshness: "fresh" });
  assert.equal(requests[0]!.url, "https://api.exa.ai/contents");
  assert.deepEqual(requests[0]!.body.ids, [result.url]);
  assert.equal(requests[0]!.body.snapshotAsOf, asOf.toISOString());
  assert.equal(requests[0]!.body.maxAgeHours, undefined);
  assert.equal(requests[0]!.body.highlights.query, "pricing");
  assert.equal(hits[0]!.snapshotAsOf, asOf.toISOString());
});

test("URL discovery date bounds do not request Snapshot or imply archived evidence", async () => {
  const { http, requests } = httpMock([json({ results: [result] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "annual winners", publishedBefore: "2024-11-14" });
  assert.equal(requests[0]!.body.endPublishedDate, "2024-11-14T23:59:59.999Z");
  assert.equal(requests[0]!.body.contents.snapshotAsOf, undefined);
  assert.equal(hits[0]?.snapshotAsOf, undefined);
  assert.equal(hits[0]?.archive, undefined);
});

test("provider output is bounded, canonicalized, deduplicated and filtered", async () => {
  const { http } = httpMock([json({ results: [
    { ...result, url: result.url + "?utm_source=spam#section", highlights: ["a".repeat(5000)] },
    result,
    { ...result, url: "https://example.com.evil.com/x" },
    { ...result, url: "javascript:alert(1)" },
    { ...result, url: "http://127.0.0.1/x" },
    { ...result, url: "https://example.com/empty", highlights: [] },
  ] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "pricing", domains: ["example.com"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, result.url);
  assert.equal(hits[0]!.text.length, 2500);
});

test("publication filters exclude undated, too old and future results", async () => {
  const { http } = httpMock([json({ results: [
    result,
    { ...result, url: "https://example.com/old", publishedDate: "2026-10-01" },
    { ...result, url: "https://example.com/future", publishedDate: "2026-12-01" },
    { ...result, url: "https://example.com/ok", publishedDate: "2026-11-04" },
  ] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "release", publishedAfter: "2026-11-03", asOf: new Date("2026-11-05T10:00Z") });
  assert.deepEqual(hits.map(h => h.url), ["https://example.com/ok"]);
});

test("partial content failures and empty passages cannot become evidence", async () => {
  const { http } = httpMock([json({ results: [result, { ...result, url: "https://example.com/ok" }], statuses: [{ id: result.url, status: "error" }] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "pricing", urls: [result.url, "https://example.com/ok"] });
  assert.deepEqual(hits.map(h => h.url), ["https://example.com/ok"]);
});

test("transient errors retry once; auth errors and long Retry-After do not retry", async () => {
  const retry = httpMock([json({}, 429, { "retry-after": "0" }), json({ results: [result] })]);
  assert.equal((await createExaSearch("key", { spendPolicy: null, fetch: retry.http }).search({ query: "q" })).length, 1);
  assert.equal(retry.requests.length, 2);
  for (const response of [json({ error: "secret" }, 401), json({}, 429, { "retry-after": "60" })]) {
    const { http, requests } = httpMock([response]);
    await assert.rejects(createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "q" }), error => error instanceof Error && !error.message.includes("secret"));
    assert.equal(requests.length, 1);
  }
});

test("bad payloads and ignored restrictions fail explicitly", async () => {
  for (const payload of [{}, null, { results: [], notices: [{ code: "RESTRICTIONS_RELAXED" }] }]) {
    const { http } = httpMock([json(payload)]);
    await assert.rejects(createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "q" }));
  }
});

test("the provider deadline aborts HTTP work", async () => {
  const http = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;

  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(createExaSearch("key", { spendPolicy: null, fetch: http, timeoutMs: 10 }).search({ query: "q" }), { name: "TimeoutError" }); }
  finally { clearTimeout(keepAlive); }
});

test("query validation rejects malformed dates, source addresses and domain filters", () => {
  for (const input of [
    { query: "" }, { query: "x", publishedAfter: "2026-02-30" },
    { query: "x", urls: ["http://localhost/x"] }, { query: "x", urls: ["http://2130706433/x"] },
    { query: "x", urls: ["https://user:password@example.com"] },
    { query: "x", domains: ["https://example.com"] },
  ]) assert.throws(() => normalizeQuery(input));
});

test("cache keys preserve exact snapshot instants and canonicalize domain order", async () => {
  let calls = 0;
  const cached = withCache({ search: async () => { calls++; return [hit()]; } });
  const base = { query: "q", domains: ["b.com", "a.com"], asOf: new Date("2026-11-03T09:00Z") };
  await cached.search(base);
  const copy = await cached.search({ ...base, domains: ["a.com", "b.com"] });
  copy[0]!.text = "mutated";
  assert.equal((await cached.search(base))[0]!.text, hit().text);
  await cached.search({ ...base, asOf: new Date("2026-11-03T10:00Z") });
  assert.equal(calls, 2);
});

test("fresh requests bypass completed cache and LRU evicts old entries", async () => {
  let calls = 0;
  const cached = withCache({ search: async () => { calls++; return [hit()]; } }, 300_000, 1);
  await cached.search({ query: "a" });
  await cached.search({ query: "b" });
  await cached.search({ query: "a" });
  await cached.search({ query: "a", freshness: "fresh" });
  await cached.search({ query: "a", freshness: "fresh" });
  assert.equal(calls, 5);
});

test("cache expiration starts at completion and failures are not cached", async () => {
  let calls = 0;
  const cached = withCache({ search: async () => { if (++calls === 1) throw new Error("temporary"); return [hit()]; } }, 0);
  await assert.rejects(cached.search({ query: "q" }));
  await cached.search({ query: "q" });
  await cached.search({ query: "q" });
  assert.equal(calls, 3);
});

test("cancelling the first subscriber does not cancel a shared search", async () => {
  let resolve!: (hits: SearchHit[]) => void;
  let providerSignal: AbortSignal | undefined;
  let calls = 0;
  const cached = withCache({ search: async (_q, signal) => { calls++; providerSignal = signal; return new Promise(r => { resolve = r; }); } });
  const first = new AbortController();
  const a = cached.search({ query: "q" }, first.signal);
  const rejected = assert.rejects(a, { name: "AbortError" });
  const b = cached.search({ query: "q" });
  await Promise.resolve();
  first.abort();
  await rejected;
  assert.equal(providerSignal!.aborted, false);
  resolve([hit()]);
  assert.deepEqual(await b, [hit()]);
  assert.equal(calls, 1);
});

test("when all subscribers cancel, the underlying search is cancelled", async () => {
  let observed: AbortSignal | undefined;
  const cached = withCache({ search: async (_q, signal) => { observed = signal; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); } });
  const controller = new AbortController();
  const pending = cached.search({ query: "q" }, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await Promise.resolve();
  controller.abort();
  await rejected;
  assert.equal(observed!.aborted, true);
});

test("process backpressure bounds active requests and skips cancelled waiters", async () => {
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const provider: SearchProvider = { search: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(r => release.push(r)); active--; return [hit()];
  } };
  const limited = withConcurrency(provider, 1, 1);
  const a = limited.search({ query: "a" });
  const abort = new AbortController();
  const b = limited.search({ query: "b" }, abort.signal);
  await assert.rejects(limited.search({ query: "overflow" }), /busy/);
  const rejected = assert.rejects(b, { name: "AbortError" });
  abort.abort(); await rejected;
  release.shift()!(); await a;
  const c = limited.search({ query: "c" });
  release.shift()!(); await c;
  assert.equal(peak, 1);
});

test("an advertised publication upper bound is enforced even without snapshot mode", async () => {
  const { http } = httpMock([json({ results: [
    { ...result, publishedDate: "2026-01-01" }, { ...result, url: "https://example.com/eligible", publishedDate: "2020-01-01" },
  ] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "history", publishedBefore: "2020-12-31" });
  assert.deepEqual(hits.map(hit => hit.url), ["https://example.com/eligible"]);
});

test("lite requests omit live fetching and unsupported combinations fail before HTTP", async () => {
  const { http, requests } = httpMock([json({ results: [result] })]);
  const provider = createExaSearch("key", { spendPolicy: null, fetch: http });
  await provider.search({ query: "stable fact", mode: "lite" });
  assert.equal(requests[0]!.body.type, "lite"); assert.equal(requests[0]!.body.contents.maxAgeHours, undefined);
  for (const query of [
    { query: "q", mode: "lite" as const, freshness: "fresh" as const },
    { query: "q", mode: "lite" as const, profile: "verification" as const },
    { query: "q", content: "full" as const },
    { query: "q", content: "full" as const, urls: ["https://example.com/a", "https://example.com/b", "https://example.com/c"] },
  ]) await assert.rejects(provider.search(query));
  assert.equal(requests.length, 1);
});

test("selected full-text reads recover omitted table rows within a strict content bound", async () => {
  const table = "Year | Winner\n" + "An old table row\n".repeat(190) + "2026 | Decisive last row";
  const { http, requests } = httpMock([json({ results: [{ ...result, text: table, highlights: ["An introductory excerpt"] }] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "complete winners table", urls: [result.url], content: "full", profile: "complete-list" });
  assert.equal(requests[0]!.body.text.maxCharacters, 12_000); assert.equal(requests[0]!.body.highlights, undefined);
  assert.match(hits[0]!.text, /Decisive last row/); assert.ok(hits[0]!.text.length <= 12_000);
});

test("freshness distinguishes application acquisition, provider fetch status and unknown age", async () => {
  const { http } = httpMock([json({ costDollars: { total: 0.012 }, statuses: [{ id: result.url, status: "success", source: "cached" }], results: [result] })]);
  const hits = await createExaSearch("key", { spendPolicy: null, fetch: http }).search({ query: "current value", freshness: "fresh", profile: "verification" });
  assert.equal(hits[0]!.freshness!.requested, "fresh"); assert.equal(hits[0]!.freshness!.acquisition, "cached"); assert.equal(hits[0]!.freshness!.ageStatus, "unknown");
  assert.equal(hits[0]!.freshness!.contentFetchedAt, undefined); assert.ok(hits[0]!.retrievedAt); assert.equal(hits[0]!.retrieval!.providerCostDollars, 0.012);
});

test("retrieval controls participate in cache identity", async () => {
  let calls = 0; const cached = withCache({ search: async () => { calls++; return [hit()]; } });
  await cached.search({ query: "q", profile: "fact", locale: "US" });
  await cached.search({ query: "q", profile: "comparison", locale: "US" });
  await cached.search({ query: "q", profile: "comparison", locale: "IN" });
  await cached.search({ query: "q", profile: "comparison", locale: "IN", policyVersion: "test-v2" });
  await cached.search({ query: "q", profile: "comparison", locale: "IN", policyVersion: "test-v2" });
  assert.equal(calls, 4);
});
