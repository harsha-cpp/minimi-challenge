import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { readTurn } from "../public/recovery.js";
import { citationTextNodes } from "../public/citations.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace('import { citationTextNodes } from "./citations.js";\n', "").replace('import { readTurn } from "./recovery.js";\n', "");

async function mount(options: { fastMode?: boolean; date?: Date; post?: (body: { now: string | null }) => Promise<Response>; chatEvents?: Array<Record<string, unknown>>; chatReplies?: Array<Array<Record<string, unknown>> | { status: number; error: string; code: string }>; pendingCard?: Record<string, unknown>; memoryEpisodes?: Array<Record<string, unknown>>; savedSession?: string; turnReplies?: Array<Record<string, unknown>>; pendingTurn?: Record<string, unknown>; chatBeforeHeadersFailure?: boolean; beforeChatReply?: () => Promise<void> } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:3000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  if (options.savedSession) window.sessionStorage.setItem("asof.preview.session.v2", options.savedSession);
  if (options.pendingTurn) window.sessionStorage.setItem("asof.pending.turn", JSON.stringify(options.pendingTurn));
  const state = { now: (options.date ?? new Date(2026, 10, 13, 15, 0)).toISOString(), simulated: false, missing: [], model: "test", episodes: 0, features: { clarifications: Boolean(options.pendingCard), fastMode: Boolean(options.fastMode) } };
  const requests: Array<{ now: string | null }> = [];
  const chatRequests: Array<Record<string, unknown>> = [];
  const chatKeys: string[] = [];
  const turnRequests: string[] = [];
  let turnReads = 0;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(window, { marked, DOMPurify: createDOMPurify(window), citationTextNodes, readTurn, TextDecoderStream,
    fetch: async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/turns/")) {
        turnRequests.push(path);
        if (init?.method === "POST") return Response.json({ ok: true });
        const reply = options.turnReplies?.[Math.min(turnReads++, (options.turnReplies?.length ?? 1) - 1)];
        if (!reply) throw new Error("No recovery response configured");
        return Response.json(reply, { status: typeof reply.status === "number" ? reply.status : 200 });
      }
      if (path.startsWith("/api/state")) return Response.json(state);
      if (path.endsWith("/clarification")) return Response.json({ card: options.pendingCard ?? null });
      if (path.startsWith("/api/sessions/")) return Response.json({ episodes: (options.memoryEpisodes ?? []).filter(episode => episode.sessionId === path.split("/").at(-1)).map(episode => ({ episode, sources: episode.sources ?? [] })) });
      if (path.startsWith("/api/episodes/")) { const episode = options.memoryEpisodes?.find(episode => String(episode.id) === path.split("/").at(-1)); return Response.json({ episode, sources: episode?.sources ?? [] }); }
      if (path === "/api/chat" && (options.chatEvents || options.chatReplies)) {
        chatRequests.push(JSON.parse(String(init?.body)));
        chatKeys.push((init!.headers as Record<string, string>)["idempotency-key"]!);
        await options.beforeChatReply?.();
        if (options.chatBeforeHeadersFailure && chatRequests.length === 1) throw new TypeError("Lost response before headers");
        const reply = options.chatReplies?.[chatRequests.length - 1] ?? options.chatEvents ?? [];
        return Array.isArray(reply) ? new Response(reply.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")) : Response.json(reply, { status: reply.status });
      }
      if (path === "/api/memory" && options.memoryEpisodes) return Response.json({ episodes: options.memoryEpisodes });
      assert.equal(path, "/api/clock");
      const body = JSON.parse(String(init?.body)) as { now: string | null };
      assert.equal(typeof (body as any).sessionId, "string");
      requests.push({ now: body.now });
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
  return { dom, window, requests, chatRequests, chatKeys, turnRequests, form, button, choose, open: () => button("#stamp").click(), travel: () => button('#clock button[type="submit"]').click() };
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

test("calendar blocks future days, months and years while allowing earlier periods", async () => {
  const now = new Date(), ui = await mount({ date: now });
  try {
    ui.open(); assert.equal(ui.button("#cal-next").disabled, true);
    for (const button of ui.window.document.querySelectorAll<HTMLButtonElement>("#cal-grid button")) {
      assert.equal(button.disabled, Number(button.textContent) > now.getDate());
    }
    ui.button("#cal-month").click();
    for (const button of ui.window.document.querySelectorAll<HTMLButtonElement>("#cal-options button")) {
      assert.equal(button.disabled, Number(button.dataset.value) > now.getMonth());
    }
    ui.button("#cal-year").click();
    assert.ok([...ui.window.document.querySelectorAll<HTMLButtonElement>("#cal-options button")].every(button => Number(button.dataset.value) <= now.getFullYear()));
    ui.choose("year", now.getFullYear() - 1); ui.choose("month", 11);
    assert.equal(ui.button("#cal-next").disabled, false);
    ui.travel(); await nextTurn();
    assert.equal(ui.requests.length, 1);
    // Reopening and changing back to this year must not carry December into the future.
    ui.open(); ui.choose("year", now.getFullYear());
    assert.equal(ui.button("#cal-month").textContent, now.toLocaleDateString("en-GB", { month: "long" }));
    assert.equal(ui.button("#cal-next").disabled, true);
  } finally { ui.dom.window.close(); }
});

test("future time on today's date is rejected before sending a clock change", async () => {
  const now = new Date(), ui = await mount({ date: now });
  try {
    ui.open();
    const noon = new Date(now); noon.setHours(12, 0, 0, 0);
    ui.window.Date.now = () => noon.getTime();
    for (const [id, value] of [["clock-hour", "23"], ["clock-minute", "59"]]) {
      const input = ui.window.document.getElementById(id!) as HTMLInputElement;
      input.value = value!; input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    }
    ui.travel(); await nextTurn();
    assert.equal(ui.requests.length, 0);
    assert.match(ui.window.document.getElementById("clock-error")!.textContent!, /past/);
    assert.equal(ui.form.hidden, false);
  } finally { ui.dom.window.close(); }
});

test("research details open during generation, close on completion and remain user-toggleable", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const ui = await mount({ beforeChatReply: () => gate, chatEvents: [
    { type: "text", delta: "A completed answer." },
    { type: "done", episodeId: 1, cited: [], timings: { recallMs: 0, searches: 0, modelCalls: 1, totalMs: 20 } },
  ] });
  try {
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = "Hello";
    ui.button("#send").click(); await nextTurn();
    const details = ui.window.document.querySelector(".answer-details") as HTMLDetailsElement;
    assert.equal(details.open, true);
    finish(); await nextTurn(); await nextTurn();
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Saved to Ledger/);
    assert.equal(details.open, false);
    details.querySelector("summary")!.click(); await nextTurn(); assert.equal(details.open, true);
    details.querySelector("summary")!.click(); assert.equal(details.open, false);
  } finally { finish(); ui.dom.window.close(); }
});

test("compose shortcut focuses the input and live mode hides the composer date strip", async () => {
  const ui = await mount();
  try {
    const isMac = /Mac|iPhone|iPad|iPod/.test(ui.window.navigator.platform);
    const hint = ui.window.document.getElementById("compose-shortcut")!;
    assert.equal(hint.textContent, isMac ? "⌘E" : "Ctrl+E");
    assert.equal(ui.window.document.getElementById("composer-era-bar")!.hidden, true);
    ui.window.document.body.focus();
    ui.window.document.dispatchEvent(new ui.window.KeyboardEvent("keydown", {
      key: "e",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
    }));
    assert.equal(ui.window.document.activeElement, ui.window.document.getElementById("input"));
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
    assert.match(answer.textContent!, /older answer.*retired simulation mode.*Re-check/);
    assert.doesNotMatch(answer.textContent!, /Snapshot|HTTP 403|access|quota/);
    const trace = ui.window.document.querySelector(".trace")!;
    assert.match(trace.textContent!, /lookup unsuccessful/);
    assert.match(trace.textContent!, /review unavailable/);
    assert.doesNotMatch(trace.querySelector("li")!.getAttribute("title") ?? "", /Snapshot|HTTP 403|quota/);
  } finally { ui.dom.window.close(); }
});

test("the ledger retains era answers and citations without presenting them as verified claims", async () => {
  const source = { n: 1, title: "Independence history", url: "https://example.com/independence" };
  const ui = await mount({ memoryEpisodes: [{
    id: 1, sessionId: "saved-session", askedAt: new Date(1948, 0, 14, 12).getTime(), question: "Will India get independence?",
    answer: "India became independent on **15 August 1947**. [1]", sources: [source],
    execution: { simulation: { mode: "era", review: "pass" } }, claims: [], verifiedStatements: [],
  }] });
  try {
    ui.button("#open-ledger").click();
    await nextTurn();
    const ledger = ui.window.document.getElementById("ledger")!;
    assert.equal(ledger.hidden, false);
    assert.match(ledger.textContent!, /Era simulation/);
    assert.match(ledger.textContent!, /Will India get independence/);
    ui.button(".ledger-question").click();
    await nextTurn();
    assert.equal(ledger.hidden, true);
    const answer = ui.window.document.querySelector("#thread .answer")!;
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
    ui.button(".source-chip").click();
    await nextTurn();
    assert.equal(ui.window.document.querySelector("#source-dialog")!.hasAttribute("hidden"), false);
    assert.match(ui.window.document.querySelector("#source-dates")!.textContent!, /Published2026-01-01/);
    assert.equal(ui.window.document.querySelector(".answer a.cite")!.getAttribute("href"), source.url);
  } finally { ui.dom.window.close(); }
});

for (const [initial, target, navigation] of [
  [new Date(2026, 0, 31, 12), new Date(2026, 1, 28, 12), "#cal-next"],
  [new Date(2024, 0, 31, 12), new Date(2024, 1, 29, 12), "#cal-next"],
  [new Date(2024, 11, 31, 12), new Date(2025, 0, 31, 12), "#cal-next"],
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

test("preview restores a saved conversation after reload and new chat starts a separate session", async () => {
  const ui = await mount({ savedSession: "saved-session", memoryEpisodes: [{
    id: 11, sessionId: "saved-session", askedAt: new Date(1948, 0, 14, 12).getTime(), question: "A saved question",
    answer: "A saved answer [1].", sources: [{ n: 1, url: "https://example.com/history", title: "History", text: "Preserved passage." }],
    execution: { time: { simulated: true }, simulation: { mode: "era" } }, claims: [], verifiedStatements: [],
  }] });
  try {
    assert.match(ui.window.document.querySelector("#thread")!.textContent!, /A saved answer/);
    assert.equal(ui.window.sessionStorage.getItem("asof.preview.session.v2"), "saved-session");
    ui.button("#new-chat").click();
    assert.ok(ui.window.document.querySelector("#empty"));
    assert.notEqual(ui.window.sessionStorage.getItem("asof.preview.session.v2"), "saved-session");
    ui.button("#stamp").click();
    assert.equal(ui.form.hidden, false, "date action still works after restoring the empty state");
  } finally { ui.dom.window.close(); }
});

test("restored legacy answers omit only the leading generic preface from presentation and copied text", async () => {
  const preface = "I could not verify this answer against the available evidence. Treat the following as unverified.";
  const answer = "The route opened in 1947 [1]. Its exact 1948 fare remains uncertain.";
  for (const separator of ["\n\n", "\r\n\r\n"]) {
    const saved = Object.freeze({ id: 18, sessionId: "legacy-preface", askedAt: Date.parse("1948-01-14T12:00:00Z"),
      question: "Tell me about the route in 1948", answer: `${preface}${separator}${answer}`,
      quality: "explicitly_unverified", sources: [{ n: 1, title: "Route history", url: "https://example.com/route" }] });
    const ui = await mount({ savedSession: saved.sessionId, memoryEpisodes: [saved] });
    const copies: string[] = [];
    Object.defineProperty(ui.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copies.push(text); } } });
    try {
      const visible = ui.window.document.querySelector(".answer")!.textContent!;
      assert.equal(visible.includes(preface), false);
      assert.match(visible, /The route opened in 1947 \[1\]\. Its exact 1948 fare remains uncertain\./);
      assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Unverified/);
      [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => button.textContent === "Copy answer")!.click();
      await nextTurn();
      assert.deepEqual(copies, [`${answer}\n\nSources\n[1] Route history — https://example.com/route`]);
      assert.match(ui.window.document.getElementById("toast")!.textContent!, /Answer and source links copied/);
      assert.equal(saved.answer, `${preface}${separator}${answer}`, "presentation must not rewrite the saved answer");
      assert.equal(saved.quality, "explicitly_unverified");
      assert.equal(ui.chatRequests.length, 0, "restoring and copying must not regenerate the answer");
    } finally { ui.dom.window.close(); }
  }
});

