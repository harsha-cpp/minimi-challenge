import { createHash } from "node:crypto";
import type { Source } from "../memory/store.ts";
import { REVIEW_POLICY_VERSION } from "../runtime/versions.ts";

export const REVIEWED_CLAIM_SCHEMA_VERSION = 1;
export interface ClaimScope {
  viewpointAt: string;
  tz: string;
  kind: "verification" | "simulation" | "lookup";
  referenceAnswerHash: string | null;
}
export interface CanonicalClaim {
  id: string;
  text: string;
  entity: string | null;
  attribute: string | null;
  value: string | null;
  conditions: string[] | null;
  effectiveDate: string | null;
  referenceClaimId: string | null;
  sourceRefs: Array<{ n: number; url: string; contentHash: string }>;
  scope: ClaimScope;
  reviewerPolicyVersion: string | null;
  status: "supported" | "unverified";
  origin: "review" | "extracted";
}
export interface ReviewedClaim extends CanonicalClaim { status: "supported"; origin: "review"; reviewerPolicyVersion: string }
export interface ExtractedClaim extends CanonicalClaim { status: "unverified"; origin: "extracted"; reviewerPolicyVersion: null }
export interface ClaimCoverage {
  claimId: string;
  status: "supported" | "changed" | "unresolved";
  sourceNumbers: number[];
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const passageHash = (text: string) => createHash("sha256").update(text).digest("hex");
const nullable = (value: unknown, max = 800): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid normalized claim field.");
  return value;
};
export function makeReviewedClaim(raw: Record<string, unknown>, sources: Map<number, Source>, scope: ClaimScope, referenceIds = new Set<string>()): ReviewedClaim {
  const text = nullable(raw.claim, 4000); if (!text) throw new Error("Claim text is required.");
  const entity = nullable(raw.entity), attribute = nullable(raw.attribute), value = nullable(raw.value);
  const effectiveDate = nullable(raw.effectiveDate, 10), referenceClaimId = nullable(raw.referenceClaimId, 64);
  if (effectiveDate && (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || new Date(`${effectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== effectiveDate)) throw new Error("Invalid claim effective date.");
  if (referenceClaimId && !referenceIds.has(referenceClaimId)) throw new Error("Unknown original claim.");
  let conditions: string[] | null = null;
  if (raw.conditions !== undefined && raw.conditions !== null) {
    if (!Array.isArray(raw.conditions) || raw.conditions.length > 12) throw new Error("Invalid claim conditions.");
    conditions = raw.conditions.map(condition => { const text = nullable(condition, 300); if (!text) throw new Error("Invalid claim condition."); return text; });
  }
  if (!Array.isArray(raw.sourceNumbers) || !raw.sourceNumbers.length || raw.sourceNumbers.length > 64) throw new Error("Claim needs sources.");
  const numbers = [...new Set(raw.sourceNumbers)];
  const sourceRefs = numbers.map(n => {
    const source = sources.get(n as number);
    if (!Number.isSafeInteger(n) || !source?.text?.trim()) throw new Error("Claim source is unavailable.");
    return { n: n as number, url: source.url, contentHash: passageHash(source.text) };
  }).sort((a, b) => a.n - b.n);
  const identity = { text, entity, attribute, value, conditions, effectiveDate, referenceClaimId, scope, reviewerPolicyVersion: REVIEW_POLICY_VERSION, origin: "review" as const };
  return { id: passageHash(JSON.stringify(identity)), ...identity, sourceRefs, status: "supported" };
}

/** Omitted original facets stay unresolved. A whole-answer verdict never fills them in. */
export function reviewCoverage(raw: unknown, originals: CanonicalClaim[], current: ReviewedClaim[], citations: number[]): ClaimCoverage[] {
  if (raw !== undefined && !Array.isArray(raw)) throw new Error("Invalid claim coverage.");
  if ((raw as unknown[] | undefined)?.length! > 64) throw new Error("Too many coverage records.");
  const expected = new Set(originals.map(claim => claim.id)), decisions = new Map<string, ClaimCoverage>();
  for (const item of raw as unknown[] ?? []) {
    const row = object(item);
    if (!row || Object.keys(row).some(key => !["claimId", "status", "sourceNumbers"].includes(key))
      || typeof row.claimId !== "string" || !expected.has(row.claimId) || decisions.has(row.claimId)
      || !["supported", "changed", "unresolved"].includes(String(row.status)) || !Array.isArray(row.sourceNumbers)) throw new Error("Invalid coverage identity.");
    const sourceNumbers = row.sourceNumbers as number[];
    if (sourceNumbers.some(n => !Number.isSafeInteger(n) || !citations.includes(n)) || new Set(sourceNumbers).size !== sourceNumbers.length) throw new Error("Invalid coverage citations.");
    if (row.status === "unresolved" ? sourceNumbers.length !== 0 : !sourceNumbers.length
      || !current.some(claim => claim.referenceClaimId === row.claimId && sourceNumbers.every(n => claim.sourceRefs.some(ref => ref.n === n)))) throw new Error("Coverage lacks an approved assertion.");
    decisions.set(row.claimId, { claimId: row.claimId, status: row.status as ClaimCoverage["status"], sourceNumbers });
  }
  return originals.map(claim => decisions.get(claim.id) ?? { claimId: claim.id, status: "unresolved", sourceNumbers: [] });
}

export function validateReviewedClaims(claims: ReviewedClaim[] | undefined, sources: Source[], viewpointAt: number): ReviewedClaim[] {
  if (claims === undefined) return [];
  if (!Array.isArray(claims) || claims.length > 64) throw new Error("Invalid reviewed claims.");
  const map = new Map(sources.map(source => [source.n, source])), seen = new Set<string>();
  for (const claim of claims) {
    if (!claim || claim.status !== "supported" || claim.origin !== "review" || claim.reviewerPolicyVersion !== REVIEW_POLICY_VERSION || seen.has(claim.id)
      || !claim.scope || Date.parse(claim.scope.viewpointAt) !== viewpointAt || !["verification", "simulation"].includes(claim.scope.kind)
      || claim.scope.referenceAnswerHash !== null && !/^[a-f0-9]{64}$/.test(claim.scope.referenceAnswerHash)) throw new Error("Invalid reviewed claim scope.");
    new Intl.DateTimeFormat("en", { timeZone: claim.scope.tz });
    const rebuilt = makeReviewedClaim({ claim: claim.text, ...claim, sourceNumbers: claim.sourceRefs.map(ref => ref.n) }, map, claim.scope,
      new Set(claim.referenceClaimId ? [claim.referenceClaimId] : []));
    if (rebuilt.id !== claim.id || JSON.stringify(rebuilt.sourceRefs) !== JSON.stringify(claim.sourceRefs)) throw new Error("Reviewed claim evidence changed.");
    seen.add(claim.id);
  }
  return structuredClone(claims);
}

/** Background extraction describes what was said. It cannot grant an evidence-review verdict. */
export function makeExtractedClaim(input: { entity: string; attribute: string; value: string; sourceUrl: string | null }, scope: ClaimScope, sources: Source[]): ExtractedClaim {
  const entity = nullable(input.entity, 200)!, attribute = nullable(input.attribute, 200)!, value = nullable(input.value, 1000)!;
  if (!entity || !attribute || !value) throw new Error("Extracted claim fields are required.");
  const text = `${entity}: ${attribute} = ${value}`;
  const identity = { text, entity, attribute, value, conditions: null, effectiveDate: null, referenceClaimId: null,
    scope, reviewerPolicyVersion: null, origin: "extracted" as const };
  const sourceRefs = sources.filter(source => source.url === input.sourceUrl && source.text?.trim()).map(source => ({
    n: source.n, url: source.url, contentHash: passageHash(source.text!),
  }));
  return { id: passageHash(JSON.stringify(identity)), ...identity, sourceRefs, status: "unverified" };
}

/** Exact verdict reuse is deliberately stricter than a retrieval-cache hit. */
export function canReuseReviewedClaim(claim: ReviewedClaim, input: { text: string; scope: ClaimScope; sources: Source[]; researchStartedAt: number; policyVersion?: string }): boolean {
  if (claim.status !== "supported" || claim.text !== input.text || claim.reviewerPolicyVersion !== (input.policyVersion ?? REVIEW_POLICY_VERSION)
    || JSON.stringify(claim.scope) !== JSON.stringify(input.scope) || !input.sources.length) return false;
  const current = input.sources.map(source => ({ source, hash: source.text ? passageHash(source.text) : null }));
  if (current.length !== claim.sourceRefs.length) return false;
  return claim.sourceRefs.every(ref => current.some(({ source, hash }) => source.url === ref.url && hash === ref.contentHash
    && source.freshness?.requested === "fresh" && source.freshness.acquisition === "live" && source.freshness.ageStatus === "known"
    && Number.isFinite(input.researchStartedAt) && Date.parse(source.freshness.contentFetchedAt ?? "") >= input.researchStartedAt));
}
