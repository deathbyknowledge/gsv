import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  LoginHandoffVerificationResult,
  ManagedEntitlementReader,
  ManagedEntitlementService,
  ManagedGatewayProvisioningInterface,
  ManagedGatewayTelegramInterface,
  ManagedTelegramControlInterface,
} from "@humansandmachines/gsv/protocol";
import { provisionReservedInstallation, type ProvisionReservedInstallationInput } from "./provisioning";
import { AccountStore, type InstallationReservation } from "./store";
import { AccountAuthHttp } from "./auth/http";
import {
  AuthAbuseProtection,
  TestBotVerifier,
  TurnstileBotVerifier,
} from "./auth/abuse";
import { SimpleWebAuthnPasskeyProvider } from "./auth/passkeys";
import { PlatformAuthService } from "./auth/service";
import { PlatformAuthStore } from "./auth/store";
import { CloudflareTransactionalMailer } from "./email/mailer";
import {
  EntitlementStore,
  type EntitlementProjection,
} from "./entitlements/store";
import { json } from "./http";
import { ManagedInstallationHttp } from "./installations/http";
import { ManagedInstallationService } from "./installations/service";
import { ManagedTelegramLinkHttp } from "./telegram/http";
import { ManagedTelegramLinkService } from "./telegram/service";
import { ManagedTelegramLinkOperationStore } from "./telegram/store";
import { accountPage, publicTurnstileSiteKey } from "./account-ui";

type AccountServiceEnv = Omit<Env, "ENVIRONMENT"> & {
  ENVIRONMENT: string;
  GATEWAY: ManagedGatewayProvisioningInterface & ManagedGatewayTelegramInterface;
  MANAGED_TELEGRAM: ManagedTelegramControlInterface;
  ASSETS?: Fetcher;
  TURNSTILE_SECRET?: string;
  GSV_TURNSTILE_SITE_KEY?: string;
};

export default class AccountService
  extends WorkerEntrypoint<AccountServiceEnv>
  implements InstallationDirectoryService, ManagedEntitlementService
{
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "healthy" });
    }
    if (url.pathname === "/api/public/config" && request.method === "GET") {
      return json({
        turnstileSiteKey: publicTurnstileSiteKey(
          this.env.GSV_TURNSTILE_SITE_KEY,
        ),
      });
    }
    if (
      (url.pathname === "/telegram" || url.pathname === "/telegram/")
      && (request.method === "GET" || request.method === "HEAD")
    ) {
      return await accountPage(request, this.env.ASSETS);
    }
    const authResponse = await this.authHttp().handle(request);
    if (authResponse) return authResponse;
    const installationResponse = await this.installationHttp().handle(request);
    if (installationResponse) return installationResponse;
    const telegramResponse = await this.telegramHttp().handle(request);
    if (telegramResponse) return telegramResponse;
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not Found" }, 404);
    }
    return new Response("Not Found", { status: 404 });
  }

  async scheduled(): Promise<void> {
    await Promise.all([
      this.abuseProtection().deleteExpiredBuckets(),
      this.store().expireReservations(),
    ]);
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return await this.store().resolveHostname(hostname);
  }

  async verifyLoginHandoff(
    token: string,
    hostname: string,
  ): Promise<LoginHandoffVerificationResult> {
    return await this.authStore().consumeLoginHandoff(token, hostname);
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

  async projectEntitlement(
    input: EntitlementProjection,
  ): Promise<EntitlementProjection> {
    return await new EntitlementStore(this.env.ACCOUNT_DB).project(input);
  }

  private store(): AccountStore {
    return new AccountStore(this.env.ACCOUNT_DB, this.env.GSV_BASE_DOMAIN);
  }

  private authStore(): PlatformAuthStore {
    return new PlatformAuthStore(this.env.ACCOUNT_DB);
  }

  private authHttp(): AccountAuthHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    return new AccountAuthHttp(
      this.authService(accountOrigin),
      this.abuseProtection(accountOrigin),
      accountOrigin,
    );
  }

  private authService(
    accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN),
  ): PlatformAuthService {
    return new PlatformAuthService(
      this.authStore(),
      new SimpleWebAuthnPasskeyProvider(
        this.env.GSV_RP_NAME,
        new URL(accountOrigin).hostname,
        accountOrigin,
      ),
      new CloudflareTransactionalMailer(this.env.EMAIL, this.env.GSV_EMAIL_FROM),
      {
        accountOrigin,
        defer: (task) => this.ctx.waitUntil(task),
      },
    );
  }

  private installationHttp(): ManagedInstallationHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    const abuse = this.abuseProtection(accountOrigin);
    return new ManagedInstallationHttp(
      new ManagedInstallationService(
        this.store(),
        new EntitlementStore(this.env.ACCOUNT_DB),
        this.authService(accountOrigin),
        this.env.GATEWAY,
      ),
      abuse,
      accountOrigin,
    );
  }

  private telegramHttp(): ManagedTelegramLinkHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    return new ManagedTelegramLinkHttp(
      new ManagedTelegramLinkService(
        this.store(),
        new ManagedTelegramLinkOperationStore(this.env.ACCOUNT_DB),
        this.authService(accountOrigin),
        this.env.MANAGED_TELEGRAM,
        this.env.GATEWAY,
      ),
      this.abuseProtection(accountOrigin),
      accountOrigin,
    );
  }

  private abuseProtection(
    accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN),
  ): AuthAbuseProtection {
    const botVerifier = this.env.ENVIRONMENT === "test"
      ? new TestBotVerifier()
      : new TurnstileBotVerifier(
          this.env.TURNSTILE_SECRET,
          new URL(accountOrigin).hostname,
        );
    return new AuthAbuseProtection(this.env.ACCOUNT_DB, botVerifier);
  }
}

export class EntitlementReaderEntrypoint
  extends WorkerEntrypoint<AccountServiceEnv>
  implements ManagedEntitlementReader
{
  async getEntitlement(
    installationId: string,
  ): Promise<EntitlementProjection | null> {
    return await new EntitlementStore(this.env.ACCOUNT_DB).get(installationId);
  }
}

function parseAccountOrigin(value: string): string {
  const normalized = value.trim();
  const url = new URL(normalized);
  if (
    url.origin !== normalized
    || url.protocol !== "https:"
    || url.pathname !== "/"
    || url.username
    || url.password
  ) {
    throw new Error("GSV_ACCOUNT_ORIGIN is invalid");
  }
  return url.origin;
}
