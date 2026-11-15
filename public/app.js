
import { citationTextNodes } from "./citations.js";
import { readTurn } from "./recovery.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isMacPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  || navigator.userAgentData?.platform === "macOS";
const composeShortcut = isMacPlatform
  ? { label: "⌘E", aria: "Meta+E", title: "Command+E to focus" }
  : { label: "Ctrl+E", aria: "Control+E", title: "Control+E to focus" };

function savedSession() { try { return sessionStorage.getItem("asof.preview.session.v2"); } catch { return null; } }
let sessionId = savedSession() || crypto.randomUUID();
function rememberSession() { try { sessionStorage.setItem("asof.preview.session.v2", sessionId); } catch {} }
rememberSession();
let inFlight = null;

let clockOffset = 0;
let simulated = false;
let clockSaving = false;
let clarificationsEnabled = false;
let pendingView = null;

const agentNow = () => new Date(Date.now() + clockOffset);
const dayLabel = (date) => date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeLabel = (date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

let latestState;
function applyState(state) {
  latestState = state;
  clockOffset = new Date(state.now).getTime() - Date.now();
  simulated = state.simulated;
  clarificationsEnabled = Boolean(state.features?.clarifications);
  const notice = $("notice");
  notice.hidden = state.missing.length === 0;
  notice.textContent = state.missing.length
    ? `Not configured: ${state.missing.join(", ")}. Copy .env.example to .env, fill it in and restart.`
    : "";
  drawStamp();
  updateEra();
}

function drawStamp() {
  const now = agentNow();
  const stamp = $("stamp");
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  stamp.textContent = `${simulated ? "Simulated · " : ""}${dayLabel(now)} · ${time}`;
  stamp.classList.toggle("simulated", simulated);
}

function tick() {
  drawStamp();
  setTimeout(tick, 1000 - ((Date.now() + clockOffset) % 1000));
}

async function setClock(now) {
  if (clockSaving) return;
  if (now !== null && new Date(now).getTime() > Date.now()) {
    showClockError("Choose a date and time in the past, or return to now.");
    return false;
  }
  clockSaving = true;
  showClockError("");
  $("clock").setAttribute("aria-busy", "true");
  for (const control of $("clock").querySelectorAll("button, input")) control.disabled = true;
  try {
    const response = await fetch("/api/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ now, sessionId }),
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || "The date could not be changed. Please try again.");
    applyState(state);
    toggleClock(false);
    return true;
  } catch (error) {
    showClockError(`Could not change the date. ${error instanceof TypeError ? "Check your connection and try again." : error.message}`);
    return false;
  } finally {
    clockSaving = false;
    $("clock").removeAttribute("aria-busy");
    for (const control of $("clock").querySelectorAll("button, input")) control.disabled = false;
    drawCalendar();
    showCalendarView(calendarView);
  }
}

function showClockError(message) {
  $("clock-error").textContent = message;
  $("clock-error").hidden = !message;
}

let picked = new Date();
let shown = new Date();
let calendarView = "days";
let firstYear = 1900;

function calendarDate(year, month, day = 1, hour = 0, minute = 0) {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(hour, minute, 0, 0);
  return date;
}

const monthNames = Array.from({ length: 12 }, (_, month) => calendarDate(2000, month).toLocaleDateString("en-GB", { month: "long" }));

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function drawCalendar() {
  const year = shown.getFullYear();
  const month = shown.getMonth();
  $("cal-month").textContent = monthNames[month];
  $("cal-month").setAttribute("aria-label", `Choose month, ${monthNames[month]}`);
  $("cal-year").textContent = String(year);
  $("cal-year").setAttribute("aria-label", `Choose year, ${year}`);

  const cells = ["M", "T", "W", "T", "F", "S", "S"].map((letter) => el("span", "", letter));
  const blanks = (calendarDate(year, month).getDay() + 6) % 7;
  for (let i = 0; i < blanks; i++) cells.push(el("span"));

  const today = new Date();
  $("cal-next").disabled = calendarDate(year, month + 1) > today;
  $("cal-prev").disabled = year === 1 && month === 0;
  const daysInMonth = calendarDate(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = calendarDate(year, month, d);
    const button = el("button", [sameDay(date, picked) && "selected", sameDay(date, today) && "today"].filter(Boolean).join(" "), String(d));
    button.type = "button";
    button.disabled = date > today;
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

function choosePeriod(year, month) {
  const next = calendarDate(year, month);
  if (next.getFullYear() < 1 || next.getFullYear() > 9999 || next > new Date()) return;
  shown = next;

  const today = new Date();
  const lastDay = shown.getFullYear() === today.getFullYear() && shown.getMonth() === today.getMonth()
    ? today.getDate() : calendarDate(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
  picked = calendarDate(shown.getFullYear(), shown.getMonth(), Math.min(picked.getDate(), lastDay));
  showClockError("");
  drawCalendar();
}

function showCalendarView(view, focus = false) {
  calendarView = view;
  const months = view === "months";
  const years = view === "years";
  $("cal-grid").hidden = view !== "days";
  $("cal-options").hidden = view === "days";
  $("cal-month").setAttribute("aria-expanded", String(months));
  $("cal-year").setAttribute("aria-expanded", String(years));
  $("cal-help").textContent = months ? "Choose a month." : years ? "Choose a year. Scroll for more." : "Choose a day, or open the month and year above.";
  for (const id of ["cal-prev", "cal-next"]) $(id).style.visibility = view === "days" ? "" : "hidden";
  $("cal-earlier").hidden = !years || firstYear === 1;
  if (view !== "days") {
    const year = shown.getFullYear();
    const today = new Date();
    const lastYear = Math.min(9999, today.getFullYear());
    firstYear = Math.min(firstYear, year);
    const values = months ? monthNames.map((_, month) => month) : Array.from({ length: lastYear - firstYear + 1 }, (_, i) => lastYear - i);
    $("cal-options").classList.toggle("years", years);
    $("cal-options").setAttribute("aria-label", months ? "Months" : "Years");
    $("cal-options").replaceChildren(...values.map(value => {
      const selected = months ? value === shown.getMonth() : value === year;
      const option = el("button", selected ? "selected" : "", months ? monthNames[value] : String(value));
      option.type = "button";
      option.disabled = months && calendarDate(year, value) > today;
      option.dataset.value = String(value);
      option.setAttribute("aria-pressed", String(selected));
      option.addEventListener("click", () => {
        choosePeriod(months ? shown.getFullYear() : value, months ? value : Math.min(shown.getMonth(), value === today.getFullYear() ? today.getMonth() : 11));
        showCalendarView(months ? "days" : "months", true);
      });
      return option;
    }));
  }
  if (focus) {
    const selected = $(view === "days" ? "cal-grid" : "cal-options").querySelector('[aria-pressed="true"]');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView?.({ block: "nearest" });
  }
}

function shiftMonth(by) {
  choosePeriod(shown.getFullYear(), shown.getMonth() + by);
}

let pickedMinutes = 0;
const DAY_MINUTES = 24 * 60;
const twoDigits = (n) => String(n).padStart(2, "0");

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

    if (Number(digits) > highest) input.value = String(highest);
    pickedMinutes = unit === "hour" ? value * 60 + (pickedMinutes % 60) : Math.floor(pickedMinutes / 60) * 60 + value;
    drawTime(true);

    if (unit === "hour" && (digits.length === 2 || value > 2)) {
      input.value = twoDigits(value);
      $("clock-minute").focus();
    }
  });

  input.addEventListener("blur", () => drawTime());
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    stepTime(unit, event.key === "ArrowUp" ? 1 : -1, true);
    input.select();
  });

  for (const arrow of spin.querySelectorAll("button")) {
    const step = () => stepTime(unit, Number(arrow.dataset.step));

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

        if (event.type === "pointerleave") pressed = false;
      };
      arrow.addEventListener("pointerup", stop);
      arrow.addEventListener("pointerleave", stop);
    });

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
    showClockError("");
    picked = new Date(Math.min(agentNow().getTime(), Date.now()));
    shown = calendarDate(picked.getFullYear(), picked.getMonth());
    firstYear = Math.max(1, Math.min(1900, picked.getFullYear() - 10));
    pickedMinutes = picked.getHours() * 60 + picked.getMinutes();
    drawCalendar();
    showCalendarView("days");
    drawTime();
    $("cal-grid").querySelector("[aria-pressed=true]")?.focus({ preventScroll: true });
  } else { $("stamp").focus({ preventScroll: true }); }
}

