/**
 * Finds the past conversations a message refers to, before the model runs.
 *
 * Memory is context, not a tool: the brief gives the agent exactly one tool
 * (web search), and a lookup that takes a few milliseconds of SQL does not
 * deserve a model round trip anyway.
 *
 * Time is the primary key. A date reference narrows a whole history to a
 * handful of conversations, after which topic words only have to break ties.
 * That is why there are no embeddings here: once the date is known there is
 * almost nothing left to rank. When a message has no date, or the date turns
 * out to be empty, recall falls back to topic words over the full log, which
 * also covers a user who remembers the subject but not the day.
 */
import { type TemporalRef, type DayRange, resolveTemporal } from "../time/resolve.ts";
import { compareDates, formatInstant, instantRange, localDate } from "../time/zone.ts";
import type { Claim, Episode, MemoryStore } from "./store.ts";

/** How many past conversations are shown to the model in full on one turn. */
const FULL_DETAIL_BUDGET = 6;
const RELATED_LIMIT = 3;
const MAX_TERMS = 12;

export interface Recalled {
  episode: Episode;
  claims: Claim[];
  /** "full" carries the answer and its claims; the others are one-line pointers. */
  detail: "full" | "pointer" | "in-chat";
}

export interface RefResult {
  text: string;
  /** Readings of the phrase that have conversations. One is a clean match; several means still ambiguous. */
  hits: Array<{ range: DayRange; episodes: Recalled[] }>;
  /** Readings that were checked and had no conversations. */
  empty: DayRange[];
  /** Offered when nothing matched: the conversations either side of the date. */
  nearest: Episode[];
}

export interface RecallResult {
  refs: RefResult[];
  /** Matched by topic. Only filled when no date reference found anything. */
  related: Recalled[];
  ms: number;
}

// Function words, plus the words people use to talk *about* a conversation
// rather than its subject ("what did I ask", "is it still correct").
const STOPWORDS = new Set(
  `a about after again all also am an and any anything are as ask asked at be been before being but by can changed
   correct could did do does for from had has have how i if in into is it its just know me more most my no not of on
   or our out over question said say since so something still tell than that the their them then there these they
   this to told up us was we were what when whether which who why will with would you your answer answered`.split(/\s+/),
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
  /** Episodes already present in this chat's history, which need no repeating. */
  inChat: Set<number> = new Set(),
): RecallResult {
  const started = performance.now();
  let temporal = resolveTemporal(message, now, tz);
  if (temporal.length > 1) {
    // In "what did I ask on 3 November, and is it still correct today?", today is
    // the present, not a day to look up. It is only a lookup when it is the sole date.
    const today = localDate(now, tz);
    const isToday = (ref: TemporalRef) =>
      ref.candidates.length === 1 && !compareDates(ref.candidates[0]!.start, today) && !compareDates(ref.candidates[0]!.end, today);
    temporal = temporal.filter((ref) => !isToday(ref));
  }
  const terms = topicTerms(message, temporal);
  const coverage = terms.length ? store.termCoverage(terms) : new Map<number, number>();
  let budget = FULL_DETAIL_BUDGET;

  const present = (episodes: Episode[]): Recalled[] => {
    // The most on-topic conversations get the full-detail budget; the list
    // itself stays in the order things happened.
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
      return { episode, detail, claims: detail === "full" ? store.claimsFor(episode.id) : [] };
    });
  };

  const refs = temporal.map((ref): RefResult => {
    const readings = ref.candidates.map((range) => {
      const { startMs, endMs } = instantRange(range.start, range.end, tz);
      return { range, episodes: store.episodesBetween(startMs, endMs) };
    });
    let withEpisodes = readings.filter((r) => r.episodes.length);
    if (withEpisodes.length > 1) {
      // Several readings have conversations: keep the ones that are about the same subject.
      const onTopic = withEpisodes.filter((r) => r.episodes.some((e) => coverage.get(e.id)));
      if (onTopic.length) withEpisodes = onTopic;
    }

    let nearest: Episode[] = [];
    if (!withEpisodes.length) {
      const first = ref.candidates[0]!;
      const { startMs, endMs } = instantRange(first.start, first.end, tz);
      nearest = store.neighbours(startMs, endMs);
    }

    return {
      text: ref.text,
      hits: withEpisodes.map((r) => ({ range: r.range, episodes: present(r.episodes) })),
      empty: readings.filter((r) => !r.episodes.length).map((r) => r.range),
      nearest,
    };
  });

  let related: Recalled[] = [];
  if (terms.length && !refs.some((r) => r.hits.length)) {
    const needed = Math.min(2, terms.length);
    const ids = [...coverage.entries()].filter(([id, n]) => n >= needed && !inChat.has(id)).map(([id]) => id);
    const episodes = store
      .episodesById(ids)
      .sort((a, b) => coverage.get(b.id)! - coverage.get(a.id)! || b.askedAt - a.askedAt)
      .slice(0, RELATED_LIMIT);
    related = present(episodes);
  }

  return { refs, related, ms: performance.now() - started };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function renderEpisode({ episode, claims, detail }: Recalled, tz: string): string {
  const head = `[E${episode.id}] ${formatInstant(episode.askedAt, tz)}`;
  const question = `"${clip(oneLine(episode.question), 300)}"`;
  if (detail === "in-chat") return `${head} — the user asked ${question} (this is in the current chat, above)`;
  if (detail === "pointer") return `${head} — the user asked ${question}`;

  const lines = [`${head}`, `  The user asked: ${question}`];
  if (episode.summary) lines.push(`  Summary: ${episode.summary}`);
  // With claims in hand the answer text is only needed for tone and framing.
  lines.push(`  Your answer then: ${clip(oneLine(episode.answer), claims.length ? 1200 : 3000)}`);
  if (claims.length) {
    lines.push("  Claims you made then:");
    for (const c of claims) {
      lines.push(`    - (C${c.id}) ${c.entity} · ${c.attribute}: ${c.value}${c.sourceUrl ? ` — source: ${c.sourceUrl}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** The MEMORY block the model sees. Empty string when there is nothing to say. */
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
          `${quoted} is ambiguous: it could mean ${labels}, and each has conversations. Pick the one that fits the message and say which you used.`,
          ...ref.hits.flatMap((h) => [`${h.range.label}:`, ...h.episodes.map((e) => renderEpisode(e, tz))]),
        ].join("\n"),
      );
    } else {
      const checked = ref.empty.map((r) => r.label).join(" or ");
      const nearest = ref.nearest.length
        ? `Nearest conversations: ${ref.nearest
            .map((e) => `[E${e.id}] ${formatInstant(e.askedAt, tz)} — "${clip(oneLine(e.question), 160)}"`)
            .join("; ")}.`
        : "The log holds no conversations before this chat.";
      blocks.push(`${quoted} → ${checked}: no conversations found then. ${nearest}`);
    }
  }

  if (result.related.length) {
    blocks.push(
      ["Possibly related, matched by topic rather than date:", ...result.related.map((e) => renderEpisode(e, tz))].join("\n"),
    );
  }

  return blocks.join("\n\n");
}
