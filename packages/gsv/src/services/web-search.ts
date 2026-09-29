import { z } from "zod";
import type { WebSearchArgs, WebSearchResult } from "../protocol/syscalls/web";

const domain = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/);

export const webSearchQuerySchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(10).optional(),
  includeDomains: z.array(domain).max(10).optional(),
  excludeDomains: z.array(domain).max(10).optional(),
}) satisfies z.ZodType<Omit<WebSearchArgs, "target">>;

export const webSearchArgsSchema: z.ZodType<WebSearchArgs> = webSearchQuerySchema.extend({
  target: z.string().min(1).max(256).optional(),
});

export const webSearchResultSchema: z.ZodType<WebSearchResult> = z.object({
  provider: z.string(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    publishedAt: z.string().optional(),
  })),
});

export const WEB_SEARCH_TIMEOUT_MS = 20_000;

export type WebSearchRequest = {
  requestId: string;
  deadlineAt: number;
  search: Omit<WebSearchArgs, "target">;
};

/** An installation-scoped service reference, minted by a trusted Gateway binding. */
export interface WebSearchTarget {
  search(input: WebSearchRequest): Promise<WebSearchResult>;
  cancel(requestId: string): Promise<void>;
  [Symbol.dispose]?(): void;
}

/** Provider credentials and request budgets remain owned by the service. */
export interface WebSearchService {
  getInstallation(installationId: string): Promise<WebSearchTarget>;
}
