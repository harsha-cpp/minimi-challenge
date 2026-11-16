import type { ConversationAnchor } from "./context.ts";
import { citedNumbers } from "./citations.ts";
import type { Source } from "../memory/store.ts";
import type { SearchQuery } from "../search.ts";
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
