import type {
  AccountSession,
  AccountSessionResult,
  AuthenticationResponseJSON,
  ManagedTelegramInspectionResult,
  ManagedTelegramInstallation,
  ManagedTelegramLink,
  PublicKeyRequestOptionsJSON,
} from "./types";

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
