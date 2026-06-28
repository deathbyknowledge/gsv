import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  RepositoryCompareResult,
  RepositoryCommitsPage,
  RepositoryDiffResult,
  RepositoryReadResult,
  RepositoryRefs,
  RepositorySearchResult,
  RepositorySummary,
} from "../domain/models";
import {
  normalizeRepositoryCommitsPage,
  normalizeRepositoryCompare,
  normalizeRepositoryDiff,
  normalizeRepositoryList,
  normalizeRepositoryRead,
  normalizeRepositoryRefs,
  normalizeRepositorySearch,
} from "../domain/normalization";
import { normalizeRepoPath } from "../domain/presentation";

export type RepositoriesClient = Pick<GSVClient, "call">;

export type RepositoryReadArgs = {
  repo: string;
  ref?: string;
  path?: string;
};

export type RepositorySearchArgs = {
  repo: string;
  ref?: string;
  query: string;
  prefix?: string;
};

export type RepositoryLogArgs = {
  repo: string;
  ref?: string;
  limit?: number;
  offset?: number;
};

export type RepositoryDiffArgs = {
  repo: string;
  commit: string;
  context?: number;
};

export type RepositoryCompareArgs = {
  repo: string;
  base: string;
  head: string;
  context?: number;
  stat?: boolean;
};

const DEFAULT_COMMIT_LIMIT = 20;

export async function listRepositories(client: RepositoriesClient): Promise<RepositorySummary[]> {
  const payload = await client.call<unknown>("repo.list", {});
  return normalizeRepositoryList(payload);
}

export async function listRepositoryRefs(client: RepositoriesClient, repo: string): Promise<RepositoryRefs> {
  const payload = await client.call<unknown>("repo.refs", { repo });
  return normalizeRepositoryRefs(payload, repo);
}

export async function readRepositoryPath(client: RepositoriesClient, args: RepositoryReadArgs): Promise<RepositoryReadResult> {
  const payload = await client.call<unknown>("repo.read", {
    repo: args.repo,
    ref: args.ref || undefined,
    path: normalizeRepoPath(args.path ?? "") || undefined,
  });
  return normalizeRepositoryRead(payload);
}

export async function searchRepository(client: RepositoriesClient, args: RepositorySearchArgs): Promise<RepositorySearchResult> {
  const query = args.query.trim();
  if (!query) {
    return {
      repo: args.repo,
      ref: args.ref || "main",
      query,
      prefix: normalizeRepoPath(args.prefix ?? "") || undefined,
      truncated: false,
      matches: [],
    };
  }
  const payload = await client.call<unknown>("repo.search", {
    repo: args.repo,
    ref: args.ref || undefined,
    query,
    prefix: normalizeRepoPath(args.prefix ?? "") || undefined,
  });
  return normalizeRepositorySearch(payload);
}

export async function listRepositoryCommits(client: RepositoriesClient, args: RepositoryLogArgs): Promise<RepositoryCommitsPage> {
  const limit = normalizeCommitLimit(args.limit);
  const offset = normalizeCommitOffset(args.offset);
  const payload = await client.call<unknown>("repo.log", {
    repo: args.repo,
    ref: args.ref || undefined,
    limit: limit + 1,
    offset,
  });
  return normalizeRepositoryCommitsPage(payload, args.repo, args.ref || "main", limit, offset);
}

export async function readRepositoryDiff(client: RepositoriesClient, args: RepositoryDiffArgs): Promise<RepositoryDiffResult> {
  const payload = await client.call<unknown>("repo.diff", {
    repo: args.repo,
    commit: args.commit,
    context: typeof args.context === "number" ? args.context : 3,
  });
  return normalizeRepositoryDiff(payload);
}

export async function compareRepositoryRefs(client: RepositoriesClient, args: RepositoryCompareArgs): Promise<RepositoryCompareResult> {
  const payload = await client.call<unknown>("repo.compare", {
    repo: args.repo,
    base: args.base,
    head: args.head,
    context: typeof args.context === "number" ? args.context : 3,
    stat: args.stat === true ? true : undefined,
  });
  return normalizeRepositoryCompare(payload);
}

function normalizeCommitLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMIT_LIMIT;
  }
  return Math.min(Math.floor(value), 100);
}

function normalizeCommitOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
