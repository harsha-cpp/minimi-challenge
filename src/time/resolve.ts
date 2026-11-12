/**
 * Turns the date words in a message ("last Tuesday", "3 November", "two weeks
 * ago") into calendar-day ranges, in code.
 *
 * Why not let the model do it: date arithmetic is exactly what models get
 * subtly wrong, it costs a round trip, and it cannot be unit-tested. Here the
 * rules are a table, the output is exact, and the cost is microseconds.
 *
 * Two decisions shape the rules:
 *  - Memory references point backward. "On Monday" means the Monday that
 *    already happened; anything that resolves to the future is not a memory
 *    reference and is dropped.
 *  - Ambiguity is returned, not hidden. "Last Tuesday", said on a Wednesday,
 *    can mean yesterday or the Tuesday of last week. Both come back as
 *    candidates and recall picks the one that actually has a conversation.
 */
import { type LocalDate, addDays, compareDates, formatDate, isRealDate, localDate, weekday } from "./zone.ts";

/** Local calendar days `start` through `end`, inclusive. */
export interface DayRange {
  start: LocalDate;
  end: LocalDate;
  label: string;
}

export interface TemporalRef {
  /** The words that were matched, as written. */
  text: string;
  /** Most likely reading first. More than one means the phrase is ambiguous. */
  candidates: DayRange[];
}

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
// Short forms that are also ordinary words ("sat", "sun", "wed", "mon") are left out.
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues?|thur?s?|fri";
const QUANTITY = "an?|one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,3}|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few";

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const monthOf = (word: string) => MONTH_KEYS.indexOf(word.slice(0, 3)) + 1;
const weekdayOf = (word: string) => WEEKDAY_KEYS.indexOf(word.slice(0, 3));

const day = (date: LocalDate): DayRange => ({ start: date, end: date, label: formatDate(date) });
const span = (start: LocalDate, end: LocalDate, label?: string): DayRange => ({
  start,
  end,
  label: label ?? `${formatDate(start)} – ${formatDate(end)}`,
});

/** Weeks run Monday to Sunday. */
const mondayOf = (date: LocalDate) => addDays(date, -((weekday(date) + 6) % 7));

/** A day and month with no year means the most recent one that has happened. */
function mostRecent(m: number, d: number, today: LocalDate): LocalDate | null {
  for (const y of [today.y, today.y - 1]) {
    const date = { y, m, d };
    if (isRealDate(date) && compareDates(date, today) <= 0) return date;
  }
  return null;
}

function explicitDate(y: number | undefined, m: number, d: number, today: LocalDate): DayRange[] | null {
  const date = y ? { y, m, d } : mostRecent(m, d, today);
  if (!date || !isRealDate(date) || compareDates(date, today) > 0) return null;
  return [day(date)];
}

function wholeMonth(y: number, m: number, today: LocalDate): DayRange[] | null {
  const start = { y, m, d: 1 };
  if (compareDates(start, today) > 0) return null;
  const last = addDays({ y: m === 12 ? y + 1 : y, m: m === 12 ? 1 : m + 1, d: 1 }, -1);
  return [span(start, compareDates(last, today) > 0 ? today : last)];
}

function namedWeekday(prefix: string | undefined, target: number, today: LocalDate): DayRange[] | null {
  if (prefix === "next" || prefix === "coming") return null;
  const daysBack = (weekday(today) - target + 7) % 7;

  if (prefix === "this") {
    // "This Friday" on a Wednesday has not happened yet.
    const inThisWeek = addDays(mondayOf(today), (target + 6) % 7);
    return compareDates(inThisWeek, today) <= 0 ? [day(inThisWeek)] : null;
  }

  if (prefix) {
    // "Last Tuesday": the most recent one, or the one in last week when the
    // most recent one is still in this week. People use both; the stricter
    // reading goes first because "yesterday" exists for the looser one.
    const mostRecentOne = addDays(today, -(daysBack || 7));
    const stillThisWeek = compareDates(mostRecentOne, mondayOf(today)) >= 0;
    return stillThisWeek ? [day(addDays(mostRecentOne, -7)), day(mostRecentOne)] : [day(mostRecentOne)];
  }

  // Bare "on Monday". Said on a Monday it usually means a week ago, since
  // "today" exists, but today stays a candidate.
  return daysBack === 0 ? [day(addDays(today, -7)), day(today)] : [day(addDays(today, -daysBack))];
}

function ago(quantity: string, unit: string, today: LocalDate): DayRange[] {
  const q = quantity.replace(/\s+/g, " ");
  const vague = q.includes("couple") || q.includes("few");
  const n = q.includes("couple") ? 2 : q.includes("few") ? 3 : (NUMBER_WORDS[q] ?? Number(q));
  if (unit === "day") {
    return vague ? [span(addDays(today, -n - 1), addDays(today, -n + 1))] : [day(addDays(today, -n))];
  }
  // "Two weeks ago" is rarely exact to the day, so these become small windows.
  const center = unit === "week" ? n * 7 : n * 30;
  const slack = unit === "week" ? (vague ? 5 : 2) : 7;
  return [span(addDays(today, -center - slack), addDays(today, -center + slack))];
}

interface Rule {
  pattern: RegExp;
  /** Null means "recognised, but not a reference to the past". */
  resolve(match: RegExpExecArray, today: LocalDate): DayRange[] | null;
}

