import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
  LoginHandoffVerificationResult,
  ManagedEntitlementReader,
  ManagedEntitlementService,
  ManagedGatewayLifecycleInterface,
  ManagedGatewayDataLifecycleInterface,
  ManagedGatewayExportInterface,
  ManagedGatewayProvisioningInterface,
  ManagedGatewayTelegramInterface,
  ManagedTelegramControlInterface,
  ManagedTelegramDataLifecycleInterface,
  ManagedInferenceDataLifecycleInterface,
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
import { GatewayEntitlementProjector } from "./entitlements/projector";
import { json } from "./http";
import { ManagedInstallationHttp } from "./installations/http";
import { ManagedInstallationService } from "./installations/service";
import { InstallationLifecycleHttp } from "./lifecycle/http";
import { InstallationLifecycleService } from "./lifecycle/service";
import { InstallationLifecycleStore } from "./lifecycle/store";
import { LifecycleNotificationService } from "./notifications/service";
import { LifecycleNotificationStore } from "./notifications/store";
import { ManagedTelegramLinkHttp } from "./telegram/http";
import { ManagedTelegramLinkService } from "./telegram/service";
import { ManagedTelegramLinkOperationStore } from "./telegram/store";
import { accountPage, publicTurnstileSiteKey } from "./account-ui";
import {
  billingProductConfig,
  stripeBillingConfig,
  type BillingProductEnvironment,
  type StripeBillingEnvironment,
} from "./billing/config";
import { BillingCommerceService } from "./billing/commerce";
import { BillingHttp, isBillingPath } from "./billing/http";
import { BillingOverviewService } from "./billing/overview";
import { BillingPlanCatalog, BillingProviderPriceCatalog } from "./billing/plans";
import { BillingReconciler } from "./billing/reconciler";
import { BillingStore } from "./billing/store";
import { StripeBillingProvider } from "./billing/stripe-provider";
import {
  BillingTerminationService,
  BillingTerminationStore,
} from "./billing/termination";
import { BillingWebhookProcessor } from "./billing/webhooks";
import { InstallationExportHttp } from "./installation-export/http";
import { InstallationExportService } from "./installation-export/service";

