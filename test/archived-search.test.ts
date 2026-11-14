import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchHit, SearchProvider, SearchQuery } from "../src/search.ts";
import type { ArchiveCaptureResult } from "../src/temporal/archive.ts";
import { archivePassages, withArchivedSearch } from "../src/temporal/archived-search.ts";

const cutoff = new Date("2024-11-14T12:00:00.000Z");
const original = "https://sports.example.com/champions";
const denied = new Error("Exa responded 403.");
const captureTime = "2024-07-22T11:46:06.000Z";
const captureUrl = (url = original, at = captureTime) => `https://web.archive.org/web/${at.replace(/[-:TZ.]/g, "").slice(0, 14)}id_/${url}`;
const frozen = (url = original): ArchiveCaptureResult => ({
  rawHash: "a".repeat(64), captureUrl: captureUrl(url),
  document: { sourceId: "preserved-article", url, title: "Preserved champions list", text: "The champions were Atlas in 2024.",
    availableAt: captureTime, capturedAt: captureTime, publishedAt: "2024-05-27T05:10:19.000Z",
    provenanceKind: "archive", provenanceUrl: captureUrl(url), reviewed: false },
});
const live = (url = original): SearchHit => ({ url, title: "LIVE FUTURE TITLE", text: "LIVE FUTURE FACT: Atlas wins in 2026.", publishedDate: "2026-11-14" });
const provider = (discover: SearchHit[] = [live()]): SearchProvider => ({ search: async query => {
  if (query.asOf) throw denied;
  return discover;
} });

test("current searches preserve the exact provider request, signal and results", async () => {
  const query: SearchQuery = { query: " champions ", freshness: "fresh" };
  const controller = new AbortController();
  const results = [live()];
  const engine = withArchivedSearch({ search: async (input, signal) => {
    assert.equal(input, query); assert.equal(signal, controller.signal); return results;
  } }, { capture: async () => assert.fail("current search acquired an archive") });
  assert.equal(await engine.search(query, controller.signal), results);
});

test("eligible Exa Snapshots return without discovery or archive acquisition", async () => {
  const result = { ...live(), text: "Frozen Exa content", publishedDate: "2024-05-27", snapshotAsOf: cutoff.toISOString() };
  let requests = 0;
  const engine = withArchivedSearch({ search: async query => {
    assert.equal(query.asOf, cutoff); requests++; return [result];
  } }, { capture: async () => assert.fail("Snapshot success acquired an archive") });
  assert.deepEqual(await engine.search({ query: "champions", asOf: cutoff }), [result]);
  assert.equal(requests, 1);
});

test("Snapshot denial discovers URLs through Exa but discards every live evidence field", async () => {
  const calls: SearchQuery[] = [];
  const engine = withArchivedSearch({ search: async query => {
    calls.push(query);
    if (query.asOf) throw denied;
    return [live()];
  } }, { capture: async input => {
    assert.equal(input.url, original); assert.equal(input.asOf, cutoff); assert.equal(input.selector, "body");
    assert.equal(input.title, undefined); return frozen(input.url);
  } });
  const hits = await engine.search({ query: "champions", asOf: cutoff, domains: ["example.com"], publishedAfter: "2024-01-01" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.asOf, undefined);
  assert.equal(calls[1]!.publishedBefore, "2024-11-14");
  assert.equal(calls[1]!.publishedAfter, "2024-01-01");
  assert.deepEqual(calls[1]!.domains, ["example.com"]);
  assert.equal(calls[1]!.query, "champions sources published before 2024-11-14");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.text, frozen().document.text);
  assert.equal(hits[0]!.title, frozen().document.title);
  assert.equal(hits[0]!.publishedDate, "2024-05-27");
  assert.equal(hits[0]!.provider, "wayback");
  assert.equal(hits[0]!.snapshotAsOf, undefined); assert.equal(hits[0]!.temporal, undefined);
  assert.deepEqual(hits[0]!.archive, { provider: "wayback", capturedAt: captureTime, captureUrl: captureUrl(), originalUrl: original, rawHash: "a".repeat(64) });
  assert.doesNotMatch(JSON.stringify(hits), /LIVE FUTURE/);
});

