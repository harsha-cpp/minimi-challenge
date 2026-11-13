import { citationTextNodes } from "./citations.js";
// The whole interface: no framework and no build step, so `npm run dev` has nothing to compile.

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A page load is a chat. Memory lives on the server and spans all of them.
const sessionId = crypto.randomUUID();
let inFlight = null;
// The agent's clock can differ from this machine's; keep the difference and tick locally.
let clockOffset = 0;
let simulated = false;

const agentNow = () => new Date(Date.now() + clockOffset);
const dayLabel = (date) => date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeLabel = (date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ---- clock ----------------------------------------------------------------

function applyState(state) {
  clockOffset = new Date(state.now).getTime() - Date.now();
  simulated = state.simulated;
  const notice = $("notice");
  notice.hidden = state.missing.length === 0;
  notice.textContent = state.missing.length
    ? `Not configured: ${state.missing.join(", ")}. Copy .env.example to .env, fill it in and restart.`
    : "";
  drawStamp();
}

function drawStamp() {
  const now = agentNow();
  const stamp = $("stamp");
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  stamp.textContent = `${simulated ? "Simulated · " : ""}${dayLabel(now)} · ${time}`;
  stamp.classList.toggle("simulated", simulated);
}

/** Redraws the stamp on each second of the agent's clock, re-aiming every time so it never drifts or skips. */
function tick() {
  drawStamp();
  setTimeout(tick, 1000 - ((Date.now() + clockOffset) % 1000));
}

async function setClock(now) {
  const response = await fetch("/api/clock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ now }),
  });
  if (response.ok) applyState(await response.json());
  toggleClock(false);
}

// The calendar in the clock popover. `picked` is the chosen day; `shown` is the month on screen.
let picked = new Date();
let shown = new Date();

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function drawCalendar() {
  const year = shown.getFullYear();
  const month = shown.getMonth();
  $("cal-title").textContent = shown.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  // Weeks start on Monday, matching how the agent reads "last week".
  const cells = ["M", "T", "W", "T", "F", "S", "S"].map((letter) => el("span", "", letter));
  const blanks = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < blanks; i++) cells.push(el("span"));

  const today = new Date();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const button = el("button", [sameDay(date, picked) && "selected", sameDay(date, today) && "today"].filter(Boolean).join(" "), String(d));
    button.type = "button";
    button.setAttribute("aria-label", dayLabel(date));
    button.setAttribute("aria-pressed", String(sameDay(date, picked)));
    button.addEventListener("click", () => {
      picked = date;
      drawCalendar();
    });
    cells.push(button);
  }
  $("cal-grid").replaceChildren(...cells);
  $("clock-summary").textContent = dayLabel(picked);
}

function shiftMonth(by) {
  shown = new Date(shown.getFullYear(), shown.getMonth() + by, 1);
  drawCalendar();
}

// The time of day in the clock popover, as minutes since midnight. One number
// means stepping past :55 carries into the next hour with no special cases.
let pickedMinutes = 0;
const DAY_MINUTES = 24 * 60;
const twoDigits = (n) => String(n).padStart(2, "0");

/** `keepTyping` leaves the fields alone while someone is mid-keystroke in one of them. */
function drawTime(keepTyping = false) {
  const hour = twoDigits(Math.floor(pickedMinutes / 60));
  const minute = twoDigits(pickedMinutes % 60);
  if (!keepTyping) {
    $("clock-hour").value = hour;
    $("clock-minute").value = minute;
  }
  for (const preset of document.querySelectorAll(".cal-presets button")) {
    preset.classList.toggle("selected", preset.dataset.time === `${hour}:${minute}`);
  }
}

