import { z } from "zod";
import { installationDeletionInspectionSchema, installationDeletionInspectionResultSchema, installationResourceKindSchema } from "../../packages/gsv/src/services/lifecycle-discovery.ts";
import { installationDeletionEvidenceSchema, validateInstallationDeletionEvidence, type DeletionResourceObservation } from "./installation-deletion-evidence.ts";
import { installationDeletionEvidenceIndexSchema, type InstallationDeletionEvidenceIndex } from "./installation-deletion-resolver.ts";

const namespaceId = z.string().regex(/^[a-f0-9]{32}$/);
const objectId = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().positive();
const epochSchema = z.strictObject({ id: z.uuid(), installationId: z.string(), createdAt: timestamp });
const namespaceSchema = z.strictObject({ namespaceId, ownerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), className: z.string().min(1),
  kind: installationResourceKindSchema, names: z.record(objectId, z.string().min(1).max(1024)).optional() });
export const deletionCaptureConfigurationSchema = z.strictObject({ version: z.literal(1), accountId: namespaceId,
  accountsOrigin: z.string().url().refine((value) => { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }),
  installationId: z.string().min(1).max(200), candidateInstallationIds: z.array(z.string().min(1).max(200)).max(500),
  namespaces: z.array(namespaceSchema).min(1).max(100),
});
export type DeletionCaptureConfiguration = z.infer<typeof deletionCaptureConfigurationSchema>;
export const cloudflareDeletionObjectPageSchema = z.object({ success: z.literal(true),
  result: z.array(z.strictObject({ id: objectId, hasStoredData: z.boolean() })).max(1000),
  result_info: z.object({ count: z.number().int().nonnegative(), cursor: z.string() }),
});
const pageSchema = z.strictObject({ requestedCursor: z.string().nullable(), response: cloudflareDeletionObjectPageSchema });
const snapshotSchema = z.strictObject({ capturedAt: timestamp, pages: z.array(z.string()).min(1) });
export const deletionCaptureInspectionSchema = installationDeletionInspectionSchema.extend({ inspectionEpochId: z.uuid() });
export const deletionCaptureInspectionResultSchema = installationDeletionInspectionResultSchema.extend({ inspectionEpochId: z.uuid(), observedAt: timestamp });
export const deletionCaptureEpochSchema = epochSchema;
export type DeletionCaptureInspection = z.infer<typeof deletionCaptureInspectionSchema>;
export interface DeletionCaptureCloudflare {
  listObjects(input: { accountId: string; namespaceId: string; cursor: string | null; limit: 1000 }): Promise<z.infer<typeof cloudflareDeletionObjectPageSchema>>;
}
export interface DeletionCaptureAccounts {
  openInspection(installationId: string): Promise<z.infer<typeof epochSchema>>;
  inspect(input: DeletionCaptureInspection): Promise<z.infer<typeof deletionCaptureInspectionResultSchema>>;
}
/** Writes are atomic, immutable, and private. A successful write survives process interruption. */
export interface DeletionCaptureArtifacts {
  read(reference: string): Promise<string | null>;
  write(reference: string, body: string): Promise<void>;
}
export type DeletionCaptureArtifact = { reference: string; sha256: string; body: string };
export type DeletionCaptureResult = {
  scope: "durable-objects"; outcome: "captured"; installationId: string; inspectionEpochId: string;
  indexReference: string; storedObjects: number; unidentifiedObjects: number;
  resources: { ownerId: string; kind: "durable-object"; namespace: string; resourceId: string; name: string }[];
  evidence: DeletionCaptureArtifact[];
};
type Snapshot = z.infer<typeof snapshotSchema>;
type Enumeration = { snapshot: Snapshot; pages: z.infer<typeof pageSchema>[] };
type CapturedNamespace = InstallationDeletionEvidenceIndex["namespaces"][number];

