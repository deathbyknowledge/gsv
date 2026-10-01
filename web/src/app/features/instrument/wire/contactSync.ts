import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { instrumentContactConversationKey, instrumentContactRequestsKey, INSTRUMENT_INBOX_KEY, conversationViewKey, instrumentContactDeliveriesKey } from "./queryKeys";
import type { QueryClient, QueryKey } from "@tanstack/preact-query";

/** Discard any older snapshot, including an initial read that has not resolved. */
export async function refreshContactQuery(cache: QueryClient, queryKey: QueryKey): Promise<void> {
  const filter = { queryKey, exact: true };
  await cache.cancelQueries(filter);
  await cache.invalidateQueries(filter);
}

const contactChangeSchema = z.object({ contactId: z.string().min(1) });
const conversationChangeSchema = z.object({ conversationId: z.string().min(1), viewOnly: z.boolean().optional() });

export async function syncContactDetailSignal(cache: QueryClient, signal: string, payload: JsonValue | undefined): Promise<void> {
  let key: QueryKey;
  if (signal === "contact.request.changed" || signal === "contact.delivery.changed") {
    const parsed = contactChangeSchema.safeParse(payload);
    if (!parsed.success) return;
    key = signal === "contact.delivery.changed" ? instrumentContactDeliveriesKey(parsed.data.contactId) : instrumentContactRequestsKey(parsed.data.contactId);
  } else if (signal === "conversation.changed") {
    const parsed = conversationChangeSchema.safeParse(payload);
    if (!parsed.success) return;
    await Promise.all([
      cache.cancelQueries({ queryKey: INSTRUMENT_INBOX_KEY }).then(() => cache.invalidateQueries({ queryKey: INSTRUMENT_INBOX_KEY })),
      refreshContactQuery(cache, conversationViewKey(parsed.data.conversationId)),
    ]);
    if (parsed.data.viewOnly) return;
    key = instrumentContactConversationKey(parsed.data.conversationId);
  } else return;
  await cache.cancelQueries({ queryKey: key });
  await cache.invalidateQueries({ queryKey: key });
}
