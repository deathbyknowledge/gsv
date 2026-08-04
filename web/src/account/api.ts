import type {
  AccountSession,
  AccountSessionResult,
  AuthenticationResponseJSON,
  ManagedTelegramInspectionResult,
  ManagedTelegramInstallation,
  ManagedTelegramLink,
  PublicKeyRequestOptionsJSON,
} from "./telegram/types";
import type {
  BillingInstallation,
  BillingOverview,
  HostedBillingSession,
} from "./billing/types";

export type PublicAccountConfig = {
  turnstileSiteKey: string | null;
};

export type PasskeyAuthenticationChallenge = {
  challengeId: string;
  options: PublicKeyRequestOptionsJSON;
};

export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AccountApi {
  constructor(private readonly request: typeof fetch = fetch) {}

  async publicConfig(): Promise<PublicAccountConfig> {
    return parsePublicConfig(await this.json("/api/public/config"));
  }

  async session(): Promise<AccountSessionResult> {
    return parseSession(await this.json("/api/session"));
  }

  async billingOverview(): Promise<BillingOverview> {
    const body = record(await this.json("/api/billing"));
    const offer = record(body.offer);
    if (!Array.isArray(body.installations)) {
      throw new Error("Account service returned an invalid billing overview");
    }
    const currency = string(offer.currency).toLowerCase();
    const monthlyPriceMinor = number(offer.monthlyPriceMinor);
    if (
      !/^[a-z]{3}$/.test(currency)
      || !Number.isSafeInteger(monthlyPriceMinor)
      || monthlyPriceMinor <= 0
    ) {
      throw new Error("Account service returned an invalid billing offer");
    }
    return {
      offer: {
        planKey: string(offer.planKey),
        currency,
        monthlyPriceMinor,
      },
      installations: body.installations.map(parseBillingInstallation),
    };
  }

  async createBillingCheckout(input: {
    installationId: string;
    planKey: string;
    idempotencyKey: string;
  }): Promise<HostedBillingSession> {
    const body = record(await this.json("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    return parseHostedBillingSession(body.session);
  }

  async createBillingPortal(input: {
    installationId: string;
    idempotencyKey: string;
  }): Promise<HostedBillingSession> {
    const body = record(await this.json("/api/billing/portal", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    return parseHostedBillingSession(body.session);
  }

  async inspectTelegramClaim(
    claimToken: string,
  ): Promise<ManagedTelegramInspectionResult> {
    const body = record(await this.json("/api/telegram/claims/inspect", {
      method: "POST",
      body: JSON.stringify({ claimToken }),
    }));
    return parseInspection(body.result);
  }

  async confirmTelegramClaim(input: {
    claimToken: string;
    installationId: string;
    idempotencyKey: string;
  }): Promise<ManagedTelegramLink> {
    const body = record(await this.json("/api/telegram/claims/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    return parseLink(body.link);
  }

  async beginPasskeyAuthentication(
    turnstileToken: string,
  ): Promise<PasskeyAuthenticationChallenge> {
    const body = record(await this.json(
      "/api/auth/passkeys/authenticate/options",
      {
        method: "POST",
        body: JSON.stringify({ turnstileToken }),
      },
    ));
    const options = record(body.options);
    return {
      challengeId: string(body.challengeId),
      options: {
        ...options,
        challenge: string(options.challenge),
      } as PublicKeyRequestOptionsJSON,
    };
  }

  async finishPasskeyAuthentication(input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
  }): Promise<void> {
    const body = record(await this.json(
      "/api/auth/passkeys/authenticate/verify",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ));
    if (body.authenticated !== true) {
      throw new Error("Account service returned an invalid authentication result");
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(path, {
        ...init,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new AccountApiError("The account service could not be reached", 0);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(body) && typeof body.error === "string"
        ? body.error
        : "The account service could not complete the request";
      throw new AccountApiError(error, response.status);
    }
    return body;
  }
}

function parsePublicConfig(value: unknown): PublicAccountConfig {
  const body = record(value);
  if (
    body.turnstileSiteKey !== null
    && typeof body.turnstileSiteKey !== "string"
  ) {
    throw new Error("Account service returned invalid public configuration");
  }
  return { turnstileSiteKey: body.turnstileSiteKey };
}

function parseSession(value: unknown): AccountSessionResult {
  const body = record(value);
  if (body.authenticated === false) return { authenticated: false };
  if (body.authenticated !== true) {
    throw new Error("Account service returned an invalid session");
  }
  const principal = record(body.principal);
  return {
    authenticated: true,
    principal: {
      id: string(principal.id),
      email: string(principal.email),
      displayName: string(principal.displayName),
      state: string(principal.state),
    },
    authMethod: string(body.authMethod),
    recentAuthAt: number(body.recentAuthAt),
    expiresAt: number(body.expiresAt),
  } satisfies AccountSession;
}

function parseInspection(value: unknown): ManagedTelegramInspectionResult {
  const body = record(value);
  if (body.ok === false) {
    const reason = string(body.reason);
    if (reason !== "invalid" && reason !== "expired" && reason !== "used") {
      throw new Error("Account service returned an invalid Telegram claim state");
    }
    return { ok: false, reason };
  }
  if (body.ok !== true || !Array.isArray(body.installations)) {
    throw new Error("Account service returned an invalid Telegram claim");
  }
  return {
    ok: true,
    claim: parseClaim(body.claim),
    installations: body.installations.map(parseInstallation),
  };
}

function parseLink(value: unknown): ManagedTelegramLink {
  const body = record(value);
  if (body.state !== "active") {
    throw new Error("Account service returned an invalid Telegram link");
  }
  return {
    state: "active",
    claimId: string(body.claimId),
    actorId: string(body.actorId),
    installation: parseInstallation(body.installation),
  };
}

function parseClaim(value: unknown) {
  const body = record(value);
  return {
    claimId: string(body.claimId),
    ...(typeof body.actorName === "string"
      ? { actorName: body.actorName }
      : {}),
    ...(typeof body.actorHandle === "string"
      ? { actorHandle: body.actorHandle }
      : {}),
    expiresAt: number(body.expiresAt),
    linked: boolean(body.linked),
  };
}

function parseInstallation(value: unknown): ManagedTelegramInstallation {
  const body = record(value);
  const state = string(body.state);
  const role = string(body.role);
  if (state !== "active") {
    throw new Error("Account service returned an inactive Telegram target");
  }
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new Error("Account service returned an invalid membership role");
  }
  const canonicalOrigin = string(body.canonicalOrigin);
  const origin = new URL(canonicalOrigin);
  if (origin.origin !== canonicalOrigin || origin.protocol !== "https:") {
    throw new Error("Account service returned an invalid GSV origin");
  }
  return {
    installationId: string(body.installationId),
    handle: string(body.handle),
    canonicalOrigin,
    state,
    role,
  };
}

function parseBillingInstallation(value: unknown): BillingInstallation {
  const body = record(value);
  const installationState = string(body.installationState);
  const operationState = string(body.operationState);
  if (
    ![
      "reserved",
      "provisioning",
      "trialing",
      "active",
      "past_due",
      "restricted",
      "cancelled",
      "retained",
      "deleting",
      "deleted",
    ]
      .includes(installationState)
    || !["reserved", "provisioning", "complete", "failed"].includes(operationState)
  ) {
    throw new Error("Account service returned an invalid billing installation");
  }
  const canonicalOrigin = canonicalBillingOrigin(body.canonicalOrigin);
  const base = {
    installationId: string(body.installationId),
    handle: string(body.handle),
    canonicalOrigin,
    installationState: installationState as BillingInstallation["installationState"],
    operationState: operationState as BillingInstallation["operationState"],
  };
  if (body.subscription === null) return { ...base, subscription: null };

  const subscription = record(body.subscription);
  const state = string(subscription.state);
  if (![
    "pending",
    "trialing",
    "active",
    "past_due",
    "cancelled",
    "restricted",
    "retained",
  ].includes(state)) {
    throw new Error("Account service returned an invalid subscription state");
  }
  return {
    ...base,
    subscription: {
      planKey: string(subscription.planKey),
      state: state as NonNullable<BillingInstallation["subscription"]>["state"],
      currentPeriodEndsAt: number(subscription.currentPeriodEndsAt),
      cancelAtPeriodEnd: boolean(subscription.cancelAtPeriodEnd),
      paidThrough: nullableNumber(subscription.paidThrough),
      graceEndsAt: nullableNumber(subscription.graceEndsAt),
      retentionEndsAt: nullableNumber(subscription.retentionEndsAt),
    },
  };
}

function parseHostedBillingSession(value: unknown): HostedBillingSession {
  const body = record(value);
  const url = string(body.url);
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.toString() !== url
  ) {
    throw new Error("Account service returned an invalid billing destination");
  }
  return {
    url,
    ...(body.expiresAt === undefined
      ? {}
      : { expiresAt: number(body.expiresAt) }),
  };
}

function canonicalBillingOrigin(value: unknown): string {
  const origin = string(value);
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== "https:") {
    throw new Error("Account service returned an invalid GSV origin");
  }
  return origin;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Account service returned an invalid response");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Account service returned an invalid response");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Account service returned an invalid response");
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Account service returned an invalid response");
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
