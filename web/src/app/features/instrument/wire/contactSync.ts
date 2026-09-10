import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { instrumentContactConversationKey, instrumentContactRequestsKey } from "./queryKeys";
import type { QueryClient, QueryKey } from "@tanstack/preact-query";

/** Discard any older snapshot, including an initial read that has not resolved. */
export async function refreshContactQuery(cache: QueryClient, queryKey: QueryKey): Promise<void> {
  const filter = { queryKey, exact: true };
  await cache.cancelQueries(filter);
  await cache.invalidateQueries(filter);
}

const contactChangeSchema = z.object({ contactId: z.string().min(1) });
const conversationChangeSchema = z.object({ conversationId: z.string().min(1) });

export async function syncContactDetailSignal(cache: QueryClient, signal: string, payload: JsonValue | undefined): Promise<void> {
  let key: QueryKey;
  if (signal === "contact.request.changed") {
    const parsed = contactChangeSchema.safeParse(payload);
    if (!parsed.success) return;
    key = instrumentContactRequestsKey(parsed.data.contactId);
  } else if (signal === "conversation.changed") {
    const parsed = conversationChangeSchema.safeParse(payload);
    if (!parsed.success) return;
    key = instrumentContactConversationKey(parsed.data.conversationId);
  } else return;
  if (cache.getQueryState(key)) await refreshContactQuery(cache, key);
}
