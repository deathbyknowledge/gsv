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
  | "overview"
  | "create"
  | "reissueOnboarding"
  | "setInferenceControl"
  | "setInstallationInferencePolicy"
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
    if (!await this.access.allows(request)) return text("Forbidden", 403);

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
          await this.service.overview(),
          undefined,
          undefined,
          request.method === "HEAD",
        );
      }
      if (url.pathname === "/admin/api/installations" && request.method === "GET") {
        return json(await this.service.overview());
      }
      if (url.pathname === "/admin/installations" && request.method === "POST") {
        this.requireMutationOrigin(request);
        const result = await this.service.create(await readFormCreate(request));
        return adminPage(await this.service.overview(), result, undefined, false, 201);
      }
      if (url.pathname === "/admin/api/installations" && request.method === "POST") {
        this.requireMutationOrigin(request);
        const body = await readJsonObject(request);
        const result = await this.service.create({
          operationId: requireString(body.operationId, "operationId"),
          handle: requireString(body.handle, "handle"),
        });
        return json(result, 201);
      }

      if (
        (url.pathname === "/admin/inference"
          || url.pathname === "/admin/api/inference")
        && request.method === "POST"
      ) {
        this.requireMutationOrigin(request);
        const api = isAdminApiPath(url.pathname);
        const enabled = api
          ? requireBoolean((await readJsonObject(request)).enabled, "enabled")
          : readFormBoolean((await readForm(request)).get("enabled"), "enabled");
        await this.service.setInferenceControl(enabled);
        return api
          ? json({ inference: { enabled } })
          : adminPage(await this.service.overview());
      }

      const inference = inferenceInstallationId(url.pathname);
      if (inference && request.method === "POST") {
        this.requireMutationOrigin(request);
        const input = inference.api
          ? await readJsonInferencePolicy(request)
          : readFormInferencePolicy(await readForm(request));
        await this.service.setInstallationInferencePolicy(
          decodeURIComponent(inference.installationId),
          input,
        );
        return inference.api
          ? json({ inference: input })
          : adminPage(await this.service.overview());
      }

      const onboarding = onboardingInstallationId(url.pathname);
      if (onboarding && request.method === "POST") {
        this.requireMutationOrigin(request);
        const result = await this.service.reissueOnboarding(
          decodeURIComponent(onboarding.installationId),
        );
        return onboarding.api
          ? json(result)
          : adminPage(await this.service.overview(), result);
      }
      return isAdminApiPath(url.pathname)
        ? json({ error: "Not Found" }, 404)
        : text("Not Found", 404);
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        return isAdminApiPath(url.pathname)
          ? json({ error: "Forbidden" }, 403)
          : text("Forbidden", 403);
      }
      const failure = publicAdminFailure(error);
      if (isAdminApiPath(url.pathname)) {
        return json({ error: failure.message }, failure.status);
      }
      return adminPage(
        await this.service.overview().catch(() => ({
          inference: { enabled: false },
          installations: [],
        })),
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
    || pathname.startsWith("/admin/");
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === "/admin/api"
    || pathname.startsWith("/admin/api/");
}

function onboardingInstallationId(pathname: string): {
  api: boolean;
  installationId: string;
} | null {
  const match = /^\/admin\/(api\/)?installations\/([^/]+)\/onboarding$/.exec(
    pathname,
  );
  return match
    ? { api: Boolean(match[1]), installationId: match[2] ?? "" }
    : null;
}

function inferenceInstallationId(pathname: string): {
  api: boolean;
  installationId: string;
} | null {
  const match = /^\/admin\/(api\/)?installations\/([^/]+)\/inference$/.exec(
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
  const form = await readForm(request);
  return {
    operationId: requireString(form.get("operationId"), "operationId"),
    handle: requireString(form.get("handle"), "handle"),
  };
}

async function readForm(request: Request): Promise<URLSearchParams> {
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
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

async function readJsonInferencePolicy(request: Request): Promise<{
  enabled: boolean;
  monthlyLimitNanoUsd: number;
}> {
  const body = await readJsonObject(request);
  return {
    enabled: requireBoolean(body.enabled, "enabled"),
    monthlyLimitNanoUsd: requireNanoUsd(
      body.monthlyLimitNanoUsd,
      "monthlyLimitNanoUsd",
    ),
  };
}

function readFormInferencePolicy(form: URLSearchParams): {
  enabled: boolean;
  monthlyLimitNanoUsd: number;
} {
  return {
    enabled: readFormBoolean(form.get("enabled"), "enabled"),
    monthlyLimitNanoUsd: parseUsdToNanoUsd(
      requireString(form.get("monthlyLimitUsd"), "monthlyLimitUsd"),
    ),
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} is invalid`);
  return value;
}

function readFormBoolean(value: string | null, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} is invalid`);
}

function requireNanoUsd(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseUsdToNanoUsd(value: string): number {
  const match = /^(0|[1-9]\d{0,6})(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) throw new Error("monthlyLimitUsd is invalid");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0"));
  const nanoUsd = whole * 1_000_000_000n + fraction;
  if (nanoUsd > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("monthlyLimitUsd is invalid");
  }
  return Number(nanoUsd);
}

function publicAdminFailure(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("handle ")
    || message.startsWith("installation ")
    || message.startsWith("operationId ")
    || message.startsWith("request ")
    || message.startsWith("form ")
    || message.startsWith("enabled ")
    || message.startsWith("monthlyLimit")
    || message.startsWith("managed inference ")
  ) {
    return { message, status: 400 };
  }
  return { message: "The operator request could not be completed.", status: 503 };
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: noStoreHeaders({ "content-type": "text/plain; charset=utf-8" }),
  });
}
