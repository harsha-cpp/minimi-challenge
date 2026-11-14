import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchHit } from "../src/search/types.ts";
import { isHistoricalEvidenceEligible } from "../src/temporal/eligibility.ts";
import { verifyHistoricalAnswer } from "../src/agent/verify.ts";

const url = "https://league.example.com/season-history";
const cutoff = new Date("2024-11-14T06:22:08.161Z");
const archived: SearchHit = { url, title: "Archived annual results", text: "2023\tClub A\n2024\tClub B",
  archive: { provider: "wayback", capturedAt: "2024-07-22T11:46:06.000Z", captureUrl: `https://web.archive.org/web/20240722114606id_/${url}`,
    originalUrl: url, rawHash: "a".repeat(64) } };

test("archive evidence requires consistent capture, original URL and exclusive provenance", () => {
  assert.equal(isHistoricalEvidenceEligible(archived, cutoff), true);
  assert.equal(isHistoricalEvidenceEligible(archived, new Date("2024-07-21T00:00:00Z")), false);
  for (const invalid of [
    { ...archived, snapshotAsOf: cutoff.toISOString() },
    { ...archived, url: "https://other.example.com/history" },
    { ...archived, archive: { ...archived.archive!, rawHash: "not-a-content-hash" } },
    { ...archived, archive: { ...archived.archive!, captureUrl: `https://web.archive.org/web/20250722114606id_/${url}` } },
    { ...archived, archive: { ...archived.archive!, captureUrl: url } },
    { ...archived, archive: { ...archived.archive!, captureUrl: archived.archive!.captureUrl + "#FUTURE" } },
    { ...archived, archive: { ...archived.archive!, capturedAt: "2024-07-22T11:46:06.001Z" } },
  ]) assert.equal(isHistoricalEvidenceEligible(invalid, cutoff), false);
});

test("a complete annual request cannot pass a checker after dropping covered years", async () => {
  let calls = 0;
  const result = await verifyHistoricalAnswer({
    llm: { json: async () => { calls++; throw new Error("Should fail before model audit"); } },
    question: "Winners list each year", answer: "| Year | Winner |\n|---|---|\n|2024|Club B [1]|",
    cutoff, sources: [{ ...archived, n: 1 }],
  });
  assert.equal(result.reason, "incomplete_answer");
  assert.equal(result.approved, false);
  assert.equal(calls, 0);
});

test("an explicit year-specific question is not forced to list unrelated years", async () => {
  const result = await verifyHistoricalAnswer({
    llm: { json: async () => ({ approved: true, units: [{ id: 1, kind: "factual", supported: true, temporalSafe: true,
      evidence: [{ source: 1, quote: "2024\tClub B" }] }] }) },
    question: "Who won in 2024?", answer: "Club B won in 2024 [1].", cutoff, sources: [{ ...archived, n: 1 }],
  });
  assert.equal(result.approved, true);
});
