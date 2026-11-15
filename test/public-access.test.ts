import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { createGuestSession, requestOwner, validateAccessPolicy, type AccessPolicy } from "../src/runtime/access.ts";

const policy = (): AccessPolicy => ({ mode: "hosted", allowedOrigins: ["https://asof.example.com"], ownerTokens: { harsha: "a".repeat(40) }, publicSessionSecret: "s".repeat(43) });
const request = (cookie: string, headers = {}) => ({ method: "GET", headers: { host: "asof.example.com", cookie, ...headers } }) as IncomingMessage;

test("public sessions remain stable across process configuration copies and cannot select another identity", () => {
  const access = policy(), first = createGuestSession(access), second = createGuestSession(access);
  assert.notEqual(first.ownerId, second.ownerId);
  assert.equal(requestOwner(request(first.cookie), structuredClone(access)), first.ownerId);
  assert.throws(() => requestOwner(request(first.cookie.replace(first.ownerId.slice(6), second.ownerId.slice(6))), access), /authentication_required/);
  assert.throws(() => requestOwner(request(first.cookie), { ...access, publicSessionSecret: "x".repeat(43) }), /authentication_required/);
  assert.throws(() => requestOwner(request(createGuestSession(access, Date.now() - 366 * 86400000).cookie), access), /authentication_required/);
  assert.match(first.cookie, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=/);
});

test("public sessions retain private-owner precedence and origin checks", () => {
  const access = policy(), guest = createGuestSession(access);
  assert.equal(requestOwner(request(guest.cookie, { authorization: `Bearer ${access.ownerTokens.harsha}` }), access), "harsha");
  assert.throws(() => requestOwner(request(guest.cookie, { authorization: "Bearer invalid" }), access), /authentication_required/);
  assert.throws(() => requestOwner(request(guest.cookie, { origin: "https://attacker.example" }), access), /invalid_origin/);
  const mutation = request(guest.cookie); mutation.method = "POST";
  assert.throws(() => requestOwner(mutation, access), /origin_required/);
  assert.throws(() => requestOwner(request(guest.cookie), { ...access, publicSessionSecret: undefined }), /authentication_required/);
});

test("public access rejects weak configuration and reserved owner identifiers", () => {
  validateAccessPolicy(policy());
  assert.throws(() => validateAccessPolicy({ ...policy(), publicSessionSecret: "" }), /strong PUBLIC_SESSION_SECRET/);
  assert.throws(() => validateAccessPolicy({ ...policy(), mode: "local" }), /hosted mode/);
  assert.throws(() => validateAccessPolicy({ ...policy(), ownerTokens: { guest_fake: "a".repeat(40) } }), /non-guest/);
});
