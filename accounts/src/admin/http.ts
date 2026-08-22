import {
  hasExpectedOrigin,
  json,
  noStoreHeaders,
  readJsonObject,
  requireString,
} from "../http";
import type { JsonValue, JsonObject } from "../http";
import type { AccountsAdminAccess } from "./access";
import type { ManagedInferenceRoutingUpdate } from "../inference-policy";
import { adminInferencePage } from "./inference-page";
import {
  adminInstallationPage,
  adminInstallationsPage,
  adminNewInstallationPage,
} from "./installations-page";
import { adminErrorPage, adminStylesheet } from "./page";
import {
  ADMIN_VISIBLE_INSTALLATION_STATES,
  type AdminInstallation,
  type AdminInstallationListQuery,
  type InstallationAdminService,
} from "./service";

const MAX_FORM_BODY_BYTES = 16 * 1024;
const MAX_ADMIN_PAGE = 1_000_000;

type AdminCreateFormInput = {
  operationId: string;
  handle: string;
};

type AdminService = Pick<
  InstallationAdminService,
  | "listInstallations"
  | "getInstallation"
  | "inferenceOverview"
  | "create"
  | "reissueOnboarding"
  | "resetInstallation"
  | "setInferenceControl"
  | "setInferenceRouting"
  | "setInstallationInferencePolicy"
  | "setInstallationState"
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

    let createFormInput: AdminCreateFormInput | undefined;
    try {
      const head = request.method === "HEAD";
      if (
        url.pathname === "/admin/styles.css"
        && (request.method === "GET" || head)
      ) {
        return adminStylesheet(head);
      }

      if (
        isInstallationRegistryPath(url.pathname)
        && (request.method === "GET" || head)
      ) {
        return adminInstallationsPage(
          await this.service.listInstallations(readInstallationListQuery(url)),
          undefined,
          head,
        );
      }
      if (
        url.pathname === "/admin/installations/new"
        && (request.method === "GET" || head)
      ) {
        return adminNewInstallationPage(undefined, head);
      }
      if (
        url.pathname === "/admin/inference"
        && (request.method === "GET" || head)
      ) {
        return adminInferencePage(
          await this.service.inferenceOverview(),
          undefined,
          head,
        );
      }
      if (
        url.pathname === "/admin/api/installations"
        && request.method === "GET"
      ) {
        return json(
          await this.service.listInstallations(readInstallationListQuery(url)),
        );
      }
      if (
        url.pathname === "/admin/api/inference"
        && request.method === "GET"
      ) {
        return json(await this.service.inferenceOverview());
      }

      const installationRoute = parseInstallationRoute(url.pathname);
      if (
        installationRoute
        && installationRoute.action === null
        && (request.method === "GET" || (!installationRoute.api && head))
      ) {
        const installation = await this.requireInstallation(
          installationRoute.installationId,
        );
        return installationRoute.api
          ? json(installation)
          : adminInstallationPage(
              installation,
              undefined,
              undefined,
              head,
            );
      }

      if (url.pathname === "/admin/installations" && request.method === "POST") {
        this.requireMutationOrigin(request);
        createFormInput = await readFormCreate(request);
        const result = await this.service.create(createFormInput);
        return adminInstallationPage(
          result.installation,
          result,
          undefined,
          false,
          201,
        );
      }
      if (
        url.pathname === "/admin/api/installations"
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
          : redirect("/admin/inference");
      }

      if (
        (url.pathname === "/admin/inference/routing"
          || url.pathname === "/admin/api/inference/routing")
        && request.method === "POST"
      ) {
        this.requireMutationOrigin(request);
        const api = isAdminApiPath(url.pathname);
        const routing = api
          ? readJsonInferenceRouting(await readJsonObject(request))
          : readFormInferenceRouting(await readForm(request));
        const result = await this.service.setInferenceRouting(routing);
        return api ? json({ routing: result }) : redirect("/admin/inference");
      }

      if (installationRoute && request.method === "POST") {
        this.requireMutationOrigin(request);
        const installationId = decodeInstallationId(
          installationRoute.installationId,
        );
        if (installationRoute.action === "inference") {
          const input = installationRoute.api
            ? await readJsonInferencePolicy(request)
            : readFormInferencePolicy(await readForm(request));
          await this.service.setInstallationInferencePolicy(
            installationId,
            input,
          );
          return installationRoute.api
            ? json({ inference: input })
            : redirectToInstallation(installationId);
        }
        if (installationRoute.action === "lifecycle") {
          const state = installationRoute.api
            ? requireOperationalState((await readJsonObject(request)).state)
            : requireOperationalState((await readForm(request)).get("state"));
          await this.service.setInstallationState(installationId, state);
          return installationRoute.api
            ? json({ installationId, state })
            : redirectToInstallation(installationId);
        }
        if (installationRoute.action === "onboarding") {
          const result = await this.service.reissueOnboarding(installationId);
          return installationRoute.api
            ? json(result)
            : adminInstallationPage(result.installation, result);
        }
        if (installationRoute.action === "reset") {
          const body = installationRoute.api
            ? await readJsonObject(request)
            : await readForm(request);
          const result = await this.service.resetInstallation(
            installationId,
            {
              operationId: requireString(
                body instanceof URLSearchParams
                  ? body.get("operationId")
                  : body.operationId,
                "operationId",
              ),
              confirmHandle: requireString(
                body instanceof URLSearchParams
                  ? body.get("confirmHandle")
                  : body.confirmHandle,
                "confirmHandle",
              ),
            },
          );
          return installationRoute.api
            ? json(result, 201)
            : adminInstallationPage(
                result.installation,
                result,
                undefined,
                false,
                201,
              );
        }
      }

      return isAdminApiPath(url.pathname)
        ? json({ error: "Not Found" }, 404)
        : adminErrorPage("The operator page does not exist.", 404, head);
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        return isAdminApiPath(url.pathname)
          ? json({ error: "Forbidden" }, 403)
          : text("Forbidden", 403);
      }
      if (error instanceof AdminNotFoundError) {
        return isAdminApiPath(url.pathname)
          ? json({ error: "Not Found" }, 404)
          : adminErrorPage(
              "The installation does not exist.",
              404,
              request.method === "HEAD",
            );
      }
      const failure = publicAdminFailure(
        error instanceof Error ? error : new Error("request failed"),
      );
      if (isAdminApiPath(url.pathname)) {
        return json({ error: failure.message }, failure.status);
      }
      return await this.renderHtmlFailure(
        request,
        url,
        failure,
        createFormInput,
      );
    }
  }

  private async requireInstallation(
    installationIdValue: string,
  ): Promise<AdminInstallation> {
    const installation = await this.service.getInstallation(
      decodeInstallationId(installationIdValue),
    );
    if (!installation) throw new AdminNotFoundError();
    return installation;
  }

  private requireMutationOrigin(request: Request): void {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      throw new AdminForbiddenError();
    }
  }

  private async renderHtmlFailure(
    request: Request,
    url: URL,
    failure: { message: string; status: number },
    createFormInput?: AdminCreateFormInput,
  ): Promise<Response> {
    if (
      request.method === "POST"
      && url.pathname === "/admin/installations"
    ) {
      return adminNewInstallationPage(
        failure.message,
        false,
        failure.status,
        createFormInput,
      );
    }
    if (
      request.method === "POST"
      && (
        url.pathname === "/admin/inference"
        || url.pathname === "/admin/inference/routing"
      )
    ) {
      const inference = await this.service.inferenceOverview().catch(() => null);
      if (inference) {
        return adminInferencePage(
          inference,
          failure.message,
          false,
          failure.status,
        );
      }
    }
    const route = parseInstallationRoute(url.pathname);
    if (request.method === "POST" && route && route.action !== null) {
      let installation: AdminInstallation | null = null;
      try {
        installation = await this.service.getInstallation(
          decodeInstallationId(route.installationId),
        );
      } catch {
        installation = null;
      }
      if (installation) {
        return adminInstallationPage(
          installation,
          undefined,
          failure.message,
          false,
          failure.status,
        );
      }
    }
    return adminErrorPage(
      failure.message,
      failure.status,
      request.method === "HEAD",
    );
  }
}

