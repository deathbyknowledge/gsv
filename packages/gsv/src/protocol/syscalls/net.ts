export type NetFetchArgs = {
  target?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  redirect?: "follow" | "error" | "manual";
  timeoutMs?: number;
};

export type NetFetchResult = {
  ok: boolean;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  redirected: boolean;
};
