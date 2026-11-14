import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { captureArchive } from "../src/temporal/archive.ts";
import { TemporalStore } from "../src/temporal/store.ts";

const original = "https://league.example.com/champions";
const stamp = "20240722114606";
const captured = "2024-07-22T11:46:06.000Z";
const cutoff = new Date("2024-11-14T06:22:08.161Z");
const fields = ["timestamp", "original", "statuscode", "mimetype"];
const row = [stamp, original, "200", "text/html"];
const memento = "Mon, 22 Jul 2024 11:46:06 GMT";
const table = ["Year\tWinner", ...Array.from({ length: 17 }, (_, i) => `${2008 + i}\tClub ${2008 + i}`)].join("\n");
const html = `<html><head><title>League 2024 edition</title></head><body><aside>EXCLUDED_SIDEBAR</aside><article id="records"><h1>Past champions</h1><p>Original edition.</p><table><tr><th>Year</th><th>Winner</th></tr>${Array.from({ length: 17 }, (_, i) => `<tr><td>${2008 + i}</td><td>Club ${2008 + i}</td></tr>`).join("")}</table><script>fetch("https://evil.example.com/FUTURE_SCRIPT");</script><style>FUTURE_STYLE</style><img src="https://evil.example.com/image"></article></body></html>`;

function transport(options: { listing?: unknown; replay?: () => Response; html?: string } = {}) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.origin, "https://web.archive.org", "only the archive host may receive network requests");
    if (url.pathname === "/cdx/search/cdx") return Response.json(options.listing ?? [fields, row]);
    return options.replay?.() ?? new Response(options.html ?? html, { headers: { "content-type": "text/html; charset=utf-8", "memento-datetime": memento } });
  };
  return { calls, http };
}

test("captures exact pre-cutoff edition and complete selected tables without scripts or external resources", async () => {
  const network = transport();
  const result = await captureArchive({ url: `${original}?utm_source=ignored#fragment`, asOf: cutoff, selector: "#records" }, { fetch: network.http });
  assert.equal(network.calls.length, 2);
  const query = network.calls[0]!.url.searchParams;
  assert.equal(query.get("url"), original);
  assert.equal(query.get("matchType"), "exact");
  assert.equal(query.get("limit"), "-1");
  assert.equal(query.get("to"), "20241114062208");
  assert.deepEqual(query.getAll("filter"), ["statuscode:200", "mimetype:text/html"]);
  assert.equal(network.calls[1]!.init!.redirect, "manual");
  assert.equal(result.document.availableAt, captured);
  assert.equal(result.document.capturedAt, captured);
  assert.equal(result.document.sourceId, original);
  assert.equal(result.document.reviewed, false);
  assert.equal(result.document.provenanceKind, "archive");
  assert.equal(result.document.provenanceUrl, result.captureUrl);
  assert.equal(result.captureUrl, `https://web.archive.org/web/${stamp}id_/${original}`);
  assert.deepEqual(result.tables, [table]);
  assert.ok(result.document.text.includes(table));
  assert.match(result.document.text, /Original edition\./);
  assert.doesNotMatch(result.document.text, /EXCLUDED|FUTURE_SCRIPT|FUTURE_STYLE/);
  assert.equal(result.rawHash, createHash("sha256").update(html).digest("hex"));
});

test("table transcriptions preserve empty cells and line breaks inside cells", async () => {
  const network = transport({ html: "<title>Records</title><main><table><tr><th></th><th>Winner</th><th></th></tr><tr><td>2024</td><td>Club<br>Alpha</td><td></td></tr></table></main>" });
  const result = await captureArchive({ url: original, asOf: cutoff, selector: "main" }, { fetch: network.http });
  assert.deepEqual(result.tables, ["\tWinner\t\n2024\tClub Alpha\t"]);
  assert.ok(result.document.text.includes(result.tables![0]!));
});

test("rejects missing, malformed, post-cutoff, and wrong-source CDX metadata before replay", async () => {
  for (const listing of [
    [], [fields], { results: [row] }, [["original", "timestamp", "statuscode", "mimetype"], row],
    [fields, ["20250101000000", original, "200", "text/html"]],
    [fields, ["20240230000000", original, "200", "text/html"]],
    [fields, [stamp, "https://other.example.com/champions", "200", "text/html"]],
    [fields, [stamp, "http://localhost/private", "200", "text/html"]],
    [fields, [stamp, original, "404", "text/html"]],
    [fields, [stamp, original, "200", "application/json"]],
    [fields, row, row],
  ]) {
    const network = transport({ listing });
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: network.http }), /Archive|historical capture/);
    assert.equal(network.calls.length, 1);
  }
});

test("redirects cannot substitute a later capture, live page, other source, or archive presentation", async () => {
  for (const location of [
    `https://web.archive.org/web/20250101000000id_/${original}`,
    original,
    `https://web.archive.org/web/${stamp}id_/https://other.example.com/page`,
    `https://web.archive.org/web/${stamp}/${original}`,
    `https://evil.example.com/web/${stamp}id_/${original}`,
  ]) {
    const network = transport({ replay: () => new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: network.http }), /redirect changed/);
    assert.equal(network.calls.length, 2);
  }
});

