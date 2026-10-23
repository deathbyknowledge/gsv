import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  PdsService,
  PublicBlob,
  PublicBlobRef,
  PublicCommit,
  PublicRecordWrite,
  PublicRepository,
  PublicRepositoryAccount,
} from "@humansandmachines/gsv/services/pds";
import type { HostedAccount, HostedRepo } from "../host/repo";
import type { PdsEnv } from "./env";

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
   * then names the new DID.
   */
  async ensureAccount(handle: string): Promise<PublicRepositoryAccount> {
    const existing = await this.repo.account();
    if (existing) return this.hosted(existing);
    const route = await this.env.INSTALLATION_DIRECTORY.resolveHostname(handle.toLowerCase());
    if (!route.found || route.installationId !== this.installationId || route.state !== "active") {
      throw new Error(`InvalidHandle: ${handle} does not address this installation`);
    }
    return this.hosted(await this.repo.create(handle, `installations/${encodeURIComponent(this.installationId)}/`));
  }

  async account(): Promise<PublicRepositoryAccount | null> {
    const account = await this.repo.account();
    return account ? this.hosted(account) : null;
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
