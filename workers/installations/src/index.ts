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
import { cleanExpiredOwnerAuthentication, handleInstallationOwnerRequest } from "./owner-front-door";
import { OPERATOR_REGISTRY_PRINCIPAL_ID, type InstallationOwnerEnvironment } from "./owner-service";
import { InstallationBootstrapService, parseOperatorAccessMode } from "./bootstrap";
import { InstallationOperatorHttp, OperatorInstallationAdminAccess } from "./operator-http";
import { createAccountsDeletionRuntime } from "./deletion-runtime";
import { configuredDeletionEnvironment, type DeletionResourceEnvironment } from "./deletion-verifier";
export { InstallationOwnershipEntrypoint } from "./owner-service";

export default class InstallationService extends WorkerEntrypoint<Env & InstallationOwnerEnvironment & DeletionResourceEnvironment>
  implements InstallationDirectoryService, InstallationOnboardingService {
  async scheduled(): Promise<void> {
    await cleanExpiredOwnerAuthentication(this.env);
    await createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, configuredDeletionEnvironment(this.env.INSTALLATIONS_DB, this.env)).resumePending();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    const ownerResponse = await handleInstallationOwnerRequest(request, this.env, OPERATOR_REGISTRY_PRINCIPAL_ID);
    if (ownerResponse) return ownerResponse;
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
      createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, configuredDeletionEnvironment(this.env.INSTALLATIONS_DB, this.env)),
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