type AccountServiceEnv = Omit<Env, "ENVIRONMENT"> & BillingProductEnvironment
& StripeBillingEnvironment & {
  ENVIRONMENT: string;
  GATEWAY: ManagedGatewayProvisioningInterface
    & ManagedGatewayTelegramInterface
    & ManagedGatewayLifecycleInterface
    & ManagedGatewayDataLifecycleInterface
    & ManagedGatewayExportInterface;
  MANAGED_TELEGRAM: ManagedTelegramControlInterface
    & ManagedTelegramDataLifecycleInterface;
  MANAGED_INFERENCE: ManagedInferenceDataLifecycleInterface;
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
      (
        url.pathname === "/telegram"
        || url.pathname === "/telegram/"
        || url.pathname === "/billing"
        || url.pathname === "/billing/"
      )
      && (request.method === "GET" || request.method === "HEAD")
    ) {
      return await accountPage(request, this.env.ASSETS);
    }
    const authResponse = await this.authHttp().handle(request);
    if (authResponse) return authResponse;
    const installationResponse = await this.installationHttp().handle(request);
    if (installationResponse) return installationResponse;
    const exportResponse = await this.installationExportHttp().handle(request);
    if (exportResponse) return exportResponse;
    const lifecycleResponse = await this.lifecycleHttp().handle(request);
    if (lifecycleResponse) {
      if (request.method === "POST" && lifecycleResponse.ok) {
        this.deferNotificationSync();
        this.deferBillingTermination();
      }
      return lifecycleResponse;
    }
    const telegramResponse = await this.telegramHttp().handle(request);
    if (telegramResponse) return telegramResponse;
    if (isBillingPath(url.pathname)) {
      try {
        const billingResponse = await this.billingHttp().handle(request);
        if (billingResponse) {
          if (
            request.method === "POST"
            && url.pathname === "/api/billing/webhooks/stripe"
            && billingResponse.ok
          ) {
            this.deferNotificationSync();
          }
          return billingResponse;
        }
      } catch {
        return json({ error: "Billing temporarily unavailable" }, 503);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not Found" }, 404);
    }
    return new Response("Not Found", { status: 404 });
  }

  async scheduled(): Promise<void> {
    const now = Date.now();
    await Promise.all([
      this.abuseProtection().deleteExpiredBuckets(),
      this.store().expireReservations(),
    ]);
    await Promise.resolve()
      .then(() => this.billingTerminationService().advanceDue(now))
      .catch(() => undefined);
    await this.billingReconciler().advanceDue(now);
    const notifications = this.notificationService();
    await notifications.sync(now);
    const lifecycle = this.lifecycleService();
    for (const candidate of await new BillingStore(this.env.ACCOUNT_DB)
      .listRetentionDeletionDue(now)) {
      await lifecycle.startRetentionDeletion({
        installationId: candidate.installationId,
        retentionEndsAt: candidate.retentionEndsAt,
        now,
      });
    }
    await lifecycle.advanceActionable(now);
    await notifications.sync(now);
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
    return await this.entitlementProjector().project(input);
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

  private installationExportHttp(): InstallationExportHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    return new InstallationExportHttp(
      new InstallationExportService(
        this.store(),
        new InstallationLifecycleStore(this.env.ACCOUNT_DB),
        this.authService(accountOrigin),
        this.env.GATEWAY,
      ),
      this.abuseProtection(accountOrigin),
      accountOrigin,
    );
  }

  private lifecycleHttp(): InstallationLifecycleHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    return new InstallationLifecycleHttp(
      this.lifecycleService(accountOrigin),
      this.abuseProtection(accountOrigin),
      accountOrigin,
    );
  }

  private lifecycleService(
    accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN),
  ): InstallationLifecycleService {
    return new InstallationLifecycleService(
      new InstallationLifecycleStore(this.env.ACCOUNT_DB),
      this.authService(accountOrigin),
      this.env.GATEWAY,
      this.env.MANAGED_INFERENCE,
      this.env.MANAGED_TELEGRAM,
      new ManagedTelegramLinkOperationStore(this.env.ACCOUNT_DB),
    );
  }

  private billingHttp(): BillingHttp {
    const accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN);
    const product = billingProductConfig(this.env);
    const store = new BillingStore(this.env.ACCOUNT_DB);
    return new BillingHttp(
      new BillingOverviewService(
        this.store(),
        store,
        this.authService(accountOrigin),
      ),
      () => this.billingProviderServices(store, accountOrigin),
      this.abuseProtection(accountOrigin),
      accountOrigin,
      {
        planKey: product.plan.planKey,
        ...product.offer,
      },
    );
  }

  private billingProviderServices(
    store: BillingStore,
    accountOrigin: string,
  ): {
    commerce: BillingCommerceService;
    webhooks: BillingWebhookProcessor;
  } {
    const product = billingProductConfig(this.env);
    const providerConfig = stripeBillingConfig(this.env, product.plan.planKey);
    const provider = new StripeBillingProvider(providerConfig);
    const reconciler = new BillingReconciler(
      store,
      this.entitlementProjector(),
      new BillingPlanCatalog([product.plan]),
      product.policy,
    );
    return {
      commerce: new BillingCommerceService(
        store,
        this.authService(accountOrigin),
        provider,
        new BillingProviderPriceCatalog(providerConfig.prices),
        accountOrigin,
      ),
      webhooks: new BillingWebhookProcessor(store, reconciler, provider),
    };
  }

  private billingReconciler(): BillingReconciler {
    const product = billingProductConfig(this.env);
    return new BillingReconciler(
      new BillingStore(this.env.ACCOUNT_DB),
      this.entitlementProjector(),
      new BillingPlanCatalog([product.plan]),
      product.policy,
    );
  }

  private billingTerminationService(): BillingTerminationService {
    const product = billingProductConfig(this.env);
    const store = new BillingStore(this.env.ACCOUNT_DB);
    const provider = new StripeBillingProvider(
      stripeBillingConfig(this.env, product.plan.planKey),
    );
    return new BillingTerminationService(
      new BillingTerminationStore(this.env.ACCOUNT_DB),
      provider,
      new BillingReconciler(
        store,
        this.entitlementProjector(),
        new BillingPlanCatalog([product.plan]),
        product.policy,
      ),
    );
  }

  private entitlementProjector(): GatewayEntitlementProjector {
    return new GatewayEntitlementProjector(
      new EntitlementStore(this.env.ACCOUNT_DB),
      this.env.GATEWAY,
    );
  }

  private notificationService(
    accountOrigin = parseAccountOrigin(this.env.GSV_ACCOUNT_ORIGIN),
  ): LifecycleNotificationService {
    return new LifecycleNotificationService(
      new LifecycleNotificationStore(this.env.ACCOUNT_DB),
      new CloudflareTransactionalMailer(this.env.EMAIL, this.env.GSV_EMAIL_FROM),
      accountOrigin,
    );
  }

  private deferNotificationSync(): void {
    this.ctx.waitUntil(
      this.notificationService().sync().then(() => undefined).catch(() => undefined),
    );
  }

  private deferBillingTermination(): void {
    this.ctx.waitUntil(
      Promise.resolve()
        .then(() => this.billingTerminationService().advanceDue())
        .then(() => undefined)
        .catch(() => undefined),
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

export class GatewayDirectoryEntrypoint
  extends WorkerEntrypoint<AccountServiceEnv>
  implements InstallationDirectoryService
{
  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return await new AccountStore(
      this.env.ACCOUNT_DB,
      this.env.GSV_BASE_DOMAIN,
    ).resolveHostname(hostname);
  }

  async verifyLoginHandoff(
    token: string,
    hostname: string,
  ): Promise<LoginHandoffVerificationResult> {
    return await new PlatformAuthStore(this.env.ACCOUNT_DB)
      .consumeLoginHandoff(token, hostname);
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
