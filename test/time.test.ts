import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTemporal } from "../src/time/resolve.ts";
import { formatInstant, instantRange, isoDate, startOfDay } from "../src/time/zone.ts";

const TZ = "Asia/Kolkata";
// Wednesday 11 November 2026, 23:44 in Bengaluru.
const NOW = new Date("2026-11-11T23:44:00+05:30");

/** Each reference as "start..end | start..end" (candidates), or a single date when start = end. */
function resolve(message: string, now = NOW, tz = TZ): string[] {
  return resolveTemporal(message, now, tz).map((ref) =>
    ref.candidates
      .map((c) => (isoDate(c.start) === isoDate(c.end) ? isoDate(c.start) : `${isoDate(c.start)}..${isoDate(c.end)}`))
      .join(" | "),
  );
}

test("the three questions from the brief", () => {
  assert.deepEqual(resolve("On Monday we shortlisted 5 CRM tools for a 20-person sales team."), ["2026-11-09"]);
  assert.deepEqual(resolve("What did I ask you on 3 November? Is your answer still correct today?"), [
    "2026-11-03",
    "2026-11-11",
  ]);
  // Ambiguous on a Wednesday: the Tuesday of last week, or yesterday.
  assert.deepEqual(resolve("Last Tuesday I asked you about Postgres hosting."), ["2026-11-03 | 2026-11-10"]);
});

test("weekdays point backward", () => {
  assert.deepEqual(resolve("last Friday"), ["2026-11-06"]);
  assert.deepEqual(resolve("what did we decide on Sunday?"), ["2026-11-08"]);
  assert.deepEqual(resolve("on Wednesday you said"), ["2026-11-04 | 2026-11-11"]);
  assert.deepEqual(resolve("this Monday"), ["2026-11-09"]);
  assert.deepEqual(resolve("Tuesday of last week"), ["2026-11-03"]);
});

test("the future is not a memory reference", () => {
  assert.deepEqual(resolve("remind me next Monday"), []);
  assert.deepEqual(resolve("the launch is this Friday"), []);
  assert.deepEqual(resolve("it ships on 2027-01-05"), []);
});

test("product names are not days", () => {
  assert.deepEqual(resolve("has monday.com changed its pricing?"), []);
  assert.deepEqual(resolve("compare Monday CRM with Pipedrive"), []);
});

test("explicit dates", () => {
  for (const phrase of ["3 November", "3rd of November", "Nov 3", "November 3rd, 2026", "2026-11-03", "3 Nov 2026"]) {
    assert.deepEqual(resolve(`what did I ask on ${phrase}?`), ["2026-11-03"], phrase);
  }
  // No year, and this year's date has not happened yet: last year's.
  assert.deepEqual(resolve("on 25 December"), ["2025-12-25"]);
  assert.deepEqual(resolve("on 31 February"), []);
  assert.deepEqual(resolve("on the 3rd"), ["2026-11-03"]);
});

test("relative phrases", () => {
  assert.deepEqual(resolve("yesterday"), ["2026-11-10"]);
  assert.deepEqual(resolve("the day before yesterday"), ["2026-11-09"]);
  assert.deepEqual(resolve("3 days ago"), ["2026-11-08"]);
  assert.deepEqual(resolve("two weeks ago"), ["2026-10-26..2026-10-30"]);
  assert.deepEqual(resolve("last week"), ["2026-11-02..2026-11-08"]);
  assert.deepEqual(resolve("earlier this week"), ["2026-11-09..2026-11-11"]);
  assert.deepEqual(resolve("last month"), ["2026-10-01..2026-10-31"]);
  assert.deepEqual(resolve("in October"), ["2026-10-01..2026-10-31"]);
  assert.deepEqual(resolve("back in December"), ["2025-12-01..2025-12-31"]);
});

test("the matched words are reported as written, in order", () => {
  const refs = resolveTemporal("Last Tuesday and again on 9 Nov", NOW, TZ);
  assert.deepEqual(refs.map((r) => r.text), ["Last Tuesday", "9 Nov"]);
});

test("'today' depends on the user's timezone, not the server's", () => {
  // 20:00 UTC on the 11th is already 01:30 on the 12th in Bengaluru, and still the 11th in New York.
  const instant = new Date("2026-11-11T20:00:00Z");
  assert.deepEqual(resolve("yesterday", instant, "Asia/Kolkata"), ["2026-11-11"]);
  assert.deepEqual(resolve("yesterday", instant, "America/New_York"), ["2026-11-10"]);
});

test("local days convert to the right instants", () => {
  const day = { y: 2026, m: 11, d: 3 };
  assert.equal(new Date(startOfDay(day, TZ)).toISOString(), "2026-11-02T18:30:00.000Z");
  const { startMs, endMs } = instantRange(day, day, TZ);
  assert.equal(endMs - startMs, 24 * 3600_000);
  assert.equal(formatInstant(Date.parse("2026-11-03T08:35:00Z"), TZ), "Tue 3 Nov 2026, 14:05");
});

test("days that change clocks are 23 or 25 hours long", () => {
  // US clocks go forward on 8 March 2026.
  const springForward = { y: 2026, m: 3, d: 8 };
  const { startMs, endMs } = instantRange(springForward, springForward, "America/New_York");
  assert.equal(new Date(startMs).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal((endMs - startMs) / 3600_000, 23);
});
