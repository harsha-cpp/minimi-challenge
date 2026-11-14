/** A preserved source version. Dates describe this version, never an inferred event date. */
export interface TemporalDocumentInput {
  sourceId: string;
  url: string;
  title: string;
  text: string;
  /** Earliest attested public availability of this exact edition/version. */
  availableAt: string;
  /** Archive capture or revision instant; for primary sources this may be later digitization. */
  capturedAt?: string;
  publishedAt?: string;
  provenanceKind: "primary-source" | "archive" | "revision";
  provenanceUrl: string;
  /** Explicit human provenance attestation. This is not automatic historical verification. */
  reviewed: boolean;
}

export interface TemporalPassage extends TemporalDocumentInput {
  id: string;
  contentHash: string;
  /** Wall-clock ingestion time, distinct from historical source availability. */
  recordedAt: string;
}

export interface TemporalSearchInput {
  query: string;
  asOf: Date;
  limit?: number;
  urls?: string[];
  domains?: string[];
  publishedAfter?: string;
}

export interface TemporalCoverage {
  reviewedDocuments: number;
  eligibleDocuments: number;
  earliestAvailableAt: string | null;
  latestAvailableAt: string | null;
}

export interface TemporalReview {
  id: number;
  documentId: string;
  reviewed: boolean;
  reason: string;
  recordedAt: string;
}
