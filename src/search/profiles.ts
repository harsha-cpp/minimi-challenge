import type { SearchProvider, SearchQuery, RetrievalProfile } from "./types.ts";
export const RETRIEVAL_POLICY_VERSION = "profiles-v1";
export const PROFILES: Record<RetrievalProfile, { results: number; excerptChars: number }> = {
  fact: { results: 5, excerptChars: 2500 }, direct: { results: 5, excerptChars: 2500 },
  verification: { results: 5, excerptChars: 3500 }, comparison: { results: 6, excerptChars: 3000 },
  "complete-list": { results: 5, excerptChars: 3500 }, historical: { results: 5, excerptChars: 3000 },
  research: { results: 8, excerptChars: 3500 },
};
export function retrievalProfile(question: string, options: { simulated?: boolean; verify?: boolean } = {}): RetrievalProfile {
  if (options.verify) return "verification";
  if (options.simulated) return "historical";
  if (/\b(?:all|complete|every|entire)\b.{0,50}\b(?:list|table|rows?|winners?|members?)\b|\b(?:list|table)\b.{0,30}\b(?:all|complete|every)\b/i.test(question)) return "complete-list";
  if (/\b(?:compar(?:e|ison)|versus|vs\.?|tradeoffs?)\b/i.test(question)) return "comparison";
  if (/https?:\/\//i.test(question)) return "direct";
  return "fact";
}
export function withProfile(provider: SearchProvider, profile: RetrievalProfile, enabled = false): SearchProvider {
  return { search: (query, signal) => provider.search(enabled ? { ...query, profile: query.profile ?? profile, policyVersion: RETRIEVAL_POLICY_VERSION } : query, signal) };
}
export function validateCapabilities(query: SearchQuery): void {
  if (query.mode === "lite" && (query.freshness === "fresh" || ["verification", "historical"].includes(query.profile ?? ""))) {
    throw new Error("Lite search cannot satisfy live-fetch freshness or verification profiles.");
  }
  if (query.mode === "lite" && query.urls) throw new Error("Search mode is not applicable to a Contents read.");
  if (query.content === "full" && (!query.urls?.length || query.urls.length > 2)) throw new Error("Full content reads require one or two explicit URLs.");
}