class AdminForbiddenError extends Error {}
class AdminNotFoundError extends Error {}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin"
    || pathname.startsWith("/admin/");
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === "/admin/api"
    || pathname.startsWith("/admin/api/");
}

function isInstallationRegistryPath(pathname: string): boolean {
  return pathname === "/admin"
    || pathname === "/admin/"
    || pathname === "/admin/installations"
    || pathname === "/admin/installations/";
}

type InstallationAdminAction =
  | "onboarding"
  | "inference"
  | "lifecycle"
  | "reset";

function parseInstallationRoute(pathname: string): {
  api: boolean;
  installationId: string;
  action: InstallationAdminAction | null;
} | null {
  const match = /^\/admin\/(api\/)?installations\/([^/]+)(?:\/(onboarding|inference|lifecycle|reset))?$/.exec(
    pathname,
  );
  return match
    ? {
        api: Boolean(match[1]),
        installationId: match[2] ?? "",
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
        action: (match[3] as InstallationAdminAction | undefined) ?? null,
      }
    : null;
}

function readInstallationListQuery(url: URL): AdminInstallationListQuery {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 100) throw new Error("query is too long");

  const stateValue = url.searchParams.get("state")?.trim() ?? "";
  const state = stateValue
    ? ADMIN_VISIBLE_INSTALLATION_STATES.find((value) => value === stateValue)
    : undefined;
  if (stateValue && !state) throw new Error("state is invalid");

  const pageValue = url.searchParams.get("page")?.trim() ?? "";
  if (pageValue && !/^[1-9]\d*$/.test(pageValue)) {
    throw new Error("page is invalid");
  }
  const page = pageValue ? Number(pageValue) : 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_ADMIN_PAGE) {
    throw new Error("page is invalid");
  }
  return {
    query,
    state: state ?? null,
    page,
  };
}