$("stamp").addEventListener("click", () => toggleClock($("clock").hidden));
$("cal-prev").addEventListener("click", () => shiftMonth(-1));
$("cal-next").addEventListener("click", () => shiftMonth(1));
$("cal-month").addEventListener("click", () => showCalendarView(calendarView === "months" ? "days" : "months", true));
$("cal-year").addEventListener("click", () => showCalendarView(calendarView === "years" ? "days" : "years", true));
$("cal-earlier").addEventListener("click", () => {
  firstYear = Math.max(1, firstYear - 100);
  const scroll = $("cal-options").scrollTop;
  showCalendarView("years");
  $("cal-options").scrollTop = scroll;
});
$("cal-options").addEventListener("keydown", (event) => {
  const buttons = [...$("cal-options").querySelectorAll("button:not(:disabled)")];
  const index = buttons.indexOf(document.activeElement);
  const columns = calendarView === "years" ? 4 : 3;
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
  if (index < 0 || (delta === undefined && event.key !== "Home" && event.key !== "End")) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + delta));
  buttons[next].focus({ preventScroll: true });
  buttons[next].scrollIntoView?.({ block: "nearest" });
});
$("clock").addEventListener("submit", (event) => {
  event.preventDefault();
  const target = calendarDate(picked.getFullYear(), picked.getMonth(), picked.getDate(), Math.floor(pickedMinutes / 60), pickedMinutes % 60);
  setClock(target.toISOString());
});
$("clock-reset").addEventListener("click", () => setClock(null));

const emptyTemplate = $("empty").cloneNode(true);
const entries = [];
let lastEra = null;
let ledgerEpisodes = [];
let ledgerYearOnly = false;
let toastTimer;
let sourceRequest = 0;

function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

function updateEra() {
  const date = agentNow();
  $("header-now").hidden = !simulated;
  const composerBar = $("composer-era-bar");
  composerBar.hidden = !simulated;
  $("composer-now").hidden = !simulated;
  if (simulated) {
    $("composer-era").textContent = `Era simulation · ${dayLabel(date)}`;
    $("composer-era").classList.add("is-simulated");
    $("composer-era-note").textContent = "Live research. Historical perspective.";
  }
  if ($("edition-year")) {
    $("edition-year").textContent = date.getFullYear();
    $("edition-date").textContent = date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    const note = simulated ? "The answer takes this date’s perspective. Later outcomes are still unknown." : "";
    $("edition-note").textContent = note;
    $("edition-note").hidden = !note;
    $("starter-context").textContent = simulated ? `Questions for ${date.getFullYear()}` : "Research, remember, revisit";
    const questions = simulated
      ? [date.getFullYear() >= 1947 ? "Is India already independent?" : "Will India gain independence?", "Who is leading India right now?", date.getFullYear() < 2007 ? "Could I buy an iPhone today?" : "Who won the most recent IPL season?"]
      : ["What changed in AI this week?", "Compare managed Postgres hosting for a small SaaS", "What did we discuss earlier, and is it still correct?"];
    document.querySelectorAll("[data-starter]").forEach((button, i) => {
      button.dataset.question = questions[i];
      button.replaceChildren(el("span", "starter-number", `0${i + 1}`), el("span", "starter-question", questions[i]), el("span", "starter-arrow", "↗"));
    });
  }
}

