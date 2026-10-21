import type { ContactDeliveryStatus } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { instrumentContactDeliveriesKey } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";

export function MessageDelivery({ delivery, mayRetry }: { delivery: ContactDeliveryStatus | undefined; mayRetry: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const retry = useMutation({
    mutationFn: () => {
      if (!delivery) throw new Error(t("people.delivery.receiptUnavailable"));
      return client.contact.delivery.retry({ deliveryId: delivery.deliveryId, expectedUpdatedAtMs: delivery.updatedAtMs });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: instrumentContactDeliveriesKey(delivery!.contactId) }),
  });
  if (!delivery) return null;
  const label = t(delivery.state === "delivered" ? "people.message.delivered" : delivery.state === "queued" ? "people.message.sending" : "people.delivery.unconfirmed");
  return <div class={`people-delivery is-${delivery.state}`}>
    <span title={delivery.state === "delivered" ? t("people.delivery.received") : delivery.lastError}>{label}</span>
    {delivery.state === "failed" && delivery.retryable && <button class="fleet-text-action" disabled={!connected || !mayRetry || retry.isPending} onClick={() => retry.mutate()}>{t(retry.isPending ? "people.retrying" : "people.message.retrySame")}</button>}
    {delivery.state === "failed" && delivery.lastError && <details><summary>{t("people.details")}</summary><p>{delivery.lastError}</p>{!delivery.retryable && <p>{t("people.delivery.noRetry")}</p>}</details>}
    {retry.error && <span class="error" role="alert">{retry.error.message}</span>}
  </div>;
}