test("known URLs skip discovery and domain restrictions are enforced before capture", async () => {
  const requests: SearchQuery[] = [], captured: string[] = [];
  const engine = withArchivedSearch({ search: async query => { requests.push(query); throw denied; } }, {
    capture: async ({ url }) => { captured.push(url); return frozen(url); },
  });
  const hits = await engine.search({ query: "champions", asOf: cutoff, domains: ["sports.example.com"],
    urls: [`${original}?utm_source=tracking#fragment`, "https://elsewhere.example.com/other"] });
  assert.equal(requests.length, 1);
  assert.deepEqual(captured, [original]); assert.equal(hits[0]!.url, original);
});

test("invalid, off-domain and duplicate discovery URLs never reach archive acquisition", async () => {
  const captured: string[] = [];
  const hits = await withArchivedSearch(provider([
    live("http://localhost/private"), live("https://other.example.net/page"), live(`${original}?utm_campaign=x`), live(original),
  ]), { capture: async ({ url }) => { captured.push(url); return frozen(url); } }).search({ query: "champions", asOf: cutoff, domains: ["example.com"] });
  assert.deepEqual(captured, [original]); assert.equal(hits.length, 1);
});

test("future captures, wrong original URLs and invalid preservation proofs retain the Snapshot error", async () => {
  const mutations: Array<(result: ArchiveCaptureResult) => void> = [
    result => { result.document.capturedAt = result.document.availableAt = "2025-01-01T00:00:00.000Z"; result.captureUrl = result.document.provenanceUrl = captureUrl(original, result.document.capturedAt); },
    result => { result.document.url = "https://sports.example.com/another"; },
    result => { result.captureUrl = result.document.provenanceUrl = original; },
    result => { result.captureUrl = result.document.provenanceUrl = captureUrl("https://sports.example.com/another"); },
    result => { result.document.availableAt = "2024-07-21T11:46:06.000Z"; },
    result => { result.rawHash = "unverified"; },
    result => { result.document.publishedAt = "2025-01-01T00:00:00.000Z"; },
    result => { result.document.provenanceKind = "primary-source"; },
  ];
  for (const mutate of mutations) {
    const engine = withArchivedSearch(provider(), { capture: async () => { const result = frozen(); mutate(result); return result; } });
    await assert.rejects(engine.search({ query: "champions", asOf: cutoff }), error => error === denied);
  }
});

test("non-Snapshot403 errors do not initiate archive discovery", async () => {
  for (const status of [401, 429, 500]) {
    const failure = new Error(`Exa responded ${status}.`);
    let requests = 0;
    const engine = withArchivedSearch({ search: async () => { requests++; throw failure; } }, {
      capture: async () => assert.fail("unrelated provider failure acquired an archive"),
    });
    await assert.rejects(engine.search({ query: "champions", asOf: cutoff }), error => error === failure);
    assert.equal(requests, 1);
  }
});

test("missing or ineligible Snapshot results initiate acquisition without exposing live results", async () => {
  for (const snapshots of [[], [live()], [{ ...live(), snapshotAsOf: cutoff.toISOString() }]]) {
    let requests = 0;
    const engine = withArchivedSearch({ search: async query => { requests++; return query.asOf ? snapshots : [live()]; } }, { capture: async () => frozen() });
    const hits = await engine.search({ query: "champions", asOf: cutoff });
    assert.equal(requests, 2); assert.equal(hits[0]!.text, frozen().document.text);
  }
});

