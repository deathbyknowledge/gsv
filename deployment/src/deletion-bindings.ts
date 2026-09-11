import type * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import type { InstallationDeletionInspection } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { GsvAdapterBinding } from "./runtime.ts";

export type GsvDeletionNamespace = {
  ownerId: string;
  worker: Cloudflare.Workers.Worker;
  binding: string;
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
      const id = physical[entry.binding];
      if (!id || !/^[a-f0-9]{32}$/.test(id)) throw new Error(`Deletion namespace is unavailable: ${entry.binding}`);
      if (result[id]) throw new Error(`Deletion namespace is declared twice: ${entry.binding}`);
      return { ...result, [id]: { ownerId: entry.ownerId, kind: entry.kind } };
    })), Output.literal<NamespaceCatalog>({}));
  return directory.bind(logicalId, {
    bindings: [{ type: "json", name: "DELETION_DISCOVERY_NAMESPACES", json: catalog }],
  });
}