function showDialog(dialog) {
  dialog.hidden = false;
  if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
}
function closeDialog(dialog) {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  dialog.hidden = true;
}

function sourceHref(source) {
  const value = source.archive?.captureUrl ?? (source.temporal?.provenanceKind === "archive" ? source.temporal.provenanceUrl : source.url);
  try { const url = new URL(value); return /^(https?|http):$/.test(url.protocol) ? url.href : "#"; } catch { return "#"; }
}
function displayAnswer(text) {
  // Presentation compatibility only: leave the saved record and fact-specific uncertainty intact.
  const legacyPreface = "I could not verify this answer against the available evidence. Treat the following as unverified.";
  for (const separator of ["\n\n", "\r\n\r\n"]) {
    if (text.startsWith(legacyPreface + separator)) { text = text.slice(legacyPreface.length + separator.length); break; }
  }
  return /^\s*I could not verify this as of \S+\.[\s\S]*(?:Exa Snapshot|preserved evidence|cited historical evidence|fully verified answer)/i.test(text)
    ? "This older answer used a retired simulation mode. Re-check it to research this date again." : text;
}
function displayError(message) {
  return /Exa Snapshot|snapshot_access_denied|matching preserved evidence/i.test(message)
    ? "This older answer needs a fresh lookup. You can retry it here." : message;
}

async function openSource(source, context = {}) {
  const requestId = ++sourceRequest;
  $("source-number").textContent = `Evidence / ${String(source.n).padStart(2, "0")}`;
  $("source-title").textContent = source.title;
  $("source-host").textContent = new URL(source.url).hostname.replace(/^www\./, "");
  $("source-host").href = sourceHref(source);
  $("source-original").href = sourceHref(source);
  $("source-context").textContent = context.at ? `Used in an answer as of ${dayLabel(new Date(context.at))}.` : "Supporting source for this answer.";
  $("source-dates").replaceChildren();
  for (const [label, value] of [["Published", source.publishedDate], ["Researched", source.retrievedAt?.slice(0, 10)]]) {
    if (value) { const cell = el("div"); cell.append(el("span", "eyebrow", label), el("span", "", value)); $("source-dates").append(cell); }
  }
  $("source-passage").textContent = source.text || (context.episodeId ? "Loading the saved passage…" : "A passage was not saved with this older entry. Read the original source for the full context.");
  showDialog($("source-dialog"));
  if (!source.text && context.episodeId) {
    try {
      const response = await fetch(`/api/episodes/${context.episodeId}`);
      if (!response.ok) throw new Error();
      const detail = await response.json();
      const saved = detail.sources.find(item => item.n === source.n);
      if (!$("source-dialog").hidden && requestId === sourceRequest) {
        $("source-passage").textContent = saved?.text || "A passage was not saved with this older entry. Read the original source for the full context.";
      }
    } catch { if (requestId === sourceRequest) $("source-passage").textContent = "The saved passage could not be loaded. You can still read the original source."; }
  }
}

DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
function renderAnswer(container, markdown, sources, context = {}) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(displayAnswer(markdown), { gfm: true }));
  const byNumber = new Map(sources.map(source => [source.n, source]));
  for (const node of citationTextNodes(container)) {
    const parts = node.textContent.split(/(\[\d+(?:\s*,\s*\d+)*\])/);
    if (parts.length === 1) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const numbers = /^\[[\d,\s]+\]$/.test(part) ? part.slice(1, -1).split(",").map(Number) : [];
      if (!numbers.length || !numbers.every(n => byNumber.has(n))) { fragment.append(part); continue; }
      for (const n of numbers) {
        const source = byNumber.get(n);
        const link = el("a", "cite", `[${n}]`);
        link.href = sourceHref(source);
        link.title = `Inspect source ${n}: ${source.title}`;
        link.setAttribute("aria-haspopup", "dialog");
        link.addEventListener("click", event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); openSource(source, context); } });
        fragment.append(link);
      }
    }
    node.replaceWith(fragment);
  }
  for (const table of container.querySelectorAll("table")) {
    const wrap = el("div", "table-scroll"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "Answer table, scroll horizontally if needed");
    table.replaceWith(wrap); wrap.append(table);
  }
}
function renderSources(list, sources, context = {}) {
  list.replaceChildren(...sources.map(source => {
    const item = el("li");
    const button = el("button", "source-chip"); button.type = "button"; button.setAttribute("aria-haspopup", "dialog");
    button.append(el("span", "n", String(source.n)), el("span", "host", new URL(source.url).hostname.replace(/^www\./, "")), el("span", "source-chevron", "↗"));
    button.title = source.title; button.addEventListener("click", () => openSource(source, context)); item.append(button); return item;
  }));
  list.hidden = !sources.length;
}

