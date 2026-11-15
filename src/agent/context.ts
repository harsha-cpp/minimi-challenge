import { createHash } from "node:crypto";
import type { Episode } from "../memory/store.ts";

export const REQUEST_CONTEXT_LIMITS = { questionChars: 1000, answerChars: 12_000 } as const;
export interface ConversationAnchor {
  episodeId: number;
  ownerId: string;
  sessionId: string;
  sequence: number;
  question: string;
  answer: string;
  viewpointAt: number;
  createdAt: number | null;
  /** SHA-256 of the complete stored answer, including text beyond the bounded quote. */
  answerHash: string;
  truncated: boolean;
}
export interface RequestContext {
  kind: "standalone" | "conversation_reference" | "missing_reference";
  memoryScope: "none" | "explicit_memory";
  anchor?: ConversationAnchor;
}
export interface RequestContextInput {
  message: string;
  sessionId: string;
  ownerId?: string;
  /** Actual durable predecessors, not recall matches or records selected by viewpoint date. */
  history: Episode[];
  /** Explicit UI selection, loaded from the owner-scoped store rather than supplied answer text. */
  targetEpisode?: Episode;
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalized = (message: string) => message.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const suppliedTextTask = (message: string) => /^(?:(?:please|can you|could you|would you)\s+)*(?:translate|rewrite|rephrase|proofread|copyedit|edit|shorten|paraphrase|format|summari[sz]e)\b/i.test(message)
  && /[:\n]\s*\S|["“”‘’'`][\s\S]+["“”‘’'`]/.test(message);

function explicitPersonalMemory(message: string): boolean {
  if (suppliedTextTask(message)
    || /^(?:(?:please|can you|could you|would you)\s+)*(?:verify|check|fact[- ]?check|validate|review|recall)\s+(?:this|the (?:following|supplied|provided))\b[\s\S]*[:\n]\s*\S/i.test(message)) return false;
  // Quoted text is supplied content, not authorization to search private history.
  message = message.replace(/["“][\s\S]*?["”]|‘[^’]*’|`[^`]*`|(?:^|\s)'[^']+'(?=\s|[.!?,;:]|$)/g, " ");
  if (/\b(?:our|my)\s+(?:(?:previous|earlier|other|past|old|last)\s+)+(?:conversation|chat|discussion|session)s?\b/i.test(message)) return true;
  if (/^(?:(?:please[,.]?|can you|could you|would you|will you|do you|help me|i (?:want|need) you to)\s+)*(?:remember|recall|remind me (?:of|about))\s+(?:my|our)\b/i.test(message)) return true;
  const namedRecall = message.match(/^(?:(?:please|can you|could you|would you)\s+)*recall\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}\s'-]{0,119})\s+(?:comparison|discussion|conversation|decision|choice|preference)s?[.!?]*$/iu);
  if (namedRecall && !/^(?:a|an|the|this|that|following|supplied|provided)$/i.test(namedRecall[1]!.trim())) return true;
  if (/\b(?:what|which|when|where|why|how)\b[\s\S]{0,160}\b(?:did|have|had)\s+(?:i|we)\s+(?:(?:ever|originally|previously|already|recently)\s+)*(?:ask|asked|say|said|tell|told|give|gave|write|written|wrote|claim|claimed|choose|chosen|chose|discuss|discussed|decide|decided|prefer|preferred|mention|mentioned|request|requested|pick|picked|select|selected|reject|rejected|specify|specified|agree|agreed)\b/i.test(message)) return true;
  if (/\b(?:what|which|when|where|how)\b[\s\S]{0,160}\b(?:i|we)\s+(?:said|told|gave|wrote|claimed|asked|chose|discussed|decided|preferred|mentioned|requested|picked|selected|rejected|specified|agreed)\b/i.test(message)) return true;
  if (/\b(?:what|which|when|where|how)\b[\s\S]{0,160}\b(?:did|have|had)\s+you\s+(?:tell|told|give|gave|recommend|recommended|suggest|suggested|say|said)\s+(?:to\s+)?(?:me|us)\b/i.test(message)) return true;
  // A date only authorizes memory when paired with a personal communication/history cue.
  const dated = /\b(?:yesterday|last (?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|earlier|previously|on\s+\d{1,2}\s+\w+|on\s+\w+\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/i.test(message);
  return dated && (/\b(?:recall|remember|find|retrieve|show|verify|check)\b[\s\S]{0,100}\b(?:my|our)\s+(?:conversation|chat|discussion|question|request|preference|choice|decision|recommendation|message|claim|statement)s?\b/i.test(message)
    || /\b(?:i|we)\s+(?:(?:asked|told)\s+you\s+(?:about\s+)?|discussed\s+(?:with\s+you\s+)?)[\p{L}\p{N}]/iu.test(message));
}

const referenceWords = new Set(("verify verification recheck re check fact factcheck double confirm validate is are was were do does did has have can could would will should " +
  "you your yours we our i me my us the a an this that these those it its them all everything anything what whats what's which whether if of in on as from at " +
  "previous last earlier prior above preceding original current latest same now today again still yet really actually please also then once more here so " +
  "answer answers response responses claim claims statement statements assertion assertions recommendation recommendations fact facts information detail details " +
  "number numbers price prices pricing cost costs plan plans version versions availability result results value values correctness accuracy " +
  "true correct accurate right valid verified supported available unchanged changed up to date sure certain confident about stand by said say wrote written gave given made make provided just " +
  "for with against evidence sources source checkable thing things time selected viewpoint calendar comparison comparisons want need to and or not full entire complete").split(/\s+/));
const verificationWords = new Set(("using consulting reading reliable official primary independent credible actual proper rigorous thorough exhaustive sourced " +
  "citation citations references research detail depth care exact links link documents docs doing go back over well better deeper further hard fast together " +
  "own recent assistant tell told stated claimed ensure possible respect regarding concerning related substantiate corroborate reassess cross evaluate doublecheck").split(/\s+/));
const strongReference = /\b(?:your\s+(?:(?:own|previous|last|earlier|prior|above|preceding|original|latest|recent)\s+)*(?:claims?|answers?|responses?|statements?|assertions?|recommendations?)|(?:the\s+)?(?:above|previous|last|earlier|prior|preceding)\s+(?:assistant\s+)?(?:answers?|responses?|claims?|statements?|assertions?)|(?:claims?|statements?|assertions?|answers?|responses?)\s+(?:that\s+)?you\s+(?:(?:just|previously|earlier)\s+)*(?:made|gave|provided|wrote|stated)|(?:what|everything)\s+you\s+(?:(?:just|previously|earlier)\s+)*(?:said|told|wrote|claimed|stated)|(?:this|that|these|those))\b/i;

/** Recognize closed, subject-free follow-ups. Any supplied claim, URL or new subject stays standalone. */
function implicitReference(message: string): boolean {
  const text = normalized(message);
  if (explicitPersonalMemory(text) || suppliedTextTask(text)) return false;
  if (/["“”`][\s\S]+["“”`]|(?:^|\s)'[^']+'(?=\s|[.!?,;:]|$)|:\s*\S|https?:\/\//i.test(text)) return false;
  const temporalSuffix = /\s+(?:as of|on|at|from)\s+(?:(?:the\s+)?(?:selected|current|previous|original)\s+(?:date|time|viewpoint)|\d{4}-\d{2}-\d{2}(?:T[^\s]+)?|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?|\d{4})[.!?]*$/i;
  const core = text.replace(temporalSuffix, "");
  const directReference = strongReference.test(core);
  const verification = /\b(?:verify|verification|re-?check|fact[- ]?check|confirm|validate|double[- ]?check|check)\b/i.test(core)
    || /\b(?:true|correct|accurate|right|valid|up[- ]to[- ]date|changed|unchanged)\b/i.test(core)
      && /\b(?:is|are|was|were|still|has|have|what|what's|whats)\b/i.test(core)
    || /\b(?:are you sure|stand by your (?:answer|response|claims?))\b/i.test(core)
    || directReference && /\b(?:substantiate|corroborate|reassess|cross[- ]?check|re[- ]?evaluate)\b/i.test(core);
  if (!verification) return false;
  const words = core.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
  if (words.length && words.every(word => referenceWords.has(word))) return true;
  if (!directReference) return false;
  const generic = (word: string) => referenceWords.has(word) || verificationWords.has(word);
  // "Verify that <named subject> is ..." supplies a claim rather than pointing at a prior one.
  for (const supplied of core.matchAll(/\b(?:this|that|these|those)\s+(?:the\s+)?([\p{L}\p{N}]+)\s+(?:is|are|was|were|has|have|can|will|links?|claims?|versions?)\b/giu)) {
    if (!generic(supplied[1]!.toLocaleLowerCase("en-US"))) return false;
  }
  // Topic modifiers introduce their own subject even when its name happens to end in "ly".
  // Adverbs such as "properly" or "meticulously" cannot turn Grammarly/Bitly into antecedents.
  for (const modifier of core.matchAll(/\b(?:about|regarding|concerning|on|for|from|of|related to|with respect to)\s+(?:(?:the|a|an|current|latest|previous|last|earlier|official|primary|reliable)\s+)*([\p{L}\p{N}]+)/giu)) {
    if (!generic(modifier[1]!.toLocaleLowerCase("en-US"))) return false;
  }
  // A direct conversational target tolerates productive adverbs and evidence-method phrasing;
  // an unknown noun or explicit new subject still cannot inherit a conversation target.
  return words.every(word => generic(word) || /^\p{L}{3,}ly$/u.test(word));
}

function sequence(episode: Episode): number | null {
  const value = episode.sequence === undefined ? episode.id : episode.sequence;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function metadata(episode: Episode): Record<string, unknown> | undefined {
  return object(episode.execution?.requestContext) ?? object(episode.execution?.context);
}
function bounded(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}
function anchorFor(episode: Episode, ownerId: string): ConversationAnchor | undefined {
  const order = sequence(episode);
  if (order === null || typeof episode.question !== "string" || typeof episode.answer !== "string" || !episode.answer.trim()
    || !Number.isFinite(new Date(episode.askedAt).getTime())) return;
  const question = bounded(episode.question, REQUEST_CONTEXT_LIMITS.questionChars), answer = bounded(episode.answer, REQUEST_CONTEXT_LIMITS.answerChars);
  return { episodeId: episode.id, ownerId, sessionId: episode.sessionId, sequence: order, question, answer,
    viewpointAt: episode.askedAt, createdAt: typeof episode.createdAt === "number" && Number.isFinite(episode.createdAt) ? episode.createdAt : null,
    answerHash: hash(episode.answer), truncated: question.length !== episode.question.length || answer.length !== episode.answer.length };
}

export function resolveRequestContext(input: RequestContextInput): RequestContext {
  const ownerId = input.ownerId ?? "local";
  if (input.targetEpisode) {
    const target = input.targetEpisode;
    const anchor = target.sessionId === input.sessionId && (target.ownerId ?? "local") === ownerId
      && Number.isSafeInteger(target.id) && target.id > 0 ? anchorFor(target, ownerId) : undefined;
    return anchor ? { kind: "conversation_reference", memoryScope: "none", anchor }
      : { kind: "missing_reference", memoryScope: "none" };
  }
  if (explicitPersonalMemory(input.message)) return { kind: "standalone", memoryScope: "explicit_memory" };
  if (!implicitReference(input.message)) return { kind: "standalone", memoryScope: "none" };
  const missing: RequestContext = { kind: "missing_reference", memoryScope: "none" };
  const scoped = input.history.filter(episode => episode.sessionId === input.sessionId && (episode.ownerId ?? "local") === ownerId);
  if (scoped.some(episode => !Number.isSafeInteger(episode.id) || episode.id <= 0 || sequence(episode) === null)) return missing;
  const history = scoped.sort((left, right) => sequence(right)! - sequence(left)!);
  const byId = new Map<number, Episode>();
  const sequences = new Set<number>();
  for (const episode of history) {
    // Conflicting records cannot establish an immutable conversational referent.
    if (byId.has(episode.id) || sequences.has(sequence(episode)!)) return missing;
    byId.set(episode.id, episode);
    sequences.add(sequence(episode)!);
  }
  const validBinding = (episode: Episode, visited = new Set<number>()): boolean => {
    if (visited.has(episode.id)) return false;
    visited.add(episode.id);
    const context = metadata(episode);
    if (context?.kind !== "conversation_reference" || !Number.isSafeInteger(context.anchorEpisodeId)
      || typeof context.anchorAnswerHash !== "string" || !/^[a-f\d]{64}$/i.test(context.anchorAnswerHash)) return false;
    const target = byId.get(context.anchorEpisodeId as number);
    if (!target || sequence(target)! >= sequence(episode)! || metadata(target)?.kind === "missing_reference"
      || !anchorFor(target, ownerId) || hash(target.answer) !== context.anchorAnswerHash.toLowerCase()) return false;
    const targetKind = metadata(target)?.kind;
    return targetKind === "standalone" || !(implicitReference(target.question) || targetKind === "conversation_reference") || validBinding(target, visited);
  };
  for (let index = 0; index < history.length; index++) {
    const episode = history[index]!;
    const context = metadata(episode);
    if (context?.kind === "missing_reference") return missing;
    const legacyReference = implicitReference(episode.question);
    // A declared but invalid binding is not permission to select another subject.
    if (context?.kind === "conversation_reference" && !validBinding(episode)) return missing;
    if (!legacyReference || context?.kind === "standalone" || context?.kind === "conversation_reference") {
      let subject = episode;
      const followed = new Set<number>();
      while (metadata(subject)?.kind === "conversation_reference"
        && (subject.quality === "explicitly_unverified" || subject.execution?.quality === "explicitly_unverified")) {
        if (followed.has(subject.id)) return missing;
        followed.add(subject.id);
        // Bound unresolved replies contain safe status prose, not a replacement claim set.
        // The binding was validated above; follow that exact parent rather than an adjacent turn.
        const parent = byId.get(metadata(subject)!.anchorEpisodeId as number);
        if (!parent) return missing;
        subject = parent;
      }
      const anchor = anchorFor(subject, ownerId);
      return anchor ? { kind: "conversation_reference", memoryScope: "none", anchor } : missing;
    }
    // Legacy unbound follow-up prose may already contain cross-conversation contamination.
    // Follow only the actual same-conversation predecessor, never that prose or a topic/FTS match.
  }
  return missing;
}
