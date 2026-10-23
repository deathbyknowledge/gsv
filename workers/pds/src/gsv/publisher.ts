import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  PdsService,
  PublicBlob,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepository,
  PublicRepositoryAccount,
  ShipServiceAuthRequest,
} from "@humansandmachines/gsv/services/pds";
import type { HostedAccount, HostedRepo } from "../host/repo";
import type { PdsEnv } from "./env";

/** The DID document service other Ships call, at the Ship's own address. */
const SHIP_SERVICE = "ship";
const SHIP_SERVICE_TYPE = "ShipService";
/** The Kernel signs only Ship-to-Ship calls: one of Ship's methods, to another Ship's service. */
const SHIP_METHOD_PREFIX = "space.ship.";

/** Only the Kernel's deployment-granted binding may publish, and only for an installation Accounts reports active. */
export class PdsPublisherEntrypoint extends WorkerEntrypoint<PdsEnv, { authority: "kernel-publish" }> implements PdsService {
  async getInstallation(installationId: string): Promise<PublicRepository> {
    if (this.ctx.props?.authority !== "kernel-publish") throw new Error("PDS publishing authority is required");
    if (!installationId || installationId.length > 160) throw new Error("Invalid installation identity");
    const route = await this.env.INSTALLATION_DIRECTORY.resolveInstallation(installationId);
    if (!route.found || route.installationId !== installationId || route.state !== "active") {
      throw new Error("Publishing requires an active installation");
    }
    return new InstallationRepository(this.env, installationId, this.env.REPOS.getByName(installationId));
  }
}

/** One installation's repository; the object holding it is named by the installation. */
class InstallationRepository extends RpcTarget implements PublicRepository {
  constructor(
    private readonly env: PdsEnv,
    private readonly installationId: string,
    private readonly repo: DurableObjectStub<HostedRepo>,
  ) {
    super();
  }

  /**
   * Returns the account the repository already has. Otherwise creates one for a
   * handle Accounts routes to this installation, whose /.well-known/atproto-did
   * then names the new DID. The handle is also the Ship's address, so the DID
   * names it as the service other Ships call.
   */
  async ensureAccount(handle: string): Promise<PublicRepositoryAccount> {
    const existing = await this.repo.account();
    if (existing) return this.hosted(existing);
    const route = await this.env.INSTALLATION_DIRECTORY.resolveHostname(handle.toLowerCase());
    if (!route.found || route.installationId !== this.installationId || route.state !== "active") {
      throw new Error(`InvalidHandle: ${handle} does not address this installation`);
    }
    const ship = { type: SHIP_SERVICE_TYPE, endpoint: `https://${handle.toLowerCase()}` };
    return this.hosted(await this.repo.create(handle, `installations/${encodeURIComponent(this.installationId)}/`, { [SHIP_SERVICE]: ship }));
  }

  async account(): Promise<PublicRepositoryAccount | null> {
    const account = await this.repo.account();
    return account ? this.hosted(account) : null;
  }

  async serviceAuth(request: ShipServiceAuthRequest): Promise<string> {
    if (!request.aud.endsWith(`#${SHIP_SERVICE}`) || !request.lxm.startsWith(SHIP_METHOD_PREFIX)) {
      throw new Error("InvalidRequest: the Kernel signs only Ship methods addressed to another Ship");
    }
    return this.repo.serviceAuth(request);
  }

  applyWrites(writes: PublicRecordWrite[]): Promise<PublicCommit> {
    return this.repo.applyWrites(writes);
  }

  uploadBlob(body: ReadableStream<Uint8Array>, size: number, mimeType: string): Promise<PublicBlobRef> {
    return this.repo.uploadBlob(body, size, mimeType);
  }

  readBlob(cid: string): Promise<PublicBlob | null> {
    return this.repo.readBlob(cid);
  }

  private hosted(account: HostedAccount): PublicRepositoryAccount {
    return { ...account, host: this.env.PDS_ORIGIN };
  }
}
