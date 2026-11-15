import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { citedNumbersIn } from "../../public/citations.js";

const window = new JSDOM("").window;
const purify = createDOMPurify(window);

export function citedNumbers(answer: string): number[] {
  const html = marked.parse(answer, { gfm: true, async: false });
  const fragment = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  return citedNumbersIn(fragment);
}