test("legacy preface cleanup preserves quoted text and fact-specific uncertainty", async () => {
  const preface = "I could not verify this answer against the available evidence. Treat the following as unverified.";
  for (const answer of [
    `> ${preface}\n\nThat quoted wording was in the previous answer.`,
    `The previous answer said:\n\n${preface}\n\nIts claim remains uncertain.`,
    "I could not verify the exact 1948 railway fare. The opening date is supported.",
  ]) {
    const ui = await mount({ savedSession: "preserved-uncertainty", memoryEpisodes: [{ id: 19,
      sessionId: "preserved-uncertainty", askedAt: Date.parse("1948-01-14T12:00:00Z"), question: "A saved question",
      answer, quality: "explicitly_unverified", sources: [] }] });
    const copies: string[] = [];
    Object.defineProperty(ui.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copies.push(text); } } });
    try {
      const visible = ui.window.document.querySelector(".answer")!.textContent!;
      assert.ok(visible.includes(answer.includes(preface) ? preface : "I could not verify the exact 1948 railway fare."));
      assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Unverified/);
      [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => button.textContent === "Copy answer")!.click();
      await nextTurn();
      assert.deepEqual(copies, [answer]);
    } finally { ui.dom.window.close(); }
  }
});

test("citation inspector uses the saved passage and preserves a direct original-source link", async () => {
  const ui = await mount({ savedSession: "evidence-session", memoryEpisodes: [{
    id: 12, sessionId: "evidence-session", askedAt: Date.parse("1948-01-14T12:00:00Z"), question: "Evidence?",
    answer: "A historical fact [1].", sources: [{ n: 1, url: "https://example.com/history", title: "A history source", text: "An exact source passage.", publishedDate: "2026-01-01" }],
    execution: { time: { simulated: true } }, claims: [], verifiedStatements: [],
  }] });
  try {
    ui.button(".cite").click();
    assert.equal(ui.window.document.getElementById("source-passage")!.textContent, "An exact source passage.");
    assert.equal(ui.window.document.getElementById("source-original")!.getAttribute("href"), "https://example.com/history");
    assert.match(ui.window.document.getElementById("source-dates")!.textContent!, /Published2026-01-01/);
    ui.button("#source-close").click();
    assert.equal(ui.window.document.getElementById("source-dialog")!.hidden, true);
  } finally { ui.dom.window.close(); }
});

