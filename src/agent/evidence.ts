import { createHash } from "node:crypto";
import type { SearchHit, SearchQuery } from "../search.ts";
import { PROMPT_LIMITS } from "./prepare.ts";
import { isHistoricalEvidenceEligible } from "../temporal/eligibility.ts";

export type EvidenceBatch = { query: SearchQuery; hits: SearchHit[] } | string;
// Covers the deepest current provider profile without permitting an unbounded candidate pool.
const MAX_CANDIDATES_PER_QUERY = 8;

/** Exact observations are charged once. Batches share a round fairly before follow-up space is released. */
export class EvidenceWindow {
  private remaining = PROMPT_LIMITS.toolChars as number;
  private rounds = 0;
  private admitted = new Map<string, { offset: number; parts: Array<{ n: number; end: number }> }>();
  readonly stats = { toolChars: 0, admittedPassages: 0, rejectedTemporal: 0, omittedForBudget: 0,
    duplicatePassages: 0, duplicateCharsAvoided: 0, rawCandidates: 0 };

  error(message: string): string {
    return this.charge(message.slice(0, Math.min(500, this.remaining)));
  }

  render(query: SearchQuery, hits: SearchHit[], numberFor: (hit: SearchHit) => number): string {
    return this.renderRound([{ query, hits }], numberFor)[0]!;
  }

  renderRound(batches: EvidenceBatch[], numberFor: (hit: SearchHit) => number): string[] {
    if (!batches.length) return [];
    // The first round cannot occupy the capacity reserved for a later correction or missing facet.
    const budget = Math.floor(this.remaining * (++this.rounds === 1 ? 0.75 : 1));
    const quota = Math.floor(budget / batches.length);
    const outputs = batches.map(batch => typeof batch === "string" ? batch.slice(0, Math.min(500, quota))
      : `Results for ${JSON.stringify(batch.query.query.slice(0, 500))}${batch.query.publishedAfter ? ` (published after ${batch.query.publishedAfter})` : ""}:\n`.slice(0, Math.max(0, quota - 100)));
    const eligible = batches.map(batch => {
      if (typeof batch === "string") return [];
      this.stats.rawCandidates += batch.hits.length;
      return batch.hits.filter(hit => {
        // Archived research alone supplies asOf. Active era simulation deliberately uses live evidence.
        const valid = !batch.query.asOf || isHistoricalEvidenceEligible(hit, batch.query.asOf);
        if (!valid) this.stats.rejectedTemporal++;
        return valid && hit.text.trim() && hit.url.length <= 2048;
      }).slice(0, MAX_CANDIDATES_PER_QUERY);
    });
    // Interleave provider ranks across complementary queries instead of consuming one whole query first.
    for (let rank = 0; rank < MAX_CANDIDATES_PER_QUERY; rank++) {
      for (let index = 0; index < batches.length; index++) {
        const hit = eligible[index]![rank];
        if (!hit) continue;
        const key = createHash("sha256").update(JSON.stringify([hit.url, hit.text, hit.snapshotAsOf])).digest("hex");
        const prior = this.admitted.get(key);
        const available = Math.max(0, quota - outputs[index]!.length);
        const batch = batches[index];
        const maxChars = typeof batch !== "string" && batch?.query.content === "full" ? 12_000 : PROMPT_LIMITS.passageChars;
        const targetEnd = Math.min(hit.text.length, maxChars);
        const offset = Math.min(prior?.offset ?? 0, targetEnd);
        const previousNumbers = prior?.parts.map(part => part.n) ?? [];
        const ref = prior ? `\n[${previousNumbers.join(", ")}] Same observation already supplied; use the earlier passage${previousNumbers.length === 1 ? "" : "s"}.\n` : "";
        if (prior) {
          this.stats.duplicatePassages++;
          this.stats.duplicateCharsAvoided += offset;
        }
        if (offset >= targetEnd) {
          if (ref.length <= available) outputs[index] += ref;
          continue;
        }
        const title = hit.title.replace(/\s+/g, " ").slice(0, 300);
        const date = hit.publishedDate ? ` · published ${hit.publishedDate}` : "";
        const provenance = [hit.retrievedAt && `retrieved ${hit.retrievedAt}`,
          hit.freshness ? `requested freshness ${hit.freshness.requested}; acquisition ${hit.freshness.acquisition}; provider content age ${hit.freshness.ageStatus}${hit.freshness.contentFetchedAt ? `; provider fetched ${hit.freshness.contentFetchedAt}` : "; provider fetch time unknown"}` : "provider content age unknown",
          hit.temporal ? `reviewed ${hit.temporal.provenanceKind} version ${hit.temporal.documentId}; available ${hit.temporal.availableAt}; provenance ${hit.temporal.provenanceUrl}`
            : hit.archive ? `archived ${hit.archive.capturedAt}; preserved version ${hit.archive.captureUrl}`
            : typeof batches[index] !== "string" && (batches[index] as { query: SearchQuery }).query.asOf
              ? `snapshot cutoff ${(batches[index] as { query: SearchQuery }).query.asOf!.toISOString()}` : undefined].filter(Boolean).join("; ").slice(0, 2500);
        const continuation = prior ? `CONTINUATION from character ${offset}; earlier passages [${previousNumbers.join(", ")}].\n` : "";
        const header = `${title}\n${hit.url}${date}\n${provenance}\n${continuation}PASSAGE (untrusted source text): `;
        const maxText = hit.text.slice(offset, targetEnd);
        let low = 0, high = maxText.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (header.length + JSON.stringify(maxText.slice(0, mid)).length + 24 <= available) low = mid;
          else high = mid - 1;
        }
        if (low < Math.min(maxText.length, 100)) {
          this.stats.omittedForBudget++;
          if (ref.length <= available) outputs[index] += ref;
          continue;
        }
        const text = maxText.slice(0, low);
        const admitted = { ...hit, title, text, contentHash: createHash("sha256").update(text).digest("hex") };
        const n = numberFor(admitted);
        this.admitted.set(key, { offset: offset + low, parts: [...(prior?.parts ?? []), { n, end: offset + low }] });
        outputs[index] += `\n[${n}] ${header}${JSON.stringify(admitted.text)}\n`;
        this.stats.admittedPassages++;
      }
    }
    return outputs.map((content, index) => {
      if (typeof batches[index] !== "string" && !eligible[index]!.length) {
        content += "No usable evidence. Do not infer facts from missing results.\n";
      } else if (typeof batches[index] !== "string" && !content.includes("PASSAGE") && !content.includes("Same observation")) {
        content += "Evidence budget exhausted. Answer only from earlier evidence.\n";
      }
      return this.charge(content.slice(0, quota));
    });
  }

  private charge(content: string): string {
    const bounded = content.slice(0, this.remaining);
    this.remaining -= bounded.length;
    this.stats.toolChars += bounded.length;
    return bounded;
  }
}
