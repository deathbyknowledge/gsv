import { ADMIN_VISIBLE_INSTALLATION_STATES, type AdminInstallationListQuery } from "../administration";
import { hasExpectedOrigin, json, noStoreHeaders, readJsonObject, requireString } from "../http";
import type { InstallationAdminAccess } from "./access";
import type { InstallationAdminService } from "./service";

type AdminService = Pick<InstallationAdminService,
  "listInstallations" | "getInstallation" | "create" | "reissueOnboarding" | "resetInstallation" | "setInstallationState"
>;

/** Installation API admission is shared by the reference Worker and operator overlays. */
export class InstallationAdminApi {
  constructor(
    private readonly service: AdminService,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const collection = url.pathname === "/admin/api/installations";
    const route = /^\/admin\/api\/installations\/([^/]+)(?:\/(onboarding|lifecycle|reset))?$/.exec(url.pathname);
    if (!collection && !route) return null;
    if (!await this.access.allows(request)) {
      return new Response("Forbidden", { status: 403, headers: noStoreHeaders({ "content-type": "text/plain; charset=utf-8" }) });
    }
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Not Found" }, 404);
    if (request.method === "POST" && !hasExpectedOrigin(request, this.origin)) return json({ error: "Forbidden" }, 403);
    try {
      if (collection) {
        if (request.method === "GET") return json(await this.service.listInstallations(readInstallationListQuery(url)));
        const body = await readJsonObject(request);
        return json(await this.service.create({
          operationId: requireString(body.operationId, "operationId"), handle: requireString(body.handle, "handle"),
        }), 201);
      }
      if (!route) return null;
      let installationId: string;
      try { installationId = decodeURIComponent(route[1]); }
      catch { throw new Error("installationId is invalid"); }
      const action = route[2];
      if (request.method === "GET" && !action) {
        const installation = await this.service.getInstallation(installationId);
        return installation ? json(installation) : json({ error: "Not Found" }, 404);
      }
      if (request.method === "POST") {
        if (action === "onboarding") return json(await this.service.reissueOnboarding(installationId));
        if (action === "lifecycle") {
          const { state } = await readJsonObject(request);
          if (state !== "active" && state !== "restricted") throw new Error("installation state is invalid");
          await this.service.setInstallationState(installationId, state);
          return json({ installationId, state });
        }
        if (action === "reset") {
          const body = await readJsonObject(request);
          return json(await this.service.resetInstallation(installationId, {
            operationId: requireString(body.operationId, "operationId"),
            confirmHandle: requireString(body.confirmHandle, "confirmHandle"),
          }), 201);
        }
      }
      return json({ error: "Not Found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (["handle ", "installation", "operationId ", "request ", "JSON ", "query ", "state ", "page "]
        .some((prefix) => message.startsWith(prefix))) return json({ error: message }, 400);
      return json({ error: "The operator request could not be completed." }, 503);
    }
  }
}

export function readInstallationListQuery(url: URL): AdminInstallationListQuery {
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query.length > 100) throw new Error("query is too long");
  const stateValue = url.searchParams.get("state")?.trim() ?? "";
  const state = stateValue ? ADMIN_VISIBLE_INSTALLATION_STATES.find((value) => value === stateValue) : undefined;
  if (stateValue && !state) throw new Error("state is invalid");
  const pageValue = url.searchParams.get("page")?.trim() ?? "";
  if (pageValue && !/^[1-9]\d*$/.test(pageValue)) throw new Error("page is invalid");
  const page = pageValue ? Number(pageValue) : 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error("page is invalid");
  return { query, state: state ?? null, page };
}
