import { z } from "zod";
import type { InstallationDeletionInventoryResolver, InstallationDeletionManifest } from "../../workers/installations/src/deletion-inventory.ts";
import {
  installationDeletionEvidenceSchema,
  validateInstallationDeletionEvidence,
  type DeletionNamespaceOwner,
  type DeletionResourceProbe,
} from "./installation-deletion-evidence.ts";

const snapshotIndex = z.strictObject({ capturedAt: z.number().int().positive(), pages: z.array(z.string().min(1)).min(1) });
const artifactValueSchema = z.json();
type DeletionArtifactValue = z.infer<typeof artifactValueSchema>;
export const installationDeletionEvidenceIndexSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("cloudflare-durable-objects"),
  installationId: z.string().min(1), capturedAt: z.number().int().positive(),
  namespaces: z.array(z.strictObject({
    namespaceId: z.string().regex(/^[a-f0-9]{32}$/), ownerId: z.string().min(1),
    before: snapshotIndex, after: snapshotIndex, observations: z.array(z.string().min(1)),
  })).min(1),
});
export type InstallationDeletionEvidenceIndex = z.infer<typeof installationDeletionEvidenceIndexSchema>;
type ManifestResource = InstallationDeletionManifest["owners"][number]["resources"][number];

export type OperatorDeletionInventory = {
  namespaces: readonly DeletionNamespaceOwner[];
  /** Includes previously enabled owners until their historical state is accounted for. */
  resources(installationId: string): Readonly<Record<string, readonly ManifestResource[]>>;
  probe: DeletionResourceProbe;
};

/**
 * The authenticated operator supplies captured Cloudflare pages. Deployment-owned
 * resource scopes and live owner probes verify their contents; no Cloudflare
 * credential or caller-supplied completeness assertion enters this service.
 */
export function createInstallationDeletionInventoryResolver(
  configuration: OperatorDeletionInventory,
  clock: () => number = Date.now,
): InstallationDeletionInventoryResolver {
  return {
    async verifyInstallationDeletionInventory(input) {
      const missing = { installationId: input.manifest.installationId, sha256: input.sha256,
        outcome: "missing-inventory" as const, verifiedAt: clock() };
      const records = input.evidence ?? [];
      const artifacts = new Map(records.map((record) => [record.reference, record]));
      if (artifacts.size !== records.length) return missing;
      const declared = new Map(input.manifest.owners.flatMap((owner) => owner.evidence).map((record) => [record.reference, record.sha256]));
      for (const record of records) {
        if (declared.get(record.reference) !== record.sha256 || await sha256(record.body) !== record.sha256) return missing;
      }
      const indexes = records.flatMap((record) => {
        let value: unknown;
        try { value = JSON.parse(record.body); } catch { return []; }
        const parsed = installationDeletionEvidenceIndexSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
      if (indexes.length !== 1) return missing;
      const index = indexes[0];
      if (index.installationId !== input.manifest.installationId || index.capturedAt > input.manifest.capturedAt) return missing;
      const scopes = configuration.resources(input.manifest.installationId);
      if (JSON.stringify(Object.keys(scopes).sort()) !== JSON.stringify(input.manifest.owners.map((owner) => owner.id).sort())) return missing;
      for (const owner of input.manifest.owners) {
        if (keys(owner.resources.filter((resource) => resource.kind !== "durable-object")) !== keys(scopes[owner.id])) return missing;
      }
      const read = (reference: string): DeletionArtifactValue => {
        const artifact = artifacts.get(reference);
        if (!artifact) throw new Error("Deletion discovery evidence is missing an artifact");
        return artifactValueSchema.parse(JSON.parse(artifact.body));
      };
      const evidence = installationDeletionEvidenceSchema.parse({
        version: 1, installationId: index.installationId, capturedAt: index.capturedAt,
        namespaces: index.namespaces.map((namespace) => ({
          namespaceId: namespace.namespaceId, ownerId: namespace.ownerId,
          before: { capturedAt: namespace.before.capturedAt, pages: namespace.before.pages.map(read) },
          after: { capturedAt: namespace.after.capturedAt, pages: namespace.after.pages.map(read) },
          observations: namespace.observations.flatMap((reference) => {
            const observations = read(reference);
            if (!Array.isArray(observations)) throw new Error("Deletion observations must be an array");
            return observations;
          }),
        })),
      });
      const result = await validateInstallationDeletionEvidence(evidence, configuration.namespaces, input.manifest, configuration.probe);
      return { ...missing, outcome: result.outcome, verifiedAt: clock() };
    },
  };
}

function keys(resources: readonly ManifestResource[]): string {
  return JSON.stringify(resources.map((resource) => JSON.stringify([resource.kind, resource.namespace, resource.resourceId, resource.name ?? null])).sort());
}

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