/** Captures only DO evidence. It neither registers an inventory nor starts erasure. */
export async function captureInstallationDeletionObjects(input: {
  configuration: DeletionCaptureConfiguration; cloudflare: DeletionCaptureCloudflare; accounts: DeletionCaptureAccounts;
  artifacts: DeletionCaptureArtifacts; clock?: () => number;
}): Promise<DeletionCaptureResult> {
  const configuration = deletionCaptureConfigurationSchema.parse(input.configuration);
  if (new Set(configuration.namespaces.map((item) => item.namespaceId)).size !== configuration.namespaces.length) throw new Error("Capture repeats a namespace");
  const clock = input.clock ?? Date.now;
  const save = async (reference: string, body: string): Promise<void> => {
    if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error("Capture artifact exceeds the per-part limit");
    await input.artifacts.write(reference, body);
  };
  await save("capture-config.json", JSON.stringify(configuration));
  const evidence = new Map<string, DeletionCaptureArtifact>();
  let evidenceBytes = 0;
  const evidencePart = async (reference: string, body: string): Promise<void> => {
    await save(reference, body);
    if (evidence.has(reference)) return;
    evidenceBytes += new TextEncoder().encode(body).byteLength;
    if (evidenceBytes > 8 * 1024 * 1024) throw new Error("Capture exceeds the current inventory evidence limit");
    evidence.set(reference, { reference, body, sha256: await digest(body) });
  };
  const enumerate = async (phase: "before" | "after", namespace: string): Promise<Enumeration> => {
    const pages: Enumeration["pages"] = [];
    const references: string[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let index = 0; index < 1000; index++) {
      const reference = `${phase}-${namespace}-${index}.json`;
      const existing = await input.artifacts.read(reference);
      const page = pageSchema.parse(existing ? JSON.parse(existing) : { requestedCursor: cursor,
        response: await input.cloudflare.listObjects({ accountId: configuration.accountId, namespaceId: namespace, cursor, limit: 1000 }) });
      if (page.requestedCursor !== cursor || page.response.result_info.count !== page.response.result.length) throw new Error("Capture enumeration page chain is invalid");
      for (const object of page.response.result) {
        if (ids.has(object.id)) throw new Error("Capture enumeration repeats an object");
        ids.add(object.id);
      }
      if (ids.size > 100_000) throw new Error("Capture namespace exceeds the current inventory limit");
      const next = page.response.result_info.cursor;
      if (page.response.result.length ? !next || cursors.has(next) : Boolean(next)) throw new Error("Capture enumeration has an invalid continuation cursor");
      await evidencePart(reference, JSON.stringify(page));
      pages.push(page); references.push(reference);
      if (!page.response.result.length) {
        const snapshotReference = `${phase}-${namespace}-snapshot.json`;
        const saved = await input.artifacts.read(snapshotReference);
        const snapshot = snapshotSchema.parse(saved ? JSON.parse(saved) : { capturedAt: clock(), pages: references });
        if (JSON.stringify(snapshot.pages) !== JSON.stringify(references)) throw new Error("Capture snapshot does not match saved pages");
        await save(snapshotReference, JSON.stringify(snapshot));
        return { snapshot, pages };
      }
      cursors.add(next); cursor = next;
    }
    throw new Error("Capture enumeration lacks a final empty page");
  };
  const savedEpoch = await input.artifacts.read("inspection-epoch.json");
  const epoch = epochSchema.parse(savedEpoch ? JSON.parse(savedEpoch) : await input.accounts.openInspection(configuration.installationId));
  if (epoch.installationId !== configuration.installationId) throw new Error("Capture inspection epoch does not match its scope");
  await save("inspection-epoch.json", JSON.stringify(epoch));
  // Epoch creation initializes historical adapter indexes before their namespaces are captured.
  const before = new Map<string, Enumeration>();
  for (const namespace of configuration.namespaces) before.set(namespace.namespaceId, await enumerate("before", namespace.namespaceId));
  if ([...before.values()].some((item) => item.snapshot.capturedAt < epoch.createdAt)) throw new Error("Capture snapshot predates its inspection epoch");
  const namespaces: CapturedNamespace[] = [];
  const fullNamespaces: z.infer<typeof installationDeletionEvidenceSchema>["namespaces"] = [];
  let storedObjects = 0;
  for (const namespace of configuration.namespaces) {
    const initial = before.get(namespace.namespaceId)!;
    const objects = initial.pages.flatMap((page) => page.response.result).filter((object) => object.hasStoredData);
    storedObjects += objects.length;
    const observations: DeletionResourceObservation[] = [];
    const references: string[] = [];
    let lastObservedAt = epoch.createdAt;
    for (let offset = 0; offset < objects.length; offset += 32) {
      const resources = objects.slice(offset, offset + 32).map((object) => {
        const resource: DeletionCaptureInspection["resources"][number] = { kind: namespace.kind, objectId: object.id, namespaceId: namespace.namespaceId };
        if (namespace.names?.[object.id]) resource.name = namespace.names[object.id];
        return resource;
      });
      const request = deletionCaptureInspectionSchema.parse({ installationId: configuration.installationId, inspectionEpochId: epoch.id,
        candidateInstallationIds: configuration.candidateInstallationIds, resources });
      const receiptReference = `inspection-${namespace.namespaceId}-${offset}.json`;
      const existing = await input.artifacts.read(receiptReference);
      const result = deletionCaptureInspectionResultSchema.parse(existing ? JSON.parse(existing) : await input.accounts.inspect(request));
      if (result.installationId !== configuration.installationId || result.inspectionEpochId !== epoch.id
        || result.observedAt < epoch.createdAt || result.observations.length !== resources.length) throw new Error("Capture inspection response has another scope or interval");
      const seen = new Set<string>();
      for (const observation of result.observations) {
        if (seen.has(observation.objectId) || observation.kind !== namespace.kind || observation.namespaceId !== namespace.namespaceId
          || !resources.some((resource) => resource.objectId === observation.objectId)) throw new Error("Capture inspection response does not match requested objects");
        seen.add(observation.objectId);
      }
      await save(receiptReference, JSON.stringify(result));
      lastObservedAt = Math.max(lastObservedAt, result.observedAt);
      const projected = result.observations.map(({ objectId, outcome, installationId, name }) => {
        const observation: DeletionResourceObservation = { objectId, outcome };
        if (installationId) observation.installationId = installationId;
        if (name) observation.name = name;
        return observation;
      });
      const reference = `observations-${namespace.namespaceId}-${offset}.json`;
      await evidencePart(reference, JSON.stringify(projected));
      references.push(reference); observations.push(...projected);
    }
    const final = await enumerate("after", namespace.namespaceId);
    if (final.snapshot.capturedAt < lastObservedAt) throw new Error("Capture clock is earlier than Accounts observations");
    namespaces.push({ namespaceId: namespace.namespaceId, ownerId: namespace.ownerId,
      before: initial.snapshot, after: final.snapshot, observations: references });
    fullNamespaces.push({ namespaceId: namespace.namespaceId, ownerId: namespace.ownerId,
      before: { capturedAt: initial.snapshot.capturedAt, pages: initial.pages }, after: { capturedAt: final.snapshot.capturedAt, pages: final.pages }, observations });
  }
  const capturedAt = Math.max(clock(), ...namespaces.map((namespace) => namespace.after.capturedAt));
  const full = { version: 1 as const, installationId: configuration.installationId, capturedAt, namespaces: fullNamespaces };
  const resources = fullNamespaces.flatMap((namespace) => namespace.observations.filter((observation) => observation.outcome === "identified"
    && observation.installationId === configuration.installationId && observation.name).map((observation) => ({ ownerId: namespace.ownerId,
    kind: "durable-object" as const, namespace: namespace.namespaceId, resourceId: observation.objectId, name: observation.name! })));
  const manifest = { installationId: configuration.installationId, owners: [...new Set(configuration.namespaces.map((namespace) => namespace.ownerId))]
    .map((id) => ({ id, resources: resources.filter((resource) => resource.ownerId === id) })) };
  const validation = await validateInstallationDeletionEvidence(full, configuration.namespaces, manifest);
  const indexReference = "durable-objects-index.json";
  const savedIndex = await input.artifacts.read(indexReference);
  const index = installationDeletionEvidenceIndexSchema.parse(savedIndex ? JSON.parse(savedIndex) : {
    version: 1, kind: "cloudflare-durable-objects", installationId: configuration.installationId,
    capturedAt, inspectionEpochId: epoch.id, namespaces,
  });
  if (index.installationId !== configuration.installationId || index.inspectionEpochId !== epoch.id
    || index.capturedAt < Math.max(...namespaces.map((namespace) => namespace.after.capturedAt))
    || JSON.stringify(index.namespaces) !== JSON.stringify(namespaces)) throw new Error("Capture index does not match its artifacts");
  await evidencePart(indexReference, JSON.stringify(index));
  return { scope: "durable-objects", outcome: "captured", installationId: configuration.installationId,
    inspectionEpochId: epoch.id, indexReference, storedObjects, unidentifiedObjects: validation.unidentifiedObjects, resources, evidence: [...evidence.values()] };
}

async function digest(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
