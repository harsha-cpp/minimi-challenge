import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { citationTextNodes } from "../public/citations.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace('import { citationTextNodes } from "./citations.js";\n', "");

async function mount(options: { date?: Date; post?: (body: { now: string | null }) => Promise<Response>; chatEvents?: Array<Record<string, unknown>>; memoryEpisodes?: Array<Record<string, unknown>> } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:3000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const state = { now: (options.date ?? new Date(2026, 10, 13, 15, 0)).toISOString(), simulated: false, missing: [], model: "test", episodes: 0 };
  const requests: Array<{ now: string | null }> = [];
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(window, { marked, DOMPurify: createDOMPurify(window), citationTextNodes, TextDecoderStream,
    fetch: async (path: string, init?: RequestInit) => {
      if (path === "/api/state") return Response.json(state);
      if (path === "/api/chat" && options.chatEvents) return new Response(options.chatEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      if (path === "/api/memory" && options.memoryEpisodes) return Response.json({ episodes: options.memoryEpisodes });
      assert.equal(path, "/api/clock");
      const body = JSON.parse(String(init?.body)) as { now: string | null };
      requests.push(body);
      if (options.post) return options.post(body);
      return Response.json({ ...state, now: body.now ?? new Date().toISOString(), simulated: body.now !== null });
    },
  });
  await window.eval(`(async () => { ${app}\n})()`);
  const button = (selector: string) => window.document.querySelector(selector) as HTMLButtonElement;
  const choose = (period: "month" | "year", value: number) => {
    if (button(`#cal-${period}`).getAttribute("aria-expanded") !== "true") button(`#cal-${period}`).click();
    button(`#cal-options button[data-value="${value}"]`).click();
  };
  const form = window.document.getElementById("clock") as HTMLFormElement;
  return { dom, window, requests, form, button, choose, open: () => button("#stamp").click(), travel: () => button('#clock button[type="submit"]').click() };
}

test("month navigation submits the visible month without requiring a second day click", async () => {
  const ui = await mount();
  try {
    ui.open();
    ui.button("#cal-prev").click();
    assert.equal(ui.button("#cal-month").textContent, "October");
    assert.equal(ui.button("#cal-year").textContent, "2026");
    assert.match(ui.window.document.getElementById("clock-summary")!.textContent!, /13 Oct 2026/);
    assert.equal(ui.button('#cal-grid button[aria-pressed="true"]').textContent, "13");
    ui.travel();
    await nextTurn();
    assert.deepEqual(ui.requests, [{ now: new Date(2026, 9, 13, 15, 0).toISOString() }]);
    assert.match(ui.button("#stamp").textContent!, /Simulated.*13 Oct 2026/);
    assert.equal(ui.form.hidden, true);
  } finally { ui.dom.window.close(); }
});

test("era simulation explains live research without a corpus or archive requirement", async () => {
  const ui = await mount({ date: new Date(1948, 0, 14, 12) });
  try {
    ui.open();
    const help = ui.window.document.getElementById("clock-coverage")!;
    assert.equal(help.hidden, false);
    assert.match(help.textContent!, /Era simulation uses live web research/);
    assert.match(help.textContent!, /Later outcomes stay unknown/);
    assert.doesNotMatch(ui.form.textContent!, /Snapshot|preserved page|Historical library|reviewed source|coverage varies/);
  } finally { ui.dom.window.close(); }
});

test("obsolete capture failures never reappear as actionable website errors", async () => {
  const failure = "I could not verify this as of 1948-01-14T08:17:10.442Z. No matching preserved evidence was returned for this question. Exa Snapshot was unavailable (HTTP 403); check the key's access, quota and supported dates.";
  const ui = await mount({ chatEvents: [
    { type: "search", id: "old-mode", query: "Historical source lookup", state: "failed", code: "snapshot_access_denied", message: failure },
    { type: "verification", state: "unavailable", ms: 10 },
    { type: "text", delta: failure },
    { type: "done", episodeId: 1, cited: [], timings: { recallMs: 0, searches: 1, firstTokenMs: 10, totalMs: 20 } },
  ] });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = "Will India get independence?";
    ui.button("#send").click();
    await nextTurn();
    const answer = ui.window.document.querySelector(".answer")!;
    assert.match(answer.textContent!, /older simulation mode.*Ask again/);
    assert.doesNotMatch(answer.textContent!, /Snapshot|HTTP 403|access|quota/);
    const trace = ui.window.document.querySelector(".trace")!;
    assert.match(trace.textContent!, /lookup unsuccessful/);
    assert.match(trace.textContent!, /review unavailable/);
    assert.doesNotMatch(trace.querySelector("li")!.getAttribute("title")!, /Snapshot|HTTP 403|quota/);
  } finally { ui.dom.window.close(); }
});

