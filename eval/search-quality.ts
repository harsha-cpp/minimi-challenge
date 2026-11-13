import type { SearchHit, SearchQuery } from "../src/search.ts";
import { matchesDomains } from "../src/search/validate.ts";

export interface SearchCase {
  id: string;
  query: SearchQuery;
  expectedDomains: string[];
  /** Lexical diagnostics only; these do not establish factual correctness. */
  evidenceTerms: string[];
}

/** Small, inspectable seed set. Expand it before making comparative claims. */
export const SEARCH_CASES: SearchCase[] = [
  { id: "postgres-pricing", query: { query: "Neon current Postgres pricing plans", domains: ["neon.com"], freshness: "fresh" }, expectedDomains: ["neon.com"], evidenceTerms: ["pricing", "compute", "storage"] },
  { id: "direct-pricing", query: { query: "Supabase Pro monthly plan price and limits", urls: ["https://supabase.com/pricing"], freshness: "fresh" }, expectedDomains: ["supabase.com"], evidenceTerms: ["pro", "month", "database"] },
  { id: "technical-source", query: { query: "SQLite write ahead logging concurrency readers writer", domains: ["sqlite.org"] }, expectedDomains: ["sqlite.org"], evidenceTerms: ["wal", "reader", "writer"] },
  { id: "release-notes", query: { query: "Node.js release changelog", domains: ["nodejs.org"], publishedAfter: "2026-01-01" }, expectedDomains: ["nodejs.org"], evidenceTerms: ["release", "version", "change"] },
  { id: "historical-source", query: { query: "Supabase Pro plan pricing", urls: ["https://supabase.com/pricing"], asOf: new Date("2026-06-01T12:00:00.000Z") }, expectedDomains: ["supabase.com"], evidenceTerms: ["pro", "month", "database"] },
  { id: "primary-research", query: { query: "retrieval augmented generation language models original paper", domains: ["arxiv.org"] }, expectedDomains: ["arxiv.org"], evidenceTerms: ["retrieval", "generation", "knowledge"] },
];

export function scoreRetrieval(item: SearchCase, hits: SearchHit[]) {
  const combined = hits.map(h => h.text).join(" ").toLowerCase();
  const termCoverage = item.evidenceTerms.filter(term => combined.includes(term.toLowerCase())).length / item.evidenceTerms.length;
  return {
    results: hits.length,
    nonEmptyEvidence: hits.length > 0 && hits.every(h => h.text.trim().length > 0),
    expectedSourceFound: hits.some(h => matchesDomains(h.url, item.expectedDomains)),
    domainCompliance: hits.every(h => matchesDomains(h.url, item.query.domains)),
    publicationCompliance: hits.every(h => !item.query.publishedAfter || Boolean(h.publishedDate && h.publishedDate >= item.query.publishedAfter)),
    snapshotPolicyPresent: !item.query.asOf || (hits.length > 0 && hits.every(h => h.snapshotAsOf === item.query.asOf!.toISOString())),
    termCoverage,
  };
}
