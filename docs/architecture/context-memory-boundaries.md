# Conversation and memory boundaries

The selected date changes the world-viewpoint used for research. It does not change the subject of
the conversation, erase visible messages, or authorize selecting a different conversation.

## The reported failure

A model-comparison conversation was followed by a backward date change and “verify your claims now”.
The old history query applied the selected world date to the current transcript, removing the visible
model discussion. Generic verification words then retrieved an older sports conversation. The review
received that sports draft and its sources without the original model claims, so citation support was
checked against the wrong request.

Earlier regressions incorrectly treated later-viewpoint messages in the same visible conversation as
records that should disappear. The corrected contract distinguishes the object of a question from
evidence eligible to answer it. Frozen fixtures are now versioned as `pipeline-regression-v3`.

## Enforced scopes

| Input | Boundary |
| --- | --- |
| Current request | The latest user message defines the task. An explicitly named new subject can change it. |
| Current transcript | Same authenticated owner and conversation, ordered by durable sequence before the current turn. No world-date cutoff removes visible predecessors. |
| Verification follow-up | The application pins a same-conversation predecessor by episode ID, sequence and full-answer SHA-256. Topic ranking never selects the target. |
| Other-conversation memory | Retrieval requires an explicit personal-memory request. SQL applies owner, conversation and requested-date scope before candidate limits. Unscoped recall fails closed. |
| Date ambiguity | Keep interpretations separate. Do not choose a date by topic similarity or substitute a nearby conversation when the requested date is empty. |
| Sources | Retrieved passages can establish facts at the viewpoint. Previous answers remain untrusted claims to check, including when written under a later viewpoint. |
| Background memory | Missing-reference clarification jobs complete without extracting claims, looking up prior claims or calling a model. |

Implicit verification includes phrases such as “verify your claims”, “verify your claims properly now”,
“is that still true?” and “are you sure?”. Strong references tolerate adverbs and evidence-request
phrasing while explicit named subjects, supplied claims and URLs remain standalone requests.
A missing reference produces a saved clarification question with no generation,
search or enrichment call. Repeating it cannot turn that clarification into a factual target.

When a valid target exists, generation receives only that bounded question/answer pair as its
antecedent. Recalled records cannot occupy its place. Authorized memory for other requests is
separately labeled and precedes the active transcript. Current-conversation and other-conversation
records are never represented as interchangeable user messages.

## Review and publication

Anchored review receives the same reference used by generation. Approval requires the exact episode
ID and answer hash, an affirmative subject check, declared coverage, and material-claim passage checks.
A sourced answer to a different subject is rejected as `wrong_context`. Repair must pass again.
An unavailable or invalid reference review cannot publish the possibly unrelated draft with a disclaimer;
the result stays explicitly unresolved about the original answer.

Ordinary unanchored era answers no longer receive a blanket unverified-warning prefix. Specific
uncertainty, unresolved verification checks and the interface's evidence-quality badges remain.
Removing that prefix does not approve a rejected draft or waive the anchored subject/support checks.

The bounded quote permits 1,000 question characters and 12,000 answer characters. The hash covers the
complete stored answer. Truncation is explicit, forbids complete verification, and requires visible
partial/unresolved qualification. Earlier timestamps are labeled as original viewpoints and actual
receipt times, not newly verified knowledge.

The committed episode retains reference metadata. Idempotent replay recovers that result. Legacy
unbound verification replies are not trusted to define a new subject: retry follows their immediate
same-conversation predecessors to the original answer, or asks for clarification if no safe reference
exists. Previously saved incorrect replies are retained for audit; this repair does not rewrite history.
An explicitly unverified bound reply contains status prose, so its next implicit retry follows the exact
validated parent ID/hash back to the claim-bearing answer. Repeated unresolved replies follow that
binding chain; missing, modified or cyclic parents fail closed. Supported verification answers and
ordinary standalone unverified answers can remain the next target.

## Validation

Regression coverage includes backward date changes, competing other-chat topics, current-chat
continuity, missing and repeated references, explicit topic changes, contaminated legacy retries,
wrong-subject drafts with valid citations, reviewer outages, clipped references, owner/sequence/hash
boundaries, date ambiguity, and real worker processing with stale prior-claim payloads.

A capped live replay against a protected copy of the reported conversation selected the original
AI-model answer and excluded the saved IPL reply. It completed durably, but its reviewer timed out
and the answer remained explicitly unresolved. That is subject-isolation and safe-degradation
evidence, not a factual-accuracy pass. Later retry/paraphrase refinements were checked offline.

These checks enforce application provenance and publication rules. Model judgments of factual truth
remain probabilistic; human adjudication and the wider release gates in [evaluation](../evaluation.md)
remain separate requirements.
