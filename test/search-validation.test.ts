import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeQuery } from "../src/search.ts";
test("search arguments reject invalid dates and private URLs", () => {
  assert.throws(() => normalizeQuery({query:"pricing",publishedAfter:"2026-02-30"}));
  assert.throws(() => normalizeQuery({query:"pricing",urls:["http://localhost/private"]}));
  assert.throws(() => normalizeQuery({query:"x".repeat(1001)}));
  assert.equal(normalizeQuery({query:"  pricing  "}).query,"pricing");
});
