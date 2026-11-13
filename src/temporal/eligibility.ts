import type { SearchHit } from "../search/types.ts";
import { parseInstant } from "../time/instant.ts";
import { canonicalUrl } from "../search/validate.ts";

type Evidence = Pick<SearchHit, "snapshotAsOf" | "publishedDate" | "temporal" | "archive"> & { url?: string };

/** Admission policy, not proof that an operator's provenance attestation is truthful. */
export function isHistoricalEvidenceEligible(source: Evidence, cutoff: Date): boolean {
  if (!Number.isFinite(cutoff.getTime())) return false;
  if (source.publishedDate && source.publishedDate > cutoff.toISOString().slice(0, 10)) return false;
  if (source.archive) {
    if (source.temporal || source.snapshotAsOf || source.archive.provider !== "wayback") return false;
    const archive = source.archive;
    const captured = parseInstant(archive.capturedAt);
    if (!captured || captured.getUTCMilliseconds() !== 0 || captured.getTime() > cutoff.getTime() || !/^[a-f0-9]{64}$/.test(archive.rawHash)) return false;
    try {
      const captureUrl = new URL(archive.captureUrl);
      if (captureUrl.origin !== "https://web.archive.org" || captureUrl.username || captureUrl.password || captureUrl.port || captureUrl.hash) return false;
      const match = /^https:\/\/web\.archive\.org\/web\/(\d{14})id_\/(https?:\/\/.+)$/.exec(archive.captureUrl);
      if (!match || canonicalUrl(match[2]!) !== canonicalUrl(archive.originalUrl)
        || !source.url || canonicalUrl(source.url) !== canonicalUrl(archive.originalUrl)) return false;
      return match[1] === captured.toISOString().replace(/\D/g, "").slice(0, 14);
    } catch { return false; }
  }
  const temporal = source.temporal;
  if (!temporal) return source.snapshotAsOf === cutoff.toISOString();
  // A corpus source must never masquerade as an Exa snapshot.
  if (source.snapshotAsOf || temporal.reviewed !== true || !temporal.documentId?.trim()) return false;
  if (!["primary-source", "archive", "revision"].includes(temporal.provenanceKind)) return false;
  const available = parseInstant(temporal.availableAt);
  const recorded = parseInstant(temporal.recordedAt);
  if (!available || !recorded || available.getTime() > cutoff.getTime()) return false;
  try { canonicalUrl(temporal.provenanceUrl); } catch { return false; }
  const captured = temporal.capturedAt ? parseInstant(temporal.capturedAt) : undefined;
  if (temporal.capturedAt && !captured) return false;
  if (captured && captured.getTime() < available.getTime()) return false;
  if (temporal.provenanceKind !== "primary-source" && (!captured || captured.getTime() > cutoff.getTime())) return false;
  return true;
}
