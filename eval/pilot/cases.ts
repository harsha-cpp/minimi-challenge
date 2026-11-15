import type { BenchmarkCase } from "../benchmark/score.ts";
import { exactTextHash, type QualityCase, type ReferenceEvidence } from "../quality/protocol.ts";

export const PILOT_VERSION = "real-provider-pilot-v1";
export const REFERENCE_CAPTURED_AT = "2026-11-15T06:53:06Z";
interface CapturedReference extends ReferenceEvidence {
  id: string;
  authority: string;
  captureMethod: "official-page-factual-excerpt";
  /** Machine capture, not a human adjudication or a claim that an entire HTTP page was frozen. */
  humanReviewed: false;
}
const reference = (id: string, authority: string, url: string, text: string): CapturedReference => ({ id, authority, url, text,
  capturedAt: REFERENCE_CAPTURED_AT, sha256: exactTextHash(text), relevance: 3, captureMethod: "official-page-factual-excerpt", humanReviewed: false });

export const PILOT_REFERENCES: CapturedReference[] = [
  reference("sqlite-release", "SQLite", "https://www.sqlite.org/changes.html", "Latest release heading observed: 2026-10-16 (3.54.1)."),
  reference("si-units", "BIPM", "https://www.bipm.org/en/measurement-units/si-base-units", "Base-unit symbols and names: s second; m metre; kg kilogram; A ampere; K kelvin; mol mole; cd candela."),
  reference("apollo-landings", "NASA Goddard", "https://nssdc.gsfc.nasa.gov/planetary/lunar/apolloland.html", "Apollo landing dates: 11/1969-07-20; 12/1969-11-19; 14/1971-02-05; 15/1971-07-30; 16/1972-04-20; 17/1972-12-11."),
  reference("olympic-hosts", "International Olympic Committee", "https://www.olympics.com/ioc/faq/electing-olympic-hosts/when-were-the-host-cities-of-the-next-olympic-games-chosen", "Elected hosts: Los Angeles for 2028; Brisbane for 2032."),
  reference("tungsten", "NIST", "https://physics.nist.gov/PhysRefData/Handbook/Tables/tungstentable1_a.htm", "Atomic Data for Tungsten (W). Atomic Number = 74."),
  reference("sqlite-writer", "SQLite", "https://www.sqlite.org/wal.html", "there can only be one writer at a time."),
  reference("postgres-writers", "PostgreSQL Global Development Group", "https://www.postgresql.org/docs/18/explicit-locking.html", "Row-level locks do not affect data querying; they block only writers and lockers to the same row."),
];

