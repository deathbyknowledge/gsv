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
  ManagedTelegramClaimRejectedError,
  ManagedTelegramControlUnavailableError,
  type ManagedTelegramLinkService,
} from "./service";

export class ManagedTelegramLinkHttp {
  constructor(
    private readonly links: ManagedTelegramLinkService,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (
      request.method === "POST"
      && url.pathname === "/api/telegram/claims/inspect"
    ) {
      return await this.withBoundary(request, "inspect");
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/telegram/claims/confirm"
    ) {
      return await this.withBoundary(request, "confirm");
    }
    return null;
  }

  private async withBoundary(
    request: Request,
    action: "inspect" | "confirm",
  ): Promise<Response> {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      return json({ error: "Forbidden" }, 403);
    }
    try {
      const sessionToken = requireSessionToken(request);
      const body = await readJsonObject(request);
      const client = await requestClient(request);
      await this.abuse.check({
        operation: action === "inspect"
          ? "telegram_claim_inspect"
          : "telegram_link_confirm",
        ipHash: client.ipHash,
        subject: sessionToken,
      });
      const claimToken = requireString(body.claimToken, "claimToken");
      if (action === "inspect") {
        return json({
          result: await this.links.inspect({ sessionToken, claimToken }),
        });
      }
      return json({
        link: await this.links.confirm({
          sessionToken,
          claimToken,
          installationId: requireString(
            body.installationId,
            "installationId",
          ),
          idempotencyKey: requireString(body.idempotencyKey, "idempotencyKey"),
        }),
      });
    } catch (error) {
      return telegramLinkError(error);
    }
  }
}

function telegramLinkError(error: unknown): Response {
  if (error instanceof RateLimitExceededError) {
    return json({ error: "Too many requests" }, 429, {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  if (error instanceof ManagedTelegramControlUnavailableError) {
    return json({ error: "Telegram linking temporarily unavailable" }, 503);
  }
  if (error instanceof ManagedTelegramClaimRejectedError) {
    return json({
      error: error.reason === "expired"
        ? "Telegram link expired"
        : error.reason === "used"
          ? "Telegram link was already used"
          : "Telegram link is invalid",
    }, error.reason === "invalid" ? 400 : 410);
  }
  const message = error instanceof Error ? error.message : "Telegram link failed";
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
  if (message.includes("membership is unavailable")) {
    return json({ error: "Installation is unavailable" }, 404);
  }
  if (message.includes("already owned")) {
    return json({ error: "Telegram link conflicts with an earlier request" }, 409);
  }
  if (
    message.includes("invalid")
    || message.includes("required")
    || message.includes("direct messages")
  ) {
    return json({ error: message }, 400);
  }
  return json({ error: "Telegram link failed" }, 400);
}
