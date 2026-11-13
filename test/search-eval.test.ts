import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRetrieval, type SearchCase } from "../eval/search-quality.ts";

const item: SearchCase = { id: "fixture", query: { query: "price", domains: ["example.com"], publishedAfter: "2026-01-01", asOf: new Date("2026-06-01T12:00Z") }, expectedDomains: ["example.com"], evidenceTerms: ["price", "storage"] };

test("evaluation distinguishes empty results from compliant evidence", () => {
  const empty = scoreRetrieval(item, []);
  assert.equal(empty.nonEmptyEvidence, false);
  assert.equal(empty.expectedSourceFound, false);
  assert.equal(empty.snapshotPolicyPresent, false);
  const evidence = scoreRetrieval(item, [{ url: "https://example.com/pricing", title: "Pricing", text: "Price depends on storage", publishedDate: "2026-02-01", snapshotAsOf: item.query.asOf!.toISOString() }]);
  assert.equal(evidence.termCoverage, 1);
  assert.equal(evidence.expectedSourceFound, true);
  assert.equal(evidence.domainCompliance, true);
  assert.equal(evidence.snapshotPolicyPresent, true);
});

test("evaluation catches domain spoofing, dates and missing snapshot policy", () => {
  const score = scoreRetrieval(item, [{ url: "https://example.com.evil.com", title: "Misleading", text: "price", publishedDate: "2025-01-01" }]);
  assert.equal(score.domainCompliance, false);
  assert.equal(score.publicationCompliance, false);
  assert.equal(score.snapshotPolicyPresent, false);
  assert.equal(score.termCoverage, 0.5);
});
