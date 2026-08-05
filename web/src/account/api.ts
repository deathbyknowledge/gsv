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
import type {
  InstallationDeletion,
  InstallationExport,
  InstallationHandoff,
  InstallationUsage,
  ManagedInstallation,
  PasskeyRegistrationChallenge,
  PasskeyRegistrationResult,
  PublicKeyCreationOptionsJSON,
  RegistrationResponseJSON,
} from "./home/types";

export type PublicAccountConfig = {
  turnstileSiteKey: string | null;
  telegramBotUsername: string | null;
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
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async publicConfig(): Promise<PublicAccountConfig> {
    return parsePublicConfig(await this.json("/api/public/config"));
  }

  async session(): Promise<AccountSessionResult> {
    return parseSession(await this.json("/api/session"));
  }

  async requestSignup(input: {
    email: string;
    displayName: string;
    turnstileToken: string;
  }): Promise<void> {
    const body = record(await this.json("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    if (body.accepted !== true) {
      throw new Error("Account service returned an invalid signup result");
    }
  }

  async verifyEmail(token: string): Promise<void> {
    const body = record(await this.json("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }));
    if (body.verified !== true || body.next !== "register_passkey") {
      throw new Error("Account service returned an invalid verification result");
    }
  }

  async recoverWithCode(input: {
    email: string;
    code: string;
    turnstileToken: string;
  }): Promise<void> {
    const body = record(await this.json("/api/auth/recovery/code", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    if (body.recovered !== true || body.next !== "register_passkey") {
      throw new Error("Account service returned an invalid recovery result");
    }
  }

  async logout(): Promise<void> {
    await this.response("/api/auth/logout", {
      method: "POST",
      body: "{}",
    });
  }

  async beginPasskeyRegistration(): Promise<PasskeyRegistrationChallenge> {
    const body = record(await this.json(
      "/api/auth/passkeys/register/options",
      { method: "POST", body: "{}" },
    ));
    return {
      challengeId: string(body.challengeId),
      options: parseCreationOptions(body.options),
    };
  }

  async finishPasskeyRegistration(input: {
    challengeId: string;
    response: RegistrationResponseJSON;
  }): Promise<PasskeyRegistrationResult> {
    const body = record(await this.json(
      "/api/auth/passkeys/register/verify",
      { method: "POST", body: JSON.stringify(input) },
    ));
    if (body.verified !== true || !Array.isArray(body.recoveryCodes)) {
      throw new Error("Account service returned an invalid passkey result");
    }
    const recoveryCodes = body.recoveryCodes.map(string);
    if (recoveryCodes.length === 0 || new Set(recoveryCodes).size !== recoveryCodes.length) {
      throw new Error("Account service returned invalid recovery codes");
    }
    return {
      recoveryCodes,
      expiresAt: number(body.expiresAt),
    };
  }

  async installations(): Promise<ManagedInstallation[]> {
    const body = record(await this.json("/api/installations"));
    if (!Array.isArray(body.installations)) {
      throw new Error("Account service returned an invalid installation list");
    }
    return body.installations.map(parseManagedInstallation);
  }

  async reserveInstallation(input: {
    idempotencyKey: string;
    handle: string;
    ownerUsername: string;
    agentName?: string;
    timezone?: string;
  }): Promise<ManagedInstallation> {
    const body = record(await this.json("/api/installations", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    return parseManagedInstallation(body.installation);
  }

  async provisionInstallation(
    installationId: string,
  ): Promise<ManagedInstallation> {
    const body = record(await this.json(
      `/api/installations/${encodeURIComponent(installationId)}/provision`,
      { method: "POST", body: "{}" },
    ));
    return parseManagedInstallation(body.installation);
  }

  async createInstallationHandoff(
    installationId: string,
  ): Promise<InstallationHandoff> {
    const body = record(await this.json("/api/installations/handoff", {
      method: "POST",
      body: JSON.stringify({ installationId }),
    }));
    const action = string(body.action);
    const parsed = new URL(action);
    if (
      parsed.protocol !== "https:"
      || parsed.pathname !== "/auth/handoff"
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
      || !isManagedGsvHostname(parsed.hostname)
    ) {
      throw new Error("Account service returned an invalid GSV handoff");
    }
    return {
      action,
      token: string(body.token),
      expiresAt: number(body.expiresAt),
    };
  }

  async installationDeletion(
    installationId: string,
  ): Promise<InstallationDeletion | null> {
    try {
      const body = record(await this.json(
        `/api/installations/${encodeURIComponent(installationId)}/deletion`,
      ));
      return parseDeletion(body.deletion);
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) return null;
      throw error;
    }
  }

  async installationUsage(
    installationId: string,
  ): Promise<InstallationUsage | null> {
    const body = record(await this.json(
      `/api/installations/${encodeURIComponent(installationId)}/usage`,
    ));
    if (body.usage === null) return null;
    const usage = record(body.usage);
    const level = string(usage.level);
    const usedPercent = number(usage.usedPercent);
    const periodEndsAt = number(usage.periodEndsAt);
    if (
      !["normal", "approaching", "critical", "exhausted"].includes(level)
      || !Number.isSafeInteger(usedPercent)
      || usedPercent < 0
      || usedPercent > 100
      || !Number.isSafeInteger(periodEndsAt)
      || periodEndsAt < 0
    ) {
      throw new Error("Account service returned invalid GSV Intelligence usage");
    }
    return {
      level: level as InstallationUsage["level"],
      usedPercent,
      periodEndsAt,
    };
  }

  async requestInstallationDeletion(input: {
    installationId: string;
    confirmedHandle: string;
    idempotencyKey: string;
  }): Promise<InstallationDeletion> {
    const body = record(await this.json(
      `/api/installations/${encodeURIComponent(input.installationId)}/deletion`,
      {
        method: "POST",
        body: JSON.stringify({
          confirmedHandle: input.confirmedHandle,
          idempotencyKey: input.idempotencyKey,
        }),
      },
    ));
    return parseDeletion(body.deletion);
  }

  async recoverInstallationDeletion(
    installationId: string,
  ): Promise<InstallationDeletion> {
    const body = record(await this.json(
      `/api/installations/${encodeURIComponent(installationId)}/deletion/recover`,
      { method: "POST", body: "{}" },
    ));
    return parseDeletion(body.deletion);
  }

  async requestInstallationExport(
    installationId: string,
  ): Promise<InstallationExport> {
    const response = await this.response(
      `/api/installations/${encodeURIComponent(installationId)}/export`,
      {
        method: "POST",
        body: "{}",
        headers: { Accept: "application/x-tar" },
      },
    );
    if (
      !response.body
      || response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-tar"
      || response.headers.get("x-gsv-export-format") !== "1"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Account service returned an invalid GSV export");
    }
    return {
      response,
      filename: exportFilename(response.headers.get("content-disposition")),
    };
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
    const response = await this.response(path, init);
    const body = await response.json().catch(() => null);
    if (body === null) {
      throw new Error("Account service returned an invalid response");
    }
    return body;
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(path, {
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
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = isRecord(body) && typeof body.error === "string"
        ? body.error
        : "The account service could not complete the request";
      throw new AccountApiError(error, response.status);
    }
    return response;
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
  if (
    body.telegramBotUsername !== null
    && (
      typeof body.telegramBotUsername !== "string"
      || body.telegramBotUsername.length < 5
      || body.telegramBotUsername.length > 32
      || !/^[A-Za-z][A-Za-z0-9_]*bot$/i.test(body.telegramBotUsername)
    )
  ) {
    throw new Error("Account service returned invalid public configuration");
  }
  return {
    turnstileSiteKey: body.turnstileSiteKey,
    telegramBotUsername: body.telegramBotUsername,
  };
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

function parseCreationOptions(value: unknown): PublicKeyCreationOptionsJSON {
  const options = record(value);
  const rp = record(options.rp);
  const user = record(options.user);
  if (!Array.isArray(options.pubKeyCredParams)) {
    throw new Error("Account service returned invalid passkey options");
  }
  const parsed: PublicKeyCreationOptionsJSON = {
    challenge: string(options.challenge),
    rp: {
      name: string(rp.name),
      ...(typeof rp.id === "string" ? { id: rp.id } : {}),
    },
    user: {
      id: string(user.id),
      name: string(user.name),
      displayName: string(user.displayName),
    },
    pubKeyCredParams: options.pubKeyCredParams.map((value) => {
      const parameter = record(value);
      const type = string(parameter.type);
      const alg = number(parameter.alg);
      if (type !== "public-key" || !Number.isSafeInteger(alg)) {
        throw new Error("Account service returned invalid passkey options");
      }
      return { type, alg };
    }),
  };
  return {
    ...parsed,
    ...(options.timeout === undefined ? {} : { timeout: number(options.timeout) }),
    ...(Array.isArray(options.excludeCredentials)
      ? {
          excludeCredentials: options.excludeCredentials.map((value) => {
            const credential = record(value);
            if (credential.type !== "public-key") {
              throw new Error("Account service returned invalid passkey options");
            }
            return {
              id: string(credential.id),
              type: "public-key" as const,
              ...(Array.isArray(credential.transports)
                ? {
                    transports: credential.transports.map((transport) => (
                      string(transport) as AuthenticatorTransport
                    )),
                  }
                : {}),
            };
          }),
        }
      : {}),
    ...(isRecord(options.authenticatorSelection)
      ? {
          authenticatorSelection: (
            options.authenticatorSelection as unknown as AuthenticatorSelectionCriteria
          ),
        }
      : {}),
    ...(typeof options.attestation === "string"
      ? { attestation: options.attestation as AttestationConveyancePreference }
      : {}),
    ...(isRecord(options.extensions)
      ? { extensions: options.extensions as AuthenticationExtensionsClientInputs }
      : {}),
  };
}

function parseManagedInstallation(value: unknown): ManagedInstallation {
  const body = record(value);
  const state = string(body.state);
  const operationState = string(body.operationState);
  if (!MANAGED_INSTALLATION_STATES.has(state) || !OPERATION_STATES.has(operationState)) {
    throw new Error("Account service returned an invalid installation");
  }
  const entitlement = body.entitlement === null
    ? null
    : parseEntitlement(body.entitlement);
  return {
    installationId: string(body.installationId),
    handle: string(body.handle),
    canonicalOrigin: canonicalGsvOrigin(body.canonicalOrigin),
    state: state as ManagedInstallation["state"],
    operationState: operationState as ManagedInstallation["operationState"],
    ownerUsername: nullableString(body.ownerUsername),
    agentName: nullableString(body.agentName),
    timezone: nullableString(body.timezone),
    reservationExpiresAt: nullableNumber(body.reservationExpiresAt),
    entitlement,
  };
}

function parseEntitlement(
  value: unknown,
): NonNullable<ManagedInstallation["entitlement"]> {
  const body = record(value);
  const state = string(body.state);
  if (!ENTITLEMENT_STATES.has(state)) {
    throw new Error("Account service returned an invalid installation entitlement");
  }
  return {
    state: state as NonNullable<ManagedInstallation["entitlement"]>["state"],
    planKey: string(body.planKey),
    effectiveAt: number(body.effectiveAt),
  };
}

function parseDeletion(value: unknown): InstallationDeletion {
  const body = record(value);
  const requestKind = string(body.requestKind);
  const state = string(body.state);
  if (
    (requestKind !== "user" && requestKind !== "retention")
    || !DELETION_STATES.has(state)
  ) {
    throw new Error("Account service returned an invalid deletion state");
  }
  return {
    operationId: string(body.operationId),
    installationId: string(body.installationId),
    requestKind,
    state: state as InstallationDeletion["state"],
    recoverableUntil: number(body.recoverableUntil),
    createdAt: number(body.createdAt),
    completedAt: nullableNumber(body.completedAt),
  };
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
  const canonicalOrigin = canonicalGsvOrigin(body.canonicalOrigin);
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
  return canonicalGsvOrigin(value);
}

function canonicalGsvOrigin(value: unknown): string {
  const origin = string(value);
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin
    || parsed.protocol !== "https:"
    || !isManagedGsvHostname(parsed.hostname)
  ) {
    throw new Error("Account service returned an invalid GSV origin");
  }
  return origin;
}

function isManagedGsvHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.gsv\.space$/.test(hostname);
}

function exportFilename(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/^attachment; filename="([A-Za-z0-9._-]+)"$/);
  return match?.[1] ?? "gsv-export.tar";
}

const MANAGED_INSTALLATION_STATES = new Set([
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
]);
const OPERATION_STATES = new Set(["reserved", "provisioning", "complete", "failed"]);
const ENTITLEMENT_STATES = new Set([
  "trialing",
  "active",
  "past_due",
  "restricted",
  "cancelled",
  "retained",
]);
const DELETION_STATES = new Set([
  "preparing",
  "recoverable",
  "deleting",
  "complete",
  "recovered",
]);

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

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
