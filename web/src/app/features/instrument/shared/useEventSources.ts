import type { EventSourceAddArgs, EventSourceRotateArgs, EventSourceSecretResult, EventSourceUpdateArgs } from "@humansandmachines/gsv/protocol";
import { useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { INSTRUMENT_EVENT_SOURCES_KEY } from "../wire/queryKeys";

export function useEventSources(enabled: boolean) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: INSTRUMENT_EVENT_SOURCES_KEY });
  const [revealed, setRevealed] = useState<EventSourceSecretResult | null>(null);
  const sources = useQuery({
    queryKey: INSTRUMENT_EVENT_SOURCES_KEY,
    queryFn: async () => (await client.call("event.source.list", {})).sources,
    enabled: connected && enabled,
  });
  const update = useMutation({ mutationFn: (change: EventSourceUpdateArgs) => client.call("event.source.update", change), onSuccess: refresh });
  const add = useMutation({
    mutationFn: (input: EventSourceAddArgs) => client.call("event.source.add", input),
    onSuccess: (result) => { setRevealed(result); return refresh(); },
  });
  const rotate = useMutation({
    mutationFn: (input: EventSourceRotateArgs) => client.call("event.source.rotate", input),
    onSuccess: (result, input) => { if (!input.secret) setRevealed(result); return refresh(); },
  });
  const remove = useMutation({
    mutationFn: (name: string) => client.call("event.source.remove", { name }),
    onSuccess: () => { setRevealed(null); return refresh(); },
  });
  return {
    sources: sources.data ?? [], loading: sources.isPending, revealed, clearRevealed: () => setRevealed(null), update, add, rotate, remove,
    error: sources.error ?? update.error ?? add.error ?? rotate.error ?? remove.error,
    pending: update.isPending || add.isPending || rotate.isPending || remove.isPending,
  };
}

export type EventSources = ReturnType<typeof useEventSources>;
