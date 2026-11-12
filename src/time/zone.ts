/**
 * Calendar-day arithmetic in the user's timezone.
 *
 * "On 3 November" means a local calendar day, while memory stores UTC
 * instants. These helpers convert between the two using only Intl, so there is
 * no date library to install.
 */

/** A calendar date with no time or zone. `m` is 1–12. */
export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(ms: number, tz: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Falls back to the machine's zone when the browser sends something unusable. */
export function validTimeZone(tz: string | undefined): string {
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      // fall through
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function localDate(instant: Date | number, tz: string): LocalDate {
  const w = wallClock(typeof instant === "number" ? instant : instant.getTime(), tz);
  return { y: w.year, m: w.month, d: w.day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** True when y-m-d names a real day (rejects 31 February). */
export function isRealDate(date: LocalDate): boolean {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return t.getUTCFullYear() === date.y && t.getUTCMonth() === date.m - 1 && t.getUTCDate() === date.d;
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant at which this local day begins. */
export function startOfDay(date: LocalDate, tz: string): number {
  const asUtc = Date.UTC(date.y, date.m - 1, date.d);
  // The offset depends on the instant we are solving for; a second pass settles
  // days where a DST change sits between the guess and the answer.
  const first = asUtc - offsetAt(asUtc, tz);
  return asUtc - offsetAt(first, tz);
}

/** Half-open UTC range covering the local days `start` through `end` inclusive. */
export function instantRange(start: LocalDate, end: LocalDate, tz: string): { startMs: number; endMs: number } {
  return { startMs: startOfDay(start, tz), endMs: startOfDay(addDays(end, 1), tz) };
}

/** "Tue 3 Nov 2026" */
export function formatDate(date: LocalDate): string {
  return `${WEEKDAYS[weekday(date)]} ${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

/** "Tue 3 Nov 2026, 14:05" */
export function formatInstant(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  const time = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  return `${formatDate({ y: w.year, m: w.month, d: w.day })}, ${time}`;
}

/** "2026-11-03" */
export function isoDate(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}