test("Ledger search finds dated records and an empty search result remains recoverable", async () => {
  const ui = await mount({ memoryEpisodes: [{ id: 1, sessionId: "record", askedAt: Date.parse("1948-01-14T12:00:00Z"), question: "India independence", summary: "Discussed independence", claims: [], verifiedStatements: [] }] });
  try {
    ui.button("#open-ledger").click(); await nextTurn();
    const input = ui.window.document.getElementById("ledger-search") as HTMLInputElement;
    input.value = "1948"; input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    assert.match(ui.window.document.getElementById("ledger-count")!.textContent!, /1 entry/);
    input.value = "nonexistent"; input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    assert.match(ui.window.document.getElementById("ledger-body")!.textContent!, /No matching entries/);
    input.value = "India"; input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    assert.match(ui.window.document.getElementById("ledger-body")!.textContent!, /India independence/);
  } finally { ui.dom.window.close(); }
});

test("Re-check now returns to the present and sends the dated original question without a simulated cutoff", async () => {
  const ui = await mount({ savedSession: "recheck-session", memoryEpisodes: [{
    id: 13, sessionId: "recheck-session", askedAt: Date.parse("1948-01-14T12:00:00Z"), question: "Who leads India?",
    answer: "A historical answer [1].", sources: [{ n: 1, title: "History", url: "https://example.com/history", text: "Historic leadership." }],
    execution: { time: { simulated: true } }, claims: [], verifiedStatements: [],
  }], chatEvents: [
    { type: "text", delta: "An updated answer." },
    { type: "done", episodeId: 14, cited: [], timings: { recallMs: 0, searches: 1, modelCalls: 2, totalMs: 20 } },
  ] });
  try {
    const action = [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => button.textContent === "Re-check now ↗")!;
    action.click(); await nextTurn(); await nextTurn();
    assert.deepEqual(ui.requests, [{ now: null }]);
    assert.equal(ui.chatRequests.length, 1);
    assert.match(String(ui.chatRequests[0]!.message), /Who leads India.*14 Jan 1948.*current sources/);
    assert.equal(ui.chatRequests[0]!.asOf, undefined);
    assert.equal(ui.chatRequests[0]!.recheckEpisodeId, 13);
  } finally { ui.dom.window.close(); }
});

