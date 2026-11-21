import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface AccessPolicy { mode: "local" | "hosted"; allowedOrigins: string[]; ownerTokens: Record<string, string>; publicSessionSecret?: string }
export class AccessError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validateAccessPolicy(policy: AccessPolicy): void {
  if (policy.mode !== "local" && policy.mode !== "hosted") throw new Error("DEPLOYMENT_MODE must be local or hosted.");
  if (policy.mode === "hosted" && (!policy.allowedOrigins.length || !Object.keys(policy.ownerTokens).length)) throw new Error("Hosted mode requires ALLOWED_ORIGINS and OWNER_TOKENS.");
  if (policy.publicSessionSecret !== undefined && (policy.mode !== "hosted" || !/^[a-zA-Z0-9_-]{43,512}$/.test(policy.publicSessionSecret))) throw new Error("Public demo requires hosted mode and a strong PUBLIC_SESSION_SECRET.");
  const tokens = new Set<string>();
  for (const [owner, token] of Object.entries(policy.ownerTokens)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(owner) || owner === "local" || owner.startsWith("guest_") || typeof token !== "string" || !/^[a-zA-Z0-9_-]{32,512}$/.test(token) || tokens.has(token)) throw new Error("Each hosted owner requires a unique token of at least 32 characters and a non-local, non-guest owner ID.");
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
const guestCookieName = "__Host-asof_guest";
const guestLifetimeSeconds = 365 * 24 * 60 * 60;
const signature = (value: string, secret: string) => createHmac("sha256", secret).update(value).digest("base64url");
/** The random identifier scopes memory; the signature prevents choosing another owner's identifier. */
export function createGuestSession(policy: AccessPolicy, now = Date.now()): { ownerId: string; cookie: string } {
  if (policy.mode !== "hosted" || !policy.publicSessionSecret) throw new Error("Public demo is disabled.");
  const id = randomBytes(24).toString("base64url");
  const payload = `v1.${id}.${Math.floor(now / 1000) + guestLifetimeSeconds}`;
  return { ownerId: `guest_${id}`, cookie: `${guestCookieName}=${payload}.${signature(payload, policy.publicSessionSecret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${guestLifetimeSeconds}` };
}
function guestOwner(req: IncomingMessage, policy: AccessPolicy): string | undefined {
  if (!policy.publicSessionSecret) return;
  const value = req.headers.cookie?.split(/;\s*/).find(part => part.startsWith(`${guestCookieName}=`))?.slice(guestCookieName.length + 1);
  const match = /^v1\.([a-zA-Z0-9_-]{32})\.([0-9]{10,11})\.([a-zA-Z0-9_-]{43})$/.exec(value ?? "");
  if (!match || Number(match[2]) <= Math.floor(Date.now() / 1000)) return;
  const payload = `v1.${match[1]}.${match[2]}`;
  if (!same(match[3]!, signature(payload, policy.publicSessionSecret))) return;
  return `guest_${match[1]}`;
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
  const owner = ownerForToken(token, policy) ?? (req.headers.authorization === undefined ? guestOwner(req, policy) : undefined);
  if (!owner) throw new AccessError(401, "authentication_required");
  return owner;
}