/** The arrows move an hour, or to the next five-minute mark; `fine` (the arrow keys) moves one minute. */
function stepTime(unit, direction, fine = false) {
  let next = pickedMinutes + direction * (unit === "hour" ? 60 : 1);
  if (unit === "minute" && !fine) {
    next = direction > 0 ? Math.floor(pickedMinutes / 5) * 5 + 5 : Math.ceil(pickedMinutes / 5) * 5 - 5;
  }
  pickedMinutes = ((next % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  drawTime();
}

for (const spin of document.querySelectorAll(".spin")) {
  const unit = spin.dataset.unit;
  const input = spin.querySelector("input");
  const highest = unit === "hour" ? 23 : 59;

  input.addEventListener("focus", () => input.select());
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 2);
    input.value = digits;
    if (!digits) return;
    const value = Math.min(Number(digits), highest);
    // Out-of-range input is corrected as it is typed: "75" minutes shows as "59" straight away.
    if (Number(digits) > highest) input.value = String(highest);
    pickedMinutes = unit === "hour" ? value * 60 + (pickedMinutes % 60) : Math.floor(pickedMinutes / 60) * 60 + value;
    drawTime(true);
    // The hour is complete after two digits, or after one that cannot begin a longer hour ("7"): move on to minutes.
    if (unit === "hour" && (digits.length === 2 || value > 2)) {
      input.value = twoDigits(value);
      $("clock-minute").focus();
    }
  });
  // Leaving a field pads it: "7" becomes "07".
  input.addEventListener("blur", () => drawTime());
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    stepTime(unit, event.key === "ArrowUp" ? 1 : -1, true);
    input.select();
  });

  for (const arrow of spin.querySelectorAll("button")) {
    const step = () => stepTime(unit, Number(arrow.dataset.step));
    // Press to step once; keep holding to run.
    let pressed = false;
    arrow.addEventListener("pointerdown", () => {
      pressed = true;
      step();
      let repeat = 0;
      const wait = setTimeout(() => (repeat = setInterval(step, 90)), 400);
      const stop = (event) => {
        clearTimeout(wait);
        clearInterval(repeat);
        arrow.removeEventListener("pointerup", stop);
        arrow.removeEventListener("pointerleave", stop);
        // Sliding off the arrow cancels the press, so no click will follow to clear the flag.
        if (event.type === "pointerleave") pressed = false;
      };
      arrow.addEventListener("pointerup", stop);
      arrow.addEventListener("pointerleave", stop);
    });
    // A click that no press already handled is the keyboard (Enter or Space on the focused arrow).
    arrow.addEventListener("click", () => {
      if (!pressed) step();
      pressed = false;
    });
  }
}

for (const preset of document.querySelectorAll(".cal-presets button")) {
  preset.addEventListener("click", () => {
    const [hour, minute] = preset.dataset.time.split(":").map(Number);
    pickedMinutes = hour * 60 + minute;
    drawTime();
  });
}

function toggleClock(open) {
  $("clock").hidden = !open;
  $("stamp").setAttribute("aria-expanded", String(open));
  if (open) {
    picked = agentNow();
    shown = new Date(picked.getFullYear(), picked.getMonth(), 1);
    pickedMinutes = picked.getHours() * 60 + picked.getMinutes();
    drawCalendar();
    drawTime();
  }
}

$("stamp").addEventListener("click", () => toggleClock($("clock").hidden));
$("cal-prev").addEventListener("click", () => shiftMonth(-1));
$("cal-next").addEventListener("click", () => shiftMonth(1));
$("clock").addEventListener("submit", (event) => {
  event.preventDefault();
  const target = new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), Math.floor(pickedMinutes / 60), pickedMinutes % 60);
  setClock(target.toISOString());
});
$("clock-reset").addEventListener("click", () => setClock(null));

// ---- rendering an answer --------------------------------------------------

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown to safe HTML, with [n] turned into links to the numbered sources. */
function renderAnswer(container, markdown, sources) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }));
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  for (const node of citationTextNodes(container)) {
    const parts = node.textContent.split(/(\[\d+(?:\s*,\s*\d+)*\])/);
    if (parts.length === 1) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const numbers = /^\[[\d,\s]+\]$/.test(part) ? part.slice(1, -1).split(",").map(Number) : [];
      if (!numbers.length || !numbers.every((n) => byNumber.has(n))) {
        fragment.append(part);
        continue;
      }
      for (const n of numbers) {
        const link = el("a", "cite", `[${n}]`);
        link.href = byNumber.get(n).url;
        link.title = byNumber.get(n).title;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        fragment.append(link);
      }
    }
    node.replaceWith(fragment);
  }
}

function renderSources(list, sources) {
  list.replaceChildren(
    ...sources.map((s) => {
      const item = el("li");
      const link = el("a");
      link.href = s.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(el("span", "host", new URL(s.url).hostname.replace(/^www\./, "")), ` — ${s.title}`);
      item.append(el("span", "n", String(s.n)), link);
      if (s.publishedDate) item.append(el("span", "date", s.publishedDate));
      return item;
    }),
  );
  list.hidden = sources.length === 0;
}

// ---- one turn -------------------------------------------------------------

function addEntry(question) {
  $("empty")?.remove();
  const now = agentNow();
  const entry = el("article", "entry");
  const gutter = el("div", "gutter");
  gutter.append(el("time", "", timeLabel(now)), el("span", "", dayLabel(now)));
  const body = el("div", "body");
  const view = {
    trace: el("ul", "trace"),
    answer: el("div", "answer"),
    sources: el("ol", "sources"),
    timings: el("div", "timings"),
  };
  view.sources.hidden = true;
  body.append(el("h2", "question", question), view.trace, view.answer, view.sources, view.timings);
  entry.append(gutter, body);
  $("thread").append(entry);
  entry.scrollIntoView({ block: "start", behavior: "smooth" });
  return view;
}