// Order matters: specific forms come first, and whatever a rule matches is
// blanked out so a later, looser rule cannot match inside it.
const RULES: Rule[] = [
  {
    pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g,
    resolve: (m, today) => explicitDate(Number(m[1]), Number(m[2]), Number(m[3]), today),
  },
  {
    // 3 November, 3rd of Nov 2026
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, "g"),
    resolve: (m, today) => explicitDate(m[3] ? Number(m[3]) : undefined, monthOf(m[2]!), Number(m[1]), today),
  },
  {
    // November 3, Nov 3rd, 2026
    pattern: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "g"),
    resolve: (m, today) => explicitDate(m[3] ? Number(m[3]) : undefined, monthOf(m[1]!), Number(m[2]), today),
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{4})\\b`, "g"),
    resolve: (m, today) => wholeMonth(Number(m[2]), monthOf(m[1]!), today),
  },
  {
    // "on the 3rd": the most recent 3rd
    pattern: /\b(?:on|since)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/g,
    resolve: (m, today) => {
      const d = Number(m[1]);
      for (let back = 0; back < 3; back++) {
        const shifted = new Date(Date.UTC(today.y, today.m - 1 - back, 1));
        const date = { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d };
        if (isRealDate(date) && compareDates(date, today) <= 0) return [day(date)];
      }
      return null;
    },
  },
  {
    pattern: new RegExp(`\\b(${WEEKDAY})\\s+(?:of\\s+)?last\\s+week\\b`, "g"),
    resolve: (m, today) => [day(addDays(mondayOf(today), -7 + ((weekdayOf(m[1]!) + 6) % 7)))],
  },
  {
    pattern: new RegExp(`\\blast\\s+week(?:'s)?\\s+(?:on\\s+)?(${WEEKDAY})\\b`, "g"),
    resolve: (m, today) => [day(addDays(mondayOf(today), -7 + ((weekdayOf(m[1]!) + 6) % 7)))],
  },
  {
    // The lookahead keeps "monday.com" and "Monday CRM" from reading as a day.
    pattern: new RegExp(`\\b(?:(last|this|past|previous|next|coming)\\s+)?(${WEEKDAY})\\b(?!\\.\\w|\\s+crm)`, "g"),
    resolve: (m, today) => namedWeekday(m[1] === "past" || m[1] === "previous" ? "last" : m[1], weekdayOf(m[2]!), today),
  },
  { pattern: /\b(?:the\s+)?day\s+before\s+yesterday\b/g, resolve: (_m, today) => [day(addDays(today, -2))] },
  { pattern: /\b(?:yesterday|last\s+night)\b/g, resolve: (_m, today) => [day(addDays(today, -1))] },
  { pattern: /\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/g, resolve: (_m, today) => [day(today)] },
  {
    pattern: new RegExp(`\\b(${QUANTITY})\\s+(day|week|month)s?\\s+(?:ago|back)\\b`, "g"),
    resolve: (m, today) => ago(m[1]!, m[2]!, today),
  },
  {
    pattern: /\blast\s+week\b/g,
    resolve: (_m, today) => [span(addDays(mondayOf(today), -7), addDays(mondayOf(today), -1))],
  },
  { pattern: /\bthis\s+week\b/g, resolve: (_m, today) => [span(mondayOf(today), today)] },
  {
    pattern: /\b(?:recently|lately|the\s+other\s+day|past\s+week|(?:last|past)\s+(?:few|couple\s+of)\s+days)\b/g,
    resolve: (_m, today) => [span(addDays(today, -7), today, "the last 7 days")],
  },
  {
    pattern: /\blast\s+month\b/g,
    resolve: (_m, today) => {
      const end = addDays({ y: today.y, m: today.m, d: 1 }, -1);
      return [span({ y: end.y, m: end.m, d: 1 }, end)];
    },
  },
  { pattern: /\bthis\s+month\b/g, resolve: (_m, today) => [span({ y: today.y, m: today.m, d: 1 }, today)] },
  {
    // "in October", "last March". A bare month name is too often just a word.
    pattern: new RegExp(`\\b(in|during|last|this)\\s+(${MONTH})\\b`, "g"),
    resolve: (m, today) => {
      const month = monthOf(m[2]!);
      const lastYear = month > today.m || (m[1] === "last" && month === today.m);
      return wholeMonth(lastYear ? today.y - 1 : today.y, month, today);
    },
  },
];

export function resolveTemporal(message: string, now: Date, tz: string): TemporalRef[] {
  const today = localDate(now, tz);
  let text = message.toLowerCase();
  const found: Array<TemporalRef & { index: number }> = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    const spans: Array<[number, number]> = [];
    while ((match = rule.pattern.exec(text))) {
      spans.push([match.index, match.index + match[0].length]);
      const candidates = rule.resolve(match, today);
      if (candidates?.length) {
        found.push({ index: match.index, text: message.slice(match.index, match.index + match[0].length), candidates });
      }
    }
    for (const [from, to] of spans) {
      text = text.slice(0, from) + " ".repeat(to - from) + text.slice(to);
    }
  }

  return found.sort((a, b) => a.index - b.index).map(({ text, candidates }) => ({ text, candidates }));
}
