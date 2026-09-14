import { z } from "zod";
import {
  installationDeletionInspectionResultSchema,
  installationResourceKindSchema,
  type InstallationDeletionDiscoveryService,
  type InstallationDeletionInspection,
  type InstallationDeletionInspectionResult,
} from "@humansandmachines/gsv/services/lifecycle-discovery";

type InspectionService = Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion">
  & Partial<Pick<InstallationDeletionDiscoveryService, "importInstallationDeletionInventory">>;
export const accountsDeletionNamespacesSchema = z.record(z.string().regex(/^[a-f0-9]{32}$/), z.strictObject({
  ownerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), kind: installationResourceKindSchema,
}));
export type AccountsDeletionNamespaces = z.infer<typeof accountsDeletionNamespacesSchema>;
export type AccountsDeletionDiscovery = {
  gateway?: InstallationDeletionDiscoveryService;
  owners?: Readonly<Record<string, InspectionService>>;
  namespaces?: AccountsDeletionNamespaces;
};

/** Deployment chooses each owner binding; an operator supplies only physical resource identities. */
export async function inspectDeletionResources(
  request: InstallationDeletionInspection,
  configuration: AccountsDeletionDiscovery,
): Promise<InstallationDeletionInspectionResult> {
  const groups = new Map<InspectionService, InstallationDeletionInspection["resources"]>();
  for (const resource of request.resources) {
    const namespace = resource.namespaceId ? configuration.namespaces?.[resource.namespaceId] : undefined;
    if (resource.namespaceId && (!namespace || namespace.kind !== resource.kind)) {
      throw new Error("installation inspection namespace is not configured for this resource kind");
    }
    let owner: InspectionService | undefined;
    const requireOwner = (ids: readonly string[]) => {
      if (namespace && !ids.includes(namespace.ownerId)) throw new Error("installation inspection namespace owner does not match its resource kind");
    };
    switch (resource.kind) {
      case "kernel": case "process": case "conversation":
        requireOwner(["gateway"]);
        owner = configuration.gateway;
        break;
      case "ripgit":
        requireOwner(["gateway", "ripgit"]);
        owner = configuration.gateway;
        break;
      case "inference-executor": case "inference-installation":
        requireOwner(["inference"]);
        owner = configuration.owners?.inference;
        break;
      case "mail":
        requireOwner(["mail"]);
        owner = configuration.owners?.mail;
        break;
      default: {
        if (!namespace || namespace.kind !== resource.kind) throw new Error("installation inspection namespace is not configured for this resource kind");
        owner = configuration.owners?.[namespace.ownerId];
      }
    }
    if (!owner) throw new Error("installation deletion discovery is not configured for this owner");
    const resources = groups.get(owner) ?? [];
    resources.push(resource);
    groups.set(owner, resources);
  }
  const results = await Promise.all([...groups].map(async ([owner, resources]) => {
    const result = installationDeletionInspectionResultSchema.parse(await owner.inspectInstallationDeletion({ ...request, resources }));
    if (result.installationId !== request.installationId || result.observations.length !== resources.length) {
      throw new Error("installation inspection response does not match");
    }
    const seen = new Set<string>();
    for (const observation of result.observations) {
      const key = resourceKey(observation);
      if (seen.has(key) || !resources.some((resource) => resourceKey(resource) === key)) {
        throw new Error("installation inspection response does not match");
      }
      seen.add(key);
    }
    return result.observations;
  }));
  const observations = results.flat();
  return { installationId: request.installationId, observations: request.resources.map((resource) =>
    observations.find((observation) => resourceKey(observation) === resourceKey(resource))!) };
}

function resourceKey(resource: InstallationDeletionInspection["resources"][number]): string {
  return JSON.stringify([resource.namespaceId ?? null, resource.kind, resource.objectId]);
}