test("publication bounds use only dates in the frozen capture", async () => {
  for (const publishedAt of [undefined, "2023-05-27T05:10:19.000Z"]) {
    const engine = withArchivedSearch(provider([{ ...live(), publishedDate: "2024-05-27" }]), {
      capture: async () => { const result = frozen(); result.document.publishedAt = publishedAt; return result; },
    });
    await assert.rejects(engine.search({ query: "champions", asOf: cutoff, publishedAfter: "2024-01-01" }), error => error === denied);
  }
  const engine = withArchivedSearch(provider(), { capture: async () => frozen() });
  await assert.rejects(engine.search({ query: "champions", asOf: cutoff, publishedBefore: "2024-01-01" }), error => error === denied);
});

test("archive acquisition caps candidates at three and concurrent fetches at two", async () => {
  let active = 0, maximum = 0;
  const captured: string[] = [];
  const urls = Array.from({ length: 5 }, (_, i) => `${original}/${i}`);
  const hits = await withArchivedSearch(provider(urls.map(url => live(url))), { capture: async ({ url }) => {
    captured.push(url); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return frozen(url);
  } }).search({ query: "champions", asOf: cutoff });
  assert.deepEqual(captured, urls.slice(0, 3)); assert.equal(maximum, 2); assert.equal(hits.length, 3);
});

test("completed captures are cached only for the exact URL and cutoff", async () => {
  let acquisitions = 0;
  const engine = withArchivedSearch(provider(), { capture: async () => { acquisitions++; return frozen(); } });
  const input = { query: "champions", asOf: cutoff };
  const first = await engine.search(input);
  first[0]!.text = "mutation"; first[0]!.archive!.rawHash = "mutation";
  const second = await engine.search(input);
  assert.equal(acquisitions, 1); assert.equal(second[0]!.text, frozen().document.text); assert.equal(second[0]!.archive!.rawHash, "a".repeat(64));
  await engine.search({ ...input, asOf: new Date(cutoff.getTime() - 1) });
  assert.equal(acquisitions, 2);
});

test("cancellation is respected even if an injected capture ignores its signal", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const acquiring = new Promise<void>(resolve => { started = resolve; });
  const engine = withArchivedSearch(provider(), { capture: async input => {
    assert.equal(input.signal, controller.signal); started(); return new Promise(() => {});
  } });
  const pending = engine.search({ query: "champions", asOf: cutoff }, controller.signal);
  await acquiring;
  const reason = new Error("user canceled"); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const already = new AbortController(); already.abort(reason);
  const untouched = withArchivedSearch({ search: async () => assert.fail("aborted request reached Exa") });
  await assert.rejects(untouched.search({ query: "champions", asOf: cutoff }, already.signal), error => error === reason);
});

test("discovery failure or unavailable captures preserve the original Snapshot denial", async () => {
  const engine = withArchivedSearch({ search: async query => { throw query.asOf ? denied : new Error("discovery offline"); } });
  await assert.rejects(engine.search({ query: "champions", asOf: cutoff }), error => error === denied);
  await assert.rejects(withArchivedSearch(provider(), { capture: async () => { throw new Error("archive unavailable"); } })
    .search({ query: "champions", asOf: cutoff }), error => error === denied);
});

test("complete tables survive a long page and plural query terms without outcome special cases", async () => {
  const rows = Array.from({ length: 17 }, (_, i) => `${2008 + i}\tClub ${String.fromCharCode(65 + i)}`);
  const table = `Year\tWinner\n${rows.join("\n")}`;
  const text = "Navigation and unrelated content. ".repeat(1200) + "\nTournament\n" + table + "\nFooter";
  const passages = archivePassages(text, "IPL WINNERS LIST EACH YEAR", [table, "untrusted table outside preserved body"]);
  assert.deepEqual(passages, [table]);
  const engine = withArchivedSearch(provider(), { capture: async () => {
    const result = frozen(); result.document.text = text; result.tables = [table]; return result;
  } });
  const hits = await engine.search({ query: "IPL WINNERS LIST EACH YEAR", asOf: cutoff });
  assert.equal(hits[0]!.text, table);
  assert.equal(hits[0]!.text.match(/^20\d\d\t/gm)?.length, 17);
  for (const row of rows) assert.ok(hits[0]!.text.includes(row));
});