test("same raw source and capture redirects are bounded and can complete", async () => {
  let attempts = 0;
  const network = transport({ replay: () => ++attempts === 1
    ? new Response(null, { status: 302, headers: { location: `https://web.archive.org/web/${stamp}id_/${original}` } })
    : new Response(html, { headers: { "content-type": "text/html", "memento-datetime": memento } }) });
  assert.equal((await captureArchive({ url: original, asOf: cutoff, selector: "#records" }, { fetch: network.http })).document.availableAt, captured);
  assert.equal(network.calls.length, 3);
  const endless = transport({ replay: () => new Response(null, { status: 302, headers: { location: `https://web.archive.org/web/${stamp}id_/${original}` } }) });
  await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: endless.http }), /redirect limit/);
  assert.equal(endless.calls.length, 5);
});

test("requires replay Memento-Datetime to confirm exactly the CDX capture instant", async () => {
  for (const value of [undefined, "Wed, 01 Jan 2025 00:00:00 GMT", "2024-07-22T11:46:06.000Z", "invalid"]) {
    const network = transport({ replay: () => new Response(html, { headers: { "content-type": "text/html", ...(value ? { "memento-datetime": value } : {}) } }) });
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: network.http }), /confirm the selected capture time/);
  }
});

test("rejects hidden auto-redirects, non-HTML bodies, and absent selected content", async () => {
  const redirected = transport({ replay: () => {
    const response = new Response(html, { headers: { "content-type": "text/html", "memento-datetime": memento } });
    Object.defineProperty(response, "url", { value: original });
    return response;
  } });
  await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: redirected.http }), /unverified redirect/);
  const notHtml = transport({ replay: () => new Response("PDF", { headers: { "content-type": "application/pdf" } }) });
  await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: notHtml.http }), /did not return HTML/);
  for (const selector of [".does-not-exist", "[invalid"]) {
    const network = transport();
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector }, { fetch: network.http }), /selected content|Invalid archive CSS selector/);
  }
});

test("response sizes are bounded with and without Content-Length", async () => {
  for (const headers of [{ "content-length": "2000" }, {}] as Array<Record<string, string>>) {
    const network = transport({ replay: () => new Response("x".repeat(2000), { headers: { ...headers, "content-type": "text/html", "memento-datetime": memento } }) });
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: network.http, maxBytes: 512 }), /size limit/);
  }
});

test("matching archive metadata cannot turn challenge or partial-response pages into evidence", async () => {
  for (const content of [
    "<title>Just a moment...</title><body>Verify you are human</body>",
    "<title>Original article</title><body><form id='challenge-form'>Continue</form></body>",
    "<title>Original article</title><body>Enable JavaScript and cookies to continue</body>",
  ]) {
    const network = transport({ html: content });
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: network.http }), /challenge or access page/);
  }
  const partial = transport({ replay: () => new Response(html, { status: 206, headers: { "content-type": "text/html", "memento-datetime": memento } }) });
  await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { fetch: partial.http }), /replay responded 206/);
});

test("deadline and caller cancellation apply even if the HTTP implementation ignores signals", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body" }, { timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) }), { name: "TimeoutError" });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(captureArchive({ url: original, asOf: cutoff, selector: "body", signal: abort.signal }, { fetch: async () => assert.fail("aborted request reached HTTP") }), { name: "AbortError" });
    const pendingAbort = new AbortController();
    const pending = captureArchive({ url: original, asOf: cutoff, selector: "body", signal: pendingAbort.signal }, { fetch: async () => new Promise<Response>(() => {}) });
    pendingAbort.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { clearInterval(keepAlive); }
});

test("archive candidates remain unreviewed and cannot silently enter historical answers", async () => {
  const network = transport();
  const result = await captureArchive({ url: original, asOf: cutoff, selector: "#records" }, { fetch: network.http });
  const store = new TemporalStore(":memory:");
  try {
    store.importDocument(result.document);
    assert.equal(store.coverage(cutoff).reviewedDocuments, 0);
    assert.equal(store.search({ query: "champions", asOf: cutoff }).length, 0);
  } finally { store.close(); }
});

test("CLI writes a new private review manifest without keys or database writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "asof-archive-capture-"));
  try {
    const mock = join(directory, "http.mjs");
    const out = join(directory, "candidate.json");
    writeFileSync(mock, `globalThis.fetch = async input => String(input).includes("/cdx/search/cdx") ? Response.json(${JSON.stringify([fields, row])}) : new Response(${JSON.stringify(html)}, {headers: {"content-type":"text/html", "memento-datetime":${JSON.stringify(memento)}}});`);
    const args = ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--import", pathToFileURL(mock).href,
      "scripts/capture-archive.ts", original, "--as-of", cutoff.toISOString(), "--selector", "#records", "--out", out];
    const result = JSON.parse(execFileSync(process.execPath, args, { cwd: resolve("."), encoding: "utf8" }));
    assert.equal(result.reviewed, false);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(saved.documents[0].reviewed, false);
    assert.equal(saved.documents[0].availableAt, captured);
    assert.equal(saved.archiveEvidence.captureUrl, result.captureUrl);
    assert.match(saved.archiveEvidence.rawHash, /^[a-f0-9]{64}$/);
    assert.throws(() => execFileSync(process.execPath, args, { cwd: resolve("."), stdio: "pipe" }), /EEXIST/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
