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
  InstallationLifecycleUnavailableError,
  type InstallationLifecycleService,
} from "./service";

export class InstallationLifecycleHttp {
  constructor(
    private readonly lifecycle: InstallationLifecycleService,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = /^\/api\/installations\/([^/]+)\/deletion$/.exec(url.pathname);
    const recoverMatch = /^\/api\/installations\/([^/]+)\/deletion\/recover$/
      .exec(url.pathname);
    if (recoverMatch && request.method === "POST") {
      return await this.withMutationBoundary(
        request,
        () => this.recover(request, decodeURIComponent(recoverMatch[1]!)),
      );
    }
    if (!match) return null;
    const installationId = decodeURIComponent(match[1]!);
    if (request.method === "GET") {
      return await this.status(request, installationId);
    }
    if (request.method === "POST") {
      return await this.withMutationBoundary(
        request,
        () => this.requestDeletion(request, installationId),
      );
    }
    return null;
  }

  private async status(request: Request, installationId: string): Promise<Response> {
    try {
      const deletion = await this.lifecycle.get({
        sessionToken: requireSessionToken(request),
        installationId,
      });
      return deletion ? json({ deletion }) : json({ error: "Not Found" }, 404);
    } catch (error) {
      return lifecycleError(error);
    }
  }

  private async requestDeletion(
    request: Request,
    installationId: string,
  ): Promise<Response> {
    const sessionToken = requireSessionToken(request);
    const body = await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "installation_delete",
      ipHash: client.ipHash,
      subject: sessionToken,
    });
    const deletion = await this.lifecycle.requestUserDeletion({
      sessionToken,
      installationId,
      confirmedHandle: requireString(body.confirmedHandle, "confirmedHandle"),
      idempotencyKey: requireString(body.idempotencyKey, "idempotencyKey"),
    });
    return json({ deletion }, 202);
  }

  private async recover(request: Request, installationId: string): Promise<Response> {
    const sessionToken = requireSessionToken(request);
    await readJsonObject(request);
    const client = await requestClient(request);
    await this.abuse.check({
      operation: "installation_recover",
      ipHash: client.ipHash,
      subject: sessionToken,
    });
    return json({
      deletion: await this.lifecycle.recoverUserDeletion({
        sessionToken,
        installationId,
      }),
    });
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
      return lifecycleError(error);
    }
  }
}

function lifecycleError(error: unknown): Response {
  if (error instanceof RateLimitExceededError) {
    return json({ error: "Too many requests" }, 429, {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  const message = error instanceof Error ? error.message : "Lifecycle request failed";
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
  if (message.includes("already in progress") || message.includes("idempotency key")) {
    return json({ error: message }, 409);
  }
  if (message.includes("no longer recoverable")) {
    return json({ error: "Deletion is no longer recoverable" }, 409);
  }
  if (
    message.includes("installation is unavailable")
    || message.includes("deletion is unavailable")
  ) {
    return json({ error: "Not Found" }, 404);
  }
  if (error instanceof InstallationLifecycleUnavailableError) {
    return json({ error: "Lifecycle service temporarily unavailable" }, 503);
  }
  if (
    message.includes("invalid")
    || message.includes("required")
    || message.includes("does not match")
  ) {
    return json({ error: message }, 400);
  }
  return json({ error: "Lifecycle request failed" }, 400);
}
