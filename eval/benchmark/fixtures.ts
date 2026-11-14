import type { SearchHit } from "../../src/search.ts";
import type { BenchmarkCase } from "./score.ts";

export interface Fixture {
  task: BenchmarkCase;
  hits: SearchHit[];
  answer: string;
  noSearch?: boolean;

  correction?: { answer: string; issue: string };
}
const asOf = "2020-11-03T09:00:17.123Z";
const url = "https://example.com/fictional-cloud/pricing";
const source = { url, title: "Fictional Cloud plan history", publishedDate: "2026-01-01",
  text: "During 2020 the Starter plan cost $19 per month. The plan now costs $99." };
const historyUrl = "https://example.com/independence-history";
const historySource = { url: historyUrl, title: "Independence timeline", publishedDate: "2025-08-15",
  text: "In 1946 India had not yet become independent; political negotiations continued. India became independent on 15 August 1947." };
const technologyUrl = "https://example.com/technology-history";

export const FIXTURES: Fixture[] = [
  { task: { id: "historical-price", question: "What was Fictional Cloud's price?", asOf, sourceGrades: { [url]: 3 }, requiredFacts: ["$19"], forbiddenFacts: ["$99"], expectedAbstention: false }, hits: [source], answer: "The Starter plan was $19 per month [1]." },
  { task: { id: "completed-event-premise", question: "Will India get independence?", asOf: "1948-01-14T08:17:10.442Z",
    sourceGrades: { [historyUrl]: 3 }, requiredFacts: ["already independent", "15 August 1947"], expectedAbstention: false },
    hits: [historySource], answer: "India is already independent, having gained independence on 15 August 1947 [1]." },
  { task: { id: "future-outcome-repaired", question: "Will India get independence?", asOf: "1946-01-14T08:17:10.442Z",
    sourceGrades: { [historyUrl]: 3 }, requiredFacts: ["not yet", "negotiations"], forbiddenFacts: ["15 August 1947"], expectedAbstention: false },
    hits: [historySource], answer: "India will become independent on 15 August 1947 [1].",
    correction: { answer: "India is not yet independent. Political negotiations continue; their outcome is uncertain from this viewpoint [1].",
      issue: "Do not reveal the later independence date as known in 1946; discuss the negotiations already underway." } },
  { task: { id: "future-technology", question: "Which iPhone can I buy today?", asOf: "1948-01-14T08:17:10.442Z",
    sourceGrades: { [technologyUrl]: 3 }, requiredFacts: ["not available", "telephone"], forbiddenFacts: ["iPhone 17", "2007"], expectedAbstention: false },
    hits: [{ url: technologyUrl, title: "Telephone history", publishedDate: "2025-01-01", text: "In 1948 landline telephones and public telephone booths were in use. The iPhone was introduced in 2007." }],
    answer: "An iPhone is not available in this era. A landline telephone is a period-appropriate option [1]." },
  { task: { id: "present-verification", question: "Is Fictional Cloud's price still correct?", sourceGrades: { [url]: 3 }, requiredFacts: ["$25"] }, hits: [{ ...source, text: "The plan costs $25." }], answer: "The plan is $25 per month [1]." },
  { task: { id: "memory-visibility", question: "What did I ask about secret pricing?", asOf, forbiddenFacts: ["FUTURE_SENTINEL"], history: [{ at: "2020-11-04T00:00:00Z", question: "secret pricing FUTURE_SENTINEL", answer: "FUTURE_SENTINEL" }] }, hits: [], noSearch: true, answer: "I have no earlier conversation about that." },
];
