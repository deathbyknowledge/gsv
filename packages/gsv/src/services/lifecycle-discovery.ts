import { z } from "zod";

export const installationResourceKindSchema = z.enum([
  "kernel", "process", "conversation", "ripgit", "mail",
  "adapter-peer", "adapter-pairing", "adapter-account", "adapter-application", "adapter-installation", "inference-executor", "inference-installation",
]);
const objectId = z.string().regex(/^[a-f0-9]{64}$/);
const installationId = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/);
export const installationResourceProbeSchema = z.strictObject({
  kind: installationResourceKindSchema, objectId, namespaceId: z.string().regex(/^[a-f0-9]{32}$/).optional(), name: z.string().min(1).max(1024).optional(),
});
export const installationDeletionInspectionSchema = z.strictObject({
  installationId, resources: z.array(installationResourceProbeSchema).max(32),
  candidateInstallationIds: z.array(installationId).max(500).optional(),
});
export const installationResourceObservationSchema = installationResourceProbeSchema.extend({
  // "unrelated" is target-relative: understood shared records contain no data owned by the requested installation.
  outcome: z.enum(["identified", "empty", "unrelated", "unidentified"]),
  installationId: installationId.optional(), localId: z.string().min(1).max(1024).optional(),
});
export const installationDeletionInspectionResultSchema = z.strictObject({
  installationId, observations: z.array(installationResourceObservationSchema).max(32),
});
export const installationDeletionInventoryImportSchema = z.strictObject({
  installationId,
  discoverySha256: z.string().regex(/^[a-f0-9]{64}$/),
  resources: z.array(installationResourceProbeSchema.required({ name: true })).max(10_000),
});

export type InstallationDeletionInspection = z.infer<typeof installationDeletionInspectionSchema>;
export type InstallationDeletionInspectionResult = z.infer<typeof installationDeletionInspectionResultSchema>;
export type InstallationResourceObservation = z.infer<typeof installationResourceObservationSchema>;
export type InstallationDeletionInventoryImport = z.infer<typeof installationDeletionInventoryImportSchema>;
export type InstallationDeletionInventoryImported = {
  installationId: string; discoverySha256: string; outcome: "verified" | "missing-inventory"; verifiedAt: number;
};

/** Accounts authorizes imports only from an already verified, registered owner manifest. */
export interface InstallationDeletionDiscoveryService {
  inspectInstallationDeletion(input: InstallationDeletionInspection): Promise<InstallationDeletionInspectionResult>;
  importInstallationDeletionInventory(input: InstallationDeletionInventoryImport): Promise<InstallationDeletionInventoryImported>;
}