function buttonAction(label, action, className = "text-action") {
  const button = el("button", className, label); button.type = "button"; button.addEventListener("click", action); return button;
}
function addEntry(question, options = {}) {
  $("empty")?.remove();
  const now = new Date(options.at ?? agentNow());
  const isEra = options.simulated ?? simulated;
  const eraKey = `${isEra}:${now.toLocaleDateString("en-CA")}`;
  if (lastEra && lastEra !== eraKey) {
    const divider = el("div", "era-divider"); divider.append(el("span", "", isEra ? `Viewpoint changed · ${dayLabel(now)}` : "Returned to the present")); $("thread").append(divider);
  }
  lastEra = eraKey;
  const entry = el("article", "entry");
  const gutter = el("div", "gutter"); gutter.append(el("time", "", timeLabel(now)), el("span", "", dayLabel(now)), el("span", "entry-mode", isEra ? "SIMULATION" : "LIVE"));
  const body = el("div", "body");
  const view = { entry, at: now.toISOString(), isEra, question, trace: el("ul", "trace"), answer: el("div", "answer"), sources: el("ol", "sources"), timings: el("div", "timings"), status: el("div", "answer-status"), steps: el("ol", "answer-steps"), actions: el("div", "answer-actions"), details: el("details", "answer-details"), text: "", dataSources: [], episodeId: options.episodeId };
  view.clarification = el("div", "clarification-slot");
  view.status.setAttribute("role", "status");
  for (const [i, title] of ["Researching", "Checking era", "Preparing answer"].entries()) view.steps.append(el("li", "", `${String(i + 1).padStart(2, "0")} ${title}`));
  view.details.append(el("summary", "", "Research details"), view.trace, view.timings);
  view.sources.hidden = true; view.actions.hidden = true;
  body.append(el("h2", "question", question), view.clarification, view.steps, view.answer, view.sources, view.status, view.actions, view.details);
  entry.append(gutter, body); $("thread").append(entry); entries.push(view);
  if (!options.restored) entry.scrollIntoView({ block: "start", behavior: "smooth" });
  return view;
}
function stage(view, index, label) {
  view.steps.hidden = false;
  [...view.steps.children].forEach((item, i) => { item.classList.toggle("active", i === index); item.classList.toggle("complete", i < index); });
  view.status.textContent = label;
}
function traceLine(list, kind, label) {
  const item = el("li"); item.append(el("span", "kind", kind), el("span", "label", label), el("span", "state")); list.append(item); return item;
}
function paintView(view) { renderAnswer(view.answer, view.text, view.dataSources, { at: view.at, episodeId: view.episodeId }); }

