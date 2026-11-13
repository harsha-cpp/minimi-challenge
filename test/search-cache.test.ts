import assert from "node:assert/strict";
import { test } from "node:test";
import { withCache } from "../src/search.ts";
test("fresh rechecks bypass cached evidence", async () => {
  let calls=0; const search=withCache({search:async()=>[{url:"https://example.com",title:"Source",text:String(++calls)}]});
  assert.equal((await search.search({query:"price"}))[0]!.text,"1");
  assert.equal((await search.search({query:"price"}))[0]!.text,"1");
  assert.equal((await search.search({query:"price",freshness:"fresh"}))[0]!.text,"2");
});
