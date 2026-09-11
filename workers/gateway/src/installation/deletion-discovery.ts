import {
  installationDeletionInspectionSchema,
  installationDeletionInventoryImportSchema,
  type InstallationDeletionInspection,
  type InstallationDeletionInspectionResult,
  type InstallationDeletionInventoryImport,
  type InstallationDeletionInventoryImported,
  type InstallationResourceObservation,
} from "@humansandmachines/gsv/services/lifecycle-discovery";
import { z } from "zod";
import type { GatewayEnv } from "../runtime-env";
import { conversationDurableObjectName, parseConversationDurableObjectName, parseProcessDurableObjectName, processDurableObjectName } from "./routing";
import { parseManagedInstallationId } from "./identity";
import type { ResourceStorageInspection } from "./retirement";

const ripgitInspectionSchema = z.strictObject({ empty: z.boolean(), name: z.string().optional() });

/** All calls originate from the authenticated operator surface through its trusted binding. */
export class GatewayDeletionDiscovery {
  constructor(private readonly env: GatewayEnv) {}

  async inspect(input: InstallationDeletionInspection): Promise<InstallationDeletionInspectionResult> {
    const request = installationDeletionInspectionSchema.parse(input);
    for (const resource of request.resources) assertGatewayResource(resource.kind);
    const candidates = [...new Set([request.installationId, ...(request.candidateInstallationIds ?? [])])];
    const observations: InstallationResourceObservation[] = [];
    for (const resource of request.resources) {
      const observation: InstallationResourceObservation = { kind: resource.kind, objectId: resource.objectId, outcome: "unidentified" };
      if (resource.namespaceId) observation.namespaceId = resource.namespaceId;
      let evidence: ResourceStorageInspection;
      let name = resource.name;
      if (resource.kind === "ripgit") {
        if (!this.env.RIPGIT) { observations.push(observation); continue; }
        const response = await this.env.RIPGIT.fetch("https://ripgit.invalid/.gsv/discovery/inspect", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(resource),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error("Ripgit discovery failed"); }
        evidence = ripgitInspectionSchema.parse(await response.json());
      } else {
        const namespace = resource.kind === "kernel" ? this.env.KERNEL : resource.kind === "process" ? this.env.PROCESS : this.env.CONVERSATION;
        const id = namespace.idFromString(resource.objectId);
        if (name && !namespace.idFromName(name).equals(id)) { observations.push(observation); continue; }
        if (resource.kind === "kernel") {
          name ??= candidates.find((candidate) => namespace.idFromName(candidate).equals(id));
          if (!name) { observations.push(observation); continue; }
          evidence = await this.env.KERNEL.getByName(name).inspectInstallationResource();
        } else if (resource.kind === "process") {
          evidence = await this.env.PROCESS.get(id).inspectInstallationResource();
          if (!name && evidence.localId) {
            const localId = evidence.localId;
            name = [...candidates.map((installationId) => processDurableObjectName(installationId, localId)), localId]
              .find((candidate) => namespace.idFromName(candidate).equals(id));
          }
        } else {
          evidence = await this.env.CONVERSATION.get(id).inspectInstallationResource();
          if (!name && evidence.localId) {
            const localId = evidence.localId;
            name = [...candidates.map((installationId) => conversationDurableObjectName(installationId, localId)), localId]
              .find((candidate) => namespace.idFromName(candidate).equals(id));
          }
        }
        if (evidence.name && !namespace.idFromName(evidence.name).equals(id)) throw new Error("Stored resource identity does not match physical address");
      }
      if (name && evidence.name && name !== evidence.name) throw new Error("Discovery conflicts with stored resource identity");
      name ??= evidence.name;
      if (evidence.localId) observation.localId = evidence.localId;
      if (name) {
        observation.name = name;
        observation.installationId = resourceInstallation(resource.kind, name);
        observation.outcome = "identified";
      } else if (evidence.empty) observation.outcome = "empty";
      observations.push(observation);
    }
    return { installationId: request.installationId, observations };
  }

  async import(input: InstallationDeletionInventoryImport): Promise<InstallationDeletionInventoryImported> {
    const request = installationDeletionInventoryImportSchema.parse(input);
    for (const resource of request.resources) assertGatewayResource(resource.kind);
    // Accounts has already matched this entire list/hash to a verified manifest. A retry resumes the durable cursor.
    const kernel = this.env.KERNEL.getByName(request.installationId);
    const batch = await kernel.beginInstallationResourceInventory(request);
    if (batch.sealed) return { installationId: request.installationId, discoverySha256: request.discoverySha256, outcome: "verified", verifiedAt: Date.now() };
    const inspected = await this.inspect({ installationId: request.installationId, resources: batch.resources });
    if (inspected.observations.some((item) => item.outcome !== "identified" || item.installationId !== request.installationId)) {
      return { installationId: request.installationId, discoverySha256: request.discoverySha256, outcome: "missing-inventory", verifiedAt: Date.now() };
    }
    for (const resource of batch.resources) {
      if (resource.kind === "process") {
        const stub = this.env.PROCESS.get(this.env.PROCESS.idFromString(resource.objectId));
        await this.attach(() => stub.attachInstallationResourceIdentity(resource.name), () => this.env.PROCESS.get(this.env.PROCESS.idFromString(resource.objectId)).inspectInstallationResource(), resource.name);
      } else if (resource.kind === "conversation") {
        const stub = this.env.CONVERSATION.get(this.env.CONVERSATION.idFromString(resource.objectId));
        await this.attach(() => stub.attachInstallationResourceIdentity(resource.name), () => this.env.CONVERSATION.get(this.env.CONVERSATION.idFromString(resource.objectId)).inspectInstallationResource(), resource.name);
      }
    }
    const repositories = batch.resources.filter((resource) => resource.kind === "ripgit");
    if (this.env.RIPGIT && repositories.length) {
      const response = await this.env.RIPGIT.fetch("https://ripgit.invalid/.gsv/discovery/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: request.installationId, names: repositories.map((resource) => resource.name) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Ripgit inventory import failed"); }
      await response.body?.cancel();
    }
    return kernel.completeInstallationResourceInventoryBatch({ discoverySha256: request.discoverySha256, cursor: batch.cursor });
  }

  private async attach(adopt: () => Promise<void>, inspect: () => Promise<ResourceStorageInspection>, name: string): Promise<void> {
    try { await adopt(); } catch { /* Adopting a nameless instance persists identity and restarts the object. */ }
    if ((await inspect()).name !== name) throw new Error("Resource identity adoption did not complete");
  }
}

export function resourceInstallation(kind: InstallationResourceObservation["kind"], name: string): string {
  assertGatewayResource(kind);
  if (kind === "process") return parseProcessDurableObjectName(name).installationId;
  if (kind === "conversation") return parseConversationDurableObjectName(name).installationId;
  if (kind === "ripgit") {
    if (name.startsWith("installation-index:")) return parseManagedInstallationId(name.slice("installation-index:".length));
    const parts = name.split("/");
    if (parts.length === 2) return "singleton";
    if (parts.length !== 3) throw new Error("Invalid repository resource name");
    return parseManagedInstallationId(parts[0]);
  }
  return parseManagedInstallationId(name);
}

function assertGatewayResource(kind: string): asserts kind is "kernel" | "process" | "conversation" | "ripgit" {
  if (kind !== "kernel" && kind !== "process" && kind !== "conversation" && kind !== "ripgit") {
    throw new Error("Resource kind is not owned by Gateway");
  }
}
