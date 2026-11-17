import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const EXECUTION_POLICY_VERSION = "claims-checkpoints-v1";
export const REVIEW_POLICY_VERSION = "claim-support-v2";
export const RETRIEVAL_POLICY_VERSION = "coverage-search-v2";
export const MEMORY_POLICY_VERSION = "lexical-concepts-v1";

const implementationFiles = [
  "agent/run.ts", "agent/prompt.ts", "agent/prepare.ts", "agent/context.ts", "agent/evidence.ts",
  "agent/comparison.ts", "agent/simulation.ts", "agent/review-recovery.ts", "agent/recheck.ts", "agent/response-mode.ts",
  "agent/claims.ts", "memory/recall.ts", "memory/enrich.ts", "memory/store.ts", "memory/concepts.ts", "memory/questions.ts",
  "search/cache.ts", "search/exa.ts", "search/passages.ts", "search/validate.ts", "search/profiles.ts", "search/limit.ts",
  "server.ts", "llm.ts", "llm/gateway.ts", "runtime/research-checkpoints.ts", "runtime/versions.ts",
];
let fingerprint: string | undefined;

/** One identity per running process. Includes local edits, but never configuration or credentials. */
export function executionPolicyFingerprint(): string {
  if (!fingerprint) {
    const hash = createHash("sha256");
    for (const file of implementationFiles) {
      hash.update(file + "\0");
      try { hash.update(readFileSync(new URL("../" + file, import.meta.url))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("absent"); }
      hash.update("\0");
    }
    fingerprint = hash.digest("hex");
  }
  return fingerprint;
}

export function executionIdentity() {
  return { implementation: executionPolicyFingerprint(), execution: EXECUTION_POLICY_VERSION,
    review: REVIEW_POLICY_VERSION, retrieval: RETRIEVAL_POLICY_VERSION, memory: MEMORY_POLICY_VERSION };
}
