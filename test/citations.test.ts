import assert from "node:assert/strict";
import { test } from "node:test";
import { citedNumbers } from "../src/agent/citations.ts";

const cases: Array<[string, number[]]> = [
  ["<div>a fact [1].</div>", [1]],
  ["<code>[0]</code> A fact [2].", [2]],
  ["<pre><span>[0]</span></pre> A fact [2].", [2]],
  ['<a href="https://example.com"><span>[99]</span></a> A fact [2].', [2]],
  ["<div><em>A fact [1, 3]</em> and another [2].</div>", [1, 2, 3]],
  ["<p>A fact &#91;1&#93; and another [2&#44; 3].</p>", [1, 2, 3]],
  ["<p><!-- [99] -->A fact [1].</p><script>[99]</script>", [1]],
  ["<div>[<em>1</em>]</div>", []], // The renderer does not join separate text nodes.
  ["`[99]` and [98](https://example.com).\n\n```html\n<div>[97]</div>\n```", []],
];
for (const [answer, expected] of cases) {
  test(`citation numbers match rendered eligible text: ${answer}`, () => {
    assert.deepEqual(citedNumbers(answer), expected);
  });
}
