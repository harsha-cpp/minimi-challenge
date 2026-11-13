export interface SearchQuery {
  query: string;
  /** YYYY-MM-DD. Only pages published after this day. */
  publishedAfter?: string;
  /** Restrict to these domains, e.g. an official pricing site. */
  domains?: string[];
  /** Set when the clock is simulated: search the web as it stood at this moment. */
  asOf?: Date;
}

export interface SearchHit {
  url: string;
  title: string;
  /** YYYY-MM-DD, when the page states or implies one. */
  publishedDate?: string;
  text: string;
}

export interface SearchProvider {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
}

