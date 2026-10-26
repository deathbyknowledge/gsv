import { installationDeletionManifestSchema, installationDeletionEvidenceSchema } from "./deletion-inventory";
import { z } from "zod";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { installationDeletionInventoryImportSchema } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { accountsDeletionInspectionSchema } from "./deletion-inspections";
import { operatorResourceAttestationSchema } from "./operator-resource-contracts";
import type { AccountsDeletionRuntime } from "./deletion-runtime";
import { AdminForbiddenError, type InstallationAdminAccess } from "./admin/access";
import type { AdminAuditRecorder } from "./admin/insight";
import { readConfirmedAction, UnconfirmedActionError } from "./admin/api";
import { hasExpectedOrigin, noStoreHeaders, readJsonObject, readRequestBody, requireString, type JsonObject, type JsonValue } from "./http";

/** What retiring a Ship, the first step of deleting it, does to its person; a refused retirement says it. */
const RETIRE_CONSEQUENCES: readonly string[] = [
  "The person's Ship stops at once, for good, and nothing replaces it: sessions, devices, messengers and background work end, and it can't be reactivated.",
  "Their public profile and records stop being served, and leave the open network when deletion erases the Ship's data and tombstones its DID. Their contacts end then.",
  "Nothing is erased yet: retiring is the first step of deleting the Ship, and erasure starts only when the deletion begins.",
];

/** Deletion control uses the existing operator authentication and mutation origin. */
export class InstallationDeletionHttp {
  constructor(
    private readonly runtime: AccountsDeletionRuntime,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly audited: AdminAuditRecorder = async (_request, _action, mutation) => await mutation(),
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const route = /^\/admin\/api\/installations\/([^/]+)\/deletion(?:\/(retire|inventory|retry|inspect|inspection|import|operator-resources))?$/.exec(new URL(request.url).pathname);
    if (!route) return null;
    if (!await this.access.allows(request)) return json({ error: "Forbidden" }, 403);
    if (request.method !== "POST") return await this.route(request, route);
    if (!hasExpectedOrigin(request, this.origin)) return json({ error: "Forbidden" }, 403);
    let installationId: string;
    try { installationId = decodeURIComponent(route[1]!); }
    catch { return await this.route(request, route); }
    let body: JsonObject | undefined;
    let reason: string | undefined;
    if (route[2] === "retire") {
      // Its audit row keeps the reason, so the request is read and checked before the row is written.
      try {
        body = await readJsonObject(request);
        reason = readConfirmedAction(body).reason;
      } catch (error) {
        return deletionFailure(error instanceof Error ? error : new Error("request failed"));
      }
    }
    try {
      return await this.audited(request, { name: `ship.deletion.${route[2] ?? "begin"}`, installationId, reason },
        () => this.route(request, route, body), (response) => ({ refused: !response.ok }));
    } catch (error) {
      if (error instanceof AdminForbiddenError) return json({ error: "Forbidden" }, 403);
      // route() answers its own failures, so this is the audit record itself failing.
      console.warn("[Operator] Admin request failed:", new URL(request.url).pathname, exceptionDiagnostics(error));
      return json({ error: "The operator request could not be completed." }, 503);
    }
  }

  private async route(request: Request, route: RegExpExecArray, read?: JsonObject): Promise<Response> {
    try {
      const installationId = decodeURIComponent(route[1]);
      const action = route[2];
      if (action === "operator-resources") {
        const resources = this.runtime.operatorResources;
        if (!resources) return json({ error: "installation operator resources are not configured" }, 503);
        if (request.method === "GET") return json(await resources.inspect(installationId));
        if (request.method !== "POST") return json({ error: "Not Found" }, 404);
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("JSON body is required");
        const input = operatorResourceAttestationSchema.parse(JSON.parse(new TextDecoder().decode(await readRequestBody(request, 512 * 1024))));
        return json(await resources.record(installationId, input), 201);
      }
      if (request.method === "GET" && !action) return json(await this.runtime.status(installationId));
      if (request.method !== "POST") return json({ error: "Not Found" }, 404);
      if (action === "inspection") return json(await this.runtime.openInspection(installationId), 201);
      if (action === "retry") return json(await this.runtime.retry(installationId));
      if (action === "inventory") {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("JSON body is required");
        const input = z.union([installationDeletionManifestSchema, z.strictObject({ manifest: installationDeletionManifestSchema,
          evidence: installationDeletionEvidenceSchema })]).parse(JSON.parse(new TextDecoder().decode(await readRequestBody(request, 18 * 1024 * 1024))));
        const result = "manifest" in input
          ? await this.runtime.registerInventory(installationId, input.manifest, input.evidence)
          : await this.runtime.registerInventory(installationId, input);
        return json(result, result.outcome === "verified" ? 201 : 409);
      }
      if (action === "import") {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("JSON body is required");
        const input = installationDeletionInventoryImportSchema.parse(JSON.parse(new TextDecoder().decode(await readRequestBody(request, 1_000_000))));
        return json(await this.runtime.importInventory(installationId, input));
      }
      if (action === "inspect") {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("JSON body is required");
        const input = accountsDeletionInspectionSchema.parse(JSON.parse(new TextDecoder().decode(await readRequestBody(request, 256 * 1024))));
        return json(await this.runtime.inspect(installationId, input));
      }
      const body = read ?? await readJsonObject(request);
      if (action === "retire") return json(await this.runtime.retire(installationId, readConfirmedAction(body).input));
      const operationId = requireString(body.operationId, "operationId");
      return json(await this.runtime.begin(installationId, { operationId, inventorySha256: requireString(body.inventorySha256, "inventorySha256") }), 201);
    } catch (error) {
      return deletionFailure(error instanceof Error ? error : new Error("request failed"));
    }
  }
}

function deletionFailure(error: Error): Response {
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) {
    return json({ error: "request deletion payload is invalid" }, 400);
  }
  if (error instanceof UnconfirmedActionError) return json({ error: error.message, consequences: [...RETIRE_CONSEQUENCES] }, 400);
  const message = error.message;
  if (["installation", "operationId ", "handle ", "request ", "JSON ", "inventorySha256 "].some((prefix) => message.startsWith(prefix))) {
    return json({ error: message }, message.includes("missing-inventory") ? 409 : 400);
  }
  return json({ error: "The deletion request could not be completed." }, 503);
}

function json(value: JsonValue, status = 200): Response {
  return Response.json(value, { status, headers: noStoreHeaders() });
}
