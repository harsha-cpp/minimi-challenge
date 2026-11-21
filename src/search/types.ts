export type RetrievalProfile = "fact" | "direct" | "verification" | "comparison" | "complete-list" | "historical" | "research";

export interface SearchQuery {
  profile?: RetrievalProfile;
  mode?: "auto" | "lite";
  content?: "highlights" | "full";
  locale?: string;
  policyVersion?: string;
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
  rank?: number;
  freshness?: {
    requested: "standard" | "fresh" | "snapshot" | "index";
    acquisition: "live" | "cached" | "unknown";
    contentFetchedAt?: string;
    ageStatus: "known" | "unknown";
  };
  retrieval?: { profile: RetrievalProfile; mode: "auto" | "lite"; content: "highlights" | "full"; policyVersion: string; providerCostDollars?: number; providerCostScope?: "request";
    passageSelection?: { selection: "complete-received-text" | "query-passages" | "document-prefix"; receivedCharacters: number; omittedCharacters: number; requestedCharacters: number; acquisitionMayBeTruncated: boolean; boundedDocumentHash: string } };
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
