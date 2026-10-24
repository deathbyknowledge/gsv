import type { UsernamePolicyInput, UsernamePolicyLists } from "../username-policy";
import { adminSignupPage } from "./signup-page";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { AdminInstallation, AdminInstallationList, AdminInstallationListQuery, AdminInstallationSummary } from "../administration";
import { hasExpectedOrigin, json, noStoreHeaders, readRequestBody, requireString } from "../http";
import { AdminForbiddenError, type InstallationAdminAccess } from "./access";
import { InstallationAdminApi, readInstallationListQuery } from "./api";
import { adminInstallationPage, adminInstallationsPage, adminNewInstallationPage, type InstallationAdminPresentation, type ShipView } from "./installations-page";
import { adminAuditPage } from "./audit-page";
import type { AdminAuditRecorder, OperatorAuditResult, ShipInsight } from "./insight";
import { adminErrorPage, adminStylesheet, adminTimeScript } from "./page";
import type { IssuedAdminInstallation } from "./service";
import { InstallationDeletionHttp } from "../deletion-http";
import type { AccountsDeletionRuntime } from "../deletion-runtime";
import type { IdentityMoves } from "../identity-moves";
import { IdentityMoveHttp } from "./identity-move-http";

type AdminCreateFormInput = { operationId: string; handle: string };
type AdminService<Detail extends AdminInstallation, Summary extends AdminInstallationSummary> = {
  getUsernamePolicy(): Promise<UsernamePolicyLists>;
  setUsernamePolicy(value: UsernamePolicyInput): Promise<void>;
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
  private readonly deletion: InstallationDeletionHttp | undefined;
  private readonly identityMove: IdentityMoveHttp | undefined;

  constructor(
    private readonly service: AdminService<Detail, Summary>,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly presentation: InstallationAdminPresentation<Detail, Summary> = {},
    deletion?: AccountsDeletionRuntime,
    private readonly insight?: ShipInsight,
    identityMoves?: IdentityMoves,
  ) {
    const audited: AdminAuditRecorder = (request, action, mutation, describe) => this.audited(request, action, mutation, describe);
    this.api = new InstallationAdminApi(service, access, origin, audited);
    this.deletion = deletion ? new InstallationDeletionHttp(deletion, access, origin, audited) : undefined;
    this.identityMove = identityMoves ? new IdentityMoveHttp(identityMoves, access, origin, audited, presentation.navigation) : undefined;
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;
    const deletionResponse = await this.deletion?.handle(request);
    if (deletionResponse) return deletionResponse;
    const identityMoveResponse = await this.identityMove?.handle(request);
    if (identityMoveResponse) return identityMoveResponse;
    const response = await this.api.handle(request);
    if (response) return response;
    if (!await this.access.allows(request)) return adminText("Forbidden", 403);
    const head = request.method === "HEAD";
    const route = /^\/admin\/installations\/([^/]+)(?:\/(onboarding|lifecycle|reset))?$/.exec(url.pathname);
    let createFormInput: AdminCreateFormInput | undefined;
    let usernamePolicyInput: UsernamePolicyInput | undefined;
    try {
      if (url.pathname === "/admin/styles.css" && (request.method === "GET" || head)) return adminStylesheet(head);
      if (url.pathname === "/admin/time.js" && (request.method === "GET" || head)) return adminTimeScript(head);
      if (["/admin", "/admin/", "/admin/installations", "/admin/installations/"].includes(url.pathname)
        && (request.method === "GET" || head)) {
        return adminInstallationsPage(await this.service.listInstallations(readInstallationListQuery(url)), undefined, head, 200, this.presentation);
      }
      if (url.pathname === "/admin/audit" && (request.method === "GET" || head)) {
        const page = readAuditPage(url);
        return adminAuditPage(this.insight ? await this.insight.audit.list({ page }) : null, head, this.presentation.navigation);
      }
      if (url.pathname === "/admin/signup" && (request.method === "GET" || head)) {
        const lists = await this.service.getUsernamePolicy();
        return adminSignupPage({ lists: { reserved: lists.reserved.join("\n"), blocked: lists.blocked.join("\n") }, head,
          saved: url.searchParams.get("saved") === "1", navigation: this.presentation.navigation });
      }
      if (url.pathname === "/admin/signup" && request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        // Two 16,000-character fields can use nine encoded bytes per UTF-16 code unit, plus form framing.
        const form = await readAdminForm(request, 320 * 1024);
        const reserved = form.get("reserved"), blocked = form.get("blocked");
        if (reserved === null || blocked === null) throw new Error("handle lists are required");
        const input = { reserved, blocked };
        usernamePolicyInput = input;
        await this.audited(request, { name: "signup.username-policy.update" }, () => this.service.setUsernamePolicy(input));
        return adminRedirect("/admin/signup?saved=1");
      }
      if (url.pathname === "/admin/installations/new" && (request.method === "GET" || head)) {
        return adminNewInstallationPage(undefined, head, 200, undefined, this.presentation.navigation);
      }
      if (route && !route[2] && (request.method === "GET" || head)) {
        const installation = await this.service.getInstallation(decodeInstallationId(route[1]));
        if (!installation) return adminErrorPage("The Ship does not exist.", 404, head, this.presentation.navigation);
        return adminInstallationPage(installation, undefined, undefined, head, 200, this.presentation, await this.shipView(installation));
      }
      if (url.pathname === "/admin/installations" && request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        const form = await readAdminForm(request);
        createFormInput = { operationId: requireString(form.get("operationId"), "operationId"), handle: requireString(form.get("handle"), "handle") };
        const input = createFormInput;
        const issued = await this.audited(request, { name: "ship.create" }, () => this.service.create(input),
          (result) => ({ installationId: result.installation.installationId }));
        return adminInstallationPage(issued.installation, issued, undefined, false, 201, this.presentation, await this.shipView(issued.installation));
      }
      if (route && request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        const installationId = decodeInstallationId(route[1]);
        if (route[2] === "lifecycle") {
          const form = await readAdminForm(request);
          const state = form.get("state");
          if (state !== "active" && state !== "restricted") throw new Error("installation state is invalid");
          await this.audited(request,
            { name: state === "restricted" ? "ship.suspend" : "ship.reactivate", installationId, reason: form.get("reason") },
            () => this.service.setInstallationState(installationId, state));
          return adminRedirect(`/admin/installations/${encodeURIComponent(installationId)}`);
        }
        if (route[2] === "onboarding") {
          const issued = await this.audited(request, { name: "ship.setup-link.reissue", installationId },
            () => this.service.reissueOnboarding(installationId));
          return adminInstallationPage(issued.installation, issued, undefined, false, 200, this.presentation, await this.shipView(issued.installation));
        }
        if (route[2] === "reset") {
          const form = await readAdminForm(request);
          const input = {
            operationId: requireString(form.get("operationId"), "operationId"),
            confirmHandle: requireString(form.get("confirmHandle"), "confirmHandle"),
          };
          const issued = await this.audited(request, { name: "ship.reset", installationId, reason: form.get("reason") },
            () => this.service.resetInstallation(installationId, input),
            (result) => ({ detail: { replacementInstallationId: result.installation.installationId } }));
          return adminInstallationPage(issued.installation, issued, undefined, false, 201, this.presentation, await this.shipView(issued.installation));
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
      if (failure.status >= 500) console.warn("[Operator] Admin request failed:", url.pathname, exceptionDiagnostics(error));
      if (isAdminApiPath(url.pathname)) return json({ error: failure.message }, failure.status);
      if (request.method === "POST" && url.pathname === "/admin/signup" && usernamePolicyInput !== undefined) {
        return adminSignupPage({ lists: usernamePolicyInput, error: failure.message, status: failure.status,
          navigation: this.presentation.navigation });
      }
      if (request.method === "POST" && url.pathname === "/admin/installations") {
        return adminNewInstallationPage(failure.message, false, failure.status, createFormInput, this.presentation.navigation);
      }
      if (request.method === "POST" && route?.[2]) {
        let installation: Detail | null = null;
        try { installation = await this.service.getInstallation(decodeInstallationId(route[1])); }
        catch { installation = null; }
        if (installation) {
          return adminInstallationPage(installation, undefined, failure.message, false, failure.status, this.presentation,
            await this.shipView(installation));
        }
      }
      return adminErrorPage(failure.message, failure.status, head, this.presentation.navigation);
    }
  }

  /** Runs an admitted operator mutation under its audit row. */
  private async audited<T>(
    request: Request,
    action: { name: string; installationId?: string; reason?: string | null },
    mutation: () => Promise<T>,
    describe?: (result: T) => OperatorAuditResult,
  ): Promise<T> {
    if (!this.insight) return await mutation();
    // Access without per-operator identity records a shared actor; an identity
    // that fails a second verification refuses the action rather than losing attribution.
    const actor = this.access.operatorIdentity ? await this.access.operatorIdentity(request) : "operator";
    if (actor === null) throw new AdminForbiddenError();
    return await this.insight.audit.run({ actor, action: action.name, installationId: action.installationId, reason: action.reason },
      mutation, describe);
  }

  /**
   * Best effort: the page also follows committed actions, so a failed read
   * must not hide their result, such as a link shown only once.
   */
  private async shipView(installation: Detail): Promise<ShipView | undefined> {
    if (!this.insight) return undefined;
    try {
      const [context, health] = await Promise.all([
        this.insight.context(installation),
        this.insight.health(installation.installationId),
      ]);
      return { context, health };
    } catch (error) {
      console.warn("[Operator] Ship page details unavailable:", installation.installationId, exceptionDiagnostics(error));
      return undefined;
    }
  }
}

function readAuditPage(url: URL): number {
  const value = url.searchParams.get("page");
  if (value === null) return 1;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page is invalid");
  return page;
}


export function requireAdminMutationOrigin(request: Request, origin: string): void {
  if (!hasExpectedOrigin(request, origin)) throw new AdminForbiddenError();
}

export async function readAdminForm(request: Request, maxBytes = 16 * 1024): Promise<URLSearchParams> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/x-www-form-urlencoded") throw new Error("form body is required");
  const bytes = await readRequestBody(request, maxBytes);
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
