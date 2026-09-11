import { WorkerEntrypoint } from "cloudflare:workers";
import type { BeginInstallationOwnerLinkInput, InstallationOwnershipService, InstallationRecoveryGatewayService } from "@humansandmachines/gsv/services/ownership";
import { InstallationOwnerStore } from "./owner-store";

export const OPERATOR_REGISTRY_PRINCIPAL_ID = "principal_operator_registry";
export type InstallationOwnerEnvironment = {
  INSTALLATIONS_DB: D1Database;
  GSV_ADMIN_ORIGIN: string;
  GSV_OWNER_OIDC_ISSUER?: string;
  GSV_OWNER_OIDC_CLIENT_ID?: string;
  ACCOUNTS_GATEWAY_RECOVERY?: InstallationRecoveryGatewayService;
  GSV_OWNER_OIDC_CLIENT_SECRET?: string;
};

export class InstallationOwnerLinkService implements InstallationOwnershipService {
  constructor(private readonly store: InstallationOwnerStore, private readonly origin: string,
    authority: { authority?: string } | undefined, enabled: boolean) {
    if (authority?.authority !== "kernel-owner-link" || !enabled) throw new Error("Owner linking authority is not configured");
  }

  async beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }> {
    if (!/^[a-f0-9-]{36}$/.test(input.attemptId)) throw new Error("Invalid owner link attempt");
    const attempt = await this.store.beginLink(input);
    return { url: `${this.origin}/owner/link`, expiresAt: attempt.expires_at };
  }
}

/** Only the Kernel's deployment-granted binding may attest a root-owned link attempt. */
export class InstallationOwnershipEntrypoint extends WorkerEntrypoint<InstallationOwnerEnvironment, { authority: "kernel-owner-link" }>
  implements InstallationOwnershipService {
  async beginInstallationOwnerLink(input: BeginInstallationOwnerLinkInput): Promise<{ url: string; expiresAt: number }> {
    return new InstallationOwnerLinkService(new InstallationOwnerStore(this.env.INSTALLATIONS_DB, OPERATOR_REGISTRY_PRINCIPAL_ID),
      this.env.GSV_ADMIN_ORIGIN, this.ctx.props, Boolean(this.env.ACCOUNTS_GATEWAY_RECOVERY && this.env.GSV_OWNER_OIDC_ISSUER && this.env.GSV_OWNER_OIDC_CLIENT_ID))
      .beginInstallationOwnerLink(input);
  }
}
