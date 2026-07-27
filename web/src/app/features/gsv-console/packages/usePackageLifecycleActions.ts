import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { packageAppsQueryKey } from "../../packages/usePackageApps";
import {
  consoleOverviewQueryKey,
  consolePackagesQueryKey,
} from "../hooks/useConsoleData";
import type { ConsolePackage } from "../domain/consoleModels";
import {
  approveAndEnableConsolePackage,
  checkoutConsolePackage,
  removeConsolePackage,
  syncConsolePackage,
} from "./packageLifecycleService";

export function usePackageLifecycleActions() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  const enableMutation = useMutation<ConsolePackage, Error, ConsolePackage>({
    mutationFn: (pkg) => approveAndEnableConsolePackage(client, pkg),
    onSuccess: async () => invalidatePackageData(queryClient),
  });

  const syncMutation = useMutation<ConsolePackage, Error, ConsolePackage>({
    mutationFn: (pkg) => syncConsolePackage(client, pkg),
    onSuccess: async () => invalidatePackageData(queryClient),
  });

  const checkoutMutation = useMutation<ConsolePackage, Error, { package: ConsolePackage; ref: string }>({
    mutationFn: (input) => checkoutConsolePackage(client, input),
    onSuccess: async () => invalidatePackageData(queryClient),
  });

  const removeMutation = useMutation<ConsolePackage, Error, ConsolePackage>({
    mutationFn: (pkg) => removeConsolePackage(client, pkg),
    onSuccess: async () => invalidatePackageData(queryClient),
  });

  return {
    checkoutMutation,
    enableMutation,
    removeMutation,
    syncMutation,
  };
}

async function invalidatePackageData(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: consolePackagesQueryKey }),
    queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey }),
    queryClient.invalidateQueries({ queryKey: packageAppsQueryKey }),
    queryClient.invalidateQueries({ queryKey: ["packages"] }),
  ]);
}
