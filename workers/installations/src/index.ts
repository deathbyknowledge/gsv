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

export default class InstallationService extends WorkerEntrypoint<Env>
  implements InstallationDirectoryService, InstallationOnboardingService {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
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
