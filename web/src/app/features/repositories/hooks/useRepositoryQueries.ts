import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleResourceState } from "../../gsv-console/domain/consoleModels";
import {
  compareRepositoryRefs,
  deleteRepository,
  listRepositories,
  listRepositoryCommits,
  listRepositoryRefs,
  pullRepository,
  readRepositoryDiff,
  readRepositoryPath,
  searchRepository,
  setRepositoryVisibility,
  type RepositoryCompareArgs,
  type RepositoryDeleteArgs,
  type RepositoryDiffArgs,
  type RepositoryLogArgs,
  type RepositoryPullArgs,
  type RepositoryReadArgs,
  type RepositorySearchArgs,
  type RepositoryVisibilityArgs,
} from "../backend/repositoriesService";
import type { RepositorySummary } from "../domain/models";

export const repositoriesQueryKey = ["repositories", "list"] as const;
const repositoriesQueryKeyRoot = ["repositories"] as const;

export function repositoryRefsQueryKey(repo: string) {
  return ["repositories", "refs", repo] as const;
}

export function repositoryReadQueryKey(args: RepositoryReadArgs) {
  return ["repositories", "read", {
    repo: args.repo,
    ref: args.ref ?? null,
    path: args.path ?? "",
  }] as const;
}

export function repositorySearchQueryKey(args: RepositorySearchArgs) {
  return ["repositories", "search", {
    repo: args.repo,
    ref: args.ref ?? null,
    query: args.query.trim(),
    prefix: args.prefix ?? "",
  }] as const;
}

export function repositoryLogQueryKey(args: RepositoryLogArgs) {
  return ["repositories", "log", {
    repo: args.repo,
    ref: args.ref ?? null,
    limit: args.limit ?? null,
    offset: args.offset ?? 0,
  }] as const;
}

export function repositoryDiffQueryKey(args: RepositoryDiffArgs) {
  return ["repositories", "diff", {
    repo: args.repo,
    commit: args.commit,
    context: args.context ?? 3,
  }] as const;
}

export function repositoryCompareQueryKey(args: RepositoryCompareArgs) {
  return ["repositories", "compare", {
    repo: args.repo,
    base: args.base,
    head: args.head,
    context: args.context ?? 3,
    stat: args.stat ?? false,
  }] as const;
}

export function useRepositories(enabled = true) {
  const { client, connected } = useGateway();
  const queryEnabled = enabled && connected;
  const query = useQuery<RepositorySummary[]>({
    queryKey: repositoriesQueryKey,
    enabled: queryEnabled,
    queryFn: async () => listRepositories(client),
  });
  const repos = query.data ?? [];
  return {
    ...query,
    repos,
    resource: toRepositoryResourceState(query, queryEnabled, repos),
  };
}

export function useRepositoryRefs(repo: string | null | undefined, enabled = true) {
  const { client, connected } = useGateway();
  const targetRepo = repo?.trim() ?? "";
  return useQuery({
    queryKey: repositoryRefsQueryKey(targetRepo),
    enabled: enabled && connected && targetRepo.length > 0,
    queryFn: async () => listRepositoryRefs(client, targetRepo),
  });
}

export function useRepositoryPath(args: RepositoryReadArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: repositoryReadQueryKey(args),
    enabled: enabled && connected && args.repo.trim().length > 0,
    queryFn: async () => readRepositoryPath(client, args),
  });
}

export function useRepositorySearch(args: RepositorySearchArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: repositorySearchQueryKey(args),
    enabled: enabled && connected && args.repo.trim().length > 0 && args.query.trim().length > 0,
    queryFn: async () => searchRepository(client, args),
  });
}

export function useRepositoryCommits(args: RepositoryLogArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: repositoryLogQueryKey(args),
    enabled: enabled && connected && args.repo.trim().length > 0,
    queryFn: async () => listRepositoryCommits(client, args),
  });
}

export function useRepositoryDiff(args: RepositoryDiffArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: repositoryDiffQueryKey(args),
    enabled: enabled && connected && args.repo.trim().length > 0 && args.commit.trim().length > 0,
    queryFn: async () => readRepositoryDiff(client, args),
  });
}

export function useRepositoryCompare(args: RepositoryCompareArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: repositoryCompareQueryKey(args),
    enabled: enabled && connected && args.repo.trim().length > 0 && args.base.trim().length > 0 && args.head.trim().length > 0,
    queryFn: async () => compareRepositoryRefs(client, args),
  });
}

export function useRepositoryPullMutation() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: RepositoryPullArgs) => pullRepository(client, args),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: repositoriesQueryKeyRoot });
    },
  });
}

export function useRepositoryDeleteMutation() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: RepositoryDeleteArgs) => deleteRepository(client, args),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: repositoriesQueryKeyRoot });
    },
  });
}

export function useRepositoryVisibilityMutation() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: RepositoryVisibilityArgs) => setRepositoryVisibility(client, args),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: repositoriesQueryKeyRoot });
    },
  });
}

function toRepositoryResourceState(
  query: UseQueryResult<RepositorySummary[]>,
  enabled: boolean,
  repos: readonly RepositorySummary[],
): ConsoleResourceState<RepositorySummary[]> {
  const hasData = query.data !== undefined;
  return {
    data: repos.length > 0 ? [...repos] : null,
    isUnavailable: !enabled && !hasData && repos.length === 0,
    isLoading: query.isLoading && !hasData && repos.length === 0,
    isRefreshing: query.isFetching && hasData,
    isError: query.isError && !hasData && repos.length === 0,
    errorText: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "",
    isEmpty: !query.isLoading && !query.isError && repos.length === 0,
  };
}
