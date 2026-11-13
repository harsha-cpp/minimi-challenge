import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { citedNumbersIn } from "../../public/citations.js";

// Reuse the DOM environment; no scripts or external resources are enabled.
const window = new JSDOM("").window;
const purify = createDOMPurify(window);

/** Match the browser's Markdown -> sanitized DOM -> eligible text-node pipeline. */
export function citedNumbers(answer: string): number[] {
  const html = marked.parse(answer, { gfm: true, async: false });
  const fragment = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  return citedNumbersIn(fragment);
}
