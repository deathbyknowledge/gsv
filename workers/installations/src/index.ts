import type { TelemetryEnvironment } from "@humansandmachines/gsv/telemetry";
import { WorkerEntrypoint } from "cloudflare:workers";
import { configuredDomainAliases, configuredOriginAliases } from "@humansandmachines/gsv/services/deployment";
import type { InstallationDirectoryResult, InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import type {
  AuthorizeInstallationOnboardingInput,
  CompleteInstallationOnboardingInput,
  CompleteInstallationOnboardingResult,
  InstallationOnboardingAuthorization,
  InstallationOnboardingService,
} from "@humansandmachines/gsv/services/onboarding";
import { InstallationSignup } from "./signup";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationAdminHttp } from "./admin/http";
import { CloudflareInstallationAdminAccess } from "./admin/access";
import { ShipInsight, type OperatorEnvironment } from "./admin/insight";
import { InstallationAdminService } from "./admin/service";
import { cleanExpiredOwnerAuthentication, handleInstallationOwnerRequest } from "./owner-front-door";
import { OPERATOR_REGISTRY_PRINCIPAL_ID, type InstallationOwnerEnvironment } from "./owner-service";
import { InstallationBootstrapService, parseOperatorAccessMode } from "./bootstrap";
import { InstallationOperatorHttp, OperatorInstallationAdminAccess } from "./operator-http";
import { createAccountsDeletionRuntime } from "./deletion-runtime";
import { configuredDeletionEnvironment, type DeletionResourceEnvironment } from "./deletion-verifier";
import { ShipTakedowns } from "./admin/takedowns";
import { installationStateNotices, type InstallationStateNoticeEnvironment } from "./state-notices";
export { InstallationOwnershipEntrypoint } from "./owner-service";
import { RequestReports } from "./request-reports";
export { RequestReportsEntrypoint } from "./request-reports";

export default class InstallationService extends WorkerEntrypoint<Env & InstallationOwnerEnvironment & DeletionResourceEnvironment & TelemetryEnvironment & OperatorEnvironment & InstallationStateNoticeEnvironment>
  implements InstallationDirectoryService, InstallationOnboardingService {
  async scheduled(): Promise<void> {
    await installationStateNotices(this.env.INSTALLATIONS_DB, this.env)?.resumePending();
    await cleanExpiredOwnerAuthentication(this.env);
    await createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, configuredDeletionEnvironment(this.env.INSTALLATIONS_DB, this.env)).resumePending();
    await new RequestReports(this.env.INSTALLATIONS_DB).forgetClosedMessages();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "healthy" });
    }
    const signup = new InstallationSignup(this.env.INSTALLATIONS_DB, this.accounts(), this.onboarding(), this.env.GSV_SIGNUP_ENABLED === "true", undefined, this.env);
    const ownerResponse = await handleInstallationOwnerRequest(request, this.env, OPERATOR_REGISTRY_PRINCIPAL_ID, signup);
    if (ownerResponse) return ownerResponse;
    if (new URL(request.url).origin !== this.env.GSV_ADMIN_ORIGIN) return new Response("Forbidden", { status: 403 });
    const accounts = this.accounts();
    const administration = new InstallationAdminService(this.env.INSTALLATIONS_DB, accounts, this.onboarding(), {
        id: OPERATOR_REGISTRY_PRINCIPAL_ID, email: "operator@gsv.invalid", displayName: "Operator registry",
      }, {}, installationStateNotices(this.env.INSTALLATIONS_DB, this.env));
    const mode = parseOperatorAccessMode(this.env.GSV_OPERATOR_ACCESS_MODE);
    const bootstrap = new InstallationBootstrapService(this.env.INSTALLATIONS_DB, accounts, this.onboarding(), administration, mode);
    const operatorResponse = await new InstallationOperatorHttp(bootstrap, this.env.GSV_ADMIN_ORIGIN, mode).handle(request);
    if (operatorResponse) return operatorResponse;
    const access = new OperatorInstallationAdminAccess(bootstrap, mode, new CloudflareInstallationAdminAccess({
      environment: this.env.ENVIRONMENT, origin: this.env.GSV_ADMIN_ORIGIN,
      teamDomain: this.env.GSV_ADMIN_ACCESS_TEAM_DOMAIN, audience: this.env.GSV_ADMIN_ACCESS_AUD,
    }));
    const api = new InstallationAdminHttp(administration, access, this.env.GSV_ADMIN_ORIGIN,
      {},
      createAccountsDeletionRuntime(this.env.INSTALLATIONS_DB, configuredDeletionEnvironment(this.env.INSTALLATIONS_DB, this.env)),
      new ShipInsight(this.env.INSTALLATIONS_DB, { gateway: this.env.OPERATOR_GATEWAY, mailDomain: this.env.GSV_MAIL_DOMAIN }),
      this.env.PDS_MODERATION ? new ShipTakedowns(this.env.PDS_MODERATION, { gateway: this.env.OPERATOR_GATEWAY }) : undefined,
      new RequestReports(this.env.INSTALLATIONS_DB),
    );
    const response = await api.handle(request);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return this.accounts().resolveHostname(hostname);
  }

  async resolveInstallation(installationId: string): Promise<InstallationDirectoryResult> {
    return this.accounts().resolveInstallation(installationId, { stateRevision: Boolean(this.env.ADMISSION_GATEWAY) });
  }

  async authorizeInstallationOnboarding(input: AuthorizeInstallationOnboardingInput): Promise<InstallationOnboardingAuthorization> {
    return this.onboarding().authorize(input);
  }

  async completeInstallationOnboarding(input: CompleteInstallationOnboardingInput): Promise<CompleteInstallationOnboardingResult> {
    return this.onboarding().complete(input);
  }

  private accounts(): AccountStore {
    return new AccountStore(this.env.INSTALLATIONS_DB, this.env.GSV_BASE_DOMAIN,
      this.env.GSV_INSTALLATION_ORIGIN_TEMPLATE || undefined,
      [this.env.GSV_ADMIN_ORIGIN, this.env.GSV_OWNER_SIGNUP_ORIGIN, ...configuredOriginAliases(this.env.GSV_OWNER_ORIGIN_ALIASES)]
        .filter((origin): origin is string => Boolean(origin)).map((origin) => new URL(origin).hostname),
      configuredDomainAliases(this.env.GSV_DOMAIN_ALIASES));
  }

  private onboarding(): InstallationOnboardingStore {
    return new InstallationOnboardingStore(this.env.INSTALLATIONS_DB, this.accounts(), this.env.GSV_OWNER_AUTH_SECRET);
  }
}