test("the ledger retains era answers and citations without presenting them as verified claims", async () => {
  const source = { n: 1, title: "Independence history", url: "https://example.com/independence" };
  const ui = await mount({ memoryEpisodes: [{
    id: 1, askedAt: new Date(1948, 0, 14, 12).getTime(), question: "Will India get independence?",
    answer: "India became independent on **15 August 1947**. [1]", sources: [source],
    execution: { simulation: { mode: "era", review: "pass" } }, claims: [], verifiedStatements: [],
  }] });
  try {
    ui.button("#open-ledger").click();
    await nextTurn();
    const ledger = ui.window.document.getElementById("ledger")!;
    assert.equal(ledger.hidden, false);
    assert.match(ledger.textContent!, /Era simulation/);
    const answer = ledger.querySelector(".simulation-answer")!;
    assert.match(answer.textContent!, /India became independent on 15 August 1947/);
    assert.equal(answer.querySelector("strong")!.textContent, "15 August 1947");
    assert.equal(answer.querySelector("a.cite")!.getAttribute("href"), source.url);
    assert.doesNotMatch(ledger.textContent!, /source checked|verified claim/i);
  } finally { ui.dom.window.close(); }
});

test("modern source dates are identified as publication dates beside a simulated answer", async () => {
  const source = { n: 1, title: "Independence history", url: "https://example.com/independence", publishedDate: "2026-01-01" };
  const ui = await mount({ date: new Date(1948, 0, 14, 12), chatEvents: [
    { type: "sources", sources: [source] },
    { type: "text", delta: "India became independent in 1947. [1]" },
    { type: "done", episodeId: 1, cited: [1], timings: { recallMs: 0, searches: 1, firstTokenMs: 10, totalMs: 20 } },
  ] });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = "Will India get independence?";
    ui.button("#send").click();
    await nextTurn();
    assert.equal(ui.window.document.querySelector(".sources .date")!.textContent, "published 2026-01-01");
    assert.equal(ui.window.document.querySelector(".answer a.cite")!.getAttribute("href"), source.url);
  } finally { ui.dom.window.close(); }
});

for (const [initial, target, navigation] of [
  [new Date(2026, 0, 31, 12), new Date(2026, 1, 28, 12), "#cal-next"],
  [new Date(2024, 0, 31, 12), new Date(2024, 1, 29, 12), "#cal-next"],
  [new Date(2026, 11, 31, 12), new Date(2027, 0, 31, 12), "#cal-next"],
  [new Date(2026, 2, 31, 12), new Date(2026, 1, 28, 12), "#cal-prev"],
] as const) {
  test(`month navigation clamps the selected day at month/year boundaries: ${initial.toISOString()}`, async () => {
    const ui = await mount({ date: initial });
    try {
      ui.open(); ui.button(navigation).click(); ui.travel(); await nextTurn();
      assert.equal(ui.requests[0]!.now, target.toISOString());
    } finally { ui.dom.window.close(); }
  });
}

test("an explicitly selected day is applied to the live stamp", async () => {
  const ui = await mount();
  try {
    ui.open();
    ui.button('#cal-grid button[aria-label="Tue, 3 Nov 2026"]').click();
    ui.travel(); await nextTurn();
    assert.equal(ui.requests[0]!.now, new Date(2026, 10, 3, 15).toISOString());
    assert.match(ui.button("#stamp").textContent!, /Simulated.*3 Nov 2026/);
  } finally { ui.dom.window.close(); }
});

test("failed clock updates remain visible, preserve the stamp and allow retry", async () => {
  let release!: (response: Response) => void;
  const ui = await mount({ post: async () => new Promise<Response>(resolve => { release = resolve; }) });
  try {
    ui.open(); ui.button("#cal-prev").click(); ui.travel();
    assert.equal(ui.form.getAttribute("aria-busy"), "true");
    assert.equal(ui.button('#clock button[type="submit"]').disabled, true);
    assert.equal(ui.button("#cal-prev").disabled, true);
    assert.equal(ui.button("#cal-month").disabled, true);
    assert.equal(ui.button("#cal-year").disabled, true);
    ui.travel(); assert.equal(ui.requests.length, 1);
    release(Response.json({ error: "Invalid date." }, { status: 400 }));
    await nextTurn();
    const error = ui.window.document.getElementById("clock-error")!;
    assert.equal(error.hidden, false);
    assert.match(error.textContent!, /Could not change the date.*Invalid date/);
    assert.equal(ui.form.hidden, false);
    assert.equal(ui.button('#clock button[type="submit"]').disabled, false);
    assert.match(ui.button("#stamp").textContent!, /13 Nov 2026/);
    assert.doesNotMatch(ui.button("#stamp").textContent!, /Simulated/);
  } finally { ui.dom.window.close(); }
});

