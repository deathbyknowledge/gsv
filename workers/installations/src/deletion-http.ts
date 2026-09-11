import { installationDeletionManifestSchema, installationDeletionEvidenceSchema } from "./deletion-inventory";
import { z } from "zod";
import { installationDeletionInspectionSchema, installationDeletionInventoryImportSchema } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { AccountsDeletionRuntime } from "./deletion-runtime";
import type { InstallationAdminAccess } from "./admin/access";
import { hasExpectedOrigin, noStoreHeaders, readJsonObject, readRequestBody, requireString, type JsonValue } from "./http";

/** Deletion control uses the existing operator authentication and mutation origin. */
export class InstallationDeletionHttp {
  constructor(private readonly runtime: AccountsDeletionRuntime, private readonly access: InstallationAdminAccess, private readonly origin: string) {}

  async handle(request: Request): Promise<Response | null> {
    const route = /^\/admin\/api\/installations\/([^/]+)\/deletion(?:\/(retire|inventory|retry|inspect|import))?$/.exec(new URL(request.url).pathname);
    if (!route) return null;
    const json = (value: JsonValue, status = 200) => Response.json(value, { status, headers: noStoreHeaders() });
    if (!await this.access.allows(request)) return json({ error: "Forbidden" }, 403);
    if (request.method === "POST" && !hasExpectedOrigin(request, this.origin)) return json({ error: "Forbidden" }, 403);
    try {
      const installationId = decodeURIComponent(route[1]);
      const action = route[2];
      if (request.method === "GET" && !action) return json(await this.runtime.status(installationId));
      if (request.method !== "POST") return json({ error: "Not Found" }, 404);
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
      const body = await readJsonObject(request);
      if (action === "inspect") return json(await this.runtime.inspect(installationId, installationDeletionInspectionSchema.parse(body)));
      const operationId = requireString(body.operationId, "operationId");
      if (action === "retire") return json(await this.runtime.retire(installationId, { operationId, confirmHandle: requireString(body.confirmHandle, "confirmHandle") }));
      return json(await this.runtime.begin(installationId, { operationId, inventorySha256: requireString(body.inventorySha256, "inventorySha256") }), 201);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) {
        return json({ error: "request deletion payload is invalid" }, 400);
      }
      const message = error instanceof Error ? error.message : "";
      if (["installation", "operationId ", "handle ", "request ", "JSON ", "inventorySha256 "].some((prefix) => message.startsWith(prefix))) {
        return json({ error: message }, message.includes("missing-inventory") ? 409 : 400);
      }
      return json({ error: "The deletion request could not be completed." }, 503);
    }
  }
}
