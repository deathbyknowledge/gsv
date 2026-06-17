import { useQuery } from "@tanstack/preact-query";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { AppManifest } from "../../../apps";
import { packageToAppManifests } from "../../../package-apps";

export const packageAppsQueryKey = ["packages", "list", { runtime: "web-ui" }] as const;

type UsePackageAppsOptions = {
  gatewayClient: Pick<GSVClient, "pkg">;
  enabled: boolean;
};

export function usePackageApps({ gatewayClient, enabled }: UsePackageAppsOptions) {
  return useQuery<readonly AppManifest[]>({
    queryKey: packageAppsQueryKey,
    enabled,
    queryFn: async () => {
      const payload = await gatewayClient.pkg.list({
        runtime: "web-ui",
      });
      const packages = Array.isArray(payload.packages) ? payload.packages : [];
      return packages.flatMap(packageToAppManifests);
    },
  });
}
