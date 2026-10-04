import type { KernelConnection, KernelConnectionState } from "./connection";
import { hasCapability } from "./capabilities";
import { CLIENT_ACTIVITY_INTERVAL_MS } from "@humansandmachines/gsv/protocol";
import type { RunRouteStore } from "./run-routes";

// Allow one reporting interval so throttled input never expires a client early.
export const SHIP_CLIENT_IDLE_MS = 5 * 60 * 1000 + CLIENT_ACTIVITY_INTERVAL_MS;

type ClientPreference = { connectionId: string | null; activeAt: number; order: number; appliedOrder: number };

/** One private preference per owner, independent of Process and run lifetimes. */
export class ShipReplies {
  constructor(private readonly storage: DurableObjectStorage) {}

  recordClient(uid: number, connectionId: string): void {
    this.record(uid, connectionId, this.reserveOrder(uid));
  }

  recordClientMessage(
    uid: number, connectionId: string, messageId: string, order: number,
    routes: RunRouteStore,
  ): void {
    this.storage.transactionSync(() => routes.pinMessageRoute(messageId, () => {
      this.record(uid, connectionId, order);
      return null;
    }));
  }

  reserveOrder(uid: number): number {
    const current = this.storage.kv.get<ClientPreference>(`ship-reply:${uid}`)
      ?? { connectionId: null, activeAt: 0, order: 0, appliedOrder: 0 };
    const order = current.order + 1;
    this.storage.kv.put(`ship-reply:${uid}`, { ...current, order });
    return order;
  }

  recordAdapter(uid: number, order = this.reserveOrder(uid)): void {
    this.record(uid, null, order);
  }

  private record(uid: number, connectionId: string | null, order: number): void {
    const current = this.storage.kv.get<ClientPreference>(`ship-reply:${uid}`)!;
    if (order <= current.appliedOrder) return;
    this.storage.kv.put(`ship-reply:${uid}`, { ...current, connectionId, activeAt: Date.now(), appliedOrder: order });
  }

  activeConnection(
    uid: number,
    connections: ReadonlyMap<string, KernelConnection<KernelConnectionState>>,
  ): string | null {
    const preferred = this.storage.kv.get<ClientPreference>(`ship-reply:${uid}`);
    if (!preferred?.connectionId || Date.now() - preferred.activeAt >= SHIP_CLIENT_IDLE_MS) return null;
    const connection = connections.get(preferred.connectionId);
    const state = connection?.state;
    if (state?.step !== "connected" || state.peer?.principal.kind !== "human"
      || state.peer.principal.account.uid !== uid
      || !hasCapability(state.peer.grant.calls, "conversation.send")) return null;
    return connection!.id;
  }
}
