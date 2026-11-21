# Elite HR portal — information-exposure findings

Non-invasive review of `https://elitehr.nxtagent.ai` (reading only publicly-served
files; no authenticated or intrusive testing). Summary of what is exposed.

## 1. RSA private key shipped in the public frontend bundle (critical)
`https://elitehr.nxtagent.ai/assets/events-BqOmmJDB.js` embeds a full RSA private
key as a JWK (`kty:"RSA"` with private components `d, p, q, dp, dq, qi`,
`key_ops:["decrypt"]`, `ext:true`). It is imported via
`crypto.subtle.importKey("jwk", …, {name:"RSA-OAEP"}, …, ["decrypt"])` and used by the
assessment "decrypt-token" flow. Anyone can download the key and decrypt whatever the
backend encrypts with the matching public key. **Rotate the keypair and move
decryption server-side.**

## 2. Assessment answers decrypted client-side
For `SPEAK_TO_ANSWER` questions, each `/candidate/questions` item carries an
RSA-encrypted `token` that the browser decrypts locally into the expected sentence.
Combined with (1), the "answer key" is recoverable by the candidate. A debug
`console.log("Assessment", …)` also dumps the full assessment object to the console.

## 3. Media object store is public-read (no auth, no expiry)
All objects under `nxtagent.objectstore.e2enetworks.net` return HTTP 200 to anonymous
requests. Bucket **listing** is denied (403), so keys cannot be enumerated, but any
exposed URL is permanently fetchable by anyone. 56 media URLs are hardcoded in the
public JS bundle (see `ALL_URLS.txt` / `MANIFEST.csv`); per-candidate question media
lives in the same public bucket. **Switch to private storage with short-lived signed
URLs.**

## 4. Proctoring signals are client-computed and client-trusted
The `/candidate/submit` body sends `faceapi_attributes` (no-face, multiple-faces,
tab-switching) computed in the browser, so they can be forged. Do real proctoring and
grading server-side.

## 5. No anonymous access to questions (auth gate holds) — key-leak scope
All candidate data endpoints enforce an access-token cookie and return
`401 "Access token not found"` without it (`/candidate/questions`,
`/candidate/instructions`, `/candidate/check-login-status`). So the private-key
leak (1) does **not** let an anonymous attacker read the question bank: the key is
only useful once the encrypted `token`s are obtained, which requires a candidate
session. Exploit paths are therefore (a) any valid candidate session, or (b)
capturing a specific candidate's ciphertext (e.g. via the `console.log` dumps or
Sentry error payloads).

## 6. API documentation is publicly exposed (info leak)
`/docs` (Swagger UI) and `/primehire/api/v1/openapi.json` return 200 to anyone,
exposing the full API surface — including back-office routes such as `/assessment`,
`/interview`, `/interview/{id}/report`, `/partner/*` (add / enable / disable /
credential reset), `/partner/{id}/credits/*` (credit system), and
`/response/{id}/generate-report`. These routes require auth, but publishing the map
aids targeting. Disable or authenticate the docs/openapi endpoints in production.
CORS was checked and is correctly allow-listed (origin not reflected); `/health` is
open and benign.

## Files in this folder
- `ALL_URLS.txt` — the 56 openly-fetchable media URLs referenced by the frontend.
- `MANIFEST.csv` — each URL with HTTP status, byte size, and detected file type.
