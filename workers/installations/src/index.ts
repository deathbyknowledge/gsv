import { WorkerEntrypoint } from "cloudflare:workers";
import type { InstallationDirectoryResult, InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationOnboardingAuthorization,
  InstallationOnboardingService,
} from "@humansandmachines/gsv/services/onboarding";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationAdminHttp } from "./admin/http";
import { CloudflareInstallationAdminAccess } from "./admin/access";
import { InstallationAdminService } from "./admin/service";
import { InstallationOwnerHttp } from "./owner-http";
import { InstallationOwnerStore } from "./owner-store";
import { OwnerIdentityProvider } from "./owner-identity";
import { OPERATOR_REGISTRY_PRINCIPAL_ID, type InstallationOwnerEnvironment } from "./owner-service";
import { InstallationBootstrapService, parseOperatorAccessMode } from "./bootstrap";
import { InstallationOperatorHttp, OperatorInstallationAdminAccess } from "./operator-http";
import { createAccountsDeletionRuntime, type AccountsDeletionEnvironment } from "./deletion-runtime";
export { InstallationOwnershipEntrypoint } from "./owner-service";

export default class InstallationService extends WorkerEntrypoint<Env & InstallationOwnerEnvironment & AccountsDeletionEnvironment>
  implements InstallationDirectoryService, InstallationOnboardingService {
  async scheduled(): Promise<void> {
    await createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, this.env).resumePending();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    if (new URL(request.url).pathname.startsWith("/owner/")) {
      if (!this.env.ACCOUNTS_GATEWAY_RECOVERY || !this.env.GSV_OWNER_OIDC_ISSUER || !this.env.GSV_OWNER_OIDC_CLIENT_ID) {
        return new Response("Owner identity is not configured", { status: 503, headers: { "cache-control": "no-store" } });
      }
      const response = await new InstallationOwnerHttp(
        new InstallationOwnerStore(this.env.INSTALLATIONS_DB, OPERATOR_REGISTRY_PRINCIPAL_ID),
        new OwnerIdentityProvider({ issuer: this.env.GSV_OWNER_OIDC_ISSUER, clientId: this.env.GSV_OWNER_OIDC_CLIENT_ID,
          clientSecret: this.env.GSV_OWNER_OIDC_CLIENT_SECRET, origin: this.env.GSV_ADMIN_ORIGIN }),
        this.env.ACCOUNTS_GATEWAY_RECOVERY, this.env.GSV_ADMIN_ORIGIN,
      ).handle(request);
      if (response) return response;
    }
    if (new URL(request.url).origin !== this.env.GSV_ADMIN_ORIGIN) return new Response("Forbidden", { status: 403 });
    const accounts = this.accounts();
    const administration = new InstallationAdminService(this.env.INSTALLATIONS_DB, accounts, this.onboarding(), {
        id: OPERATOR_REGISTRY_PRINCIPAL_ID, email: "operator@gsv.invalid", displayName: "Operator registry",
      }, {});
    const mode = parseOperatorAccessMode(this.env.GSV_OPERATOR_ACCESS_MODE);
    const bootstrap = new InstallationBootstrapService(this.env.INSTALLATIONS_DB, accounts, this.onboarding(), administration, mode);
    const operatorResponse = await new InstallationOperatorHttp(bootstrap, this.env.GSV_ADMIN_ORIGIN, mode).handle(request);
    if (operatorResponse) return operatorResponse;
    const api = new InstallationAdminHttp(
      administration,
      new OperatorInstallationAdminAccess(bootstrap, mode, new CloudflareInstallationAdminAccess({
        environment: this.env.ENVIRONMENT,
        origin: this.env.GSV_ADMIN_ORIGIN,
        teamDomain: this.env.GSV_ADMIN_ACCESS_TEAM_DOMAIN,
        audience: this.env.GSV_ADMIN_ACCESS_AUD,
      })),
      this.env.GSV_ADMIN_ORIGIN,
      {},
      createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, this.env),
    );
    const response = await api.handle(request);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return this.accounts().resolveHostname(hostname);
  }

  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    return this.accounts().resolveInstallation(installationId);
  }

  async authorizeInstallationOnboarding(input: AuthorizeInstallationOnboardingInput): Promise<InstallationOnboardingAuthorization> {
    return this.onboarding().authorize(input);
  }

  async completeInstallationOnboarding(input: CompleteInstallationOnboardingInput): Promise<CompleteInstallationOnboardingResult> {
    return this.onboarding().complete(input);
  }

  private accounts(): AccountStore {
    return new AccountStore(this.env.INSTALLATIONS_DB, this.env.GSV_BASE_DOMAIN,
      this.env.GSV_INSTALLATION_ORIGIN_TEMPLATE || undefined, [new URL(this.env.GSV_ADMIN_ORIGIN).hostname]);
  }

  private onboarding(): InstallationOnboardingStore {
    return new InstallationOnboardingStore(this.env.INSTALLATIONS_DB, this.accounts());
  }
}