function choiceSummary(view, answer) {
  view.clarification.replaceChildren();
  const summary = el("div", "clarification-summary");
  summary.append(el("span", "eyebrow", answer.skipped ? "Using reasonable assumptions" : "Your direction"), el("p", "", answer.answer));
  view.clarification.append(summary);
}
function updatePendingComposer() {
  input.placeholder = pendingView?.card.selection ? "Use saved choice above" : pendingView ? "Your own detail…" : "Ask anything";
  if (pendingView) {
    $("compose-context").hidden = false;
    $("compose-context").textContent = `Clarifying: ${pendingView.question}`;
  } else $("compose-context").hidden = true;
}
function selectionFor(answer) {
  return answer.skipped ? { skip: true } : answer.optionId ? { optionId: answer.optionId } : { text: answer.answer };
}
function showClarification(view, card) {
  view.clarificationId = card.id;
  view.card = card;
  view.awaitingClarification = true;
  pendingView = view;
  view.steps.hidden = true; view.actions.hidden = true; view.details.hidden = true;
  view.clarification.replaceChildren();
  const section = el("section", "clarification-card");
  const heading = el("h3", "", card.question); heading.id = `clarification-${card.id}`; heading.tabIndex = -1;
  section.setAttribute("aria-labelledby", heading.id);
  section.append(el("span", "eyebrow", "One detail will help"), heading, el("p", "clarification-why", card.why));
  const options = el("div", "clarification-options"); options.setAttribute("role", "group"); options.setAttribute("aria-label", card.question);
  for (const option of card.options) {
    const button = buttonAction("", () => submitClarification(view, { optionId: option.id }), "clarification-option");
    const content = el("span", "option-content"); content.append(el("strong", "", option.label), el("span", "option-detail", option.detail));
    button.append(el("span", "option-letter", option.id.toUpperCase()), content, el("span", "option-arrow", "↗")); options.append(button);
  }
  section.append(options);
  const form = el("form", "clarification-custom");
  const label = el("label", "", "Or add your own detail");
  const field = el("input"); field.type = "text"; field.maxLength = 1000; field.placeholder = "Tell me what matters to you…"; field.id = `detail-${card.id}`; label.htmlFor = field.id;
  const row = el("div", "custom-detail-row"); const submit = el("button", "", "Use this detail ↗"); submit.type = "submit"; row.append(field, submit);
  form.append(label, row); form.addEventListener("submit", event => {
    event.preventDefault();
    if (!field.value.trim()) { error.textContent = "Choose an option or add a short detail."; field.focus(); return; }
    submitClarification(view, { text: field.value.trim() });
  });
  const error = el("p", "clarification-error"); error.setAttribute("role", "alert");
  section.append(form, error, buttonAction("Use your best judgment instead ↗", () => submitClarification(view, { skip: true }), "text-action clarification-skip"));
  if (view.isEra) section.append(el("p", "clarification-date", `This answer stays set to ${dayLabel(new Date(view.at))}.`));
  view.clarification.append(section);
  view.status.textContent = "Waiting for your direction. No research is running.";
  if (card.selection) {
    view.submittedSelection = selectionFor(card.selection);
    choiceSummary(view, card.selection);
    const resume = buttonAction("Continue with this choice ↗", () => submitClarification(view, view.submittedSelection), "text-action clarification-resume");
    view.clarification.append(resume);
    view.status.textContent = "Your choice is saved. Continue above to finish the answer.";
  }
  updatePendingComposer();
}
function submitClarification(view, selection) {
  if (inFlight) return;
  view.idempotencyKey = null; view.turnId = null; view.turnStatus = null; view.requestBody = null;
  view.awaitingClarification = false; view.submittedSelection = selection; pendingView = null;
  const option = "optionId" in selection ? view.card.options.find(option => option.id === selection.optionId) : null;
  const answer = { answer: option ? `${option.label}: ${option.detail}` : "text" in selection ? selection.text : "Use your best judgment and state reasonable assumptions.", skipped: Boolean(selection.skip) };
  choiceSummary(view, answer); updatePendingComposer();
  send(view.question, { view, clarification: { id: view.clarificationId, selection } });
}
function showActions(view, failed = false) {
  view.actions.replaceChildren(); view.actions.hidden = false;
  if (!failed) view.actions.append(buttonAction("Copy answer", async () => {
    const citations = view.dataSources.filter(source => view.cited?.includes(source.n)).map(source => `[${source.n}] ${source.title} — ${sourceHref(source)}`).join("\n");
    try { await navigator.clipboard.writeText(`${displayAnswer(view.text)}${citations ? `\n\nSources\n${citations}` : ""}`); notify("Answer and source links copied."); }
    catch { notify("Copy is unavailable in this browser. Select the answer text to copy it."); }
  }));
  view.actions.append(buttonAction("Edit question", () => { $("input").value = view.question; $("compose-context").textContent = "Editing an earlier question · sends as a new entry"; $("compose-context").hidden = false; fitInput(); $("input").focus(); }));
  view.actions.append(buttonAction(failed ? "Retry question ↗" : "Ask again", () => { if (inFlight) return notify("Finish or stop the current answer first.");
    if (failed && view.turnId && !["failed", "interrupted", "missing"].includes(view.turnStatus)) return checkSaved(view).catch(error => notify(error.message));
    if (failed && ["failed", "interrupted"].includes(view.turnStatus)) { view.idempotencyKey = null; view.turnId = null; view.requestBody = null; }
    if (failed && view.clarificationExpired) return send(view.question);
    if (failed && view.clarificationId && view.submittedSelection) return send(view.question, { view, clarification: { id: view.clarificationId, selection: view.submittedSelection } });
    send(view.question, failed ? { view } : {}); }));
  if (!failed && view.isEra) view.actions.append(buttonAction("Re-check now ↗", () => recheck(view.episodeId)));
}
function completeEntry(view, timings, cited) {
  view.cited = cited; view.turnStatus = "completed"; clearPendingTurn(view);
  view.details.open = false;
  view.steps.hidden = true;
  paintView(view);
  const sources = view.dataSources.filter(source => cited.includes(source.n));
  renderSources(view.sources, sources, { at: view.at, episodeId: view.episodeId });
  view.status.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"}${timings?.totalMs != null ? ` · ${seconds(timings.totalMs)}` : ""} · Saved to Ledger${view.quality === "explicitly_unverified" ? " · Unverified" : view.quality === "supported_partial" ? " · Partially supported" : ""}`;
  view.status.classList.add("is-complete");
  showActions(view);
}