test("evidence passages are bounded exact source substrings", () => {
  const text = "prefix ".repeat(2000) + "Atlas champions score " + "suffix ".repeat(2000);
  const [passage] = archivePassages(text, "Atlas champions");
  assert.equal(passage!.length, 6000); assert.ok(text.includes(passage!)); assert.match(passage!, /Atlas champions/);
  const fakeTable = "Atlas champions fake text that never appeared";
  assert.notEqual(archivePassages(text, "Atlas champions", [fakeTable])[0], fakeTable);
});

test("long relevant tables preserve every row in contiguous row-boundary chunks", async () => {
  const rows = Array.from({ length: 90 }, (_, i) => `${1900 + i}\tWinner ${i} ${"source detail ".repeat(7)}`);
  const table = `Year\tWinner\n${rows.join("\n")}`;
  assert.ok(table.length > 6000 && table.length < 20_000);
  const passages = archivePassages(`Article\n${table}\nFooter`, "winners each year", [table]);
  assert.ok(passages.length > 1 && passages.length <= 5);
  assert.equal(passages.join(""), table);
  for (const [i, chunk] of passages.entries()) {
    assert.ok(chunk.length <= 6000); assert.ok(table.includes(chunk));
    if (i < passages.length - 1) assert.ok(chunk.endsWith("\n"));
    for (const line of chunk.replace(/\n$/, "").split("\n")) assert.ok(line === "Year\tWinner" || rows.includes(line));
  }
  const engine = withArchivedSearch(provider(), { capture: async () => {
    const result = frozen(); result.document.text = table; result.tables = [table]; return result;
  } });
  const hits = await engine.search({ query: "winners each year", asOf: cutoff });
  assert.equal(hits.map(hit => hit.text).join(""), table);
  assert.ok(hits.at(-1)!.text.includes(rows.at(-1)!));
});

test("oversized tables and indivisible rows reject the candidate without a partial body fallback", async () => {
  const oversized = `Year\tWinner\n${Array.from({ length: 210 }, (_, i) => `${1800 + i}\tWinner ${i} ${"detail ".repeat(15)}`).join("\n")}`;
  const wideRow = `Year\tWinner\n2000\tWinner ${"x".repeat(6000)}`;
  for (const table of [oversized, wideRow]) {
    assert.deepEqual(archivePassages(`Winner introduction\n${table}\nFooter`, "winners", [table]), []);
    const engine = withArchivedSearch(provider(), { capture: async () => {
      const result = frozen(); result.document.text = table; result.tables = [table]; return result;
    } });
    await assert.rejects(engine.search({ query: "winners", asOf: cutoff }), error => error === denied);
  }
});

test("candidate table groups are skipped atomically when the shared character budget is exhausted", async () => {
  const first = `Year\tWinner\n${Array.from({ length: 110 }, (_, i) => `${1800 + i}\tWinner ${i} ${"detail ".repeat(15)}`).join("\n")}`;
  const second = `Year\tWinner\n${Array.from({ length: 80 }, (_, i) => `${1950 + i}\tWinner ${i} ${"detail ".repeat(15)}`).join("\n")}`;
  assert.ok(first.length < 20_000 && second.length < 20_000 && first.length + second.length > 20_000);
  const urls = [original, `${original}/second`];
  const engine = withArchivedSearch(provider(urls.map(url => live(url))), { capture: async ({ url }) => {
    const result = frozen(url); const table = url === original ? first : second;
    result.document.text = table; result.tables = [table]; return result;
  } });
  const hits = await engine.search({ query: "winners", asOf: cutoff });
  assert.equal(hits.map(hit => hit.text).join(""), first);
  assert.ok(hits.every(hit => hit.url === original));
  assert.ok(hits.at(-1)!.text.includes("1909\tWinner 109"));
});
