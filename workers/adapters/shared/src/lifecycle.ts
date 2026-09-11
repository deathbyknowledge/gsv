import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionService } from "../../../../packages/gsv/src/services/lifecycle.js";
import { installationDeletionInspectionSchema, installationDeletionInventoryImportSchema, type InstallationDeletionInspection, type InstallationDeletionInspectionResult, type InstallationDeletionInventoryImport, type InstallationDeletionInventoryImported, type InstallationResourceObservation } from "../../../../packages/gsv/src/services/lifecycle-discovery.js";
import type { InstallationDirectoryService } from "../../../../packages/gsv/src/services/directory.js";
import type { AdapterResourceInspection } from "./peer-retirement";

export interface AdapterDeletionResource extends InstallationDeletionService {
  inspectInstallationResource(installationId: string): Promise<AdapterResourceInspection>;
}
export interface AdapterDeletionCoordinator extends InstallationDeletionService {
  importInstallationDeletionInventory(input: InstallationDeletionInventoryImport): Promise<InstallationDeletionInventoryImported>;
  registeredResource(kind: Kind, objectId: string): Promise<InstallationDeletionInventoryImport["resources"][number] | null>;
  inspectInstallationResource(installationId: string): Promise<AdapterResourceInspection>;
}
export interface AdapterDeletionNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): Pick<AdapterDeletionResource, "inspectInstallationResource">;
}
type Kind = InstallationDeletionInspection["resources"][number]["kind"];

/** Shared authority policy; concrete Workers alone select their physical namespaces. */
export class AdapterLifecycle {
  constructor(private readonly options: {
    authority?: string;
    directory: InstallationDirectoryService;
    coordinator(installationId: string): AdapterDeletionCoordinator;
    coordinatorId(installationId: string): string;
    namespace(kind: Kind): AdapterDeletionNamespace | null;
  }) {}

  async quiesceInstallation(value: InstallationDeletionRequest) {
    const input = await this.authorize(value);
    return await this.options.coordinator(input.installationId).quiesceInstallation(input);
  }
  async eraseInstallation(value: InstallationDeletionRequest) {
    const input = await this.authorize(value);
    return await this.options.coordinator(input.installationId).eraseInstallation(input);
  }
  async installationDeletionStatus(value: InstallationDeletionRequest) {
    const input = await this.authorize(value);
    return await this.options.coordinator(input.installationId).installationDeletionStatus(input);
  }
  async importInstallationDeletionInventory(value: InstallationDeletionInventoryImport) {
    this.authority();
    const input = installationDeletionInventoryImportSchema.parse(value);
    await this.requireRetired(input.installationId, true);
    return await this.options.coordinator(input.installationId).importInstallationDeletionInventory(input);
  }
  async inspectInstallationDeletion(value: InstallationDeletionInspection): Promise<InstallationDeletionInspectionResult> {
    this.authority();
    const input = installationDeletionInspectionSchema.parse(value);
    await this.requireRetired(input.installationId, true);
    // Accounts invokes this empty probe before opening the capture epoch. The
    // named index must exist before either namespace enumeration is taken.
    await this.options.coordinator(input.installationId).inspectInstallationResource(input.installationId);
    const observations: InstallationResourceObservation[] = [];
    for (const resource of input.resources) {
      const observation: InstallationResourceObservation = { ...resource, outcome: "unidentified" };
      if (resource.kind === "adapter-installation") {
        for (const id of new Set([input.installationId, ...(input.candidateInstallationIds ?? [])])) {
          if (this.options.coordinatorId(id) !== resource.objectId || resource.name && resource.name !== id) continue;
          const resolved = await this.options.directory.resolveInstallation(id);
          if (!resolved.found || resolved.installationId !== id) continue;
          observation.name = id;
          observation.outcome = "identified";
          observation.installationId = id;
          break;
        }
      } else {
        const namespace = this.options.namespace(resource.kind);
        if (namespace && (!resource.name || namespace.idFromName(resource.name).toString() === resource.objectId)) {
          const result = await namespace.get(namespace.idFromString(resource.objectId)).inspectInstallationResource(input.installationId);
          const registered = result.outcome === "empty" || result.outcome === "unrelated"
            ? await this.options.coordinator(input.installationId).registeredResource(resource.kind, resource.objectId) : null;
          if (registered && namespace.idFromName(registered.name).toString() === resource.objectId && (!result.name || result.name === registered.name)) {
            observation.name = registered.name; observation.outcome = "identified"; observation.installationId = input.installationId;
          }
          else if (result.outcome === "empty") observation.outcome = "empty";
          else if (result.name && namespace.idFromName(result.name).toString() === resource.objectId && (!resource.name || result.name === resource.name)) {
            if (result.outcome === "unrelated") { observation.name = result.name; observation.outcome = "unrelated"; }
            else if (result.outcome === "identified" && result.installationId === input.installationId) {
              observation.name = result.name; observation.outcome = "identified"; observation.installationId = input.installationId;
            }
          }
        }
      }
      observations.push(observation);
    }
    return { installationId: input.installationId, observations };
  }

  private authority(): void { if (this.options.authority !== "installation-deletion") throw new Error("Adapter deletion binding authority is required"); }
  private async authorize(value: InstallationDeletionRequest): Promise<InstallationDeletionRequest> {
    this.authority();
    const input = installationDeletionRequestSchema.parse(value);
    await this.requireRetired(input.installationId);
    return input;
  }
  private async requireRetired(installationId: string, capture = false): Promise<void> {
    const result = await this.options.directory.resolveInstallation(installationId);
    if (!result.found || result.installationId !== installationId || !(capture ? ["retained"] : ["retained", "deleting", "deleted"]).includes(result.state)) throw new Error("Adapter deletion requires a retired installation");
  }
}
