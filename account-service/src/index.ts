import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  LoginHandoffVerificationResult,
  ManagedGatewayProvisioningInterface,
} from "@humansandmachines/gsv/protocol";
import { provisionReservedInstallation, type ProvisionReservedInstallationInput } from "./provisioning";
import { AccountStore, type InstallationReservation } from "./store";

type AccountServiceEnv = Env & {
  GATEWAY: ManagedGatewayProvisioningInterface;
};

export default class AccountService
  extends WorkerEntrypoint<AccountServiceEnv>
  implements InstallationDirectoryService
{
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "healthy" });
    }
    return new Response("Not Found", { status: 404 });
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return await this.store().resolveHostname(hostname);
  }

  async verifyLoginHandoff(
    _token: string,
    _hostname: string,
  ): Promise<LoginHandoffVerificationResult> {
    return { ok: false };
  }

  async reserveInstallation(input: {
    principalId: string;
    operationId: string;
    handle: string;
    provisionVersion?: number;
  }): Promise<InstallationReservation> {
    return await this.store().reserveInstallation(input);
  }

  async provisionInstallation(
    input: ProvisionReservedInstallationInput,
  ): Promise<InstallationReservation> {
    return await provisionReservedInstallation(this.store(), this.env.GATEWAY, input);
  }

  private store(): AccountStore {
    return new AccountStore(this.env.ACCOUNT_DB, this.env.GSV_BASE_DOMAIN);
  }
}
