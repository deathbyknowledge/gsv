import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/preact-query";
import { useEffect, useMemo } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  DEFAULT_CONSOLE_ADAPTERS,
  createConsoleAgent,
  loadConsoleAgentContext,
  loadConsoleAccounts,
  loadConsoleAdapterAccounts,
  loadConsoleConfig,
  loadConsoleOverview,
  loadConsolePackages,
  loadConsoleProcesses,
  loadConsoleTargets,
  saveConsoleAgentBehavior,
  saveConsoleAgentContext,
  type CreateConsoleAgentInput,
  type CreateConsoleAgentResult,
  type ConsoleAgentContextFile,
  type LoadConsoleOverviewOptions,
  type SaveConsoleAgentBehaviorInput,
  type SaveConsoleAgentBehaviorResult,
  type SaveConsoleAgentContextInput,
  type SaveConsoleAgentContextResult,
} from "../backend/consoleService";
import { summarizeConsoleOverview } from "../domain/consoleNormalization";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleResourceState,
  ConsoleTarget,
} from "../domain/consoleModels";

export const consoleOverviewQueryKey = ["gsv-console", "overview"] as const;
export const consoleProcessesQueryKey = ["processes", "gsv-console"] as const;
export const consoleTargetsQueryKey = ["devices", "gsv-console"] as const;
export const consolePackagesQueryKey = ["packages", "gsv-console"] as const;
export const consoleAccountsQueryKey = ["accounts", "gsv-console"] as const;
export const consoleAdaptersQueryKey = ["adapters", "gsv-console"] as const;
export const consoleConfigQueryKey = ["gsv-console", "config"] as const;
export const consoleAgentContextQueryKey = ["gsv-console", "agent-context"] as const;

type ConsoleQueryOptions = {
  enabled?: boolean;
};

type ConsoleOverviewHookOptions = ConsoleQueryOptions & LoadConsoleOverviewOptions;

const CONSOLE_OVERVIEW_SIGNALS = new Set([
  "proc.changed",
  "device.status",
  "pkg.changed",
  "adapter.status",
]);

export function useConsoleOverview(options: ConsoleOverviewHookOptions = {}) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const enabled = connected && (options.enabled ?? true);
  const adapters = options.adapters ?? DEFAULT_CONSOLE_ADAPTERS;
  const includeConfig = options.includeConfig ?? true;

  useEffect(() => {
    return client.onSignal((signal) => {
      if (CONSOLE_OVERVIEW_SIGNALS.has(signal)) {
        void queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey });
      }
    });
  }, [client, queryClient]);

  const query = useQuery<ConsoleOverviewData>({
    queryKey: [...consoleOverviewQueryKey, { adapters: [...adapters], includeConfig }],
    enabled,
    queryFn: () => loadConsoleOverview(client, { adapters, includeConfig }),
  });

  const counts = useMemo<ConsoleOverviewCounts | null>(
    () => query.data ? summarizeConsoleOverview(query.data) : null,
    [query.data],
  );

  return {
    ...query,
    counts,
    resource: toResourceState(query, enabled, isOverviewEmpty),
  };
}

export function useConsoleProcesses(options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsoleProcess[]>({
    queryKey: consoleProcessesQueryKey,
    enabled,
    queryFn: () => loadConsoleProcesses(client),
  });

  return {
    ...query,
    processes: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsoleTargets(options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsoleTarget[]>({
    queryKey: consoleTargetsQueryKey,
    enabled,
    queryFn: () => loadConsoleTargets(client),
  });

  return {
    ...query,
    targets: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsolePackages(options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsolePackage[]>({
    queryKey: consolePackagesQueryKey,
    enabled,
    queryFn: () => loadConsolePackages(client),
  });

  return {
    ...query,
    packages: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsoleAccounts(options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsoleAccount[]>({
    queryKey: consoleAccountsQueryKey,
    enabled,
    queryFn: () => loadConsoleAccounts(client),
  });

  return {
    ...query,
    accounts: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsoleAdapters(options: ConsoleQueryOptions & { adapters?: readonly string[] } = {}) {
  const { client, connected } = useGateway();
  const adapters = options.adapters ?? DEFAULT_CONSOLE_ADAPTERS;
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsoleAdapterAccount[]>({
    queryKey: [...consoleAdaptersQueryKey, { adapters: [...adapters] }],
    enabled,
    queryFn: () => loadConsoleAdapterAccounts(client, adapters),
  });

  return {
    ...query,
    adapters: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsoleConfig(options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && (options.enabled ?? true);
  const query = useQuery<ConsoleConfigEntry[]>({
    queryKey: consoleConfigQueryKey,
    enabled,
    queryFn: () => loadConsoleConfig(client),
  });

  return {
    ...query,
    config: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useConsoleAgentContext(username: string, options: ConsoleQueryOptions = {}) {
  const { client, connected } = useGateway();
  const enabled = connected && username.trim().length > 0 && (options.enabled ?? true);
  const query = useQuery<ConsoleAgentContextFile[]>({
    queryKey: [...consoleAgentContextQueryKey, username],
    enabled,
    queryFn: () => loadConsoleAgentContext(client, username),
  });

  return {
    ...query,
    files: query.data ?? [],
    resource: toResourceState(query, enabled, isArrayEmpty),
  };
}

export function useCreateConsoleAgent() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation<CreateConsoleAgentResult, Error, CreateConsoleAgentInput>({
    mutationFn: (input) => createConsoleAgent(client, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: consoleAccountsQueryKey }),
        queryClient.invalidateQueries({ queryKey: consoleAgentContextQueryKey }),
        queryClient.invalidateQueries({ queryKey: consoleConfigQueryKey }),
        queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey }),
      ]);
    },
  });
}

export function useSaveConsoleAgentContext() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation<SaveConsoleAgentContextResult, Error, SaveConsoleAgentContextInput>({
    mutationFn: (input) => saveConsoleAgentContext(client, input),
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: [...consoleAgentContextQueryKey, input.username] });
    },
  });
}

export function useSaveConsoleAgentBehavior() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation<SaveConsoleAgentBehaviorResult, Error, SaveConsoleAgentBehaviorInput>({
    mutationFn: (input) => saveConsoleAgentBehavior(client, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: consoleConfigQueryKey }),
        queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey }),
      ]);
    },
  });
}

function toResourceState<T>(
  query: UseQueryResult<T>,
  enabled: boolean,
  isEmptyData: (data: T) => boolean,
): ConsoleResourceState<T> {
  const hasData = query.data !== undefined;
  return {
    data: query.data ?? null,
    isUnavailable: !enabled && !hasData,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isError: query.isError && !hasData,
    errorText: errorText(query.error),
    isEmpty: !query.isLoading && !query.isError && hasData && isEmptyData(query.data as T),
  };
}

function isArrayEmpty(value: readonly unknown[]): boolean {
  return value.length === 0;
}

function isOverviewEmpty(value: ConsoleOverviewData): boolean {
  return value.processes.length === 0
    && value.targets.length === 0
    && value.packages.length === 0
    && value.accounts.length === 0
    && value.adapters.length === 0
    && value.config.length === 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}