function rememberPendingTurn(view) {
  try { sessionStorage.setItem("asof.pending.turn", JSON.stringify({ sessionId: view.requestBody?.sessionId ?? sessionId, requestBody: view.requestBody, turnId: view.turnId, question: view.question, at: view.at, isEra: view.isEra, idempotencyKey: view.idempotencyKey })); } catch {}
}
function clearPendingTurn(view) {
  try { const saved = JSON.parse(sessionStorage.getItem("asof.pending.turn") || "null"); if (saved && (view.idempotencyKey && saved.idempotencyKey === view.idempotencyKey || view.turnId && saved.turnId === view.turnId)) sessionStorage.removeItem("asof.pending.turn"); } catch {}
}
async function checkSaved(view, signal) {
  const result = await readTurn(view.turnId ?? { idempotencyKey: view.idempotencyKey }, fetch, signal);
  if (!result.turn) {
    view.turnStatus = "missing"; view.steps.hidden = true;
    view.status.textContent = "No saved answer was found. Retry will use the same request key.";
    view.answer.replaceChildren(el("p", "failure", view.status.textContent)); showActions(view, true); return;
  }
  view.turnId = result.turn.id; rememberPendingTurn(view);
  view.turnStatus = result.turn.status;
  view.steps.hidden = true;
  if (result.turn.status === "completed") {
    const existing = entries.find(item => item !== view && item.episodeId === result.episode.id);
    if (existing) { view.entry.remove(); entries.splice(entries.indexOf(view), 1); clearPendingTurn(view); return; }
    view.episodeId = result.episode.id; view.text = result.episode.answer; view.quality = result.episode.quality;
    view.dataSources = result.sources ?? []; paintView(view); completeEntry(view, null, view.dataSources.map(source => source.n)); return;
  }
  if (result.turn.status === "running") {
    view.status.textContent = "Your answer is still running. Check its saved status below.";
    view.actions.replaceChildren(buttonAction("Check saved answer ↗", () => checkSaved(view).catch(error => notify(error.message)))); view.actions.hidden = false; return;
  }
  clearPendingTurn(view);
  view.status.textContent = "This attempt ended before an answer was saved. You can retry your question.";
  view.answer.replaceChildren(el("p", "failure", view.status.textContent)); showActions(view, true);
}
async function restorePendingTurn() {
  let saved; try { saved = JSON.parse(sessionStorage.getItem("asof.pending.turn") || "null"); } catch { return; }
  if (!saved || saved.sessionId !== sessionId) return;
  const view = addEntry(saved.question, { at: saved.at, simulated: saved.isEra, restored: true });
  view.turnId = saved.turnId; view.idempotencyKey = saved.idempotencyKey; view.requestBody = saved.requestBody;
  try { await checkSaved(view); } catch (error) { view.status.textContent = error.message; view.turnStatus = "running"; showActions(view, true); }
}
async function send(message, options = {}) {
  if (inFlight || !message.trim()) return;
  const view = options.view ?? addEntry(message.trim());
  view.text = ""; view.dataSources = []; view.answer.replaceChildren(); view.actions.hidden = true;
  view.details.hidden = false;
  view.details.open = true;
  view.status.classList.remove("is-complete", "is-interrupted");
  const requestStarted = performance.now();
  const noteRender = () => {
    if (!view.text || view.firstRenderMs != null) return; view.firstRenderMs = Math.round(performance.now() - requestStarted);
    if (view.turnId) fetch(`/api/turns/${encodeURIComponent(view.turnId)}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstRenderMs: view.firstRenderMs }) }).catch(() => {});
  };
  view.firstRenderMs = null;
  const abort = new AbortController(); inFlight = abort; setBusy(true);
  const asOf = view.isEra ? new Date(view.at).toISOString() : undefined;
  view.idempotencyKey ??= crypto.randomUUID();
  view.requestBody ??= { sessionId, message: message.trim(), tz, mode: view.isEra ? "era" : "live", asOf,
    ...(options.recheckEpisodeId ? { recheckEpisodeId: options.recheckEpisodeId } : {}),
    ...(options.clarification ? { clarification: options.clarification } : {}) };
  rememberPendingTurn(view);
  $("compose-context").hidden = true;
  let frame = 0, completed = false, reader;
  const searches = new Map(); let reviewLine;
  stage(view, 0, "Finding the sources behind your answer…");
  const handle = event => {
    if (event.type === "turn") { view.turnId = event.turnId; view.turnStatus = "running"; rememberPendingTurn(view); }
    else if (event.type === "clarification") { clearPendingTurn(view); showClarification(view, event.card); }
    else if (event.type === "recall") for (const note of event.notes) traceLine(view.trace, "memory", note);
    else if (event.type === "search") {
      const line = searches.get(event.id) ?? traceLine(view.trace, "search", event.query); searches.set(event.id, line); line.className = event.state;
      line.querySelector(".state").textContent = event.state === "running" ? "searching" : event.state === "failed" ? "lookup unsuccessful" : `${event.results} results · ${seconds(event.ms)}`;
      if (event.state === "running") stage(view, 0, view.isEra ? "Researching the world at your selected date…" : "Researching current sources…");
    } else if (event.type === "verification") {
      reviewLine ??= traceLine(view.trace, "review", "Era and sources");
      reviewLine.querySelector(".state").textContent = event.state === "running" ? "checking" : event.state === "unavailable" ? "review unavailable" : `complete · ${seconds(event.ms)}`;
      stage(view, event.state === "running" ? 1 : 2, event.state === "running" ? "Checking dates, source support, and historical perspective…" : "Preparing your answer…");
    } else if (event.type === "sources") view.dataSources = event.sources;
    else if (event.type === "text") {
      stage(view, 2, "Preparing your answer…"); view.text += event.delta;
      frame ||= requestAnimationFrame(() => { frame = 0; paintView(view); noteRender(); });
    } else if (event.type === "retract") { view.text = ""; paintView(view); }
    else if (event.type === "done") {
      completed = true; view.episodeId = event.episodeId; view.quality = event.quality; view.turnId = event.turnId ?? view.turnId;
      view.timings.textContent = `Recall ${seconds(event.timings.recallMs)} · ${event.timings.searches} searches · ${event.timings.modelCalls} model calls${event.timings.verificationMs ? ` · review ${seconds(event.timings.verificationMs)}` : ""} · total ${seconds(event.timings.totalMs)}`;
      completeEntry(view, event.timings, event.cited);
    } else if (event.type === "error") throw new Error(displayError(event.message));
  };
  try {
    const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": view.idempotencyKey }, body: JSON.stringify(view.requestBody), signal: abort.signal });
    const durableId = response.headers.get("x-turn-id");
    if (durableId) { view.turnId = durableId; view.turnStatus = "running"; rememberPendingTurn(view); }
    if (response.status === 202) {
      await checkSaved(view, abort.signal); completed = view.turnStatus === "completed"; return;
    }
    if (!response.ok) {
      const failure = await response.json();
      if (failure.code === "clarification_unavailable") {
        view.clarificationId = null; view.submittedSelection = null; view.clarificationExpired = true;
        view.clarification.replaceChildren();
      }
      throw new Error(failure.error ?? "The request could not be completed.");
    }
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; buffer += value;
      if (buffer.length > 262_144) throw new Error("The answer stream exceeded its buffer limit. Check the saved answer.");
      const batches = buffer.split("\n\n"); buffer = batches.pop();
      for (const raw of batches) if (raw.startsWith("data: ")) handle(JSON.parse(raw.slice(6)));
    }
    if (!completed && !view.awaitingClarification && !abort.signal.aborted) throw new Error("The connection ended before the answer was saved. You can retry your question.");
  } catch (error) {
    cancelAnimationFrame(frame); frame = 0;
    if (view.turnId || view.idempotencyKey) {
      if (view.turnId && abort.signal.aborted) { try { await fetch(`/api/turns/${encodeURIComponent(view.turnId)}`, { method: "POST" }); } catch {} }
      try { await checkSaved(view); if (view.turnStatus === "completed") { completed = true; return; } if (["running", "missing", "failed", "interrupted"].includes(view.turnStatus)) return; } catch {}
    }
    view.steps.hidden = true;
    view.status.classList.remove("is-complete"); view.status.classList.add("is-interrupted");
    view.status.textContent = abort.signal.aborted ? "Stopped. You can edit or retry your question." : "The answer was interrupted. Your question is still here.";
    if (!abort.signal.aborted) view.answer.replaceChildren(el("p", "failure", displayError(error.message)));
    showActions(view, true);
  } finally {
    await reader?.cancel().catch(() => {});
    cancelAnimationFrame(frame);
    if (completed) { paintView(view); requestAnimationFrame(noteRender); }
    else if (view.turnStatus !== "running") view.details.open = false;
    if (inFlight === abort) { inFlight = null; setBusy(false);
      if (view.awaitingClarification) view.clarification.querySelector("h3")?.focus({ preventScroll: true });
    }
  }
}

const input = $("input");
function setBusy(busy) {
  $("send").textContent = busy ? "Stop" : pendingView?.card.selection ? "Continue ↗" : pendingView ? "Add detail ↗" : "Send ↗";
  $("send").setAttribute("aria-label", busy ? "Stop answer" : pendingView?.card.selection ? "Continue with saved choice" : pendingView ? "Submit clarification detail" : "Send message");
  if (!busy) (pendingView?.clarification.querySelector("h3, .clarification-resume") ?? input).focus({ preventScroll: true });
}
function fitInput() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
$("composer").addEventListener("submit", event => { event.preventDefault(); if (inFlight) return inFlight.abort();
  if (pendingView?.card.selection) return submitClarification(pendingView, pendingView.submittedSelection);
  const message = input.value; if (!message.trim()) return;
  if (pendingView && message.trim().length > 1000) return notify("Keep this detail under 1000 characters, or start a new chat.");
  input.value = ""; fitInput();
  if (pendingView) submitClarification(pendingView, { text: message.trim() });
  else send(message); });
input.addEventListener("input", fitInput);
input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); } });
$("thread").addEventListener("click", event => { const starter = event.target.closest("[data-question]"); if (starter) send(starter.dataset.question); });
function resetThread() { $("thread").replaceChildren(); entries.length = 0; lastEra = null; pendingView = null; }
function newChat() {
  clearTimeout(toastTimer); $("toast").hidden = true;
  inFlight?.abort(); inFlight = null; sessionId = crypto.randomUUID(); rememberSession(); resetThread(); setBusy(false);
  $("thread").append(emptyTemplate.cloneNode(true)); updateEra(); input.value = ""; fitInput(); $("compose-context").hidden = true;
  updatePendingComposer();
}
$("new-chat").addEventListener("click", newChat);
document.querySelector(".wordmark").addEventListener("click", event => { event.preventDefault(); newChat(); });
$("composer-era").addEventListener("click", () => toggleClock($("clock").hidden));
for (const id of ["header-now", "composer-now"]) $(id).addEventListener("click", () => setClock(null));
async function recheck(episodeId) {
  if (inFlight) return notify("Finish or stop the current answer first.");
  try {
    const response = await fetch(`/api/episodes/${episodeId}`);
    if (!response.ok) throw new Error("The saved answer could not be loaded. Open its conversation and try again.");
    const { episode } = await response.json();
    if (!episode || !Number.isSafeInteger(episode.id)) throw new Error("The saved answer could not be loaded.");
    if (sessionId !== episode.sessionId && !await restoreSession(episode.sessionId, true)) throw new Error("The saved conversation could not be loaded.");
    closeDialog($("ledger"));
    if (!await setClock(null)) return notify("The date could not be updated. Try again.");
    send(`Re-check your answer to “${episode.question}” from ${dayLabel(new Date(episode.askedAt))} using current sources. What is still correct, and what has changed?`, { recheckEpisodeId: episode.id });
  } catch (error) { notify(error.message); }
}

async function restoreSession(id, scroll = false) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("This saved conversation could not be loaded.");
  const { episodes, conversation } = await response.json();
  if (conversation) applyState({ ...latestState, now: new Date(conversation.viewpointAt ?? Date.now()).toISOString(), simulated: conversation.viewpointAt !== null });
  if (!episodes.length) return false;
  resetThread(); sessionId = id; rememberSession();
  for (const item of episodes) {
    const { episode, sources } = item;
    const view = addEntry(episode.question, { at: episode.askedAt, simulated: Boolean(episode.execution?.time?.simulated ?? episode.execution?.simulation), episodeId: episode.id, restored: true });
    view.text = episode.answer; view.dataSources = sources; view.quality = episode.quality;
    if (episode.execution?.clarification) choiceSummary(view, episode.execution.clarification);
    completeEntry(view, null, sources.map(source => source.n));
    view.details.hidden = true;
  }
  if (scroll) entries.at(-1)?.entry.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}
async function restorePending(id) {
  if (!clarificationsEnabled) return;
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/clarification`);
  if (!response.ok) return;
  const { card } = await response.json();
  if (!card) return;
  const view = addEntry(card.message, { at: card.time.effectiveAt, simulated: card.time.simulated, restored: true });
  showClarification(view, card);
}
async function openConversation(episode) {
  if (inFlight) return notify("Finish or stop the current answer first.");
  try { await restoreSession(episode.sessionId, true); await restorePending(episode.sessionId); updatePendingComposer(); setBusy(false); closeDialog($("ledger")); notify("Conversation reopened. Continue below."); }
  catch (error) { notify(error.message); }
}
function drawLedger() {
  const term = $("ledger-search").value.trim().toLowerCase();
  const year = agentNow().getFullYear();
  const filtered = ledgerEpisodes.filter(episode => (!ledgerYearOnly || new Date(episode.askedAt).getFullYear() === year)
    && `${episode.question} ${episode.summary || ""} ${episode.answer || ""} ${dayLabel(new Date(episode.askedAt))} ${new Date(episode.askedAt).toISOString().slice(0, 10)}`.toLowerCase().includes(term));
  $("ledger-count").textContent = `${filtered.length} ${filtered.length === 1 ? "entry" : "entries"}`;
  const body = $("ledger-body"); body.replaceChildren();
  if (!filtered.length) body.append(el("p", "ledger-empty", ledgerEpisodes.length ? "No matching entries. Try another topic or date." : "Your first answer will start the record."));
  let currentDay = "";
  for (const episode of filtered) {
    const date = new Date(episode.askedAt); const label = dayLabel(date);
    if (label !== currentDay) { currentDay = label; body.append(el("h3", "ledger-day", label)); }
    const item = el("div", "ledger-item");
    item.append(el("div", "when", `${timeLabel(date)} · ${episode.execution?.simulation?.mode === "era" ? "Era simulation" : "Live research"}`));
    item.append(buttonAction(episode.question, () => openConversation(episode), "ledger-question"));
    if (episode.summary) item.append(el("p", "ledger-summary", episode.summary));
    const actions = el("div", "ledger-entry-actions");
    actions.append(buttonAction("Open conversation ↗", () => openConversation(episode)), buttonAction("Re-check now", () => recheck(episode.id))); item.append(actions); body.append(item);
  }
}
async function openLedger() {
  showDialog($("ledger")); $("ledger-body").replaceChildren(el("p", "ledger-empty", "Opening your record…"));
  try { const response = await fetch("/api/memory"); if (!response.ok) throw new Error(); const page = await response.json(); ledgerEpisodes = page.episodes; drawLedger(); addLedgerPage(page.nextCursor); }
  catch { $("ledger-body").replaceChildren(el("p", "ledger-empty", "The Ledger could not be loaded. Close it and try again.")); }
}
function addLedgerPage(cursor) {
  if (!cursor) return;
  const more = buttonAction("Load more entries", async () => {
    more.disabled = true;
    try { const response = await fetch(`/api/memory?cursor=${cursor}`); if (!response.ok) throw new Error(); const page = await response.json(); ledgerEpisodes.push(...page.episodes); drawLedger(); addLedgerPage(page.nextCursor); }
    catch { more.disabled = false; notify("More entries could not be loaded."); }
  }); $("ledger-body").append(more);
}
$("open-ledger").addEventListener("click", openLedger);
$("close-ledger").addEventListener("click", () => closeDialog($("ledger")));
$("ledger-search").addEventListener("input", drawLedger);
$("ledger-era").addEventListener("click", () => { ledgerYearOnly = !ledgerYearOnly; $("ledger-era").setAttribute("aria-pressed", String(ledgerYearOnly)); drawLedger(); });
$("source-close").addEventListener("click", () => closeDialog($("source-dialog")));
for (const dialog of [$("ledger"), $("source-dialog")]) {
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(dialog); });
  dialog.addEventListener("click", event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(dialog); });
}
function typingTarget(target) {
  return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true']");
}

