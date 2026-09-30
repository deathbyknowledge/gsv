import type { ContactDeliveryStatus } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { instrumentContactDeliveriesKey } from "../wire/queryKeys";

export function MessageDelivery({ delivery, mayRetry }: { delivery: ContactDeliveryStatus | undefined; mayRetry: boolean }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const retry = useMutation({
    mutationFn: () => {
      if (!delivery) throw new Error("Delivery receipt is unavailable");
      return client.contact.delivery.retry({ deliveryId: delivery.deliveryId, expectedUpdatedAtMs: delivery.updatedAtMs });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: instrumentContactDeliveriesKey(delivery!.contactId) }),
  });
  if (!delivery) return null;
  const label = delivery.state === "delivered" ? "delivered" : delivery.state === "queued" ? "sending…" : "delivery unconfirmed";
  return <div class={`people-delivery is-${delivery.state}`}>
    <span title={delivery.state === "delivered" ? "Received by their GSV; read state remains private." : delivery.lastError}>{label}</span>
    {delivery.state === "failed" && delivery.retryable && <button class="fleet-text-action" disabled={!connected || !mayRetry || retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "retrying…" : "retry same message"}</button>}
    {delivery.state === "failed" && delivery.lastError && <details><summary>details</summary><p>{delivery.lastError}</p>{!delivery.retryable && <p>This delivery cannot be retried automatically.</p>}</details>}
    {retry.error && <span class="error" role="alert">{retry.error.message}</span>}
  </div>;
}
