/** Labels belong to the evaluator, never to the answering model or retrieval query. */
export interface SimulationCase {
  id: string;
  split: "regression" | "probe";
  category: string;
  asOf: string;
  question: string;
  /** An actual preceding user turn, generated in the same empty in-memory session. */
  precedingQuestion?: string;
  research: "required" | "optional" | "none";
  pairedCurrent?: boolean;
  expectations: Array<{ id: string; criterion: string }>;
  /** Evaluator references only: neither supplied URLs nor seeded research evidence. */
  references: string[];
}

export const SIMULATION_CASES: SimulationCase[] = [
  {
    id: "india-after-independence", split: "regression", category: "false future premise", asOf: "1948-01-14T08:17:10.442Z",
    question: "Will India get independence?", research: "required",
    expectations: [
      { id: "already-independent", criterion: "Correct the future premise: India is ALREADY independent at the selected January 1948 viewpoint." },
      { id: "independence-date", criterion: "Give the independence date as 15 August 1947 (August 15, 1947 is equivalent)." },
      { id: "no-republic-confusion", criterion: "Do not say India is already a republic or that independence occurred in 1950. Do not disclose post-viewpoint outcomes as completed facts." },
    ], references: ["https://www.india.gov.in/explore-india/facts-of-india/republic-day"],
  },
  {
    id: "india-before-independence", split: "regression", category: "future outcome restraint", asOf: "1947-01-14T08:00:00.000Z",
    question: "Will India get independence?", research: "required",
    expectations: [
      { id: "not-independent-yet", criterion: "Explain from January 1947 that India is not yet independent and remains under British rule." },
      { id: "future-not-certain", criterion: "Treat independence timing and final outcome as uncertain from this viewpoint; do not reveal 15 August 1947 as the known future date or describe partition as an already completed event." },
    ], references: ["https://www.india.gov.in/explore-india/facts-of-india/republic-day"],
  },
  {
    id: "declaration-day-before", split: "probe", category: "event boundary", asOf: "1776-07-03T12:00:00.000Z",
    question: "Has the Continental Congress adopted the final Declaration of Independence yet? Keep the answer to what has happened by today.", research: "required",
    expectations: [
      { id: "not-final-yet", criterion: "Say the final Declaration has not yet been adopted by July 3, 1776. Distinguish the July 2 independence resolution if mentioned." },
      { id: "no-tomorrow-outcome", criterion: "Do not state as a known future outcome that the Declaration will be adopted on July 4 or signed on August 2. It is fine to say the draft is being considered." },
    ], references: ["https://www.archives.gov/milestone-documents/declaration-of-independence", "https://www.archives.gov/founding-docs/timeline"],
  },
  {
    id: "india-not-yet-republic", split: "probe", category: "state transition", asOf: "1948-01-14T08:00:00.000Z",
    question: "Is India already a republic, or is it still a dominion?", research: "required",
    expectations: [
      { id: "dominion", criterion: "Identify India as an independent dominion, not yet a republic, in January 1948." },
      { id: "constitution-not-yet-in-force", criterion: "Do not present the January 1950 republic/Constitution commencement as already completed or guaranteed future knowledge in 1948." },
    ], references: ["https://www.india.gov.in/explore-india/facts-of-india/republic-day"],
  },
  {
    id: "constitution-original-term", split: "probe", category: "original historical document", asOf: "1800-01-14T12:00:00.000Z",
    question: "According to the original text of Article II of the U.S. Constitution, how long is a President's term of office? Give a short answer with a citation.", research: "required", pairedCurrent: true,
    expectations: [{ id: "four-year-term", criterion: "State that the original Article II term of office is four years, with a supporting source citation." }],
    references: ["https://www.archives.gov/founding-docs/constitution-transcript"],
  },
  {
    id: "us-president-2010", split: "probe", category: "historical officeholder", asOf: "2010-01-14T12:00:00.000Z",
    question: "Who is the president of the United States right now?", research: "required",
    expectations: [
      { id: "obama", criterion: "Name Barack Obama as the current president at the January 2010 viewpoint, rather than substituting the real present-day officeholder." },
      { id: "no-future-tenure", criterion: "Do not narrate Obama's post-January-2010 re-election, end of term, or later presidents as already known events. An explicitly uncertain forecast is allowed." },
    ], references: ["https://www.obamalibrary.gov/timeline"],
  },
  {
    id: "nobel-physics-2023", split: "probe", category: "completed science award", asOf: "2024-01-14T12:00:00.000Z",
    question: "Who received the 2023 Nobel Prize in Physics? Give the names and cite your source.", research: "required", pairedCurrent: true,
    expectations: [{ id: "all-three-laureates", criterion: "Name all three: Pierre Agostini, Ferenc Krausz, and Anne L'Huillier (curly apostrophe/spelling accents acceptable); do not substitute laureates from a different year." }],
    references: ["https://www.nobelprize.org/prizes/physics/2023/press-release/"],
  },
  {
    id: "apollo-first-landing", split: "probe", category: "completed space mission", asOf: "1970-01-14T12:00:00.000Z",
    question: "Which mission first landed humans on the Moon, and who were the two astronauts who walked on the surface? Cite your source.", research: "required", pairedCurrent: true,
    expectations: [{ id: "apollo11-walkers", criterion: "Identify Apollo 11, Neil Armstrong and Buzz Aldrin. Michael Collins can be mentioned only as remaining in lunar orbit, not walking on the Moon." }],
    references: ["https://www.nasa.gov/mission/apollo-11/", "https://www.nasa.gov/history/apollo-11-mission-overview/"],
  },
  {
    id: "ipl-each-year-2024", split: "regression", category: "complete annual table", asOf: "2024-11-14T06:22:08.161Z",
    question: "IPL WINNERS LIST EACH YEAR", research: "required",
    expectations: [
      { id: "all-seventeen-winners", criterion: "Give every completed season 2008 through 2024 inclusive with the correct winner, without missing a season. Correct mapping is independently checked by code." },
      { id: "no-future-winner", criterion: "Do not provide a completed winner for any season after the selected November 2024 viewpoint. A sentence saying future winners are not yet known is allowed." },
    ], references: ["https://indianexpress.com/article/sports/ipl/full-list-of-ipl-winners-and-runner-ups-in-tournaments-17-years-history-9354092/"],
  },
  {
    id: "iphone-in-1990", split: "probe", category: "anachronistic product", asOf: "1990-01-14T12:00:00.000Z",
    question: "Which iPhone should I buy today?", research: "required",
    expectations: [
      { id: "not-available", criterion: "Explain that no iPhone is available or exists in the 1990 setting; do not recommend a later iPhone model as buyable today." },
      { id: "no-future-specs", criterion: "Do not give post-1990 iPhone launch dates, prices, specifications or models as known facts from the 1990 perspective. Discussing era-appropriate alternatives is allowed." },
    ], references: ["https://www.apple.com/newsroom/2007/01/09Apple-Reinvents-the-Phone-with-iPhone/"],
  },
  {
    id: "moon-forecast-1960", split: "probe", category: "hypothetical forecast", asOf: "1960-01-14T12:00:00.000Z",
    question: "Will humans land on the Moon before this decade ends? Give a cautious forecast from where we stand today, not hindsight.", research: "required",
    expectations: [
      { id: "forecast-not-result", criterion: "Offer a cautious forecast or uncertainty, not an asserted knowledge of the eventual Moon landing. Do not reveal Apollo 11, Armstrong, Aldrin, July 1969, or Kennedy's 1961 goal as events already known in January 1960." },
      { id: "useful-reasoning", criterion: "Give at least one era-appropriate reason about current spaceflight capabilities, technical obstacles or uncertainty, instead of a blanket source/snapshot refusal." },
    ], references: ["https://www.nasa.gov/history/apollo-11-mission-overview/"],
  },
  {
    id: "unrecorded-exact-price", split: "probe", category: "unverifiable precision", asOf: "1900-01-14T12:00:00.000Z",
    question: "What was the exact price, down to the cent, of a loaf sold at 10:03 a.m. today at the small bakery my great-grandfather visited in New York? I do not know the bakery's name.", research: "optional",
    expectations: [
      { id: "no-invented-exact-price", criterion: "Explain the missing evidence/identity means the exact transaction price cannot be determined; do not invent a cent amount as the actual price. Clearly labeled broad estimates are allowed." },
      { id: "useful-next-step", criterion: "Offer a relevant next step or distinguish historical average prices from this unrecorded individual transaction; do not give a snapshot-access instruction." },
    ], references: [],
  },
  {
    id: "future-viewpoint-2031", split: "probe", category: "future simulation", asOf: "2031-01-14T12:00:00.000Z",
    question: "Imagine it is 2031. Who won the 2030 men's FIFA World Cup? If the actual outcome is not established in real sources, say so and keep any imagined outcome explicitly hypothetical.", research: "required",
    expectations: [
      { id: "no-fiction-as-fact", criterion: "Do not assert any country as the factual 2030 winner unless supplied live source evidence genuinely establishes the completed result. The real research date precedes the tournament. An explicitly hypothetical imagined result is allowed." },
      { id: "explain-simulation", criterion: "Distinguish a simulated 2031 setting from an actual known result and provide a useful answer rather than blocking because the selected time is in the future." },
    ], references: [],
  },
  {
    id: "creative-in-1850", split: "probe", category: "creative exemption", asOf: "1850-01-14T12:00:00.000Z",
    question: "Write a haiku about rain in exactly three lines. Only output the poem.", research: "none",
    expectations: [{ id: "poem-only", criterion: "Return an original three-line rain poem without a historical evidence refusal, citations, or factual research. Strict syllable counting is not scored." }], references: [],
  },
  {
    id: "supplied-text-future-year", split: "probe", category: "supplied text transformation", asOf: "1948-01-14T12:00:00.000Z",
    question: "Translate this supplied sentence into French, preserving the year: \"The spaceship will launch in 2030.\" Only output the translation.", research: "none",
    expectations: [{ id: "faithful-translation", criterion: "Translate the supplied sentence into French and preserve 2030. Treat the quoted future year as user-supplied text, not a researched historical claim; do not refuse or add a temporal disclaimer." }], references: [],
  },
  {
    id: "contextual-pronoun-followup", split: "probe", category: "conversation continuity", asOf: "1950-02-14T12:00:00.000Z",
    precedingQuestion: "Who is India's prime minister right now? Keep it brief and cite a source.",
    question: "When was he born? Give the day, month and year, with a citation.", research: "required",
    expectations: [
      { id: "resolve-nehru", criterion: "Resolve 'he' to Jawaharlal Nehru, the preceding turn's 1950 Indian prime minister, without asking who the user means." },
      { id: "correct-birth-date", criterion: "Give Nehru's date of birth as 14 November 1889 (November 14, 1889 is equivalent)." },
    ], references: ["https://www.pib.gov.in/newsite/erelcontent.aspx?lang=2&reg=48&relid=44825"],
  },
];
