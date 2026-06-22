import { useMutation, useQuery, type UseQueryResult } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleResourceState } from "../../gsv-console/domain/consoleModels";
import { executeTerminalCommand, listTerminalTargets } from "../backend/terminalService";
import type { TerminalCommandInput, TerminalTarget } from "../domain/models";

export const terminalTargetsQueryKey = ["devices", "terminal", "targets"] as const;

export function useTerminalTargets(enabled = true) {
  const { client, connected } = useGateway();
  const queryEnabled = enabled && connected;
  const query = useQuery<TerminalTarget[]>({
    queryKey: terminalTargetsQueryKey,
    enabled: queryEnabled,
    queryFn: async () => listTerminalTargets(client),
  });

  return {
    ...query,
    targets: query.data ?? [],
    resource: toTerminalResourceState(query, queryEnabled),
  };
}

export function useTerminalCommandMutation() {
  const { client } = useGateway();
  return useMutation({
    mutationFn: async (command: TerminalCommandInput) => executeTerminalCommand(client, command),
  });
}

function toTerminalResourceState(
  query: UseQueryResult<TerminalTarget[]>,
  enabled: boolean,
): ConsoleResourceState<TerminalTarget[]> {
  const hasData = query.data !== undefined;
  return {
    data: query.data ?? null,
    isUnavailable: !enabled && !hasData,
    isLoading: query.isLoading && !hasData,
    isRefreshing: query.isFetching && hasData,
    isError: query.isError && !hasData,
    errorText: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "",
    isEmpty: !query.isLoading && !query.isError && hasData && (query.data?.length ?? 0) === 0,
  };
}
