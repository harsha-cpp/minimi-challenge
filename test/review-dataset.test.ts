import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveRequestContext } from "../src/agent/context.ts";
import { projectGenerationInput, validateDataset, type QualityCase } from "../eval/quality/protocol.ts";

const cases: QualityCase[] = JSON.parse(readFileSync(new URL("../eval/quality/review-cases.json", import.meta.url), "utf8")).cases;
const expectations: Record<string, { kind: string; memoryScope: string }> = JSON.parse(readFileSync(new URL("../eval/quality/review-routing.json", import.meta.url), "utf8"));
test("focused 25-conversation review set is protocol-compatible and keeps human labels pending", () => {
  validateDataset(cases); assert.equal(cases.length, 25);
  assert.ok(cases.every(item => item.labels.status === "pending" && !item.labels.references.length && !item.labels.adjudicators.length && !item.labels.reconciled));
  assert.ok(cases.every(item => item.labels.requiredFacets.length >= 2));
  for (const item of cases) assert.doesNotMatch(JSON.stringify(projectGenerationInput(item)), /acceptableUncertainty|requiredFacets|adjudicators/);
});
for (const item of cases) test(`review routing: ${item.input.id}`, () => {
  const history = (item.input.history ?? []).map((row, index) => ({ id: index + 1, sequence: index + 1,
    ownerId: "local", sessionId: row.scope === "memory" ? "another-conversation" : "visible", askedAt: Date.parse(row.at), createdAt: Date.parse(row.at),
    tz: "UTC", question: row.question, answer: row.answer, summary: null, topics: null }));
  const result = resolveRequestContext({ message: item.input.question, sessionId: "visible", history });
  assert.deepEqual({ kind: result.kind, memoryScope: result.memoryScope }, expectations[item.input.id]);
  if (result.anchor) assert.equal(result.anchor.sessionId, "visible");
});
