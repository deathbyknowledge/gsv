import { z } from "zod";

const objectId = z.string().regex(/^[a-f0-9]{64}$/);
const namespaceId = z.string().regex(/^[a-f0-9]{32}$/);
const timestamp = z.number().int().positive();
const objectSchema = z.strictObject({ id: objectId, hasStoredData: z.boolean() });
const enumerationSchema = z.strictObject({
  capturedAt: timestamp,
  pages: z.array(z.strictObject({
    requestedCursor: z.string().nullable(),
    response: z.object({
      success: z.literal(true), result: z.array(objectSchema).max(10_000),
      result_info: z.object({ count: z.number().int().nonnegative(), cursor: z.string() }),
    }),
  })).min(1).max(1000),
});
export const deletionResourceObservationSchema = z.strictObject({
  objectId,
  outcome: z.enum(["identified", "empty", "unidentified"]),
  installationId: z.string().min(1).max(200).optional(), name: z.string().min(1).max(1024).optional(),
});
export const installationDeletionEvidenceSchema = z.strictObject({
  version: z.literal(1), installationId: z.string().min(1).max(200), capturedAt: timestamp,
  namespaces: z.array(z.strictObject({
    namespaceId, ownerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    before: enumerationSchema, after: enumerationSchema,
    observations: z.array(deletionResourceObservationSchema).max(100_000),
  })).min(1).max(100),
});
export type InstallationDeletionEvidence = z.infer<typeof installationDeletionEvidenceSchema>;
export type DeletionResourceObservation = z.infer<typeof deletionResourceObservationSchema>;
export type DeletionNamespaceOwner = { namespaceId: string; ownerId: string; className: string };
export type DiscoveredDeletionResource = { ownerId: string; kind: "durable-object"; namespace: string; resourceId: string; name: string };
export type DeletionManifestForEvidence = {
  installationId: string;
  owners: { id: string; resources: { kind: string; namespace: string; resourceId: string; name?: string }[] }[];
};
export type InstallationDeletionEvidenceValidation = {
  scope: "durable-objects";
  installationId: string;
  outcome: "verified" | "missing-inventory";
  unidentifiedObjects: number;
  resources: DiscoveredDeletionResource[];
};
export interface DeletionResourceProbe {
  inspect(input: { namespaceId: string; ownerId: string; className: string; objectIds: string[] }): Promise<DeletionResourceObservation[]>;
}

/**
 * Validates complete authenticated operator evidence for the DO part of a manifest.
 * The caller owns artifact provenance and R2/D1/KV/queue/provider/backup evidence.
 * A trusted probe refreshes ownership when uploaded observations are not authoritative.
 */
export async function validateInstallationDeletionEvidence(
  input: InstallationDeletionEvidence,
  expected: readonly DeletionNamespaceOwner[],
  manifest: DeletionManifestForEvidence,
  probe?: DeletionResourceProbe,
): Promise<InstallationDeletionEvidenceValidation> {
  const evidence = installationDeletionEvidenceSchema.parse(input);
  if (evidence.installationId !== manifest.installationId) throw new Error("Deletion evidence installation mismatch");
  const configured = new Map(expected.map((item) => [item.namespaceId, item]));
  if (!configured.size || configured.size !== expected.length || configured.size !== evidence.namespaces.length) throw new Error("Deletion evidence namespace inventory mismatch");
  const seenNamespaces = new Set<string>();
  const resources: DiscoveredDeletionResource[] = [];
  let unidentifiedObjects = 0;
  for (const item of evidence.namespaces) {
    if (seenNamespaces.has(item.namespaceId) || configured.get(item.namespaceId)?.ownerId !== item.ownerId) throw new Error("Deletion evidence has an unconfigured or repeated namespace");
    seenNamespaces.add(item.namespaceId);
    if (item.before.capturedAt > item.after.capturedAt || item.after.capturedAt > evidence.capturedAt) throw new Error("Deletion evidence timestamps are out of order");
    const before = enumerate(item.before);
    const after = enumerate(item.after);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Deletion enumeration changed while ownership was being inspected");
    const stored = after.filter((object) => object.hasStoredData).map((object) => object.id);
    const observations: DeletionResourceObservation[] = [];
    if (probe) {
      for (let offset = 0; offset < stored.length; offset += 32) {
        const result = await probe.inspect({ namespaceId: item.namespaceId, ownerId: item.ownerId, className: configured.get(item.namespaceId)!.className, objectIds: stored.slice(offset, offset + 32) });
        observations.push(...result.map((observation) => deletionResourceObservationSchema.parse(observation)));
      }
    } else observations.push(...item.observations);
    const indexed = new Map(observations.map((observation) => [observation.objectId, observation]));
    if (indexed.size !== observations.length || indexed.size !== stored.length || stored.some((id) => !indexed.has(id))) throw new Error("Deletion observations do not cover exactly the stored objects");
    for (const observation of observations) {
      if (observation.outcome === "unidentified") { unidentifiedObjects += 1; continue; }
      if (observation.outcome === "empty") continue;
      if (!observation.installationId || !observation.name) throw new Error("Identified resource has no owned installation and name");
      if (observation.installationId === evidence.installationId) {
        resources.push({ ownerId: item.ownerId, kind: "durable-object", namespace: item.namespaceId, resourceId: observation.objectId, name: observation.name });
      }
    }
  }
  const expectedResources = manifest.owners.flatMap((owner) => owner.resources.filter((resource) => resource.kind === "durable-object").map((resource) => ({ ownerId: owner.id, ...resource })));
  const keys = (items: readonly { ownerId: string; namespace: string; resourceId: string; name?: string }[]) => items.map((item) => JSON.stringify([item.ownerId, item.namespace, item.resourceId, item.name])).sort();
  const actualKeys = keys(resources);
  const expectedKeys = keys(expectedResources);
  const complete = unidentifiedObjects === 0 && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && new Set(expectedKeys).size === expectedKeys.length;
  return { scope: "durable-objects", installationId: evidence.installationId, outcome: complete ? "verified" : "missing-inventory", unidentifiedObjects, resources };
}

function enumerate(snapshot: z.infer<typeof enumerationSchema>): z.infer<typeof objectSchema>[] {
  const objects = new Map<string, z.infer<typeof objectSchema>>();
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (const [index, page] of snapshot.pages.entries()) {
    if (page.requestedCursor !== cursor || page.response.result_info.count !== page.response.result.length) throw new Error("Cloudflare enumeration page chain is invalid");
    for (const object of page.response.result) {
      if (objects.has(object.id)) throw new Error("Cloudflare enumeration repeats an object");
      objects.set(object.id, object);
    }
    const next = page.response.result_info.cursor;
    if (!page.response.result.length) {
      if (next || index !== snapshot.pages.length - 1) throw new Error("Cloudflare enumeration has an invalid terminal page");
      return [...objects.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    if (!next || seenCursors.has(next)) throw new Error("Cloudflare enumeration is missing a continuation cursor");
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Cloudflare enumeration lacks a final empty page");
}
