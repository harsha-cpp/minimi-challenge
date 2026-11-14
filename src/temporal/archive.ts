import { createHash } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { canonicalUrl } from "../search/validate.ts";
import { parseInstant } from "../time/instant.ts";
import type { TemporalDocumentInput } from "./types.ts";

const ARCHIVE = "https://web.archive.org";
const MAX_BYTES = 8 * 1024 * 1024;
const FIELDS = ["timestamp", "original", "statuscode", "mimetype"];

export interface ArchiveCaptureInput {
  url: string;
  asOf: Date;
  selector: string;
  title?: string;
  signal?: AbortSignal;
}

export interface ArchiveCaptureOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ArchiveCaptureResult {
  document: TemporalDocumentInput;
  captureUrl: string;
  /** SHA-256 of the archive replay's response body, not proof of archive authenticity. */
  rawHash: string;
  /** Complete selected table transcriptions, preserving cells/rows without generated summaries. */
  tables?: string[];
}

/** Capture a preserved page for explicit review. This never fetches a live source or approves it. */
export async function captureArchive(input: ArchiveCaptureInput, options: ArchiveCaptureOptions = {}): Promise<ArchiveCaptureResult> {
  const started = performance.now();
  if (typeof input.url !== "string" || !input.url.trim() || input.url.length > 2048) throw new Error("Archive source URL must contain 1 to 2048 characters.");
  const original = canonicalUrl(input.url);
  if (original.length > 2048) throw new Error("Canonical archive source URL exceeds 2048 characters.");
  if (!(input.asOf instanceof Date) || !Number.isFinite(input.asOf.getTime())) throw new Error("A real historical cutoff is required.");
  if (typeof input.selector !== "string" || !input.selector.trim() || input.selector.length > 1000) throw new Error("A nonempty CSS selector of at most 1000 characters is required.");
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 500)) throw new Error("Source title must contain 1 to 500 characters.");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Archive timeout must be 1 to 120000 milliseconds.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error("Archive body limit must be 1 to 8388608 bytes.");
  input.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const http = options.fetch ?? fetch;
  const cdxUrl = new URL("/cdx/search/cdx", ARCHIVE);
  cdxUrl.searchParams.set("url", original);
  cdxUrl.searchParams.set("matchType", "exact");
  cdxUrl.searchParams.set("to", input.asOf.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14));
  cdxUrl.searchParams.set("output", "json");
  cdxUrl.searchParams.append("filter", "statuscode:200");
  cdxUrl.searchParams.append("filter", "mimetype:text/html");
  cdxUrl.searchParams.set("fl", FIELDS.join(","));
  cdxUrl.searchParams.set("limit", "-1");

  const index = await request(http, cdxUrl.href, signal);
  if (!index.ok) { await index.body?.cancel(); throw new Error(`Archive index responded ${index.status}.`); }
  if (index.redirected || (index.url && !sameIndex(index.url))) { await index.body?.cancel(); throw new Error("Archive index changed its endpoint."); }
  const indexBytes = await body(index, Math.min(maxBytes, 1024 * 1024), signal);
  let listing: unknown;
  try { listing = JSON.parse(new TextDecoder().decode(indexBytes)); }
  catch { throw new Error("Archive index returned invalid JSON."); }
  if (!Array.isArray(listing) || listing.length === 0 || listing.length === 1) throw new Error("No eligible historical capture exists at or before this date.");
  if (listing.length !== 2 || !Array.isArray(listing[0]) || JSON.stringify(listing[0]) !== JSON.stringify(FIELDS)
    || !Array.isArray(listing[1]) || listing[1].length !== FIELDS.length || listing[1].some(value => typeof value !== "string")) {
    throw new Error("Archive index returned an invalid capture record.");
  }
  const [stamp, capturedOriginal, status, mime] = listing[1] as string[];
  const captured = captureInstant(stamp!);
  let capturedUrl: string;
  try { capturedUrl = canonicalUrl(capturedOriginal!); } catch { throw new Error("Archive index returned an invalid source URL."); }
  if (!captured || captured.getTime() > input.asOf.getTime() || capturedUrl !== original || status !== "200" || mime !== "text/html") {
    throw new Error("Archive capture does not match the requested source and historical cutoff.");
  }
  let captureUrl = `${ARCHIVE}/web/${stamp}id_/${capturedOriginal}`;
  let replay: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!sameReplay(captureUrl, stamp!, original)) throw new Error("Archive redirect changed the source or capture time.");
    const response = await request(http, captureUrl, signal);
    if (response.redirected || (response.url && !sameReplay(response.url, stamp!, original))) {
      await response.body?.cancel(); throw new Error("Archive replay followed an unverified redirect.");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error("Archive replay exceeded its redirect limit.");
      const next = new URL(location, captureUrl).href;
      if (!sameReplay(next, stamp!, original)) throw new Error("Archive redirect changed the source or capture time.");
      captureUrl = next;
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Archive replay responded ${response.status}.`); }
    const contentType = response.headers.get("content-type") ?? "text/html";
    if (!/^text\/html(?:\s*;|$)/i.test(contentType)) { await response.body?.cancel(); throw new Error("Archive replay did not return HTML."); }
    const memento = response.headers.get("memento-datetime");
    if (!memento || !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(memento)
      || Date.parse(memento) !== captured.getTime()) {
      await response.body?.cancel(); throw new Error("Archive replay did not confirm the selected capture time.");
    }
    replay = response;
    break;
  }
  if (!replay) throw new Error("Archive replay did not complete.");
  const bytes = await body(replay, maxBytes, signal);
  const rawHash = createHash("sha256").update(bytes).digest("hex");
  // Default JSDOM behavior does not run scripts or load external resources.
  const dom = new JSDOM(Buffer.from(bytes), { url: original, contentType: replay.headers.get("content-type") ?? "text/html", virtualConsole: new VirtualConsole() });
  try {
    for (const node of dom.window.document.querySelectorAll("script,style,template,noscript")) node.remove();
    let selected: Element[];
    try { selected = [...dom.window.document.querySelectorAll(input.selector)]; }
    catch { throw new Error("Invalid archive CSS selector."); }
    if (!selected.length) throw new Error("The archive capture does not contain the selected content.");
    const roots = selected.filter(node => !selected.some(other => other !== node && other.contains(node)));
    const text = roots.map(extract).filter(Boolean).join("\n\n");
    if (!text || text.length > 200_000) throw new Error("Selected archive text must contain 1 to 200000 characters; choose a narrower selector.");
    const pageTitle = dom.window.document.title.replace(/\s+/g, " ").trim();
    const challenge = /^(?:just a moment|attention required|access denied|robot check|security verification|checking your browser|wayback machine)\b/i.test(pageTitle)
      || Boolean(dom.window.document.querySelector("#challenge-form, #cf-challenge-running, [data-cf-chl-widget], form[action*='/cdn-cgi/challenge']"))
      || (text.length < 2000 && /verify (?:that )?you(?:'re| are) (?:a )?human|checking your browser before accessing|enable javascript and cookies to continue/i.test(text));
    if (challenge) throw new Error("Archive replay contains a challenge or access page, not usable source content.");
    const title = (input.title ?? pageTitle).replace(/\s+/g, " ").trim();
    if (!title || title.length > 500) throw new Error("Supply a source title containing 1 to 500 characters.");
    signal.throwIfAborted();
    // Parsing is synchronous: an expired timer may not have run while JSDOM occupied the event loop.
    if (performance.now() - started >= timeoutMs) throw new DOMException("Archive capture exceeded its deadline.", "TimeoutError");
    const tables = roots.flatMap(root => (root.tagName === "TABLE" ? [root] : [...root.querySelectorAll("table")]
      .filter(table => { const outer = table.parentElement?.closest("table"); return !outer || !root.contains(outer); }))).map(tableText).filter(table => Boolean(table) && text.includes(table));
    return { captureUrl, rawHash, ...(tables.length ? { tables } : {}), document: {
      sourceId: original, url: original, title, text,
      availableAt: captured.toISOString(), capturedAt: captured.toISOString(),
      provenanceKind: "archive", provenanceUrl: captureUrl, reviewed: false,
    } };
  } finally { dom.window.close(); }
}

function captureInstant(stamp: string): Date | null {
  if (!/^\d{14}$/.test(stamp)) return null;
  return parseInstant(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`);
}

