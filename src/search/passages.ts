/** Bounded, extractive selection. Scores select text, never establish factual support. */
export const FULL_DOCUMENT_CHAR_LIMIT = 400_000;
const GAP = "\n\n[... omitted source paragraphs ...]\n\n";
const STOP = new Set("a an and are as at be been by can did do does for from had has have how i in is it its me my of on or our that the their them there these they this to us was were what when where which who why will with would you your earlier answer recheck now".split(" "));
const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
export interface PassageSelection {
  text: string;
  selection: "complete-received-text" | "query-passages" | "document-prefix";
  receivedCharacters: number;
  omittedCharacters: number;
}

/** Retains whole paragraphs and adjacent context; never clips a matching sentence or removes its negation. */
export function selectPassages(text: string, query: string, maxCharacters = 12_000, options: { discardTrailingParagraph?: boolean } = {}): PassageSelection {
  text = text.replaceAll("\0", "").trim();
  const receivedCharacters = text.length;
  if (options.discardTrailingParagraph) {
    const boundaries = [...text.matchAll(/\n[\t \r]*\n+/g)];
    const last = boundaries.at(-1)?.index;
    text = last === undefined ? "" : text.slice(0, last).trimEnd();
  }
  if (text.length <= maxCharacters) return { text, selection: options.discardTrailingParagraph ? "document-prefix" : "complete-received-text", receivedCharacters, omittedCharacters: receivedCharacters - text.length };
  const paragraphs = text.split(/\n[\t \r]*\n+/).map(value => value.trim()).filter(Boolean);
  const terms = [...new Set(tokens(query).filter(term => !STOP.has(term) && (term.length > 1 || /\d/.test(term))))].slice(0, 80);
  const matches = paragraphs.map(paragraph => {
    const words = new Set(tokens(paragraph));
    return terms.filter(term => words.has(term));
  });
  const frequencies = new Map(terms.map(term => [term, matches.reduce((count, list) => count + Number(list.includes(term)), 0)]));
  const scores = matches.map((list, index) => ({ index, score: list.reduce((sum, term) =>
    sum + Math.log(1 + paragraphs.length / (frequencies.get(term)! || 1)) * (/\d/.test(term) ? 2 : 1), 0) / Math.sqrt(1 + paragraphs[index]!.length / 1500) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Set<number>();
  const render = (indices: Set<number>): string => [...indices].sort((a, b) => a - b)
    .map((index, n, sorted) => (n ? index === sorted[n - 1]! + 1 ? "\n\n" : GAP : index > 0 ? GAP.trimStart() : "") + paragraphs[index])
    .join("") + (indices.size && Math.max(...indices) < paragraphs.length - 1 ? GAP.trimEnd() : "");
  if (scores.length) {
    for (const { index } of scores.slice(0, 256)) {
      if (selected.has(index)) continue;
      // Keep preceding context (often a heading) and the next two paragraphs (often exceptions).
      // If this entire window cannot fit, omit it instead of silently clipping a qualifier.
      const candidate = new Set(selected);
      for (let i = Math.max(0, index - 1); i <= Math.min(paragraphs.length - 1, index + 2); i++) candidate.add(i);
      if (render(candidate).length <= maxCharacters) for (const i of candidate) selected.add(i);
    }
  } else {
    for (let i = 0; i < paragraphs.length; i++) {
      const candidate = new Set([...selected, i]);
      if (render(candidate).length > maxCharacters) break;
      selected.add(i);
    }
  }
  const selectedText = render(selected);
  return { text: selectedText, selection: scores.length ? "query-passages" : "document-prefix", receivedCharacters,
    omittedCharacters: Math.max(0, receivedCharacters - [...selected].reduce((sum, index) => sum + paragraphs[index]!.length, 0)) };
}
