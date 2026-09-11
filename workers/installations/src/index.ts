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

export default class InstallationService extends WorkerEntrypoint<Env>
  implements InstallationDirectoryService, InstallationOnboardingService {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    const accounts = this.accounts();
    const api = new InstallationAdminHttp(
      new InstallationAdminService(this.env.INSTALLATIONS_DB, accounts, this.onboarding(), {
        id: "principal_operator_registry", email: "operator@gsv.invalid", displayName: "Operator registry",
      }, {}),
      new CloudflareInstallationAdminAccess({
        environment: this.env.ENVIRONMENT,
        origin: this.env.GSV_ADMIN_ORIGIN,
        teamDomain: this.env.GSV_ADMIN_ACCESS_TEAM_DOMAIN,
        audience: this.env.GSV_ADMIN_ACCESS_AUD,
      }),
      this.env.GSV_ADMIN_ORIGIN,
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
    return new AccountStore(this.env.INSTALLATIONS_DB, this.env.GSV_BASE_DOMAIN);
  }

  private onboarding(): InstallationOnboardingStore {
    return new InstallationOnboardingStore(this.env.INSTALLATIONS_DB, this.accounts());
  }
}