test("month and year can jump decades while preserving the selected day and time", async () => {
  const ui = await mount();
  try {
    ui.open();
    ui.choose("year", 1998);
    ui.choose("month", 6);
    assert.match(ui.window.document.getElementById("clock-summary")!.textContent!, /13 Jul 1998/);
    ui.travel(); await nextTurn();
    assert.equal(ui.requests[0]!.now, new Date(1998, 6, 13, 15).toISOString());
    ui.open();
    assert.equal(ui.button("#cal-month").textContent, "July");
    assert.equal(ui.button("#cal-year").textContent, "1998");
  } finally { ui.dom.window.close(); }
});

test("direct month and year changes clamp leap days and month endings", async () => {
  const ui = await mount({ date: new Date(2024, 0, 31, 12) });
  try {
    ui.open(); ui.choose("month", 1);
    assert.equal(ui.button('#cal-grid button[aria-pressed="true"]').textContent, "29");
    ui.choose("year", 2023);
    assert.equal(ui.button('#cal-grid button[aria-pressed="true"]').textContent, "28");
    ui.travel(); await nextTurn();
    assert.equal(ui.requests[0]!.now, new Date(2023, 1, 28, 12).toISOString());
  } finally { ui.dom.window.close(); }
});

test("custom year and month menus guide selection without submitting Travel", async () => {
  const ui = await mount();
  try {
    ui.open();
    ui.button("#cal-year").click();
    assert.equal(ui.window.document.getElementById("cal-grid")!.hidden, true);
    assert.equal(ui.button('#cal-options button[aria-pressed="true"]').textContent, "2026");
    ui.choose("year", 2010);
    assert.equal(ui.button("#cal-month").getAttribute("aria-expanded"), "true");
    assert.equal(ui.window.document.querySelectorAll("#cal-options button").length, 12);
    ui.choose("month", 10);
    assert.match(ui.window.document.getElementById("clock-summary")!.textContent!, /13 Nov 2010/);
    assert.equal(ui.window.document.activeElement?.getAttribute("aria-pressed"), "true");
    assert.equal(ui.requests.length, 0);
    assert.equal(ui.form.hidden, false);
    assert.equal(ui.window.document.getElementById("cal-options")!.hidden, true);
    ui.travel(); await nextTurn();
    assert.equal(ui.requests[0]!.now, new Date(2010, 10, 13, 15).toISOString());
  } finally { ui.dom.window.close(); }
});

test("custom year options support keyboard navigation and Escape returns focus", async () => {
  const ui = await mount();
  try {
    ui.open();
    ui.button("#cal-year").click();
    assert.equal(ui.window.document.activeElement?.textContent, "2026");
    const key = (key: string) => ui.window.document.activeElement!.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    key("ArrowDown");
    assert.equal(ui.window.document.activeElement?.textContent, "2022");
    key("Escape");
    assert.equal(ui.window.document.activeElement?.id, "cal-year");
    assert.equal(ui.window.document.getElementById("cal-options")!.hidden, true);
    assert.equal(ui.form.hidden, false);
    key("Escape");
    assert.equal(ui.form.hidden, true);
    assert.equal(ui.requests.length, 0);
  } finally { ui.dom.window.close(); }
});

test("earlier year options can extend the history without changing the selected date", async () => {
  const ui = await mount();
  try {
    ui.open(); ui.button("#cal-year").click();
    assert.equal(ui.window.document.querySelector('#cal-options button[data-value="1899"]'), null);
    ui.button("#cal-earlier").click();
    assert.match(ui.window.document.getElementById("clock-summary")!.textContent!, /13 Nov 2026/);
    ui.choose("year", 1899);
    ui.travel(); await nextTurn();
    assert.match(ui.requests[0]!.now!, /^1899-11-13T/);
  } finally { ui.dom.window.close(); }
});

test("years below 100 do not silently travel to the twentieth century", async () => {
  const date = new Date(2026, 10, 13, 15);
  date.setFullYear(99);
  const ui = await mount({ date });
  try {
    ui.open(); ui.choose("year", 98);
    ui.travel(); await nextTurn();
    assert.match(ui.requests[0]!.now!, /^0098-11-13T/);
  } finally { ui.dom.window.close(); }
});

test("network failures are handled without closing the date picker", async () => {
  const ui = await mount({ post: async () => { throw new TypeError("Failed to fetch"); } });
  try {
    ui.open(); ui.travel(); await nextTurn();
    assert.equal(ui.form.hidden, false);
    assert.match(ui.window.document.getElementById("clock-error")!.textContent!, /Could not change the date/);
    assert.equal(ui.form.hasAttribute("aria-busy"), false);
  } finally { ui.dom.window.close(); }
});

test("return to now clears simulated mode", async () => {
  const ui = await mount();
  try {
    ui.open(); ui.button("#cal-prev").click(); ui.travel(); await nextTurn();
    ui.open(); ui.button("#clock-reset").click(); await nextTurn();
    assert.deepEqual(ui.requests[1], { now: null });
    assert.doesNotMatch(ui.button("#stamp").textContent!, /Simulated/);
    assert.equal(ui.form.hidden, true);
  } finally { ui.dom.window.close(); }
});