function traceLine(list, kind, label, state = "", className = "") {
  const item = el("li", className);
  item.append(el("span", "kind", kind), el("span", "label", label), el("span", "state", state));
  list.append(item);
  return item;
}

async function send(message) {
  if (inFlight || !message.trim()) return;
  const view = addEntry(message.trim());
  const abort = new AbortController();
  inFlight = abort;
  setBusy(true);

  let text = "";
  let sources = [];
  let frame = 0;
  const searches = new Map();
  // Tokens arrive faster than the eye reads: re-render once per animation frame at most.
  const paint = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      renderAnswer(view.answer, text, sources);
    });
  };

  const handle = (event) => {
    if (event.type === "recall") {
      for (const note of event.notes) traceLine(view.trace, "memory", note);
    } else if (event.type === "search") {
      const label = event.publishedAfter ? `${event.query} (after ${event.publishedAfter})` : event.query;
      const line = searches.get(event.id) ?? traceLine(view.trace, "search", label);
      searches.set(event.id, line);
      line.className = event.state;
      line.querySelector(".state").textContent =
        event.state === "running"
          ? ""
          : event.state === "failed"
            ? "failed"
            : `${event.results} result${event.results === 1 ? "" : "s"} · ${seconds(event.ms)}`;
    } else if (event.type === "sources") {
      sources = event.sources;
    } else if (event.type === "text") {
      text += event.delta;
      paint();
    } else if (event.type === "retract") {
      text = "";
      paint();
    } else if (event.type === "done") {
      renderAnswer(view.answer, text, sources);
      renderSources(view.sources, sources.filter((s) => event.cited.includes(s.n)));
      const t = event.timings;
      view.timings.textContent = [
        `recall ${seconds(t.recallMs)}`,
        `${t.searches} search${t.searches === 1 ? "" : "es"}`,
        t.firstTokenMs === null ? null : `first word ${seconds(t.firstTokenMs)}`,
        `total ${seconds(t.totalMs)}`,
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (event.type === "error") {
      view.answer.replaceChildren(el("p", "failure", event.message));
    }
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message, tz }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error ?? `Request failed (${response.status})`);

    // Server-sent events over a POST: each event is one "data: {json}" line followed by a blank line.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const raw of events) {
        if (raw.startsWith("data: ")) handle(JSON.parse(raw.slice(6)));
      }
    }
  } catch (error) {
    if (abort.signal.aborted) view.timings.textContent = "stopped";
    else handle({ type: "error", message: error.message });
  } finally {
    cancelAnimationFrame(frame);
    if (text && !view.answer.querySelector(".failure")) renderAnswer(view.answer, text, sources);
    inFlight = null;
    setBusy(false);
  }
}

// ---- composer -------------------------------------------------------------

const input = $("input");

function setBusy(busy) {
  $("send").textContent = busy ? "Stop" : "Send";
  if (!busy) input.focus();
}

function fitInput() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (inFlight) return inFlight.abort();
  const message = input.value;
  input.value = "";
  fitInput();
  send(message);
});

input.addEventListener("input", fitInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

for (const starter of document.querySelectorAll(".starters button")) {
  starter.addEventListener("click", () => send(starter.textContent));
}

$("new-chat").addEventListener("click", () => location.reload());

// ---- ledger ---------------------------------------------------------------

async function openLedger() {
  const { episodes } = await (await fetch("/api/memory")).json();
  const body = $("ledger-body");
  body.replaceChildren();
  if (!episodes.length) body.append(el("p", "ledger-empty", "Nothing yet. Ask something."));

  const claimsById = new Map(episodes.flatMap((e) => e.claims).map((c) => [c.id, c]));
  let currentDay = "";
  for (const episode of episodes) {
    const when = new Date(episode.askedAt);
    if (dayLabel(when) !== currentDay) {
      currentDay = dayLabel(when);
      body.append(el("h3", "", currentDay));
    }
    const item = el("div", "ledger-item");
    item.append(el("div", "when", timeLabel(when)), el("p", "asked", episode.question));
    if (episode.claims.length) {
      const list = el("ul", "claims");
      for (const claim of episode.claims) {
        const row = el("li", claim.verdict);
        const value = el("span", "value");
        const prior = claim.verdict === "changed" ? claimsById.get(claim.priorClaimId) : null;
        if (prior) value.append(el("span", "was", prior.value));
        value.append(claim.verdict === "unchanged" ? `${claim.value} ✓` : claim.value);
        row.append(el("span", "what", `${claim.entity} · ${claim.attribute}`), value);
        list.append(row);
      }
      item.append(list);
    }
    body.append(item);
  }
  $("ledger").hidden = false;
}

$("open-ledger").addEventListener("click", openLedger);
$("close-ledger").addEventListener("click", () => ($("ledger").hidden = true));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("ledger").hidden = true;
  toggleClock(false);
});

applyState(await (await fetch("/api/state")).json());
tick();
