import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";

import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  loadResponsibilitiesWorkspace,
  mutateResponsibilitiesWorkspace,
  type ResponsibilityWorkspaceMutation,
} from "./responsibilitiesService";

export const responsibilitiesWorkspaceQueryKey = ["gsv-console", "responsibilities"] as const;

export function useResponsibilitiesWorkspace() {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: responsibilitiesWorkspaceQueryKey,
    enabled: connected,
    queryFn: () => loadResponsibilitiesWorkspace(client),
    refetchInterval: 5_000,
  });
  const mutation = useMutation<void, Error, ResponsibilityWorkspaceMutation>({
    mutationFn: (input) => mutateResponsibilitiesWorkspace(client, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: responsibilitiesWorkspaceQueryKey });
    },
  });
  return { connected, query, mutation };
}
