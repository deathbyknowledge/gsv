import { AdapterStatusStore } from "./adapter-status";
import { AdapterIngressReceiptStore } from "./adapter-ingress-receipts";
import { AdapterMessageRefStore } from "./adapter-message-refs";
import { IdentityLinkStore } from "./identity-links";
import { SurfaceRouteStore } from "./surface-routes";
import { PrivateAdapterDestinationStore } from "./private-adapter-destinations";

export class AdapterStore {
  readonly identityLinks: IdentityLinkStore;
  readonly surfaceRoutes: SurfaceRouteStore;
  readonly privateDestinations: PrivateAdapterDestinationStore;
  readonly status: AdapterStatusStore;
  readonly ingressReceipts: AdapterIngressReceiptStore;
  readonly messageRefs: AdapterMessageRefStore;

  constructor(sql: SqlStorage) {
    this.identityLinks = new IdentityLinkStore(sql);
    this.surfaceRoutes = new SurfaceRouteStore(sql);
    this.privateDestinations = new PrivateAdapterDestinationStore(sql);
    this.status = new AdapterStatusStore(sql);
    this.ingressReceipts = new AdapterIngressReceiptStore(sql);
    this.messageRefs = new AdapterMessageRefStore(sql);
  }
}
