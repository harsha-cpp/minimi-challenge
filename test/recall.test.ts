import assert from "node:assert/strict";
import { test } from "node:test";
import { recall, renderMemory } from "../src/memory/recall.ts";
import { MemoryStore } from "../src/memory/store.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-11T23:44:00+05:30");
const at = (local: string) => Date.parse(`${local}+05:30`);

function seeded() {
  const store = new MemoryStore(":memory:");
  const save = (askedAt: number, question: string, answer: string) =>
    store.saveEpisode({ sessionId: "old", askedAt, tz: TZ, question, answer, sources: [] });

  const postgres = save(at("2026-11-03T14:05:00"), "Which managed database should a small SaaS use?", "Neon or Supabase.");
  store.enrich(postgres, {
    summary: "Compared managed Postgres hosts for a small SaaS.",
    topics: ["postgres hosting", "managed database", "pricing"],
    claims: [
      { entity: "Neon", attribute: "Launch plan price", value: "$19/month", kind: "price", sourceUrl: "https://neon.com/pricing", priorClaimId: null, verdict: "new" },
    ],
  });

  const crm = save(at("2026-11-09T11:00:00"), "Shortlist 5 CRM tools for a 20-person sales team", "HubSpot, Pipedrive, ...");
  store.enrich(crm, { summary: "Shortlisted five CRMs.", topics: ["crm", "sales tools"], claims: [] });

  const unrelated = save(at("2026-11-10T09:00:00"), "What is the capital of Australia?", "Canberra.");
  return { store, postgres, crm, unrelated };
}

test("'on 3 November' finds that day's conversation and its claims", () => {
  const { store, postgres } = seeded();
  const result = recall(store, "What did I ask you on 3 November? Is your answer still correct today?", NOW, TZ, new Set(), "local", { allowCrossSession: true });

  assert.deepEqual(result.refs.map((r) => r.text), ["3 November"]);
  const third = result.refs[0]!;
  assert.deepEqual(third.hits[0]!.episodes.map((e) => e.episode.id), [postgres]);
  assert.equal(third.hits[0]!.episodes[0]!.claims[0]!.value, "$19/month");

  const memory = renderMemory(result, TZ);
  assert.match(memory, /Tue 3 Nov 2026, 14:05/);
  assert.match(memory, /Neon · Launch plan price: \$19\/month — source: https:\/\/neon\.com\/pricing/);
});

