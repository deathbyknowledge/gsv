import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleResourceState } from "../../gsv-console/domain/consoleModels";
import {
  createFilesPath,
  deleteFilesPath,
  listFilesTargets,
  readFilesPath,
  searchFiles,
  writeFilesPath,
  type FilesDeleteArgs,
  type FilesReadArgs,
  type FilesSearchArgs,
  type FilesWriteArgs,
} from "../backend/filesService";
import type { FilesTarget } from "../domain/models";
import { normalizeTarget } from "../domain/paths";

export const filesTargetsQueryKey = ["devices", "files", "targets"] as const;

export function filesReadQueryKey(args: FilesReadArgs) {
  return ["files", "read", {
    target: normalizeTarget(args.target),
    path: args.path,
    offset: args.offset ?? null,
    limit: args.limit ?? null,
  }] as const;
}

export function filesSearchQueryKey(args: FilesSearchArgs) {
  return ["files", "search", {
    target: normalizeTarget(args.target),
    path: args.path ?? ".",
    query: args.query.trim(),
    include: args.include ?? null,
  }] as const;
}

export function useFilesTargets(enabled = true) {
  const { client, connected } = useGateway();
  const queryEnabled = enabled && connected;
  const query = useQuery<FilesTarget[]>({
    queryKey: filesTargetsQueryKey,
    enabled: queryEnabled,
    queryFn: async () => listFilesTargets(client),
  });
  const targets = withNativeFilesTarget(query.data ?? [], connected);

  return {
    ...query,
    targets,
    resource: toFilesResourceState(query, queryEnabled, targets),
  };
}

export function useFilesPath(args: FilesReadArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: filesReadQueryKey(args),
    enabled: enabled && connected && args.path.trim().length > 0,
    queryFn: async () => readFilesPath(client, args),
  });
}

export function useFilesDirectory(args: FilesReadArgs, enabled = true) {
  return useFilesPath(args, enabled);
}

export function useFilesFile(args: FilesReadArgs, enabled = true) {
  return useFilesPath(args, enabled);
}

export function useFilesSearch(args: FilesSearchArgs, enabled = true) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: filesSearchQueryKey(args),
    enabled: enabled && connected && args.query.trim().length > 0,
    queryFn: async () => searchFiles(client, args),
  });
}

export function useFilesMutations() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  const invalidateFiles = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  const save = useMutation({
    mutationFn: async (args: FilesWriteArgs) => writeFilesPath(client, args),
    onSuccess: invalidateFiles,
  });

  const create = useMutation({
    mutationFn: async (args: FilesWriteArgs) => createFilesPath(client, args),
    onSuccess: invalidateFiles,
  });

  const remove = useMutation({
    mutationFn: async (args: FilesDeleteArgs) => deleteFilesPath(client, args),
    onSuccess: invalidateFiles,
  });

  return { save, create, remove };
}

function toFilesResourceState(
  query: UseQueryResult<FilesTarget[]>,
  enabled: boolean,
  targets: readonly FilesTarget[],
): ConsoleResourceState<FilesTarget[]> {
  const hasData = query.data !== undefined;
  return {
    data: targets.length > 0 ? [...targets] : null,
    isUnavailable: !enabled && !hasData && targets.length === 0,
    isLoading: query.isLoading && !hasData && targets.length === 0,
    isRefreshing: query.isFetching && hasData,
    isError: query.isError && !hasData && targets.length === 0,
    errorText: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : "",
    isEmpty: !query.isLoading && !query.isError && targets.length === 0,
  };
}

function withNativeFilesTarget(targets: readonly FilesTarget[], connected: boolean): FilesTarget[] {
  return [
    {
      id: "gsv",
      label: "GSV",
      online: connected,
      platform: "native",
      description: "Gateway filesystem",
      ownerUsername: null,
      lastSeenAt: null,
    },
    ...targets.filter((target) => target.id !== "gsv"),
  ];
}
