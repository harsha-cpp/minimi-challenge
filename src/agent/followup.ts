/** Closed follow-ups may inherit this chat's subject; named new subjects may not. */
export function followupFocus(message: string): { ordinal?: number; facet?: string } | undefined {
  const text = message.trim().replace(/[?.!]+$/, "");
  const ordinal = text.match(/^(?:(?:please|can you|could you|would you)\s+)*(?:re[- ]?check|check|verify|double[- ]?check)\s+(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:option|item|recommendation)(?:\s*,?\s*(?:particularly|especially|including)\s+(?:its\s+)?(price|pricing|cost|availability))?$/i);
  if (ordinal) return { ordinal: ["first","second","third","fourth","fifth"].indexOf(ordinal[1]!.toLowerCase()) + 1 || Number(ordinal[1]![0]), facet: ordinal[2]?.toLowerCase() };
  const facet = text.match(/^(?:and\s+)?(?:what|how) about (?:the |its |their )?(price|prices|pricing|cost|costs|billing|availability|release date)$/i);
  if (facet) return {facet:facet[1]!.toLowerCase()};
}

export function selectOrdinal(answer: string, ordinal: number): string | undefined {
  const starts = [...answer.matchAll(/^[ \t]*(\d+)[.)][ \t]+(.+)$/gm)];
  if (starts.length) {
    // Multiple lists or malformed numbering cannot establish one particular second option.
    if (starts.some((entry,index) => Number(entry[1]) !== index + 1) || ordinal > starts.length) return;
    const item = starts[ordinal-1]!;
    const lines = answer.slice(item.index,starts[ordinal]?.index ?? answer.length).split("\n");
    // Unindented closing prose is outside the selected option. Including it can silently
    // pull another option's prices and citations back into an otherwise scoped check.
    const end = lines.findIndex((line,index) => index > 0 && line.trim() && !/^(?: {2,}|\t)/.test(line));
    return lines.slice(0,end < 0 ? lines.length : end).join("\n").trim();
  }
  const lines = answer.split("\n");
  const tables: string[][] = [];
  for (let i=1;i<lines.length;i++) {
    if (!/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i]!)) continue;
    const table = [lines[i-1]!,lines[i]!];
    for(let j=i+1;j<lines.length && /^\s*\|.*\|\s*$/.test(lines[j]!);j++) table.push(lines[j]!);
    if(table.length>2) tables.push(table);
  }
  if(tables.length!==1 || tables[0]!.length < ordinal+2) return;
  // Only entity rows, not feature rows comparing products across columns, are ordinal options.
  if(!/^\s*\|?\s*(?:option|provider|product|tool|service|host|name)\s*\|/i.test(tables[0]![0]!)) return;
  return [tables[0]![0],tables[0]![1],tables[0]![ordinal+1]].join("\n");
}
