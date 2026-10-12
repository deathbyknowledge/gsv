import type { ManagedWhatsAppPeerState } from "./managed-peer-state";

/**
 * Retire the previous adapter outbox on activation. These were delivery copies;
 * the canonical GSV conversation retains the original messages. The old store
 * was capped at 64 entries, so this transaction is bounded.
 */
export async function retireWhatsAppOutbox(storage: DurableObjectStorage): Promise<void> {
  await storage.transaction(async (txn) => {
    const held = await txn.list({ prefix: "managed_whatsapp_peer:v1:held:" });
    if (held.size) await txn.delete([...held.keys()]);
    const key = "managed_whatsapp_peer:v1:state";
    const state = await txn.get<ManagedWhatsAppPeerState & { pendingTemplate?: unknown }>(key);
    if (state && "pendingTemplate" in state) {
      const { pendingTemplate: _, ...current } = state;
      await txn.put(key, current);
    }
  });
}
