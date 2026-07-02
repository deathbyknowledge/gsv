export type NetFetchArgs = {
  target?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutMs?: number;
};

export type NetFetchResult = {
  ok: boolean;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  bodyText?: string;
  bodyBytes: number;
};
