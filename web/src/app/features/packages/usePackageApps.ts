import { useQuery } from "@tanstack/preact-query";
import type { PkgListResult } from "@gsv/protocol/syscalls/packages";
import type { AppManifest } from "../../../apps";
import type { GatewayClientLike } from "../../services/gateway/gatewayClient";
import { packageToAppManifests } from "../../../package-apps";

export const packageAppsQueryKey = ["packages", "list", { runtime: "web-ui" }] as const;

type UsePackageAppsOptions = {
  gatewayClient: GatewayClientLike;
  enabled: boolean;
};

export function usePackageApps({ gatewayClient, enabled }: UsePackageAppsOptions) {
  return useQuery<readonly AppManifest[]>({
    queryKey: packageAppsQueryKey,
    enabled,
    queryFn: async () => {
      const payload = await gatewayClient.call<PkgListResult>("pkg.list", {
        runtime: "web-ui",
      });
      const packages = Array.isArray(payload.packages) ? payload.packages : [];
      return packages.flatMap(packageToAppManifests);
    },
  });
}
