export type { SearchHit, SearchProvider, SearchQuery, RetrievalProfile } from "./search/types.ts";
export { createExaSearch } from "./search/exa.ts";
export { withCache } from "./search/cache.ts";
export { normalizeQuery } from "./search/validate.ts";
export { withConcurrency } from "./search/limit.ts";

export { withProfile, retrievalProfile, RETRIEVAL_POLICY_VERSION } from "./search/profiles.ts";
