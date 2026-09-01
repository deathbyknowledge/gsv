import { AdapterStatusStore } from "./adapter-status";
import { AdapterIngressReceiptStore } from "./adapter-ingress-receipts";
import { IdentityLinkStore } from "./identity-links";
import { LinkChallengeStore } from "./link-challenges";
import { SurfaceRouteStore } from "./surface-routes";
import { PrivateAdapterDestinationStore } from "./private-adapter-destinations";

export class AdapterStore {
  readonly identityLinks: IdentityLinkStore;
  readonly surfaceRoutes: SurfaceRouteStore;
  readonly privateDestinations: PrivateAdapterDestinationStore;
  readonly linkChallenges: LinkChallengeStore;
  readonly status: AdapterStatusStore;
  readonly ingressReceipts: AdapterIngressReceiptStore;

  constructor(sql: SqlStorage) {
    this.identityLinks = new IdentityLinkStore(sql);
    this.surfaceRoutes = new SurfaceRouteStore(sql);
    this.privateDestinations = new PrivateAdapterDestinationStore(sql);
    this.linkChallenges = new LinkChallengeStore(sql);
    this.status = new AdapterStatusStore(sql);
    this.ingressReceipts = new AdapterIngressReceiptStore(sql);
  }
}
