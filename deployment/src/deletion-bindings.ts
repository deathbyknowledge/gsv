import type * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import type { InstallationDeletionInspection } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { GsvAdapterBinding } from "./runtime.ts";
import type { InstallationDeletionManifest } from "../../workers/installations/src/deletion-inventory.ts";
import { OPERATOR_RESOURCE_OWNER, operatorResourceCatalogSchema, type OperatorResourceCatalog } from "../../workers/installations/src/operator-resource-contracts.ts";
export type { OperatorResourceCatalog } from "../../workers/installations/src/operator-resource-contracts.ts";

export type GsvDeletionNamespace = {
  ownerId: string;
  worker: Cloudflare.Workers.Worker;
  className: string;
  kind: InstallationDeletionInspection["resources"][number]["kind"];
};
type NamespaceCatalog = Record<string, Pick<GsvDeletionNamespace, "ownerId" | "kind">>;

export function gsvAdapterDeletionNamespaces(adapters: readonly GsvAdapterBinding[]): GsvDeletionNamespace[] {
  return adapters.flatMap((adapter) => {
    if (!adapter.lifecycle) throw new Error(`Adapter ${adapter.id} has no lifecycle inventory`);
    return adapter.lifecycle.namespaces.map((namespace) => ({ ...namespace, ownerId: adapter.id, worker: adapter.worker }));
  });
}

/** Physical namespace IDs come from the adopted Worker outputs, never operator-entered IDs. */
export function GsvDeletionDiscoveryBindings(
  logicalId: string,
  directory: Cloudflare.Workers.Worker,
  namespaces: readonly GsvDeletionNamespace[],
) {
  const catalog = namespaces.reduce<Output.Output<NamespaceCatalog>>((previous, entry) =>
    Output.all(previous, entry.worker.durableObjectNamespaces).pipe(Output.map(([result, physical]) => {
      const id = physical[entry.className];
      if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error(`Deletion namespace is unavailable: ${entry.className}`);
      if (result[id]) throw new Error(`Deletion namespace is declared twice: ${entry.className}`);
      return { ...result, [id]: { ownerId: entry.ownerId, kind: entry.kind } };
    })), Output.literal<NamespaceCatalog>({}));
  return directory.bind(logicalId, {
    bindings: [{ type: "json", name: "DELETION_DISCOVERY_NAMESPACES", json: catalog }],
  });
}

type ManifestResource = InstallationDeletionManifest["owners"][number]["resources"][number];
export type GsvDeletionResourceScopes = Record<string, {
  kind: Exclude<ManifestResource["kind"], "durable-object">; namespace: string;
}[]>;

/** Declares ownership only. External cleanup remains unknown until the operator records scoped evidence. */
export function GsvDeletionResourceBindings(
  logicalId: string,
  directory: Cloudflare.Workers.Worker,
  applicationScopes: GsvDeletionResourceScopes | Output.Output<GsvDeletionResourceScopes>,
  operatorResources: OperatorResourceCatalog,
) {
  const catalog = operatorResourceCatalogSchema.parse(operatorResources);
  const scopes = Output.asOutput(applicationScopes).pipe(Output.map((owners) => {
    if (!["accounts", "gateway", "inference"].every((owner) => owner in owners) || OPERATOR_RESOURCE_OWNER in owners) {
      throw new Error("Deletion scopes require the application owners and a separately declared operator catalog");
    }
    for (const resources of Object.values(owners)) for (const resource of resources) {
      if (resource.kind === "r2" && !catalog.some((entry) => entry.source === "cloudflare-r2-multipart" && entry.namespace === resource.namespace)) {
        throw new Error("Deletion inventory must account for multipart uploads in every application bucket");
      }
    }
    return { ...owners, [OPERATOR_RESOURCE_OWNER]: catalog.map(({ kind, namespace }) => ({ kind, namespace })) };
  }));
  return directory.bind(logicalId, { bindings: [
    { type: "json", name: "DELETION_RESOURCE_SCOPES", json: scopes },
    { type: "json", name: "OPERATOR_DELETION_CATALOG", json: catalog },
  ] });
}
