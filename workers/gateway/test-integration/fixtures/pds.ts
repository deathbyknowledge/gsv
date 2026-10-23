import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { PublicRepository, PublicRepositoryAccount } from "@humansandmachines/gsv/services/pds";

// Public repositories the deployment's PDS holds for the integration installations.
const ACCOUNTS = new Map<string, PublicRepositoryAccount>([
  ["inst_integration_first", { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "first.gsv.space" }],
  // Its handle is another hostname, which second.gsv.space must not claim.
  ["inst_integration_second", { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", handle: "second.ship.space" }],
]);

class IntegrationRepository extends RpcTarget implements Pick<PublicRepository, "account"> {
  constructor(private readonly installationId: string) { super(); }

  async account(): Promise<PublicRepositoryAccount | null> {
    return ACCOUNTS.get(this.installationId) ?? null;
  }
}

export class IntegrationPds extends WorkerEntrypoint {
  async getInstallation(installationId: string): Promise<IntegrationRepository> {
    return new IntegrationRepository(installationId);
  }
}