test("Ledger re-check opens the selected answer's conversation instead of checking the active chat", async () => {
  const ui = await mount({ savedSession: "active", memoryEpisodes: [{ id: 15, sessionId: "chosen", askedAt: Date.parse("2020-01-01T00:00:00Z"),
    question: "Selected subject", answer: "Selected answer", sources: [] }], chatEvents: [
    { type: "text", delta: "An updated answer." },
    { type: "done", episodeId: 16, cited: [], timings: { recallMs: 0, searches: 1, modelCalls: 2, totalMs: 20 } },
  ] });
  try {
    ui.button("#open-ledger").click(); await nextTurn();
    [...ui.window.document.querySelectorAll<HTMLButtonElement>(".ledger-entry-actions button")].find(button => button.textContent === "Re-check now")!.click();
    await nextTurn(); await nextTurn();
    assert.equal(ui.chatRequests[0]!.sessionId, "chosen");
    assert.equal(ui.chatRequests[0]!.recheckEpisodeId, 15);
    assert.equal(ui.chatRequests[0]!.mode, "live");
    assert.match(String(ui.chatRequests[0]!.message), /Selected subject/);
  } finally { ui.dom.window.close(); }
});

const clarificationCard = {
  id: "12345678-1234-4321-8123-123456789abc", message: "Help me choose a project management tool",
  question: "What kind of team will use it?", why: "Team size changes the plans and collaboration features worth comparing.",
  time: { effectiveAt: "1948-01-14T12:00:00.000Z", receivedAt: "2026-11-15T10:00:00.000Z", simulated: true, tz: "Asia/Kolkata" },
  options: [{ id: "a", label: "Small team", detail: "Low-cost collaboration for a few people" }, { id: "b", label: "Larger company", detail: "Cross-team reporting and automation" }],
};
const clarificationDone = [
  { type: "text", delta: "For your small team, start with these criteria." },
  { type: "done", episodeId: 15, cited: [], timings: { recallMs: 0, searches: 1, modelCalls: 2, totalMs: 20 } },
];
const flushChat = async () => { await nextTurn(); await nextTurn(); };

