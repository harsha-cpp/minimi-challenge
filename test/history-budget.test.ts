import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareHistory } from "../src/agent/prepare.ts";
test("only retained turns are excluded from recall", () => {
 const history=Array.from({length:8},(_,i)=>({id:i+1,sessionId:"s",askedAt:i,tz:"UTC",question:"q".repeat(1000),answer:"a".repeat(4000),summary:null,topics:null}));
 const prepared=prepareHistory(history,"UTC");
 assert.ok(prepared.ids.size<8);assert.equal(prepared.ids.has(1),false);assert.equal(prepared.ids.has(8),true);
});
