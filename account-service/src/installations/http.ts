import {
  type AuthAbuseProtection,
  RateLimitExceededError,
} from "../auth/abuse";
import {
  hasExpectedOrigin,
  json,
  readJsonObject,
  requestClient,
  requireSessionToken,
  requireString,
} from "../http";
import {
  InstallationProvisioningUnavailableError,
  type ManagedInstallationService,
} from "./service";

export class ManagedInstallationHttp {
  constructor(
    private readonly installations: ManagedInstallationService,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === "/api/installations" && request.method === "GET") {
      return await this.list(request);
    }
    if (url.pathname === "/api/installations" && request.method === "POST") {
      return await this.withMutationBoundary(request, () => this.reserve(request));
    }
    const provision = /^\/api\/installations\/([^/]+)\/provision$/.exec(url.pathname);
    if (provision && request.method === "POST") {
      return await this.withMutationBoundary(
        request,
        () => this.provision(request, decodeURIComponent(provision[1]!)),
      );
    }
    const usage = /^\/api\/installations\/([^/]+)\/usage$/.exec(url.pathname);
    if (usage && request.method === "GET") {
      return await this.usage(request, decodeURIComponent(usage[1]!));
    }
    return null;
  }

  private async list(request: Request): Promise<Response> {
    try {
      const sessionToken = requireSessionToken(request);
      return json({
        installations: await this.installations.list(sessionToken),
      });
    } catch (error) {
      return installationError(error);
    }
  }

  private async reserve(request: Request): Promise<Response> {
    const sessionToken = requireSessionToken(request);
    const body = await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "installation_reservation",
      ipHash: client.ipHash,
      subject: sessionToken,
    });
    const installation = await this.installations.reserve({
      sessionToken,
      idempotencyKey: requireString(body.idempotencyKey, "idempotencyKey"),
      handle: requireString(body.handle, "handle"),
      ownerUsername: requireString(body.ownerUsername, "ownerUsername"),
      ...optionalString(body.agentName, "agentName"),
      ...optionalString(body.timezone, "timezone"),
    });
    return json({ installation }, 201);
  }

  private async provision(request: Request, installationId: string): Promise<Response> {
    const sessionToken = requireSessionToken(request);
    await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "installation_provision",
      ipHash: client.ipHash,
      subject: sessionToken,
    });
    const installation = await this.installations.provision({
      sessionToken,
      installationId,
    });
    return json({ installation });
  }

  private async usage(request: Request, installationId: string): Promise<Response> {
    try {
      return json({
        usage: await this.installations.usage({
          sessionToken: requireSessionToken(request),
          installationId,
        }),
      });
    } catch (error) {
      return installationError(error);
    }
  }

  private async withMutationBoundary(
    request: Request,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      return json({ error: "Forbidden" }, 403);
    }
    try {
      return await operation();
    } catch (error) {
      return installationError(error);
    }
  }
}

function optionalString(
  value: unknown,
  field: "agentName" | "timezone",
): { agentName?: string; timezone?: string } {
  if (value === undefined || value === null) return {};
  return { [field]: requireString(value, field) };
}

function installationError(error: unknown): Response {
  if (error instanceof RateLimitExceededError) {
    return json({ error: "Too many requests" }, 429, {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  const message = error instanceof Error ? error.message : "Installation request failed";
  if (message.includes("authentication required")) {
    return json({ error: "Authentication required" }, 401);
  }
  if (message.includes("passkey authentication is required")) {
    return json({
      error: message.includes("recent")
        ? "Recent passkey authentication is required"
        : "Passkey authentication is required",
    }, 403);
  }
  if (message === "handle is unavailable" || message === "handle is reserved") {
    return json({ error: "Handle is unavailable" }, 409);
  }
  if (message.includes("operationId was already used")) {
    return json({ error: "Idempotency key conflicts with an earlier request" }, 409);
  }
  if (message.includes("reservation expired")) {
    return json({ error: "Reservation expired" }, 409);
  }
  if (
    message.includes("entitlement is required")
    || message.includes("entitlement is unavailable")
  ) {
    return json({ error: "Subscription or trial required" }, 409);
  }
  if (message.includes("installation is unavailable")) {
    return json({ error: "Not Found" }, 404);
  }
  if (error instanceof InstallationProvisioningUnavailableError) {
    return json({ error: "Provisioning temporarily unavailable" }, 503);
  }
  if (
    message.includes("invalid")
    || message.includes("required")
    || message.includes("different")
  ) {
    return json({ error: message }, 400);
  }
  return json({ error: "Installation request failed" }, 400);
}