test("clarification cards end normally, have no preselection, and resume the original entry with the real clicked choice", async () => {
  const ui = await mount({ chatReplies: [[{ type: "clarification", card: clarificationCard }], clarificationDone] });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = clarificationCard.message; ui.button("#send").click(); await flushChat();
    assert.equal(ui.window.document.querySelectorAll(".clarification-option").length, 2);
    assert.equal(ui.window.document.querySelectorAll('.clarification-option[aria-pressed="true"]').length, 0);
    assert.equal(ui.window.document.querySelector(".failure"), null);
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Waiting for your direction/);
    assert.equal(ui.chatRequests.length, 1);
    ui.button(".clarification-option").click(); await flushChat();
    assert.deepEqual(ui.chatRequests[1]!.clarification, { id: clarificationCard.id, selection: { optionId: "a" } });
    assert.equal(ui.chatRequests[1]!.message, clarificationCard.message);
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
    assert.match(ui.window.document.querySelector(".clarification-summary")!.textContent!, /Small team/);
    assert.match(ui.window.document.querySelector(".answer")!.textContent!, /For your small team/);
    assert.equal((ui.window.document.querySelector(".answer-details") as HTMLElement).hidden, false);
  } finally { ui.dom.window.close(); }
});

test("Fast selection survives clarification and is visible on the completed answer", async () => {
  const ui = await mount({ fastMode: true, chatReplies: [[{ type: "clarification", card: { ...clarificationCard, responseMode: "fast" } }], clarificationDone] });
  try {
    const mode = ui.window.document.getElementById("response-mode") as HTMLSelectElement;
    mode.value = "fast"; mode.dispatchEvent(new ui.window.Event("change"));
    assert.match(ui.window.document.getElementById("response-mode-hint")!.textContent!, /lighter research/);
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = clarificationCard.message;
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests[0]!.responseMode, "fast");
    mode.value = "standard"; mode.dispatchEvent(new ui.window.Event("change"));
    ui.button(".clarification-option").click(); await flushChat();
    assert.equal(ui.chatRequests[1]!.responseMode, "fast");
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Fast/);
  } finally { ui.dom.window.close(); }
});

