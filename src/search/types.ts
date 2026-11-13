export interface SearchQuery {
  query: string;
  /** Publication filter, not evidence of when a page changed. */
  publishedAfter?: string;
  /** URL discovery date filter only; never proof of historical page contents. */
  publishedBefore?: string;
  domains?: string[];
  /** Exact historical cutoff. Never substitute live content for a missing snapshot. */
  asOf?: Date;
  /** Read known sources through Exa Contents. */
  urls?: string[];
  /** Fresh requests bypass the completed-result cache. */
  freshness?: "standard" | "fresh";
}

/** Provenance of an operator-reviewed, immutable historical source version. */
export interface TemporalProvenance {
  documentId: string;
  availableAt: string;
  recordedAt: string;
  provenanceKind: "primary-source" | "archive" | "revision";
  provenanceUrl: string;
  reviewed: boolean;
  /** Archive capture/revision instant, or digitization time for an original primary source. */
  capturedAt?: string;
}

export interface SearchHit {
  url: string;
  title: string;
  publishedDate?: string;
  text: string;
  provider?: string;
  requestId?: string;
  /** Real acquisition time, even when the conversation clock is simulated. */
  retrievedAt?: string;
  /** Requested cutoff, not a provider-confirmed capture date. */
  snapshotAsOf?: string;
  contentHash?: string;
  method?: "search" | "contents";
  temporal?: TemporalProvenance;
  /** Validated URL-version retrieval; not an operator's manual corpus review. */
  archive?: {
    provider: "wayback";
    capturedAt: string;
    captureUrl: string;
    originalUrl: string;
    rawHash: string;
  };
}

export interface SearchProvider {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
}
