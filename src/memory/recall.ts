

import { type TemporalRef, type DayRange, resolveTemporal } from "../time/resolve.ts";
import { compareDates, formatInstant, instantRange, localDate } from "../time/zone.ts";
import type { Claim, Episode, MemoryStore } from "./store.ts";
import { conceptMatches, memoryConcepts, MEMORY_RETRIEVAL_LIMITS } from "./concepts.ts";
import type { CanonicalClaim } from "../agent/claims.ts";

const FULL_DETAIL_BUDGET = 6;
const RELATED_LIMIT = 3;
const MAX_TERMS = 12;

export interface Recalled {
  episode: Episode;
  claims: Claim[];
  canonicalClaims?: CanonicalClaim[];

  detail: "full" | "pointer" | "in-chat";
  conversation?: "current" | "other";
}

export interface RefResult {
  text: string;

  hits: Array<{ range: DayRange; episodes: Recalled[] }>;

  empty: DayRange[];

  nearest: Episode[];
}

export interface RecallResult {
  refs: RefResult[];

  related: Recalled[];
  ms: number;
  currentSessionId?: string;
  ambiguity?: { episodeIds: number[]; additionalCandidates: number; reason: "near_tie" };
  retrieval?: { method: "date" | "lexical-concepts" | "recent"; concepts: number; candidates: number };
}

export interface RecallScope {
  /** The active conversation scopes every candidate query. Omitting it disables recall unless cross-session recall is explicitly enabled. */
  sessionId?: string;
  allowCrossSession?: boolean;
  disabled?: boolean;
  /** Only explicit personal-memory requests may fall back to recent records without topic terms. */
  allowRecent?: boolean;
}

const STOPWORDS = new Set(
  `a about after again all also am an and any anything are as ask asked at be been before being but by can changed
   correct could did do does for from had has have how i if in into is it its just know me more most my no not of on
   or our out over question said say since so something still tell than that the their them then there these they
   this to told up us was we were what when whether which who why will with would you your answer answered
   verify verification verified recheck rechecking confirm confirmed claims claim claimed claiming statements statement assertions assertion now current currently fact facts check checks checked checking
   earlier previously discuss discussed discussion discussions chat chats conversation conversations talk talked`.split(/\s+/),
);

