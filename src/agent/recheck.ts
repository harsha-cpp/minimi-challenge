import type { ConversationAnchor } from "./context.ts";
import { citedNumbers } from "./citations.ts";
import type { Source } from "../memory/store.ts";
import type { SearchQuery } from "../search.ts";
import type { CanonicalClaim } from "./claims.ts";
import { canonicalUrl, normalizeQuery } from "../search/validate.ts";

/** Reuse addresses, never the saved page text or its previous freshness verdict. */
export function recheckSourceQuery(anchor: ConversationAnchor, sources: Source[]): SearchQuery | undefined {
  const cited = new Set(citedNumbers(anchor.answer));
  const urls = new Set<string>();
  for (const source of sources) {
    if (!cited.has(source.n) || source.url.length > 2048) continue;
    try { urls.add(canonicalUrl(source.url)); } catch { continue; }
    if (urls.size === 4) break;
  }
  if (!urls.size) return;
  return normalizeQuery({ query: anchor.question.slice(0, 1000), urls: [...urls],
    freshness: "fresh", profile: "verification", content: urls.size <= 2 ? "full" : "highlights" });
}

export const RECHECK_RESEARCH_INSTRUCTIONS = `Fresh reads of the original answer's cited source URLs were attempted below.
Only the newly fetched passages are evidence; saved answer text is the claim set to check.
Compare those claims against these passages first. If they suffice, answer now without rediscovering
the same sources. Otherwise batch targeted searches for missing claims, inaccessible pages, or later
changes. An unchanged announcement page does not establish that a current price, product or policy
is unchanged: check a current authoritative page or subsequent updates before making that claim.
A page title or table of contents is not a factual passage. If the relevant passage is missing,
use the remaining search allowance to retrieve that passage before drafting; do not fill gaps from memory.
Explicitly identify anything not checked. Never infer unchanged facts from an empty search.`;

/** Research must leave time for the visible answer and, when required, its evidence review. */
export function completionReserveMs(availableMs: number, buffered: boolean): number {
  return Math.min(buffered ? 45_000 : 15_000, Math.floor(availableMs / (buffered ? 2 : 3)));
}

export function lookupAllowanceMs(input: { remainingMs: number; reserveMs: number; fast: boolean; verification: boolean; configuredMs?: number }): number {
  const configured = input.configuredMs;
  const limit = configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured : input.fast || input.verification ? 10_000 : 12_000;
  return Math.max(0, Math.floor(Math.min(limit, input.remainingMs - input.reserveMs)));
}

export interface ComparisonSearchPlan {
  queries: SearchQuery[];
  targets: number;
  plannedTargets: number;
  omittedTargets: number;
}