test("Fast cannot be selected when the server has no fast deployment", async () => {
  const ui = await mount();
  try { assert.equal(ui.button('#response-mode option[value="fast"]').disabled, true); }
  finally { ui.dom.window.close(); }
});

for (const kind of ["freeform", "skip", "composer"] as const) {
  test(`clarification supports ${kind} without inventing a selected option`, async () => {
    const ui = await mount({ chatReplies: [[{ type: "clarification", card: clarificationCard }], clarificationDone] });
    try {
      const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
      input.value = clarificationCard.message; ui.button("#send").click(); await flushChat();
      if (kind === "skip") ui.button(".clarification-skip").click();
      else if (kind === "freeform") {
        const custom = ui.window.document.querySelector(".clarification-custom input") as HTMLInputElement;
        ui.button('.clarification-custom button[type="submit"]').click();
        assert.match(ui.window.document.querySelector(".clarification-error")!.textContent!, /Choose an option/);
        assert.equal(ui.chatRequests.length, 1);
        custom.value = "For 8 teachers in India"; ui.button('.clarification-custom button[type="submit"]').click();
      } else { input.value = "For 8 teachers in India"; ui.button("#send").click(); }
      await flushChat();
      assert.deepEqual(ui.chatRequests[1]!.clarification, { id: clarificationCard.id, selection: kind === "skip" ? { skip: true } : { text: "For 8 teachers in India" } });
      assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
      assert.match(ui.window.document.querySelector(".clarification-summary")!.textContent!, kind === "skip" ? /reasonable assumptions/ : /8 teachers/);
    } finally { ui.dom.window.close(); }
  });
}

test("refresh restores the pending historical question and selection stays pinned despite a live clock change", async () => {
  const ui = await mount({ savedSession: "pending-session", pendingCard: clarificationCard, chatEvents: clarificationDone });
  try {
    assert.match(ui.window.document.querySelector(".question")!.textContent!, /project management tool/);
    assert.match(ui.window.document.querySelector(".clarification-date")!.textContent!, /14 Jan 1948/);
    ui.open(); ui.button("#clock-reset").click(); await flushChat();
    ui.button(".clarification-option").click(); await flushChat();
    assert.equal(ui.chatRequests[0]!.sessionId, "pending-session");
    assert.equal(ui.chatRequests[0]!.asOf, clarificationCard.time.effectiveAt);
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
  } finally { ui.dom.window.close(); }
});

test("interrupted clarified answers retry the same choice on the same entry", async () => {
  const ui = await mount({ chatReplies: [[{ type: "clarification", card: clarificationCard }], [], clarificationDone] });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = clarificationCard.message; ui.button("#send").click(); await flushChat();
    ui.button(".clarification-option").click(); await flushChat();
    assert.match(ui.window.document.querySelector(".failure")!.textContent!, /connection ended/);
    [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => button.textContent === "Retry question ↗")!.click();
    await flushChat();
    assert.deepEqual(ui.chatRequests[2]!.clarification, ui.chatRequests[1]!.clarification);
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
    assert.equal(ui.window.document.querySelector(".failure"), null);
  } finally { ui.dom.window.close(); }
});

test("refresh after an interrupted selection offers only the saved choice and can continue from the composer", async () => {
  const selection = { id: clarificationCard.id, question: clarificationCard.question, answer: "Small team: Low-cost collaboration for a few people", skipped: false, optionId: "a" };
  const ui = await mount({ savedSession: "pending-session", pendingCard: { ...clarificationCard, selection }, chatEvents: clarificationDone });
  try {
    assert.equal(ui.window.document.querySelector(".clarification-option"), null);
    assert.match(ui.window.document.querySelector(".clarification-summary")!.textContent!, /Small team/);
    ui.button("#send").click(); await flushChat();
    assert.deepEqual(ui.chatRequests[0]!.clarification, { id: clarificationCard.id, selection: { optionId: "a" } });
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
    ui.button("#new-chat").click();
    assert.equal(ui.button("#send").textContent, "Send ↗");
    assert.equal(ui.window.document.querySelector(".clarification-summary"), null);
  } finally { ui.dom.window.close(); }
});