function composeShortcutPressed(event) {
  if (typingTarget(event.target) || !$("clock").hidden || $("ledger").open || $("source-dialog").open) return false;
  const key = event.key.toLowerCase();
  if (isMacPlatform) {
    return key === "e" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }
  return key === "e" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function paintComposeShortcut() {
  const hint = $("compose-shortcut");
  if (!hint) return;
  hint.textContent = composeShortcut.label;
  input.setAttribute("aria-keyshortcuts", composeShortcut.aria);
  input.title = composeShortcut.title;
}

document.addEventListener("keydown", event => {
  if (composeShortcutPressed(event)) {
    event.preventDefault();
    input.focus({ preventScroll: true });
    return;
  }
  if (event.key !== "Escape") return;
  if (!$("source-dialog").hidden && $("source-dialog").open) { event.preventDefault(); closeDialog($("source-dialog")); }
  else if (!$("ledger").hidden) { event.preventDefault(); closeDialog($("ledger")); }
  else if (!$("clock").hidden) {
    event.preventDefault();
    if (calendarView !== "days") { const trigger = calendarView === "years" ? "cal-year" : "cal-month"; showCalendarView("days"); $(trigger).focus(); }
    else toggleClock(false);
  }
});
document.addEventListener("pointerdown", event => { if (!$("clock").hidden && !event.target.closest("#clock, #stamp, #composer-era-bar")) toggleClock(false); });

paintComposeShortcut();
applyState(await (await fetch(`/api/state?sessionId=${encodeURIComponent(sessionId)}`)).json());
try { await restoreSession(sessionId); await restorePending(sessionId); await restorePendingTurn(); } catch { notify("Saved conversation could not be restored. Your Ledger is still available."); }
setBusy(false); tick();
