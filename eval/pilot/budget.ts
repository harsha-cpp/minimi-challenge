import { AdmissionError } from "../../src/llm/gateway.ts";
import type { SearchProvider, SearchQuery } from "../../src/search.ts";
import { EXA_MAX_ATTEMPTS } from "../../src/search/exa.ts";

/** A local campaign allowance complements, and never replaces, the durable cross-process ledger. */
export function searchAllowance(provider: SearchProvider, maxDollars: number, attemptDollars: number, maxAttempts = EXA_MAX_ATTEMPTS) {
  if (![maxDollars, attemptDollars].every(value => Number.isFinite(value) && value > 0)
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid pilot search allowance.");
  let reservedDollars = 0, admittedLookups = 0, rejectedLookups = 0;
  const bound = attemptDollars * maxAttempts;
  return {
    get snapshot() { return { maxDollars, reservedDollars, admittedLookups, rejectedLookups, maxAttemptsPerLookup: maxAttempts }; },
    provider: { search: async (query: SearchQuery, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (reservedDollars + bound > maxDollars + 1e-12) {
        rejectedLookups++;
        throw new AdmissionError("budget", "The campaign's search allowance is exhausted; no lookup was started.");
      }
      // Retain both attempt reservations even after an error or a cache hit. The final result's cost
      // metadata cannot establish whether an earlier failed attempt was billed.
      reservedDollars += bound; admittedLookups++;
      return provider.search(query, signal);
    } } satisfies SearchProvider,
  };
}
