import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface AccessPolicy { mode: "local" | "hosted"; allowedOrigins: string[]; ownerTokens: Record<string, string> }
export class AccessError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validateAccessPolicy(policy: AccessPolicy): void {
  if (policy.mode !== "local" && policy.mode !== "hosted") throw new Error("DEPLOYMENT_MODE must be local or hosted.");
  if (policy.mode === "hosted" && (!policy.allowedOrigins.length || !Object.keys(policy.ownerTokens).length)) throw new Error("Hosted mode requires ALLOWED_ORIGINS and OWNER_TOKENS.");
  const tokens = new Set<string>();
  for (const [owner, token] of Object.entries(policy.ownerTokens)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner) || owner === "local" || typeof token !== "string" || !/^[a-zA-Z0-9_-]{32,512}$/.test(token) || tokens.has(token)) throw new Error("Each hosted owner requires a unique token of at least 32 characters and a non-local owner ID.");
    tokens.add(token);
  }
  for (const value of policy.allowedOrigins) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "https:") throw new Error("Hosted origins must be exact HTTPS origins.");
  }
}
export function ownerForToken(token: string, policy: AccessPolicy): string | undefined {
  return Object.entries(policy.ownerTokens).find(([, expected]) => same(token, expected))?.[0];
}
export function requestOwner(req: IncomingMessage, policy: AccessPolicy): string {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
  if (policy.mode === "local") {
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) throw new AccessError(403, "invalid_host");
    if (origin && origin !== `http://${host}`) throw new AccessError(403, "invalid_origin");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new AccessError(403, "invalid_origin");
    return "local";
  }
  if (!policy.allowedOrigins.some(value => new URL(value).host === host)) throw new AccessError(403, "invalid_host");
  if (origin && !policy.allowedOrigins.includes(origin)) throw new AccessError(403, "invalid_origin");
  const bearer = req.headers.authorization?.match(/^Bearer (.{1,512})$/)?.[1];
  const cookie = req.headers.cookie?.split(/;\s*/).find(value => value.startsWith("asof_owner="))?.slice("asof_owner=".length);
  if (mutation && !bearer && !origin) throw new AccessError(403, "origin_required");
  const token = bearer ?? cookie ?? "";
  const owner = ownerForToken(token, policy);
  if (!owner) throw new AccessError(401, "authentication_required");
  return owner;
}
