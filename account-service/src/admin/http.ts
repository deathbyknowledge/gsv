import {
  hasExpectedOrigin,
  json,
  noStoreHeaders,
  readJsonObject,
  requireString,
} from "../http";
import type { AccountsAdminAccess } from "./access";
import { adminPage, adminStylesheet } from "./page";
import type { InstallationAdminService } from "./service";

const MAX_FORM_BODY_BYTES = 4 * 1024;

type AdminService = Pick<
  InstallationAdminService,
  "list" | "create" | "reissueOnboarding"
>;

export class AccountsAdminHttp {
  constructor(
    private readonly service: AdminService,
    private readonly access: AccountsAdminAccess,
    private readonly accountOrigin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!isAdminPath(url.pathname)) return null;
    if (!await this.access.allows(request)) {
      return text("Forbidden", 403);
    }

    try {
      if (
        url.pathname === "/admin/styles.css"
        && (request.method === "GET" || request.method === "HEAD")
      ) {
        return adminStylesheet(request.method === "HEAD");
      }
      if (
        (url.pathname === "/admin" || url.pathname === "/admin/")
        && (request.method === "GET" || request.method === "HEAD")
      ) {
        return adminPage(
          await this.service.list(),
          undefined,
          undefined,
          request.method === "HEAD",
        );
      }
      if (
        url.pathname === "/api/admin/installations"
        && request.method === "GET"
      ) {
        return json({ installations: await this.service.list() });
      }
      if (
        url.pathname === "/admin/installations"
        && request.method === "POST"
      ) {
        this.requireMutationOrigin(request);
        const result = await this.service.create(await readFormCreate(request));
        return adminPage(await this.service.list(), result, undefined, false, 201);
      }
      if (
        url.pathname === "/api/admin/installations"
        && request.method === "POST"
      ) {
        this.requireMutationOrigin(request);
        const body = await readJsonObject(request);
        const result = await this.service.create({
          operationId: requireString(body.operationId, "operationId"),
          handle: requireString(body.handle, "handle"),
        });
        return json(result, 201);
      }

      const onboarding = onboardingInstallationId(url.pathname);
      if (onboarding && request.method === "POST") {
        this.requireMutationOrigin(request);
        const result = await this.service.reissueOnboarding(
          decodeURIComponent(onboarding.installationId),
        );
        if (onboarding.api) return json(result);
        return adminPage(await this.service.list(), result);
      }
      return url.pathname.startsWith("/api/")
        ? json({ error: "Not Found" }, 404)
        : text("Not Found", 404);
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        return url.pathname.startsWith("/api/")
          ? json({ error: "Forbidden" }, 403)
          : text("Forbidden", 403);
      }
      const failure = publicAdminFailure(error);
      if (url.pathname.startsWith("/api/")) {
        return json({ error: failure.message }, failure.status);
      }
      return adminPage(
        await this.service.list().catch(() => []),
        undefined,
        failure.message,
        false,
        failure.status,
      );
    }
  }

  private requireMutationOrigin(request: Request): void {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      throw new AdminForbiddenError();
    }
  }
}

class AdminForbiddenError extends Error {}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === "/api/admin"
    || pathname.startsWith("/api/admin/");
}

function onboardingInstallationId(pathname: string): {
  api: boolean;
  installationId: string;
} | null {
  const match = /^\/(api\/)?admin\/installations\/([^/]+)\/onboarding$/.exec(
    pathname,
  );
  return match
    ? { api: Boolean(match[1]), installationId: match[2] ?? "" }
    : null;
}

async function readFormCreate(request: Request): Promise<{
  operationId: string;
  handle: string;
}> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/x-www-form-urlencoded") {
    throw new Error("form body is required");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FORM_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  return {
    operationId: requireString(form.get("operationId"), "operationId"),
    handle: requireString(form.get("handle"), "handle"),
  };
}

function publicAdminFailure(error: unknown): {
  message: string;
  status: number;
} {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("handle ")
    || message.startsWith("installation ")
    || message.startsWith("operationId ")
    || message.startsWith("request ")
    || message.startsWith("form ")
  ) {
    return { message, status: 400 };
  }
  return {
    message: "The operator request could not be completed.",
    status: 503,
  };
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: noStoreHeaders({ "content-type": "text/plain; charset=utf-8" }),
  });
}
