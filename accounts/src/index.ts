import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationDirectoryResult,
  InstallationDirectoryService,
  InstallationOnboardingAuthorization,
  InstallationOnboardingService,
  ManagedInferenceUsageEvent,
  ManagedInferenceUsageService,
} from "@humansandmachines/gsv/protocol";
import { EnvironmentAccountsAdminAccess } from "./admin/access";
import { AccountsAdminHttp } from "./admin/http";
import { InstallationAdminService } from "./admin/service";
import { ManagedInferenceUsageStore } from "./inference-usage";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";

type AccountServiceEnv = Omit<
  Env,
  | "ENVIRONMENT"
  | "GSV_ACCOUNT_ORIGIN"
  | "GSV_INSTALLATION_ORIGIN_TEMPLATE"
> & {
  ENVIRONMENT: string;
  GSV_ACCOUNT_ORIGIN: string;
  GSV_INSTALLATION_ORIGIN_TEMPLATE?: string;
  GSV_ADMIN_ACCESS_TEAM_DOMAIN?: string;
  GSV_ADMIN_ACCESS_AUD?: string;
};

export default class AccountService
  extends WorkerEntrypoint<AccountServiceEnv>
  implements
    InstallationDirectoryService,
    InstallationOnboardingService,
    ManagedInferenceUsageService
{
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "healthy" });
    }
    const adminResponse = await this.adminHttp().handle(request);
    if (adminResponse) return adminResponse;
    return new Response("Not Found", { status: 404 });
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return await this.store().resolveHostname(hostname);
  }

  async authorizeInstallationOnboarding(
    input: AuthorizeInstallationOnboardingInput,
  ): Promise<InstallationOnboardingAuthorization> {
    return await this.onboardingStore().authorize(input);
  }

  async completeInstallationOnboarding(
    input: CompleteInstallationOnboardingInput,
  ): Promise<CompleteInstallationOnboardingResult> {
    return await this.onboardingStore().complete(input);
  }

  async recordManagedInferenceUsage(
    events: ManagedInferenceUsageEvent[],
  ): Promise<void> {
    await new ManagedInferenceUsageStore(this.env.ACCOUNT_DB).record(events);
  }

  private store(): AccountStore {
    return new AccountStore(
      this.env.ACCOUNT_DB,
      this.env.GSV_BASE_DOMAIN,
      this.env.GSV_INSTALLATION_ORIGIN_TEMPLATE,
    );
  }

  private onboardingStore(): InstallationOnboardingStore {
    return new InstallationOnboardingStore(this.env.ACCOUNT_DB, this.store());
  }

  private adminHttp(): AccountsAdminHttp {
    const accounts = this.store();
    const onboarding = new InstallationOnboardingStore(
      this.env.ACCOUNT_DB,
      accounts,
    );
    return new AccountsAdminHttp(
      new InstallationAdminService(this.env.ACCOUNT_DB, accounts, onboarding),
      new EnvironmentAccountsAdminAccess(this.env),
      parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN),
    );
  }
}

function parseAccountOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value) throw new Error("GSV_ACCOUNT_ORIGIN is invalid");
  return url.origin;
}