test("topic matches do not decide between dates that both have conversations", () => {
  const { store, postgres } = seeded();

  const result = recall(store, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  const ref = result.refs[0]!;
  assert.equal(ref.hits.length, 2);
  assert.equal(ref.hits[0]!.range.label, "Tue 3 Nov 2026");
  assert.deepEqual(ref.hits[0]!.episodes.map((e) => e.episode.id), [postgres]);
  assert.equal(ref.hits[1]!.range.label, "Tue 10 Nov 2026");
  assert.match(renderMemory(result, TZ), /Keep these interpretations separate and ask which conversation the user means before verification/);
});

test("an ambiguous day with nothing to tell the readings apart stays ambiguous", () => {
  const { store } = seeded();
  const result = recall(store, "What did I ask last Tuesday?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  assert.equal(result.refs[0]!.hits.length, 2);
  assert.match(renderMemory(result, TZ), /is ambiguous: it could mean Tue 3 Nov 2026 or Tue 10 Nov 2026/);
  assert.match(renderMemory(result, TZ), /Keep these interpretations separate and ask which conversation the user means before verification/);
  assert.doesNotMatch(renderMemory(result, TZ), /Pick the one that fits/);
});

test("the topic words reach a conversation that used different words", () => {
  const { store, postgres } = seeded();

  const result = recall(store, "that postgres hosting comparison, any pricing changes?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  assert.deepEqual(result.related.map((e) => e.episode.id), [postgres]);
});

test("an empty date excludes nearby records and topic matches from the generated memory", () => {
  const { store, crm, postgres } = seeded();

  const result = recall(store, "On Friday we shortlisted 5 CRM tools for our sales team. Any changes?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  const ref = result.refs[0]!;
  assert.equal(ref.hits.length, 0);
  assert.deepEqual(ref.nearest.map((e) => e.id), [postgres, crm]);
  assert.deepEqual(result.related, []);
  const memory = renderMemory(result, TZ);
  assert.match(memory, /"Friday" → Fri 6 Nov 2026: no conversations found then\. Records exist outside the requested date range; they are not eligible for this request\./);
  for (const id of [postgres, crm]) {
    const episode = store.episode(id)!;
    assert.equal(memory.includes(episode.question), false);
    assert.equal(memory.includes(episode.answer), false);
    assert.equal(memory.includes(`[E${id}]`), false);
  }
  assert.doesNotMatch(memory, /Possibly related|CRM|Postgres|HubSpot|Neon/);
});

test("with no history at all the memory block says the log is empty", () => {
  const store = new MemoryStore(":memory:");
  const result = recall(store, "On Monday we shortlisted 5 CRM tools.", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  assert.match(renderMemory(result, TZ), /Mon 9 Nov 2026: no conversations found then\. No eligible conversations are available in the requested date range/);
});

test("a message with no date and no matching topic adds nothing", () => {
  const { store } = seeded();
  const result = recall(store, "How do rainbows form?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  assert.equal(renderMemory(result, TZ), "");
});

test("turns already in the current chat are pointed at, not repeated", () => {
  const { store, unrelated } = seeded();
  const result = recall(store, "what did I ask yesterday?", NOW, TZ, new Set([unrelated]), "local", { allowCrossSession: true });
  assert.equal(result.refs[0]!.hits[0]!.episodes[0]!.detail, "in-chat");
  assert.match(renderMemory(result, TZ), /this is in the current chat, above/);
});

test("'today' on its own is a day to look up", () => {
  const { store } = seeded();
  const id = store.saveEpisode({ sessionId: "old", askedAt: at("2026-11-11T09:00:00"), tz: TZ, question: "morning question", answer: "a", sources: [] });
  const result = recall(store, "What did I ask you today?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  assert.deepEqual(result.refs[0]!.hits[0]!.episodes.map((e) => e.episode.id), [id]);
});

test("only a bounded number of conversations are expanded in full", () => {
  const store = new MemoryStore(":memory:");
  for (let i = 0; i < 10; i++) {
    store.saveEpisode({ sessionId: "old", askedAt: at(`2026-11-10T1${i}:00:00`), tz: TZ, question: `q${i}`, answer: "a", sources: [] });
  }
  const result = recall(store, "what did I ask yesterday?", NOW, TZ, new Set(), "local", { allowCrossSession: true });
  const details = result.refs[0]!.hits[0]!.episodes.map((e) => e.detail);
  assert.equal(details.filter((d) => d === "full").length, 6);
  assert.equal(details.filter((d) => d === "pointer").length, 4);
});

test("rewinding time excludes future topic matches, same-day conversations and nearest suggestions", () => {
  const store = new MemoryStore(":memory:");
  const save = (at: string, question: string) => store.saveEpisode({ sessionId: "s", askedAt: Date.parse(at), tz: "UTC", question, answer: "a", sources: [] });
  const past = save("2020-11-03T09:00Z", "old topic");
  const future = save("2020-11-03T11:00Z", "secret future pricing");
  save("2020-11-05T11:00Z", "secret future pricing later");
  const now = new Date("2020-11-03T10:00Z");
  assert.deepEqual(store.sessionHistory("s", 8, now.getTime()).map(e => e.id), [past]);
  assert.equal(store.count(now.getTime()), 1);
  const sameDay = recall(store, "What did I ask today?", now, "UTC", new Set(), "local", { allowCrossSession: true });
  assert.deepEqual(sameDay.refs[0]!.hits[0]!.episodes.map(e => e.episode.id), [past]);
  const topic = recall(store, "secret future pricing", now, "UTC", new Set(), "local", { allowCrossSession: true });
  assert.equal(topic.related.length, 0);
  const empty = recall(store, "What did I ask on 2 November?", now, "UTC", new Set(), "local", { allowCrossSession: true });
  assert.ok(empty.refs.flatMap(r => r.nearest).every(e => e.id !== future && e.askedAt <= now.getTime()));
  store.close();
});