function sameIndex(value: string): boolean {
  try { const url = new URL(value); return url.origin === ARCHIVE && url.pathname === "/cdx/search/cdx" && !url.username && !url.password && !url.port; }
  catch { return false; }
}

function sameReplay(value: string, stamp: string, original: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== ARCHIVE || url.username || url.password || url.port || url.hash) return false;
    const match = /^\/web\/(\d{14})id_\/(https?:\/\/.+)$/.exec(url.pathname + url.search);
    return Boolean(match && match[1] === stamp && canonicalUrl(match[2]!) === original);
  } catch { return false; }
}

async function request(http: typeof fetch, url: string, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return abortable(http(url, { redirect: "manual", signal, headers: { accept: "application/json, text/html;q=0.9" } }), signal);
}

async function body(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) { await response.body?.cancel(); throw new Error("Archive response exceeded the size limit."); }
  if (!response.body) throw new Error("Archive response contained no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Archive response exceeded the size limit.");
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; }
  return result;
}

function extract(source: Element): string {
  const node = source.cloneNode(true) as Element;
  const tables = node.tagName === "TABLE" ? [node] : [...node.querySelectorAll("table")].filter(table => !table.parentElement?.closest("table"));
  if (node.tagName === "TABLE") return tableText(node);
  for (const table of tables) table.replaceWith(node.ownerDocument.createTextNode(`\n${tableText(table)}\n`));
  for (const br of node.querySelectorAll("br")) br.replaceWith(node.ownerDocument.createTextNode("\n"));
  for (const block of node.querySelectorAll("p,div,section,article,li,h1,h2,h3,h4,h5,h6,header,footer,aside,main,dl,dt,dd,pre,blockquote")) block.append("\n");
  return (node.textContent ?? "").split(/\r?\n/).map(line => line.replace(/[^\S\t\n]+/g, " ").replace(/^ +| +$/g, "")).filter(line => Boolean(line.trim())).join("\n");
}

function tableText(table: Element): string {
  return [...table.querySelectorAll("tr")].filter(row => row.closest("table") === table).map(row =>
    [...row.children].filter(cell => ["TD", "TH"].includes(cell.tagName)).map(cell => {
      const clone = cell.cloneNode(true) as Element;
      for (const br of clone.querySelectorAll("br")) br.replaceWith(clone.ownerDocument.createTextNode(" "));
      for (const block of clone.querySelectorAll("div,p,li")) block.append(" ");
      return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    }).join("\t"),
  ).filter(Boolean).join("\n");
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
