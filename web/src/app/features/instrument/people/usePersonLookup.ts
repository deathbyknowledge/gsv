import { GsvClientError } from "@humansandmachines/gsv/client";
import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";

/**
 * Looks up the public profile an address names. Only the latest lookup counts: a newer one,
 * or a reset, keeps an earlier answer from replacing what the person is now asking about.
 */
export function usePersonLookup(onFound?: (profile: PublicProfile) => void) {
  const { client } = useGateway();
  const revision = useRef(0);
  const found = useRef(onFound);
  found.current = onFound;
  const resolve = useMutation({
    mutationFn: async ({ address, revision }: { address: string; revision: number }) => ({ ...(await client.profile.resolve({ address })), revision }),
    onSuccess: ({ profile, revision: resolved }) => { if (revision.current === resolved) found.current?.(profile); },
  });
  const latest = resolve.variables?.revision === revision.current;
  const error = latest ? resolve.error : null;
  return {
    lookup: (address: string) => resolve.mutate({ address, revision: ++revision.current }),
    reset: () => { revision.current++; resolve.reset(); },
    profile: latest && resolve.data ? resolve.data.profile : undefined,
    pending: latest && resolve.isPending,
    error,
    /** No public profile at that address; a missing account and a private profile look the same. */
    missing: error instanceof GsvClientError && error.code === 404,
  };
}