const searchWords = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
const requestStop = new Set("a an and are as at be before by can check compare correct did do earlier for from has have i in is it my now of on or our please previous recheck same still that the their them then these this to true up verify was we what when which with you your".split(" "));
const compact = (value: string, limit: number): string => value.replace(/https?:\/\/\S+/g, " ").replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " ")
  .replace(/[|*_`#]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const safeUrl = (value: string): string | undefined => { try { return value.length <= 2048 ? canonicalUrl(value) : undefined; } catch { return; } };

/** Plan focused, concurrent retrieval without asking a model to rediscover the selected answer.
 * Old page text is deliberately absent: only source addresses, original assertions and their conditions
 * guide fresh reads. A prior citation identifies where to look, not whether that site is authoritative.
 */
export function comparisonSearchPlan(input: { anchor: ConversationAnchor; claims: CanonicalClaim[]; sources: Source[]; request: string }): ComparisonSearchPlan {
  const { anchor, claims } = input;
  const requested = [...new Set(searchWords(input.request).filter(word => !requestStop.has(word) && word.length > 2))];
  const relevance = (value: string): number => { const words = new Set(searchWords(value)); return requested.reduce((sum, word) => sum + Number(words.has(word)), 0); };
  const claimFocus = (claim: CanonicalClaim): string => [compact(claim.entity ?? "",80), compact(claim.text,220),
    compact([...(claim.conditions ?? [])].sort((a,b) => relevance(b)-relevance(a)).join("; "),100),claim.effectiveDate].filter(Boolean).join("; ");
  const cited = new Set(citedNumbers(anchor.answer));
  const sourceMap = new Map<string, Source>();
  for (const source of input.sources) {
    const url = safeUrl(source.url);
    if (url && cited.has(source.n) && !sourceMap.has(url)) sourceMap.set(url, source);
  }
  const citationLines = anchor.answer.split(/\n+/).filter(line => /\[\d/.test(line)).map(line => ({line,numbers:citedNumbers(line)}));
  const citedContext = (source: Source): string => {
    // Keep the original row/paragraph around this citation, not unrelated adjacent products.
    const excerpt = citationLines.filter(item => item.numbers.includes(source.n)).map(item => item.line).join(" ");
    return compact(excerpt || `${source.title} ${anchor.question}`, 600);
  };
  const groups = new Map<string, { focus: string[]; urls: Set<string>; rank: number }>();
  for (const claim of claims) {
    const urls = claim.sourceRefs.map(ref => safeUrl(ref.url)).filter((url): url is string => Boolean(url && sourceMap.has(url)));
    const key = claim.entity?.trim().toLowerCase() || urls[0] || claim.id;
    const group = groups.get(key) ?? { focus: [], urls: new Set<string>(), rank: groups.size };
    group.focus.push(claimFocus(claim)); urls.forEach(url => group.urls.add(url)); groups.set(key, group);
  }
  // Sources without extracted assertions still represent parts of the full original answer.
  for (const [url, source] of sourceMap) if (![...groups.values()].some(group => group.urls.has(url))) {
    groups.set(`source:${url}`, { focus: [citedContext(source)], urls: new Set([url]), rank: groups.size });
  }
  if (!groups.size) groups.set("question", { focus: [compact(`${anchor.question} ${anchor.answer}`, 650)], urls: new Set(), rank: 0 });
  for (const group of groups.values()) group.focus.sort((a,b) => relevance(b)-relevance(a));
  const ordered = [...groups.values()].sort((a, b) => relevance(b.focus.join(" ")) - relevance(a.focus.join(" ")) || a.rank - b.rank);
  const selected = ordered.slice(0, 5);
  const sourceTargets = [...sourceMap].map(([url, source]) => {
    const facts = claims.filter(claim => claim.sourceRefs.some(ref => safeUrl(ref.url) === url));
    const focus = facts.length ? facts.map(claimFocus).sort((a,b) => relevance(b)-relevance(a)).join("; ") : citedContext(source);
    return { url, focus: compact(focus, 850), score: relevance(focus) };
  }).filter(item => selected.some(group => group.urls.has(item.url)))
    .sort((a, b) => b.score - a.score);
  const queries: SearchQuery[] = sourceTargets.slice(0, 2).map(item => normalizeQuery({ query: item.focus || compact(anchor.question, 850),
    urls: [item.url], content: "full", freshness: "fresh", profile: "verification" }));
  // Keep small checks small. Multi-target checks get a focused same-site lookup plus an
  // unrestricted discovery query covering every planned target, including moved or conflicting pages.
  // Share the query allowance fairly so a fifth vendor is not dropped by a long prefix.
  const batches = Array.from({ length: Math.min(2, selected.length) }, () => [] as typeof selected);
  selected.forEach((group, index) => batches[index % batches.length]!.push(group));
  for (const [index, group] of batches.entries()) {
    const batch = index === 1 ? selected : group;
    const perTarget = Math.floor(850 / batch.length);
    const focus = batch.map(group => compact(group.focus.join("; "), perTarget)).join("; ");
    const domains = [...new Set(batch.flatMap(group => [...group.urls].map(url => new URL(url).hostname)))].slice(0,10);
    queries.push(normalizeQuery({ query: `${focus} current official information updates`, content: "highlights", freshness: "fresh", profile: "verification",
      // A targeted same-site search can find an updated pricing page; an unrestricted search
      // is always retained to discover moved pages, corrections and conflicting sources.
      ...(index === 0 && batches.length > 1 && domains.length ? { domains } : {}) }));
  }
  return { queries, targets: ordered.length, plannedTargets: selected.length, omittedTargets: Math.max(0, ordered.length - selected.length) };
}
