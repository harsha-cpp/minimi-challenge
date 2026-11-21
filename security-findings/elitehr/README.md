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

## Files in this folder
- `ALL_URLS.txt` — the 56 openly-fetchable media URLs referenced by the frontend.
- `MANIFEST.csv` — each URL with HTTP status, byte size, and detected file type.
