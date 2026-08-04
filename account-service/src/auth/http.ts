import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { normalizeEmail } from "../domain";
import {
  hasExpectedOrigin,
  json,
  noStoreHeaders,
  readJsonObject,
  requestClient,
  requireSessionToken,
  requireString,
} from "../http";
import {
  type AuthAbuseProtection,
  BotVerificationError,
  RateLimitExceededError,
} from "./abuse";
import {
  accountSessionSetCookie,
  clearAccountSessionCookie,
  readAccountSessionCookie,
} from "./session-cookie";
import { PlatformAuthUnavailableError, type PlatformAuthService } from "./service";

export class AccountAuthHttp {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === "/api/session" && request.method === "GET") {
      return await this.session(request);
    }
    if (url.pathname === "/api/auth/signup" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.signup(request));
    }
    if (url.pathname === "/api/auth/email/verify" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.verifyEmail(request));
    }
    if (url.pathname === "/api/auth/recovery/code" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.recoverWithCode(request));
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.logout(request));
    }
    if (url.pathname === "/api/auth/passkeys/register/options" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.registrationOptions(request));
    }
    if (url.pathname === "/api/auth/passkeys/register/verify" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.verifyRegistration(request));
    }
    if (url.pathname === "/api/auth/passkeys/authenticate/options" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.authenticationOptions(request));
    }
    if (url.pathname === "/api/auth/passkeys/authenticate/verify" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.verifyAuthentication(request));
    }
    if (url.pathname === "/api/installations/handoff" && request.method === "POST") {
      return await this.withPostBoundary(request, () => this.installationHandoff(request));
    }
    return null;
  }

  private async session(request: Request): Promise<Response> {
    const token = readAccountSessionCookie(request.headers.get("cookie"));
    const session = token ? await this.auth.authenticateSession(token) : null;
    return json(session ? {
      authenticated: true,
      principal: {
        id: session.principal.id,
        email: session.principal.email,
        displayName: session.principal.displayName,
        state: session.principal.state,
      },
      authMethod: session.authMethod,
      recentAuthAt: session.recentAuthAt,
      expiresAt: session.expiresAt,
    } : { authenticated: false });
  }

  private async signup(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const email = requireString(body.email, "email");
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "signup",
      ipHash: client.ipHash,
      subject: normalizeEmail(email),
      bot: {
        token: requireString(body.turnstileToken, "turnstileToken"),
        action: "signup",
        remoteIp: client.ipAddress,
      },
    });
    const result = await this.auth.requestSignup({
      email,
      displayName: requireString(body.displayName, "displayName"),
    });
    return json(result, 202);
  }

  private async verifyEmail(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const token = requireString(body.token, "token");
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "email_verify",
      ipHash: client.ipHash,
      subject: token,
    });
    const session = await this.auth.verifyEmail({
      token,
      ipHash: client.ipHash,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return json({
      verified: true,
      principal: {
        id: session.principal.id,
        email: session.principal.email,
        displayName: session.principal.displayName,
      },
      next: "register_passkey",
    }, 200, {
      "set-cookie": accountSessionSetCookie(session.token, session.expiresAt),
    });
  }

  private async recoverWithCode(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const email = requireString(body.email, "email");
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "recovery",
      ipHash: client.ipHash,
      subject: normalizeEmail(email),
      bot: {
        token: requireString(body.turnstileToken, "turnstileToken"),
        action: "recovery",
        remoteIp: client.ipAddress,
      },
    });
    const session = await this.auth.recoverWithCode({
      email,
      code: requireString(body.code, "code"),
      ipHash: client.ipHash,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return json({
      recovered: true,
      next: "register_passkey",
    }, 200, {
      "set-cookie": accountSessionSetCookie(session.token, session.expiresAt),
    });
  }

  private async logout(request: Request): Promise<Response> {
    const token = readAccountSessionCookie(request.headers.get("cookie"));
    if (token) await this.auth.logout(token).catch(() => false);
    return new Response(null, {
      status: 204,
      headers: noStoreHeaders({ "set-cookie": clearAccountSessionCookie() }),
    });
  }

  private async registrationOptions(request: Request): Promise<Response> {
    const token = requireSessionToken(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "passkey_registration",
      ipHash: client.ipHash,
      subject: token,
    });
    return json(await this.auth.beginPasskeyRegistration(token));
  }

  private async verifyRegistration(request: Request): Promise<Response> {
    const token = requireSessionToken(request);
    const body = await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "passkey_registration",
      ipHash: client.ipHash,
      subject: token,
    });
    const result = await this.auth.finishPasskeyRegistration({
      sessionToken: token,
      challengeId: requireString(body.challengeId, "challengeId"),
      response: requireRegistrationResponse(body.response),
    });
    return json(result, 200, {
      "set-cookie": accountSessionSetCookie(token, result.expiresAt),
    });
  }

  private async authenticationOptions(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "passkey_login_options",
      ipHash: client.ipHash,
      bot: {
        token: requireString(body.turnstileToken, "turnstileToken"),
        action: "passkey_login",
        remoteIp: client.ipAddress,
      },
    });
    return json(await this.auth.beginPasskeyAuthentication());
  }

  private async verifyAuthentication(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    const response = requireAuthenticationResponse(body.response);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "passkey_login_verify",
      ipHash: client.ipHash,
      subject: response.id,
    });
    const session = await this.auth.finishPasskeyAuthentication({
      challengeId: requireString(body.challengeId, "challengeId"),
      response,
      ipHash: client.ipHash,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return json({ authenticated: true }, 200, {
      "set-cookie": accountSessionSetCookie(session.token, session.expiresAt),
    });
  }

  private async installationHandoff(request: Request): Promise<Response> {
    const token = requireSessionToken(request);
    const body = await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "installation_handoff",
      ipHash: client.ipHash,
      subject: token,
    });
    const handoff = await this.auth.createInstallationHandoff({
      sessionToken: token,
      installationId: requireString(body.installationId, "installationId"),
    });
    return json({
      action: new URL("/auth/handoff", handoff.canonicalOrigin).toString(),
      token: handoff.token,
      expiresAt: handoff.expiresAt,
    });
  }

  private async withPostBoundary(
    request: Request,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      return json({ error: "Forbidden" }, 403);
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return json({ error: "Too many requests" }, 429, {
          "retry-after": String(error.retryAfterSeconds),
        });
      }
      if (error instanceof BotVerificationError) {
        return json({ error: "Verification failed" }, 400);
      }
      if (error instanceof PlatformAuthUnavailableError) {
        return json({ error: "Service unavailable" }, 503);
      }
      const message = publicAuthError(error);
      const status = message === "Authentication required"
        ? 401
        : message === "Passkey authentication is required"
            || message === "Recent passkey authentication is required"
          ? 403
          : 400;
      return json({ error: message }, status);
    }
  }
}

function requireRegistrationResponse(value: unknown): RegistrationResponseJSON {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("passkey registration response is invalid");
  }
  return value as RegistrationResponseJSON;
}

function requireAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
    throw new Error("passkey authentication response is invalid");
  }
  return value as AuthenticationResponseJSON;
}

function publicAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Authentication failed";
  if (message.includes("authentication required")) return "Authentication required";
  if (message.includes("passkey authentication is required")) {
    return message.includes("recent")
      ? "Recent passkey authentication is required"
      : "Passkey authentication is required";
  }
  if (message.includes("unavailable") || message.includes("invalid") || message.includes("expired")) {
    return "Authentication failed";
  }
  if (message.includes("required") || message.includes("too large")) return message;
  return "Authentication failed";
}
