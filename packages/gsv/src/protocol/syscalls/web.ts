/** Indexed web search; source excerpts are untrusted web content. */
export type WebSearchArgs = {
  target?: string;
  query: string;
  limit?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
};

export type WebSearchResult = {
  provider: string;
  results: WebSearchHit[];
};
