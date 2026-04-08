import { AdapterStatusStore } from "./adapter-status";
import { IdentityLinkStore } from "./identity-links";
import { LinkChallengeStore } from "./link-challenges";
import { SurfaceRouteStore } from "./surface-routes";

export class AdapterStore {
  readonly identityLinks: IdentityLinkStore;
  readonly surfaceRoutes: SurfaceRouteStore;
  readonly linkChallenges: LinkChallengeStore;
  readonly status: AdapterStatusStore;

  constructor(sql: SqlStorage) {
    this.identityLinks = new IdentityLinkStore(sql);
    this.surfaceRoutes = new SurfaceRouteStore(sql);
    this.linkChallenges = new LinkChallengeStore(sql);
    this.status = new AdapterStatusStore(sql);
  }

  init(): void {
    this.identityLinks.init();
    this.surfaceRoutes.init();
    this.linkChallenges.init();
    this.status.init();
  }
}
