import { AccountsDeletionInspections } from "./deletion-inspections";
import type { AccountsDeletionEnvironment } from "./deletion-runtime";
import type { InstallationDeletionManifest } from "./deletion-inventory";
import { createInstallationDeletionInventoryResolver, type OperatorDeletionInventory } from "../../../deployment/src/installation-deletion-resolver.ts";
import type { DeletionResourceObservation } from "../../../deployment/src/installation-deletion-evidence.ts";
import { AccountsOperatorResources } from "./operator-resources";

type ScopedResource = Pick<InstallationDeletionManifest["owners"][number]["resources"][number], "kind" | "namespace">;
export type DeletionResourceEnvironment = AccountsDeletionEnvironment & {
  /** Deployment declares every current or historical owner and its non-DO storage. */
  DELETION_RESOURCE_SCOPES?: Record<string, ScopedResource[]>;
  DELETION_ADDITIONAL_EVIDENCE?: Pick<OperatorDeletionInventory, "verifyAdditionalEvidence">;
};

/** Uses bounded server-side observations; registration does not invoke thousands of objects again. */
export function configuredDeletionEnvironment(db: D1Database, env: DeletionResourceEnvironment): AccountsDeletionEnvironment {
  const additionalEvidence = env.DELETION_ADDITIONAL_EVIDENCE ?? (env.OPERATOR_DELETION_CATALOG
    ? new AccountsOperatorResources(db, env.OPERATOR_DELETION_CATALOG) : undefined);
  if (env.DELETION_INVENTORY || !env.DELETION_RESOURCE_SCOPES || !additionalEvidence) return env;
  const namespaces = env.DELETION_DISCOVERY_NAMESPACES ?? {};
  const scopes = env.DELETION_RESOURCE_SCOPES;
  const inspections = new AccountsDeletionInspections(db);
  return { ...env, DELETION_INVENTORY: createInstallationDeletionInventoryResolver({
    namespaces: Object.entries(namespaces).map(([namespaceId, owner]) => ({ namespaceId, ownerId: owner.ownerId, className: owner.kind })),
    resources: (installationId) => Object.fromEntries(Object.entries(scopes).map(([owner, resources]) => [owner,
      resources.map((resource) => ({ ...resource, resourceId: resource.kind === "r2" ? `installations/${encodeURIComponent(installationId)}/` : installationId })),
    ])),
    verifyAdditionalEvidence: (input) => additionalEvidence.verifyAdditionalEvidence(input),
    createProbe: async (epoch) => ({
      async inspect(input) {
        const owner = namespaces[input.namespaceId];
        if (!owner || owner.ownerId !== input.ownerId || owner.kind !== input.className) throw new Error("Installation deletion namespace ownership changed");
        const observations = await inspections.read({ ...epoch, namespaceId: input.namespaceId, kind: owner.kind,
          objectIds: input.objectIds, beforeCapturedAt: input.beforeCapturedAt, afterCapturedAt: input.afterCapturedAt });
        return observations.map(({ objectId, outcome, installationId, name }) => {
          const observation: DeletionResourceObservation = { objectId, outcome };
          if (installationId) observation.installationId = installationId;
          if (name) observation.name = name;
          return observation;
        });
      },
    }),
  }) };
}