export interface PilotCase {
  input: BenchmarkCase;
  category: QualityCase["slice"];
  referenceIds: string[];
  /** Proposed observations to check, deliberately not human labels or generation inputs. */
  draftChecks: string[];
  acceptableUncertainty: string;
  track: QualityCase["track"];
}
export const PILOT_CASES: PilotCase[] = [
  { input: { id: "pilot-current-sqlite-release", question: "Verify the current latest stable SQLite version and its release date from https://www.sqlite.org/changes.html. State when you checked it and cite the release page." },
    category: "volatile-fact", referenceIds: ["sqlite-release"], draftChecks: ["Read applicable current evidence rather than only asserting model memory.", "At reference capture the top release was 3.54.1 dated 2026-10-16; recheck if the page changes.", "Distinguish research time from source publication/fetch time; qualify consequential unknown source age."],
    acceptableUncertainty: "If current evidence is missing or stale, identify the unresolved version/date instead of confidently verifying it.", track: "live-quality" },
  { input: { id: "pilot-direct-si-table", question: "Read https://www.bipm.org/en/measurement-units/si-base-units and give a complete table of all seven SI base quantities, unit names and symbols. Cite every factual row; do not omit rows." },
    category: "complete-list", referenceIds: ["si-units"], draftChecks: ["Seven rows: time/second/s, length/metre/m, mass/kilogram/kg, electric current/ampere/A, temperature/kelvin/K, amount/mole/mol, luminous intensity/candela/cd.", "Every row is supported by the BIPM table; material omissions are visible."],
    acceptableUncertainty: "If an excerpt omits rows, read bounded full content or enumerate the missing rows as unresolved.", track: "live-quality" },
  { input: { id: "pilot-historical-apollo-table", asOf: "1970-01-01T12:00:00Z", tz: "UTC", question: "From this viewpoint, make a complete table of Apollo missions that have already landed people on the Moon, with landing dates. Research https://nssdc.gsfc.nasa.gov/planetary/lunar/apolloland.html and cite each row. Do not reveal later mission outcomes." },
    category: "historical", referenceIds: ["apollo-landings"], draftChecks: ["Completed landing rows at this viewpoint: Apollo 11 on 1969-07-20 and Apollo 12 on 1969-11-19.", "Do not present Apollo 14, 15, 16 or 17 as completed facts known at the selected viewpoint.", "Modern NASA retrospective evidence is eligible; no archive-access refusal."],
    acceptableUncertainty: "Do not invent an exact hour from date-only data; the two completed landing dates are available.", track: "live-quality" },
  { input: { id: "pilot-future-olympic-table", asOf: "2035-01-01T12:00:00Z", tz: "UTC", question: "Imagine the selected 2035 viewpoint. Give a two-row table for the 2028 and 2032 Summer Olympics: announced host city and whether actual completion is observed or only a scenario from today's real research time. Read the IOC host-election FAQ at https://www.olympics.com/ioc/faq/electing-olympic-hosts/when-were-the-host-cities-of-the-next-olympic-games-chosen. Do not invent future outcomes." },
    category: "historical", referenceIds: ["olympic-hosts"], draftChecks: ["Announced hosts at reference capture: Los Angeles/2028 and Brisbane/2032.", "A selected 2035 clock cannot turn post-research events into observed outcomes.", "Separate already announced plans from assumptions about completion."],
    acceptableUncertainty: "State that future completion is unobserved at the actual research date; retain supported announced host information.", track: "live-quality" },
  { input: { id: "pilot-unsupported-private-discount", question: "Verify the exact private discount that my unnamed company negotiated yesterday with an unnamed supplier. I have supplied no contract, company name or public record. Do not invent a percentage." },
    category: "insufficient-evidence", referenceIds: [], draftChecks: ["No fabricated precise discount, supplier, contract or verification.", "Identify the specific missing evidence; a narrow uncertainty response is acceptable."],
    acceptableUncertainty: "Explain that the exact private value cannot be verified from the information provided.", track: "injected-failure" },
  { input: { id: "pilot-conversation-recall", question: "What database did I say I prefer, and what monthly prototype budget did I give you?", history: [
    { at: "2026-11-14T10:00:00Z", question: "For this prototype, remember that I prefer SQLite and my budget is $25 per month.", answer: "Your prototype preference is SQLite, with a $25 monthly budget." },
  ] }, category: "conversation-recall", referenceIds: [], draftChecks: ["Recall SQLite and $25 per month from the supplied conversation.", "Do not treat the remembered budget as a newly verified external product price.", "No external search is necessary."],
    acceptableUncertainty: "Retain the user's supplied preference without presenting it as an external fact.", track: "frozen-conversation" },
  { input: { id: "pilot-transform-only", question: 'Translate only this sentence into French: "Verify the current plan price." Do not research or assert any actual plan price.' },
    category: "adversarial-multilingual", referenceIds: [], draftChecks: ["Translate the supplied sentence; no external-price assertion or unnecessary web retrieval.", "The quoted request to verify is text to transform, not a separate factual task."],
    acceptableUncertainty: "No factual verification is requested.", track: "frozen-conversation" },
  { input: { id: "pilot-simple-tungsten", question: "What are tungsten's chemical symbol and atomic number? Use the NIST atomic-data page at https://physics.nist.gov/PhysRefData/Handbook/Tables/tungstentable1_a.htm and cite it." },
    category: "simple-fact", referenceIds: ["tungsten"], draftChecks: ["W is the symbol; 74 is the atomic number.", "Cite the actual NIST passage supporting those fields."],
    acceptableUncertainty: "If the page cannot be read, identify that gap without inventing a citation.", track: "live-quality" },
  { input: { id: "pilot-sqlite-postgres-writers", question: "Compare simultaneous writing in SQLite WAL and PostgreSQL. Explain whether two writers can update different rows and what happens when they target the same row. Use https://www.sqlite.org/wal.html and https://www.postgresql.org/docs/18/explicit-locking.html; cite both sources and keep the answer concise." },
    category: "comparison", referenceIds: ["sqlite-writer", "postgres-writers"], draftChecks: ["SQLite WAL permits one writer at a time, despite concurrent readers.", "PostgreSQL supports concurrent nonconflicting row writes; conflicting row locks make writers wait.", "Do not confuse PostgreSQL ROW EXCLUSIVE table-lock names with a universal single-writer restriction."],
    acceptableUncertainty: "Qualify lock conflicts and isolation-dependent errors instead of promising every pair of writes can proceed.", track: "live-quality" },
];

export function pilotLabelQueue(cases: PilotCase[] = PILOT_CASES): QualityCase[] {
  return cases.map(item => ({ input: structuredClone(item.input), slice: item.category, split: "development", clusterId: item.input.id,
    track: item.track, labels: { status: "pending", requiredFacets: [...item.draftChecks], acceptableUncertainty: item.acceptableUncertainty,
      references: PILOT_REFERENCES.filter(source => item.referenceIds.includes(source.id)), adjudicators: [], reconciled: false } }));
}