test("expired clarification can restart the original question without retrying the expired reference forever", async () => {
  const ui = await mount({ chatReplies: [[{ type: "clarification", card: clarificationCard }], { status: 409, error: "This question has expired. Ask your question again.", code: "clarification_unavailable" }, clarificationDone] });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = clarificationCard.message; ui.button("#send").click(); await flushChat();
    ui.button(".clarification-option").click(); await flushChat();
    assert.match(ui.window.document.querySelector(".failure")!.textContent!, /expired/);
    [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => button.textContent === "Retry question ↗")!.click();
    await flushChat();
    assert.equal(ui.chatRequests[2]!.message, clarificationCard.message);
    assert.equal(ui.chatRequests[2]!.clarification, undefined);
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 2);
  } finally { ui.dom.window.close(); }
});

const recoveredTurn = { turn: { id: "durable-1", status: "completed" }, episode: { id: 17, answer: "The committed answer [1].", quality: "supported" }, sources: [{ n: 1, title: "Official", url: "https://example.com/official" }] };

test("lost done recovers the durable answer without a second generation", async () => {
  const ui = await mount({ chatEvents: [{ type: "turn", turnId: "durable-1" }, { type: "text", delta: "Provisional answer" }], turnReplies: [recoveredTurn] });
  try {
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = "What is the answer?";
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests.length, 1); assert.ok(ui.turnRequests.includes("/api/turns/durable-1"));
    assert.match(ui.window.document.querySelector(".answer")!.textContent!, /The committed answer/);
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Saved to Ledger/);
    assert.equal(ui.window.sessionStorage.getItem("asof.pending.turn"), null);
    assert.equal(ui.window.document.querySelector(".failure"), null);
  } finally { ui.dom.window.close(); }
});

test("lost response headers recover by the key saved before POST", async () => {
  const ui = await mount({ chatEvents: [], chatBeforeHeadersFailure: true, turnReplies: [recoveredTurn] });
  try {
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = "What is the answer?";
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests.length, 1);
    assert.ok(ui.turnRequests.includes(`/api/turns/by-key/${ui.chatKeys[0]}`));
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Saved to Ledger/);
  } finally { ui.dom.window.close(); }
});

test("still-running recovery offers a read-only check and never silently regenerates", async () => {
  const ui = await mount({ chatEvents: [{ type: "turn", turnId: "durable-1" }], turnReplies: [{ turn: { id: "durable-1", status: "running" } }, recoveredTurn] });
  try {
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = "What is the answer?";
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests.length, 1); assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /still running/);
    const check = [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => /Check saved answer/.test(button.textContent!))!;
    check.click(); await flushChat(); assert.equal(ui.chatRequests.length, 1);
    assert.match(ui.window.document.querySelector(".answer")!.textContent!, /committed answer/);
  } finally { ui.dom.window.close(); }
});

test("a request never received by the server is manually retried with its original idempotency key", async () => {
  const ui = await mount({ chatReplies: [[], [{ type: "turn", turnId: "durable-1" }, { type: "text", delta: "Saved retry." }, { type: "done", turnId: "durable-1", episodeId: 17, quality: "non_factual", cited: [], timings: { recallMs: 0, searches: 0, modelCalls: 1, totalMs: 1 } }]], chatBeforeHeadersFailure: true, turnReplies: [{ status: 404 }] });
  try {
    (ui.window.document.getElementById("input") as HTMLTextAreaElement).value = "Hello";
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests.length, 1);
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /No saved answer/);
    [...ui.window.document.querySelectorAll<HTMLButtonElement>(".answer-actions button")].find(button => /Retry question/.test(button.textContent!))!.click(); await flushChat();
    assert.equal(ui.chatRequests.length, 2); assert.equal(ui.chatKeys[0], ui.chatKeys[1]); assert.deepEqual(ui.chatRequests[0], ui.chatRequests[1]);
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
    assert.match(ui.window.document.querySelector(".answer")!.textContent!, /Saved retry/);
  } finally { ui.dom.window.close(); }
});

