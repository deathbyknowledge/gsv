import { ADMIN_VISIBLE_INSTALLATION_STATES, type AdminInstallationListQuery } from "../administration";
import { hasExpectedOrigin, json, noStoreHeaders, readJsonObject, requireString, type JsonValue } from "../http";
import { AdminForbiddenError, type InstallationAdminAccess } from "./access";
import type { AdminAuditRecorder } from "./insight";
import { runTakedownAction, type ShipTakedowns } from "./takedowns";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { z } from "zod";

const operatorReasonSchema = z.string().max(500).nullish();
import { RESET_CONSEQUENCES, ShipFollowError, type InstallationAdminService } from "./service";

type AdminService = Pick<InstallationAdminService,
  "listInstallations" | "getInstallation" | "create" | "reissueOnboarding" | "resetInstallation" | "setInstallationState"
>;

/** Installation API admission is shared by the reference Worker and operator overlays. */
export class InstallationAdminApi {
  constructor(
    private readonly service: AdminService,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly audited: AdminAuditRecorder = async (_request, _action, mutation) => await mutation(),
    private readonly takedowns?: ShipTakedowns,
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const collection = url.pathname === "/admin/api/installations";
    const route = /^\/admin\/api\/installations\/([^/]+)(?:\/(onboarding|lifecycle|reset|takedowns|takedowns\/restore))?$/.exec(url.pathname);
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
        const input = { operationId: requireString(body.operationId, "operationId"), handle: requireString(body.handle, "handle") };
        const issued = await this.audited(request, { name: "ship.create" }, () => this.service.create(input),
          (result) => ({ installationId: result.installation.installationId }));
        return json(issued, 201);
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
      if (request.method === "GET" && action === "takedowns" && this.takedowns) {
        const repository = await this.takedowns.repository(installationId);
        return repository ? json(repository) : json({ error: "Not Found" }, 404);
      }
      if (request.method === "POST") {
        if (action === "onboarding") {
          const issued = await this.audited(request, { name: "ship.setup-link.reissue", installationId },
            () => this.service.reissueOnboarding(installationId));
          return json(issued);
        }
        if (action === "lifecycle") {
          const { state, reason: reasonValue } = await readJsonObject(request);
          if (state !== "active" && state !== "restricted") throw new Error("installation state is invalid");
          const reason = readOperatorReason(reasonValue);
          await this.audited(request, { name: state === "restricted" ? "ship.suspend" : "ship.reactivate", installationId, reason },
            () => this.service.setInstallationState(installationId, state));
          return json({ installationId, state });
        }
        if (action === "reset") {
          const { input, reason } = readConfirmedAction(await readJsonObject(request));
          const reset = await this.audited(request, { name: "ship.reset", installationId, reason },
            () => this.service.resetInstallation(installationId, input),
            (result) => ({ detail: { replacementInstallationId: result.installation.installationId } }));
          return json(reset, 201);
        }
        if ((action === "takedowns" || action === "takedowns/restore") && this.takedowns) {
          return json(await runTakedownAction(this.takedowns, this.audited, request, installationId,
            action === "takedowns" ? "takedown" : "restore", await readJsonObject(request)));
        }
      }
      return json({ error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof AdminForbiddenError) return json({ error: "Forbidden" }, 403);
      if (error instanceof UnconfirmedActionError) return json({ error: error.message, consequences: [...RESET_CONSEQUENCES] }, 400);
      const message = error instanceof Error ? error.message : "";
      if (["handle ", "installation", "operationId ", "request ", "JSON ", "query ", "state ", "page "]
        .some((prefix) => message.startsWith(prefix))) return json({ error: message }, 400);
      console.warn("[Operator] Admin request failed:", url.pathname, exceptionDiagnostics(error));
      return json({ error: error instanceof ShipFollowError ? error.message : "The operator request could not be completed." }, 503);
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

/**
 * A reset or retirement whose operator hasn't typed the Ship's handle or given
 * a reason; its refusal says what the action does.
 */
export class UnconfirmedActionError extends Error {}

/** A reset or retirement request, once its operator has typed the Ship's handle and given a reason. */
export function readConfirmedAction(values: { operationId?: JsonValue; confirmHandle?: JsonValue; reason?: JsonValue }) {
  const operationId = requireString(values.operationId, "operationId");
  const reason = readOperatorReason(values.reason)?.trim();
  if (!reason) throw new UnconfirmedActionError("request reason is required");
  const confirmHandle = values.confirmHandle;
  if (String(confirmHandle) !== confirmHandle || !confirmHandle) throw new UnconfirmedActionError("confirmHandle is required");
  return { input: { operationId, confirmHandle }, reason };
}

function readOperatorReason(value: JsonValue | undefined): string | null {
  const reason = operatorReasonSchema.safeParse(value);
  if (!reason.success) throw new Error("request reason is invalid");
  return reason.data ?? null;
}
