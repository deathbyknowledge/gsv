import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  LoginHandoffVerificationResult,
  ManagedGatewayProvisioningInterface,
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

type AccountServiceEnv = Omit<Env, "ENVIRONMENT"> & {
  ENVIRONMENT: string;
  GATEWAY: ManagedGatewayProvisioningInterface;
  TURNSTILE_SECRET?: string;
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
    const authResponse = await this.authHttp().handle(request);
    if (authResponse) return authResponse;
    return new Response("Not Found", { status: 404 });
  }

  async scheduled(): Promise<void> {
    await this.abuseProtection().deleteExpiredBuckets();
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

  private store(): AccountStore {
    return new AccountStore(this.env.ACCOUNT_DB, this.env.GSV_BASE_DOMAIN);
  }

  private authStore(): PlatformAuthStore {
    return new PlatformAuthStore(this.env.ACCOUNT_DB);
  }

  private authHttp(): AccountAuthHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    const auth = new PlatformAuthService(
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
    return new AccountAuthHttp(
      auth,
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
