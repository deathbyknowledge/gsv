import type {
  SyntheticAdapterDeliverySnapshot,
  SyntheticAdapterRouteSpec,
  SyntheticAdapterSnapshot,
  SyntheticAdapterSpec,
} from "./schema";

type InboundReceipt = SyntheticAdapterSnapshot["inboundReceipts"][number];

export class SyntheticMessagingAdapter {
  readonly id: string;
  readonly kind: SyntheticAdapterSpec["kind"];
  readonly accountId: string;
  readonly ownerUid: number;

  private readonly inboundReceipts = new Map<string, InboundReceipt>();
  private readonly deliveries = new Map<string, SyntheticAdapterDeliverySnapshot>();
  private connected: boolean;

  constructor(spec: SyntheticAdapterSpec) {
    this.id = spec.id;
    this.kind = spec.kind;
    this.accountId = spec.accountId;
    this.ownerUid = spec.ownerUid;
    this.connected = spec.connected;
  }

  admitInbound(processId: string, route: SyntheticAdapterRouteSpec): void {
    this.requireRoute(route);
    if (!this.connected) throw new Error("Adapter account is offline: " + this.id);
    const receipt: InboundReceipt = {
      deliveryId: route.inboundDeliveryId,
      processId,
      messageId: route.messageId,
    };
    const existing = this.inboundReceipts.get(receipt.deliveryId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
        throw new Error("Adapter inbound delivery id was reused with different data");
      }
      return;
    }
    this.inboundReceipts.set(receipt.deliveryId, receipt);
  }

  send(
    processId: string,
    route: SyntheticAdapterRouteSpec,
    deliveryId: string,
    text: string,
  ): SyntheticAdapterDeliverySnapshot {
    this.requireRoute(route);
    if (!this.connected) throw new Error("Adapter account is offline: " + this.id);
    const delivery: SyntheticAdapterDeliverySnapshot = {
      deliveryId,
      processId,
      surface: structuredClone(route.surface),
      text,
      replyToId: route.messageId,
      state: "sent",
    };
    const existing = this.deliveries.get(deliveryId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(delivery)) {
        throw new Error("Adapter delivery id was reused with different content");
      }
      return structuredClone(existing);
    }
    this.deliveries.set(deliveryId, delivery);
    return structuredClone(delivery);
  }

  snapshot(): SyntheticAdapterSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      accountId: this.accountId,
      ownerUid: this.ownerUid,
      connected: this.connected,
      inboundReceipts: [...this.inboundReceipts.values()]
        .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))
        .map((receipt) => structuredClone(receipt)),
      deliveries: [...this.deliveries.values()]
        .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))
        .map((delivery) => structuredClone(delivery)),
    };
  }

  private requireRoute(route: SyntheticAdapterRouteSpec): void {
    if (route.adapterId !== this.id || route.accountId !== this.accountId) {
      throw new Error("Adapter route does not belong to account " + this.id);
    }
  }
}