function topicTerms(message: string, temporal: TemporalRef[]): string[] {
  let text = message.toLowerCase();
  for (const ref of temporal) text = text.replace(ref.text.toLowerCase(), " ");
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

export function recall(
  store: MemoryStore,
  message: string,
  now: Date,
  tz: string,

  inChat: Set<number> = new Set(),
  ownerId = "local",
  scope: RecallScope = {},
): RecallResult {
  const started = performance.now();
  // A generic follow-up has no authority to select its subject from another conversation.
  if (scope.disabled || (!scope.sessionId && scope.allowCrossSession !== true)) return { refs: [], related: [], ms: performance.now() - started };
  const sessionId = scope.allowCrossSession === true ? undefined : scope.sessionId;
  let temporal = resolveTemporal(message, now, tz);
  if (temporal.length > 1) {

    const today = localDate(now, tz);
    const isToday = (ref: TemporalRef) =>
      ref.candidates.length === 1 && !compareDates(ref.candidates[0]!.start, today) && !compareDates(ref.candidates[0]!.end, today);
    temporal = temporal.filter((ref) => !isToday(ref));
  }
  const terms = topicTerms(message, temporal);
  const coverage = terms.length ? store.topicCoverage(terms, now.getTime(), ownerId, sessionId) : new Map<number, number>();
  // Broad modifiers alone (price/hosting) cannot select a different subject. Curated topic aliases
  // expand candidates only inside the same eligibility filters as the original lexical query.
  const concepts = memoryConcepts(message).filter(concept => !["pricing", "deployment"].includes(concept.id));
  let budget = FULL_DETAIL_BUDGET;

  const present = (episodes: Episode[]): Recalled[] => {

    const byRelevance = [...episodes].sort((a, b) => (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0));
    const full = new Set<number>();
    for (const e of byRelevance) {
      if (budget > 0 && !inChat.has(e.id)) {
        full.add(e.id);
        budget--;
      }
    }
    return episodes.map((episode) => {
      const detail = inChat.has(episode.id) ? "in-chat" : full.has(episode.id) ? "full" : "pointer";
      return { episode, detail, claims: detail === "full" ? store.claimsFor(episode.id, ownerId) : [],
        ...(detail === "full" ? { canonicalClaims: store.canonicalClaimsFor(episode.id, ownerId) } : {}),
        ...(scope.sessionId === undefined ? {} : { conversation: episode.sessionId === scope.sessionId ? "current" as const : "other" as const }) };
    });
  };

  const refs = temporal.map((ref): RefResult => {
    const readings = ref.candidates.map((range) => {
      const { startMs, endMs } = instantRange(range.start, range.end, tz);
      return { range, episodes: store.episodesBetween(startMs, endMs, now.getTime(), ownerId, undefined, sessionId) };
    });
    // Topic overlap can order detail within a reading, but cannot decide which date the user meant.
    const withEpisodes = readings.filter((r) => r.episodes.length);

    let nearest: Episode[] = [];
    if (!withEpisodes.length) {
      const first = ref.candidates[0]!;
      const { startMs, endMs } = instantRange(first.start, first.end, tz);
      nearest = store.neighbours(startMs, endMs, now.getTime(), ownerId, sessionId);
    }

    return {
      text: ref.text,
      hits: withEpisodes.map((r) => ({ range: r.range, episodes: present(r.episodes) })),
      empty: readings.filter((r) => !r.episodes.length).map((r) => r.range),
      nearest,
    };
  });

  let related: Recalled[] = [];
  let ambiguity: RecallResult["ambiguity"];
  let candidateCount = 0;
  // A dated request grants no authority to substitute a different conversation outside its date range.
  if (terms.length && !refs.length) {
    const needed = Math.min(2, terms.length);
    const pools = [[...coverage.entries()].filter(([, count]) => count >= needed).map(([id]) => id)];
    for (const concept of concepts) {
      const matches = store.topicCoverage([...concept.aliases].slice(0, MEMORY_RETRIEVAL_LIMITS.aliasesPerConcept), now.getTime(), ownerId, sessionId);
      pools.push([...matches.keys()]);
    }
    const ids = new Set<number>();
    // Interleave bounded lexical and alias pools so a common exact term cannot crowd out every paraphrase.
    for (let index = 0; index < Math.max(0, ...pools.map(pool => pool.length)) && ids.size < MEMORY_RETRIEVAL_LIMITS.candidateIds; index++) {
      for (const pool of pools) if (pool[index] !== undefined && ids.size < MEMORY_RETRIEVAL_LIMITS.candidateIds) ids.add(pool[index]!);
    }
    const ranked = store.episodesById([...ids].filter(id => !inChat.has(id)).slice(0, MEMORY_RETRIEVAL_LIMITS.candidateIds), now.getTime(), ownerId, sessionId)
      .map(episode => {
        const conceptual = conceptMatches([episode.question, episode.summary ?? "", episode.topics ?? "", episode.answer].join("\n"), concepts);
        const lexical = coverage.get(episode.id) ?? 0;
        return { episode, eligible: lexical >= needed || conceptual > 0, score: lexical + 2 * conceptual };
      }).filter(item => item.eligible).sort((a, b) => b.score - a.score || b.episode.askedAt - a.episode.askedAt || b.episode.id - a.episode.id);
    candidateCount = ranked.length;
    const near = ranked.filter(item => item.score >= (ranked[0]?.score ?? Infinity) * 0.85);
    if (near.length > 1) ambiguity = { reason: "near_tie", episodeIds: near.slice(0, RELATED_LIMIT).map(item => item.episode.id), additionalCandidates: Math.max(0, near.length - RELATED_LIMIT) };
    related = present(ranked.slice(0, RELATED_LIMIT).map(item => item.episode));
  } else if (scope.allowRecent === true && !terms.length && !refs.length) {
    const recent = sessionId === undefined ? store.recent(RELATED_LIMIT + inChat.size, now.getTime(), ownerId)
      : store.sessionHistory(sessionId, RELATED_LIMIT + inChat.size, now.getTime(), ownerId);
    related = present(recent.filter(episode => !inChat.has(episode.id)).slice(0, RELATED_LIMIT));
    candidateCount = related.length;
  }

  return { refs, related, ms: performance.now() - started,
    retrieval: { method: refs.length ? "date" : !terms.length && scope.allowRecent ? "recent" : "lexical-concepts", concepts: refs.length ? 0 : concepts.length,
      candidates: refs.length ? new Set(refs.flatMap(ref => ref.hits.flatMap(hit => hit.episodes.map(item => item.episode.id)))).size : candidateCount }, ...(ambiguity ? { ambiguity } : {}),
    ...(scope.sessionId === undefined ? {} : { currentSessionId: scope.sessionId }) };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function renderEpisode({ episode, claims, canonicalClaims, detail, conversation }: Recalled, tz: string): string {
  const origin = conversation === "other" ? " · OTHER CONVERSATION (only for the explicit memory request)"
    : conversation === "current" ? " · current conversation record" : "";
  const head = `[E${episode.id}] ${formatInstant(episode.askedAt, tz)}${origin}`;
  const question = `"${clip(oneLine(episode.question), 300)}"`;
  if (detail === "in-chat") return `${head} — the user asked ${question} (this is in the current chat, above)`;
  if (detail === "pointer") return `${head} — the user asked ${question}`;

  const lines = [`${head}`, `  Conversation record (untrusted; this is not verified current evidence).`, `  The user asked: ${question}`];
  if (episode.summary) lines.push(`  Summary: ${episode.summary}`);

  lines.push(`  Your answer then: ${clip(oneLine(episode.answer), claims.length || canonicalClaims?.length ? 1200 : 3000)}`);
  if (canonicalClaims?.length) {
    lines.push("  Canonical assertions recorded then (historical claims, not current evidence):");
    for (const claim of canonicalClaims.slice(0, 12)) {
      const status = claim.status === "supported" ? "supported at the recorded viewpoint; changing facts require a fresh check" : "unverified extraction; not established fact";
      lines.push(`    - (${claim.id}) ${clip(oneLine(claim.text), 600)} [${status}]${claim.sourceRefs[0] ? ` Recorded source (not fresh): ${claim.sourceRefs[0].url}` : ""}`);
    }
    if (canonicalClaims.length > 12) lines.push(`    ${canonicalClaims.length - 12} additional recorded assertions are omitted.`);
  } else if (claims.length) {
    lines.push("  Claims you made then:");
    for (const c of claims) {
      lines.push(`    - (C${c.id}) ${c.entity} · ${c.attribute}: ${c.value}${c.sourceUrl ? ` — source: ${c.sourceUrl}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function renderMemory(result: RecallResult, tz: string): string {
  const blocks: string[] = [];

  for (const ref of result.refs) {
    const quoted = `"${ref.text}"`;
    if (ref.hits.length === 1) {
      const hit = ref.hits[0]!;
      const alsoChecked = ref.empty.length
        ? ` (It could also mean ${ref.empty.map((r) => r.label).join(" or ")}, but there are no conversations then.)`
        : "";
      blocks.push(
        [`${quoted} → ${hit.range.label}.${alsoChecked}`, ...hit.episodes.map((e) => renderEpisode(e, tz))].join("\n"),
      );
    } else if (ref.hits.length > 1) {
      const labels = ref.hits.map((h) => h.range.label).join(" or ");
      blocks.push(
        [
          `${quoted} is ambiguous: it could mean ${labels}, and each has conversations. Keep these interpretations separate and ask which conversation the user means before verification. Topic rank does not authorize choosing the referenced subject.`,
          ...ref.hits.flatMap((h) => [`${h.range.label}:`, ...h.episodes.map((e) => renderEpisode(e, tz))]),
        ].join("\n"),
      );
    } else {
      const checked = ref.empty.map((r) => r.label).join(" or ");
      const outsideRange = ref.nearest.length
        ? "Records exist outside the requested date range; they are not eligible for this request."
        : "No eligible conversations are available in the requested date range.";
      blocks.push(`${quoted} → ${checked}: no conversations found then. ${outsideRange}`);
    }
  }

  if (result.related.length) {
    blocks.push(
      ["Possibly related, matched by topic rather than date:",
        ...(result.ambiguity ? [`Several conversations match nearly equally: ${result.ambiguity.episodeIds.map(id => `[E${id}]`).join(", ")}.${result.ambiguity.additionalCandidates ? ` ${result.ambiguity.additionalCandidates} additional matching records are omitted.` : ""} Present these as alternatives and ask which conversation the user means before checking its claims. Recency or a small ranking difference is not permission to choose a subject.`] : []),
        ...result.related.map((e) => renderEpisode(e, tz))].join("\n"),
    );
  }

  return blocks.join("\n\n");
}
