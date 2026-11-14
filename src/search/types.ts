export interface SearchQuery {
  query: string;

  publishedAfter?: string;

  publishedBefore?: string;
  domains?: string[];

  asOf?: Date;

  urls?: string[];

  freshness?: "standard" | "fresh";
}

export interface TemporalProvenance {
  documentId: string;
  availableAt: string;
  recordedAt: string;
  provenanceKind: "primary-source" | "archive" | "revision";
  provenanceUrl: string;
  reviewed: boolean;

  capturedAt?: string;
}

export interface SearchHit {
  url: string;
  title: string;
  publishedDate?: string;
  text: string;
  provider?: string;
  requestId?: string;

  retrievedAt?: string;

  snapshotAsOf?: string;
  contentHash?: string;
  method?: "search" | "contents";
  temporal?: TemporalProvenance;

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
