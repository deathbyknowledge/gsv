import type { KernelConnection, KernelConnectionState } from "./connection";
import { hasCapability } from "./capabilities";
import { CLIENT_ACTIVITY_INTERVAL_MS } from "@humansandmachines/gsv/protocol";
import type { RunRouteStore } from "./run-routes";

// Allow one reporting interval so throttled input never expires a client early.
export const SHIP_CLIENT_IDLE_MS = 5 * 60 * 1000 + CLIENT_ACTIVITY_INTERVAL_MS;

type ClientPreference = { connectionId: string | null; activeAt: number; revision: string };

/** One private preference per owner, independent of Process and run lifetimes. */
export class ShipReplies {
  constructor(private readonly storage: DurableObjectStorage) {}

  recordClient(uid: number, connectionId: string): void {
    this.storage.kv.put(`ship-reply:${uid}`, { connectionId, activeAt: Date.now(), revision: crypto.randomUUID() } satisfies ClientPreference);
  }

  recordClientMessage(
    uid: number, connectionId: string, messageId: string, expectedRevision: string | null,
    routes: RunRouteStore,
  ): void {
    this.storage.transactionSync(() => routes.pinMessageRoute(messageId, () => {
      if (this.revision(uid) === expectedRevision) this.recordClient(uid, connectionId);
      return null;
    }));
  }

  revision(uid: number): string | null {
    return this.storage.kv.get<ClientPreference>(`ship-reply:${uid}`)?.revision ?? null;
  }

  recordAdapter(uid: number, expectedRevision?: string | null): void {
    if (expectedRevision !== undefined && this.revision(uid) !== expectedRevision) return;
    this.storage.kv.put(`ship-reply:${uid}`, { connectionId: null, activeAt: Date.now(), revision: crypto.randomUUID() } satisfies ClientPreference);
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
