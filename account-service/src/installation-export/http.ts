import {
  type AuthAbuseProtection,
  RateLimitExceededError,
} from "../auth/abuse";
import {
  hasExpectedOrigin,
  noStoreHeaders,
  readJsonObject,
  requestClient,
  requireSessionToken,
} from "../http";
import {
  InstallationExportConflictError,
  InstallationExportService,
  InstallationExportUnavailableError,
} from "./service";

export class InstallationExportHttp {
  constructor(
    private readonly exports: InstallationExportService,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = /^\/api\/installations\/([^/]+)\/export$/.exec(url.pathname);
    if (!match) return null;
    if (request.method !== "POST") return null;
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      return errorResponse("Forbidden", 403);
    }
    try {
      const sessionToken = requireSessionToken(request);
      await readJsonObject(request);
      const client = await requestClient(request);
      await this.abuse.check({
        operation: "installation_export",
        ipHash: client.ipHash,
        subject: sessionToken,
      });
      const result = await this.exports.create({
        sessionToken,
        installationId: decodeURIComponent(match[1]!),
      });
      const headers = noStoreHeaders({
        "content-disposition": `attachment; filename="${exportFilename(
          result.installation.handle,
          result.exportedAt,
        )}"`,
        "content-security-policy": "sandbox",
        "content-type": "application/x-tar",
        "x-gsv-export-format": "1",
      });
      return new Response(result.response.body, { headers });
    } catch (error) {
      return exportError(error);
    }
  }
}

function exportError(error: unknown): Response {
  if (error instanceof RateLimitExceededError) {
    return errorResponse("Too many requests", 429, {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  if (error instanceof InstallationExportConflictError) {
    return errorResponse("Installation teardown has already started", 409);
  }
  if (error instanceof InstallationExportUnavailableError) {
    return errorResponse("Export temporarily unavailable", 503);
  }
  const message = error instanceof Error ? error.message : "Export failed";
  if (message.includes("authentication required")) {
    return errorResponse("Authentication required", 401);
  }
  if (message.includes("passkey authentication is required")) {
    return errorResponse(
      message.includes("recent")
        ? "Recent passkey authentication is required"
        : "Passkey authentication is required",
      403,
    );
  }
  if (message.includes("installation is unavailable")) {
    return errorResponse("Not Found", 404);
  }
  if (message.includes("invalid") || message.includes("required")) {
    return errorResponse(message, 400);
  }
  return errorResponse("Export failed", 400);
}

function errorResponse(
  message: string,
  status: number,
  extraHeaders: HeadersInit = {},
): Response {
  return Response.json(
    { error: message },
    { status, headers: noStoreHeaders(extraHeaders) },
  );
}

function exportFilename(handle: string, exportedAt: number): string {
  const timestamp = new Date(exportedAt).toISOString()
    .replaceAll(":", "")
    .replaceAll("-", "")
    .replace(".000", "");
  return `gsv-${handle}-${timestamp}.tar`;
}
