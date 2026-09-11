import type { AdminInstallation, AdminInstallationList, AdminInstallationListQuery, AdminInstallationSummary } from "../administration";
import { hasExpectedOrigin, json, noStoreHeaders, readRequestBody, requireString } from "../http";
import type { InstallationAdminAccess } from "./access";
import { InstallationAdminApi, readInstallationListQuery } from "./api";
import { adminInstallationPage, adminInstallationsPage, adminNewInstallationPage, type InstallationAdminPresentation } from "./installations-page";
import { adminErrorPage, adminStylesheet } from "./page";
import type { IssuedAdminInstallation } from "./service";

type AdminCreateFormInput = { operationId: string; handle: string };
type AdminService<Detail extends AdminInstallation, Summary extends AdminInstallationSummary> = {
  listInstallations(input: AdminInstallationListQuery): Promise<Omit<AdminInstallationList, "installations"> & { installations: Summary[] }>;
  getInstallation(installationId: string): Promise<Detail | null>;
  create(input: AdminCreateFormInput): Promise<IssuedAdminInstallation & { installation: Detail }>;
  reissueOnboarding(installationId: string): Promise<IssuedAdminInstallation & { installation: Detail }>;
  resetInstallation(installationId: string, input: { operationId: string; confirmHandle: string }): Promise<IssuedAdminInstallation & { installation: Detail }>;
  setInstallationState(installationId: string, state: "active" | "restricted"): Promise<void>;
};

/** Installation forms and JSON share the same service and admission policy. */
export class InstallationAdminHttp<
  Detail extends AdminInstallation = AdminInstallation,
  Summary extends AdminInstallationSummary = AdminInstallationSummary,
> {
  private readonly api: InstallationAdminApi;

  constructor(
    private readonly service: AdminService<Detail, Summary>,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly presentation: InstallationAdminPresentation<Detail, Summary> = {},
  ) {
    this.api = new InstallationAdminApi(service, access, origin);
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;
    const response = await this.api.handle(request);
    if (response) return response;
    if (!await this.access.allows(request)) return adminText("Forbidden", 403);
    const head = request.method === "HEAD";
    const route = /^\/admin\/installations\/([^/]+)(?:\/(onboarding|lifecycle|reset))?$/.exec(url.pathname);
    let createFormInput: AdminCreateFormInput | undefined;
    try {
      if (url.pathname === "/admin/styles.css" && (request.method === "GET" || head)) return adminStylesheet(head);
      if (["/admin", "/admin/", "/admin/installations", "/admin/installations/"].includes(url.pathname)
        && (request.method === "GET" || head)) {
        return adminInstallationsPage(await this.service.listInstallations(readInstallationListQuery(url)), undefined, head, 200, this.presentation);
      }
      if (url.pathname === "/admin/installations/new" && (request.method === "GET" || head)) {
        return adminNewInstallationPage(undefined, head, 200, undefined, this.presentation.navigation);
      }
      if (route && !route[2] && (request.method === "GET" || head)) {
        const installation = await this.service.getInstallation(decodeInstallationId(route[1]));
        if (!installation) return adminErrorPage("The installation does not exist.", 404, head, this.presentation.navigation);
        return adminInstallationPage(installation, undefined, undefined, head, 200, this.presentation);
      }
      if (url.pathname === "/admin/installations" && request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        const form = await readAdminForm(request);
        createFormInput = { operationId: requireString(form.get("operationId"), "operationId"), handle: requireString(form.get("handle"), "handle") };
        const issued = await this.service.create(createFormInput);
        return adminInstallationPage(issued.installation, issued, undefined, false, 201, this.presentation);
      }
      if (route && request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        const installationId = decodeInstallationId(route[1]);
        if (route[2] === "lifecycle") {
          const state = (await readAdminForm(request)).get("state");
          if (state !== "active" && state !== "restricted") throw new Error("installation state is invalid");
          await this.service.setInstallationState(installationId, state);
          return adminRedirect(`/admin/installations/${encodeURIComponent(installationId)}`);
        }
        if (route[2] === "onboarding") {
          const issued = await this.service.reissueOnboarding(installationId);
          return adminInstallationPage(issued.installation, issued, undefined, false, 200, this.presentation);
        }
        if (route[2] === "reset") {
          const form = await readAdminForm(request);
          const issued = await this.service.resetInstallation(installationId, {
            operationId: requireString(form.get("operationId"), "operationId"),
            confirmHandle: requireString(form.get("confirmHandle"), "confirmHandle"),
          });
          return adminInstallationPage(issued.installation, issued, undefined, false, 201, this.presentation);
        }
      }
      return isAdminApiPath(url.pathname)
        ? json({ error: "Not Found" }, 404)
        : adminErrorPage("The operator page does not exist.", 404, head, this.presentation.navigation);
    } catch (error) {
      if (error instanceof AdminForbiddenError) {
        return isAdminApiPath(url.pathname) ? json({ error: "Forbidden" }, 403) : adminText("Forbidden", 403);
      }
      const failure = installationAdminFailure(error instanceof Error ? error : new Error("request failed"));
      if (isAdminApiPath(url.pathname)) return json({ error: failure.message }, failure.status);
      if (request.method === "POST" && url.pathname === "/admin/installations") {
        return adminNewInstallationPage(failure.message, false, failure.status, createFormInput, this.presentation.navigation);
      }
      if (request.method === "POST" && route?.[2]) {
        let installation: Detail | null = null;
        try { installation = await this.service.getInstallation(decodeInstallationId(route[1])); }
        catch { installation = null; }
        if (installation) return adminInstallationPage(installation, undefined, failure.message, false, failure.status, this.presentation);
      }
      return adminErrorPage(failure.message, failure.status, head, this.presentation.navigation);
    }
  }
}

export class AdminForbiddenError extends Error {}

export function requireAdminMutationOrigin(request: Request, origin: string): void {
  if (!hasExpectedOrigin(request, origin)) throw new AdminForbiddenError();
}

export async function readAdminForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/x-www-form-urlencoded") throw new Error("form body is required");
  const bytes = await readRequestBody(request, 16 * 1024);
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

export function decodeInstallationId(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new Error("installationId is invalid"); }
}

export function adminRedirect(location: string): Response {
  return new Response(null, { status: 303, headers: noStoreHeaders({ location }) });
}

export function adminText(value: string, status: number): Response {
  return new Response(value, { status, headers: noStoreHeaders({ "content-type": "text/plain; charset=utf-8" }) });
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === "/admin/api" || pathname.startsWith("/admin/api/");
}

function installationAdminFailure(error: Error) {
  const message = error.message;
  if (["handle ", "installation", "operationId ", "request ", "form ", "query ", "state ", "page "]
    .some((prefix) => message.startsWith(prefix))) return { message, status: 400 };
  return { message: "The operator request could not be completed.", status: 503 };
}
