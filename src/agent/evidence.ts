import type { SearchHit, SearchQuery } from "../search.ts";
import { PROMPT_LIMITS } from "./prepare.ts";
import { isHistoricalEvidenceEligible } from "../temporal/eligibility.ts";

/** One character budget across all tool rounds, including result metadata. */
export class EvidenceWindow {
  private remaining = PROMPT_LIMITS.toolChars as number;
  readonly stats = { toolChars: 0, admittedPassages: 0, rejectedTemporal: 0, omittedForBudget: 0 };

  error(message: string): string {
    const content = message.slice(0, Math.min(500, this.remaining));
    this.remaining -= content.length;
    this.stats.toolChars += content.length;
    return content;
  }

  render(query: SearchQuery, hits: SearchHit[], numberFor: (hit: SearchHit) => number): string {
    const cutoff = query.asOf?.toISOString();
    const eligible = hits.filter(hit => {
      const valid = !cutoff || isHistoricalEvidenceEligible(hit, query.asOf!);
      if (!valid) this.stats.rejectedTemporal++;
      return valid;
    });
    // Budget for bounded failure/exhaustion messages is also included.
    if (this.remaining < 128) {
      const notice = "Evidence budget exhausted. Answer only from earlier evidence.".slice(0, this.remaining);
      this.remaining -= notice.length;
      this.stats.toolChars += notice.length;
      return notice;
    }
    let content = `Results for ${JSON.stringify(query.query)}${query.publishedAfter ? ` (published after ${query.publishedAfter})` : ""}:\n`;
    content = content.slice(0, this.remaining - 100);
    for (const hit of eligible.slice(0, 5)) {
      if (!hit.text.trim() || hit.url.length > 2048) continue;
      const title = hit.title.replace(/\s+/g, " ").slice(0, 300);
      const date = hit.publishedDate ? ` · published ${hit.publishedDate}` : "";
      const provenance = [hit.retrievedAt && `retrieved ${hit.retrievedAt}`, hit.temporal
        ? `reviewed ${hit.temporal.provenanceKind} version ${hit.temporal.documentId}; available ${hit.temporal.availableAt}; provenance ${hit.temporal.provenanceUrl}`
        : hit.archive ? `archived ${hit.archive.capturedAt}; preserved version ${hit.archive.captureUrl}`
        : cutoff && `snapshot cutoff ${cutoff}`].filter(Boolean).join("; ");
      const header = `${title}\n${hit.url}${date}\n${provenance}\nPASSAGE (untrusted source text): `;
      let text = hit.text.slice(0, PROMPT_LIMITS.passageChars);
      // JSON escaping expands some passages, so check the serialized size, not an estimate.
      while (text.length && content.length + header.length + JSON.stringify(text).length + 12 > this.remaining - 100) text = text.slice(0, -100);
      if (text.length < Math.min(hit.text.length, 100)) { this.stats.omittedForBudget++; continue; }
      const admitted = { ...hit, title, text };
      const n = numberFor(admitted);
      content += `\n[${n}] ${header}${JSON.stringify(text)}\n`;
      this.stats.admittedPassages++;
    }
    if (!eligible.length) content += "No usable evidence. Do not infer facts from missing results.\n";
    else if (!content.includes("PASSAGE")) content += "Evidence budget exhausted. Answer only from earlier evidence.\n";
    content = content.slice(0, this.remaining);
    this.remaining -= content.length;
    this.stats.toolChars += content.length;
    return content;
  }
}