async function readFormCreate(request: Request): Promise<AdminCreateFormInput> {
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

function readFormInferencePolicy(form: URLSearchParams) {
  return {
    enabled: readFormBoolean(form.get("enabled"), "enabled"),
    monthlyLimitNanoUsd: parseUsdToNanoUsd(
      requireString(form.get("monthlyLimitUsd"), "monthlyLimitUsd"),
    ),
  };
}

function readJsonInferenceRouting(
  body: JsonObject,
): ManagedInferenceRoutingUpdate {
  const provider = readJsonObjectField(body.provider, "provider");
  return {
    modelId: requireString(body.modelId, "modelId"),
    displayName: requireString(body.displayName, "displayName"),
    contextWindow: requirePositiveInteger(body.contextWindow, "contextWindow"),
    maxOutputTokens: requirePositiveInteger(
      body.maxOutputTokens,
      "maxOutputTokens",
    ),
    reasoning: requireBoolean(body.reasoning, "reasoning"),
    inputNanoUsdPerToken: requireNanoUsd(
      body.inputNanoUsdPerToken,
      "inputNanoUsdPerToken",
    ),
    outputNanoUsdPerToken: requireNanoUsd(
      body.outputNanoUsdPerToken,
      "outputNanoUsdPerToken",
    ),
    cacheReadNanoUsdPerToken: requireNanoUsd(
      body.cacheReadNanoUsdPerToken,
      "cacheReadNanoUsdPerToken",
    ),
    cacheWriteNanoUsdPerToken: requireNanoUsd(
      body.cacheWriteNanoUsdPerToken,
      "cacheWriteNanoUsdPerToken",
    ),
    provider: {
      allowFallbacks: requireBoolean(
        provider.allowFallbacks,
        "provider.allowFallbacks",
      ),
      requireParameters: requireBoolean(
        provider.requireParameters,
        "provider.requireParameters",
      ),
      dataCollection: requireDataCollection(provider.dataCollection),
      zdr: requireBoolean(provider.zdr, "provider.zdr"),
      order: requireStringArray(provider.order, "provider.order"),
      only: requireStringArray(provider.only, "provider.only"),
      ignore: requireStringArray(provider.ignore, "provider.ignore"),
      quantizations: requireQuantizations(provider.quantizations),
      sort: requireProviderSort(provider.sort),
      ...optionalJsonNumber(
        provider.preferredMinThroughput,
        "preferredMinThroughput",
      ),
      ...optionalJsonNumber(
        provider.preferredMaxLatency,
        "preferredMaxLatency",
      ),
    },
  };
}

function readFormInferenceRouting(
  form: URLSearchParams,
): ManagedInferenceRoutingUpdate {
  return {
    modelId: requireString(form.get("modelId"), "modelId"),
    displayName: requireString(form.get("displayName"), "displayName"),
    contextWindow: parsePositiveInteger(form.get("contextWindow"), "contextWindow"),
    maxOutputTokens: parsePositiveInteger(
      form.get("maxOutputTokens"),
      "maxOutputTokens",
    ),
    reasoning: readFormBoolean(form.get("reasoning"), "reasoning"),
    inputNanoUsdPerToken: parseUsdPerMillionToNanoUsd(
      form.get("inputUsdPerMillion"),
      "inputUsdPerMillion",
    ),
    outputNanoUsdPerToken: parseUsdPerMillionToNanoUsd(
      form.get("outputUsdPerMillion"),
      "outputUsdPerMillion",
    ),
    cacheReadNanoUsdPerToken: parseUsdPerMillionToNanoUsd(
      form.get("cacheReadUsdPerMillion"),
      "cacheReadUsdPerMillion",
    ),
    cacheWriteNanoUsdPerToken: parseUsdPerMillionToNanoUsd(
      form.get("cacheWriteUsdPerMillion"),
      "cacheWriteUsdPerMillion",
    ),
    provider: {
      allowFallbacks: readFormBoolean(
        form.get("allowFallbacks"),
        "allowFallbacks",
      ),
      requireParameters: readFormBoolean(
        form.get("requireParameters"),
        "requireParameters",
      ),
      dataCollection: requireDataCollection(form.get("dataCollection")),
      zdr: readFormBoolean(form.get("zdr"), "zdr"),
      order: parseCommaList(form.get("order"), "order"),
      only: parseCommaList(form.get("only"), "only"),
      ignore: parseCommaList(form.get("ignore"), "ignore"),
      quantizations: requireQuantizations(
        parseCommaList(form.get("quantizations"), "quantizations"),
      ),
      sort: requireProviderSort(form.get("sort")),
      ...optionalFormNumber(
        form.get("preferredMinThroughput"),
        "preferredMinThroughput",
      ),
      ...optionalFormNumber(
        form.get("preferredMaxLatency"),
        "preferredMaxLatency",
      ),
    },
  };
}

function requireBoolean(value: JsonValue, field: string): boolean {
  if (value !== true && value !== false) throw new Error(`${field} is invalid`);
  return value;
}

function readJsonObjectField(
  value: JsonValue,
  field: string,
): JsonObject {
  if (!value || value.constructor !== Object || Array.isArray(value)) {
    throw new Error(`${field} is invalid`);
  }
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return value as JsonObject;
}

function requirePositiveInteger(value: JsonValue, field: string): number {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} is invalid`);
  }
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return value as number;
}

function parsePositiveInteger(value: string | null, field: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return requirePositiveInteger(Number(value), field);
}

function requireStringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => String(item) !== item)) {
    throw new Error(`${field} is invalid`);
  }
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return value as string[];
}

function requireQuantizations(
  value: JsonValue,
): ManagedInferenceRoutingUpdate["provider"]["quantizations"] {
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return requireStringArray(value, "quantizations") as
    ManagedInferenceRoutingUpdate["provider"]["quantizations"];
}

function requireProviderSort(
  value: JsonValue,
): ManagedInferenceRoutingUpdate["provider"]["sort"] {
  if (
    value !== "default"
    && value !== "price"
    && value !== "throughput"
    && value !== "latency"
  ) {
    throw new Error("sort is invalid");
  }
  return value;
}

function requireDataCollection(
  value: JsonValue,
): ManagedInferenceRoutingUpdate["provider"]["dataCollection"] {
  if (value !== "allow" && value !== "deny") {
    throw new Error("dataCollection is invalid");
  }
  return value;
}

function parseCommaList(value: string | null, field: string): string[] {
  if (value === null) throw new Error(`${field} is invalid`);
  if (!value.trim()) return [];
  return value.split(",").map((item) => item.trim());
}

function parseUsdPerMillionToNanoUsd(
  value: string | null,
  field: string,
): number {
  if (!value || !/^(0|[1-9]\d{0,3})(?:\.(\d{1,3}))?$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 1_000 + Number(fraction.padEnd(3, "0"));
}

function optionalFormNumber(
  value: string | null,
  field: "preferredMinThroughput" | "preferredMaxLatency",
): Partial<Pick<
  ManagedInferenceRoutingUpdate["provider"],
  "preferredMinThroughput" | "preferredMaxLatency"
>> {
  if (value === null || value.trim() === "") return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return field === "preferredMinThroughput"
    ? { preferredMinThroughput: parsed }
    : { preferredMaxLatency: parsed };
}

function optionalJsonNumber(
  value: JsonValue,
  field: "preferredMinThroughput" | "preferredMaxLatency",
): Partial<Pick<
  ManagedInferenceRoutingUpdate["provider"],
  "preferredMinThroughput" | "preferredMaxLatency"
>> {
  if (value === undefined) return {};
  if (Number(value) !== value || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} is invalid`);
  }
  return field === "preferredMinThroughput"
    ? { preferredMinThroughput: value }
    : { preferredMaxLatency: value };
}

