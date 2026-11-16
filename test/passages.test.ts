import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { selectPassages } from "../src/search/passages.ts";
import { EvidenceWindow } from "../src/agent/evidence.ts";
import { createExaSearch } from "../src/search/exa.ts";

const definition = "The 404 (Not Found) status code indicates that the origin server did not find a current representation for the target resource or is not willing to disclose that one exists. A 404 status code does not indicate whether this lack is temporary or permanent.";
const document = "# Contents\n\n404 Not Found\n\n" + "Unrelated routing and connection information.\n\n".repeat(7400) + "#### 15.5.5. 404 Not Found\n\n" + definition + "\n\nA 404 response is heuristically cacheable unless explicit cache controls say otherwise.\n\n#### 15.5.6. 405 Method Not Allowed\n\nAnother status definition.\n\n" + "Trailing information.\n\n".repeat(1000);

test("query-focused bounded reads recover a definition after 300k characters with qualifications intact", () => {
  assert.ok(document.indexOf(definition) > 300_000);
  const selected = selectPassages(document, "What does HTTP status code 404 mean?");
  assert.ok(selected.text.length <= 12_000);
  assert.equal(selected.selection, "query-passages");
  assert.ok(selected.text.includes(definition));
  assert.match(selected.text, /#### 15\.5\.5\. 404 Not Found/);
  assert.match(selected.text, /unless explicit cache controls/);
  assert.match(selected.text, /omitted source paragraphs/);
  assert.ok(selected.omittedCharacters > 300_000);
});

test("nonadjacent excerpts mark gaps and retain paragraphs containing negation", () => {
  const first = "Acme pricing is $20 per seat. This does not apply to annual subscriptions.";
  const second = "Acme availability is US only. It is not available in Europe.";
  const selected = selectPassages(first + "\n\n" + "Unrelated section.\n\n".repeat(900) + second, "Acme pricing availability", 1800);
  assert.ok(selected.text.includes(first)); assert.ok(selected.text.includes(second));
  assert.match(selected.text, /omitted source paragraphs/);
  assert.ok(selected.text.length <= 1800);
});

test("no matching terms yields a labeled bounded prefix and never cuts an oversized paragraph", () => {
  const selected = selectPassages("Opening paragraph.\n\n" + "Nothing related here.\n\n".repeat(1000), "quantum entanglement", 200);
  assert.equal(selected.selection, "document-prefix"); assert.match(selected.text, /^Opening paragraph/);
  assert.ok(selected.text.length <= 200); assert.ok(selected.omittedCharacters > 0);
  assert.equal(selectPassages("Pricing is available " + "x".repeat(2000) + " but not to consumers.", "pricing", 200).text, "");
});

test("short documents remain complete and unchanged", () => {
  const text = "All prices exclude tax.\n\nBilling is annual only.";
  assert.deepEqual(selectPassages(text, "prices"), { text, selection: "complete-received-text", receivedCharacters: text.length, omittedCharacters: 0 });
});

test("Exa requests larger bounded full content, hashes selected passages, and records incomplete acquisition", async () => {
  let request: Record<string, any> = {};
  const provider = createExaSearch("test", { spendPolicy: null, fetch: (async (_url, options) => {
    request = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ results: [{ url: "https://example.com/standard", title: "Standard", text: document }],
      statuses: [{ id: "https://example.com/standard", status: "success", source: "live" }] }));
  }) as typeof fetch });
  const [hit] = await provider.search({ query: "What does HTTP status code 404 mean?", urls: ["https://example.com/standard"], content: "full", freshness: "fresh" });
  assert.equal(request.text.maxCharacters, 400_000); assert.equal(request.maxAgeHours, 0);
  assert.ok(hit); assert.ok(hit.text.includes(definition)); assert.ok(hit.text.length <= 12_000);
  assert.equal(hit.contentHash, createHash("sha256").update(hit.text).digest("hex"));
  assert.equal(hit.retrieval?.passageSelection?.acquisitionMayBeTruncated, true);
  assert.equal(hit.retrieval?.passageSelection?.requestedCharacters, 400_000);
  const rendered = new EvidenceWindow().render({ query: "404", content: "full", urls: [hit.url] }, [hit], () => 1);
  assert.match(rendered, /bounded source acquisition \(may omit the document tail\)/);
  assert.match(rendered, /not proof of complete document coverage/);
});


test("a provider-capped last paragraph is discarded rather than presented without its missing qualification", () => {
  const text = "Opening complete paragraph.\n\nAcme pricing is $20 but";
  const selected = selectPassages(text, "Acme pricing", 12000, { discardTrailingParagraph: true });
  assert.equal(selected.text, "Opening complete paragraph.");
  assert.equal(selected.omittedCharacters, text.length - selected.text.length);
  assert.doesNotMatch(selected.text, /Acme/);
});


test("many tiny matching paragraphs have bounded selection work and output", () => {
  const began = performance.now();
  const selected = selectPassages("404\n\n".repeat(80_000), "404");
  assert.ok(selected.text.length <= 12_000);
  assert.ok(performance.now() - began < 2000, "bounded input must not block the event loop for seconds");
});