test("refresh recovers a saved request key without generation and does not duplicate a restored episode", async () => {
  const ui = await mount({ savedSession: "restore-session", pendingTurn: { sessionId: "restore-session", question: "Original question", at: "2026-11-15T10:00:00Z", isEra: false, idempotencyKey: "original-key", requestBody: { sessionId: "restore-session", message: "Original question", mode: "live", tz: "UTC" } }, memoryEpisodes: [{ id: 17, sessionId: "restore-session", askedAt: Date.parse("2026-11-15T10:00:00Z"), question: "Original question", answer: recoveredTurn.episode.answer, quality: "explicitly_unverified", sources: [] }], turnReplies: [recoveredTurn] });
  try {
    assert.equal(ui.chatRequests.length, 0); assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 1);
    assert.ok(ui.turnRequests.includes("/api/turns/by-key/original-key")); assert.equal(ui.window.sessionStorage.getItem("asof.pending.turn"), null);
    assert.match(ui.window.document.querySelector(".answer-status")!.textContent!, /Unverified/);
  } finally { ui.dom.window.close(); }
});

test("changing the viewpoint keeps the model conversation and sends its verification follow-up with the same session", async () => {
  const clockRequests: Array<{ now: string | null; sessionId: string }> = [];
  const modelAnswer = "We discussed Kimi and Claude coding benchmarks.";
  const ui = await mount({ savedSession: "model-chat", date: new Date(2026, 10, 15, 14, 2),
    memoryEpisodes: [{ id: 3, sessionId: "cricket-chat", askedAt: Date.parse("2026-05-15T09:00:00Z"),
      question: "Verify the IPL winners.", answer: "IPL winners: Rajasthan Royals in 2008." }],
    post: async body => {
      clockRequests.push(body as { now: string | null; sessionId: string });
      return Response.json({ now: body.now, simulated: true, missing: [], model: "test", episodes: 2,
        features: { clarifications: false } });
    },
    chatReplies: [
      [{ type: "text", delta: modelAnswer }, { type: "done", episodeId: 10, quality: "explicitly_unverified", cited: [],
        timings: { recallMs: 0, searches: 0, modelCalls: 1, totalMs: 20 } }],
      [{ type: "text", delta: "The Kimi and Claude claims need applicable evidence." },
        { type: "done", episodeId: 11, quality: "explicitly_unverified", cited: [],
          timings: { recallMs: 0, searches: 1, modelCalls: 2, totalMs: 20 } }],
    ],
  });
  try {
    const input = ui.window.document.getElementById("input") as HTMLTextAreaElement;
    input.value = "How do Kimi and Claude compare for coding?";
    ui.button("#send").click(); await flushChat();
    assert.equal(ui.chatRequests[0]!.mode, "live");
    ui.open(); ui.choose("month", 4); ui.travel(); await flushChat();
    assert.equal(clockRequests[0]!.sessionId, "model-chat");
    assert.match(ui.window.document.querySelector("#thread")!.textContent!, /Kimi and Claude coding benchmarks/);
    input.value = "verify your claims now";
    ui.button("#send").click(); await flushChat();

    assert.equal(ui.chatRequests.length, 2);
    assert.equal(ui.chatRequests[0]!.sessionId, "model-chat");
    assert.equal(ui.chatRequests[1]!.sessionId, "model-chat");
    assert.equal(ui.chatRequests[1]!.mode, "era");
    assert.equal(ui.chatRequests[1]!.message, "verify your claims now");
    const selected = Date.parse(clockRequests[0]!.now!);
    const requested = Date.parse(String(ui.chatRequests[1]!.asOf));
    assert.ok(requested >= selected && requested - selected < 60_000,
      "the new request uses the selected viewpoint; the display clock may keep advancing within that minute");
    assert.notEqual(ui.chatKeys[0], ui.chatKeys[1]);
    assert.equal(ui.window.sessionStorage.getItem("asof.preview.session.v2"), "model-chat");
    assert.equal(ui.window.document.querySelectorAll("#thread .entry").length, 2);
    assert.match(ui.window.document.querySelector("#thread")!.textContent!, /Viewpoint changed/i);
    assert.doesNotMatch(ui.window.document.querySelector("#thread")!.textContent!, /IPL|Rajasthan/);
  } finally { ui.dom.window.close(); }
});