function requireOperationalState(value: JsonValue): "active" | "restricted" {
  if (value !== "active" && value !== "restricted") {
    throw new Error("installation state is invalid");
  }
  return value;
}

function readFormBoolean(value: string | null, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} is invalid`);
}

function requireNanoUsd(value: JsonValue, field: string): number {
  if (Number(value) !== value || !Number.isSafeInteger(value) || value < 0) {
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

function decodeInstallationId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("installationId is invalid");
  }
}

function redirectToInstallation(installationId: string): Response {
  return redirect(
    `/admin/installations/${encodeURIComponent(installationId)}`,
  );
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: noStoreHeaders({ location }),
  });
}

function publicAdminFailure(error: Error) {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("handle ")
    || message.startsWith("installation")
    || message.startsWith("operationId ")
    || message.startsWith("request ")
    || message.startsWith("form ")
    || message.startsWith("enabled ")
    || message.startsWith("monthlyLimit")
    || message.startsWith("modelId ")
    || message.startsWith("displayName ")
    || message.startsWith("contextWindow ")
    || message.startsWith("maxOutputTokens ")
    || message.startsWith("reasoning ")
    || message.startsWith("inputNanoUsdPerToken ")
    || message.startsWith("outputNanoUsdPerToken ")
    || message.startsWith("cacheReadNanoUsdPerToken ")
    || message.startsWith("cacheWriteNanoUsdPerToken ")
    || message.startsWith("provider")
    || message.startsWith("sort ")
    || message.startsWith("dataCollection ")
    || message.startsWith("inputUsdPerMillion ")
    || message.startsWith("outputUsdPerMillion ")
    || message.startsWith("cacheReadUsdPerMillion ")
    || message.startsWith("cacheWriteUsdPerMillion ")
    || message.startsWith("managed inference ")
    || message.startsWith("query ")
    || message.startsWith("state ")
    || message.startsWith("page ")
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
