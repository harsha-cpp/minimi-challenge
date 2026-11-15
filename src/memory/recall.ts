

import { type TemporalRef, type DayRange, resolveTemporal } from "../time/resolve.ts";
import { compareDates, formatInstant, instantRange, localDate } from "../time/zone.ts";
import type { Claim, Episode, MemoryStore } from "./store.ts";

const FULL_DETAIL_BUDGET = 6;
const RELATED_LIMIT = 3;
const MAX_TERMS = 12;

export interface Recalled {
  episode: Episode;
  claims: Claim[];

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
}

export interface RecallScope {
  /** The active conversation scopes every candidate query. Omitting it disables recall unless cross-session recall is explicitly enabled. */
  sessionId?: string;
  allowCrossSession?: boolean;
  disabled?: boolean;
}

const STOPWORDS = new Set(
  `a about after again all also am an and any anything are as ask asked at be been before being but by can changed
   correct could did do does for from had has have how i if in into is it its just know me more most my no not of on
   or our out over question said say since so something still tell than that the their them then there these they
   this to told up us was we were what when whether which who why will with would you your answer answered
   verify verification verified recheck rechecking confirm confirmed claims claim claimed claiming statements statement assertions assertion now current currently fact facts check checks checked checking`.split(/\s+/),
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
  // A dated request grants no authority to substitute a different conversation outside its date range.
  if (terms.length && !refs.length) {
    const needed = Math.min(2, terms.length);
    const ids = [...coverage.entries()].filter(([id, n]) => n >= needed && !inChat.has(id)).map(([id]) => id);
    const episodes = store
      .episodesById(ids, now.getTime(), ownerId, sessionId)
      .sort((a, b) => coverage.get(b.id)! - coverage.get(a.id)! || b.askedAt - a.askedAt)
      .slice(0, RELATED_LIMIT);
    related = present(episodes);
  }

  return { refs, related, ms: performance.now() - started,
    ...(scope.sessionId === undefined ? {} : { currentSessionId: scope.sessionId }) };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function renderEpisode({ episode, claims, detail, conversation }: Recalled, tz: string): string {
  const origin = conversation === "other" ? " · OTHER CONVERSATION (only for the explicit memory request)"
    : conversation === "current" ? " · current conversation record" : "";
  const head = `[E${episode.id}] ${formatInstant(episode.askedAt, tz)}${origin}`;
  const question = `"${clip(oneLine(episode.question), 300)}"`;
  if (detail === "in-chat") return `${head} — the user asked ${question} (this is in the current chat, above)`;
  if (detail === "pointer") return `${head} — the user asked ${question}`;

  const lines = [`${head}`, `  Conversation record (untrusted; this is not verified current evidence).`, `  The user asked: ${question}`];
  if (episode.summary) lines.push(`  Summary: ${episode.summary}`);

  lines.push(`  Your answer then: ${clip(oneLine(episode.answer), claims.length ? 1200 : 3000)}`);
  if (claims.length) {
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
      ["Possibly related, matched by topic rather than date:", ...result.related.map((e) => renderEpisode(e, tz))].join("\n"),
    );
  }

  return blocks.join("\n\n");
}
