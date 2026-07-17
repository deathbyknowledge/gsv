import { AdapterStatusStore } from "./adapter-status";
import { AdapterIngressReceiptStore } from "./adapter-ingress-receipts";
import { IdentityLinkStore } from "./identity-links";
import { LinkChallengeStore } from "./link-challenges";
import { SurfaceRouteStore } from "./surface-routes";

export class AdapterStore {
  readonly identityLinks: IdentityLinkStore;
  readonly surfaceRoutes: SurfaceRouteStore;
  readonly linkChallenges: LinkChallengeStore;
  readonly status: AdapterStatusStore;
  readonly ingressReceipts: AdapterIngressReceiptStore;

  constructor(sql: SqlStorage) {
    this.identityLinks = new IdentityLinkStore(sql);
    this.surfaceRoutes = new SurfaceRouteStore(sql);
    this.linkChallenges = new LinkChallengeStore(sql);
    this.status = new AdapterStatusStore(sql);
    this.ingressReceipts = new AdapterIngressReceiptStore(sql);
  }
}
