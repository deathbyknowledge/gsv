import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ownerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const referenceSchema = z.string().min(1).max(2000);
export const installationDeletionManifestSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().min(1).max(200),
  capturedAt: z.number().int().positive(),
  owners: z.array(z.strictObject({
    id: ownerIdSchema,
    resources: z.array(z.strictObject({
      kind: z.enum(["durable-object", "d1", "r2", "kv", "queue", "provider", "logs", "backup", "cache"]),
      namespace: referenceSchema,
      resourceId: referenceSchema,
      name: referenceSchema.optional(),
    })).max(10_000),
    evidence: z.array(z.strictObject({
      id: referenceSchema,
      reference: referenceSchema,
      sha256: sha256Schema,
      capturedAt: z.number().int().positive(),
    })).min(1).max(1000),
  })).min(1).max(64),
});
export type InstallationDeletionManifest = z.infer<typeof installationDeletionManifestSchema>;
export const installationDeletionEvidenceSchema = z.array(z.strictObject({ reference: referenceSchema, sha256: sha256Schema, body: z.string() })).max(1000);
export type InstallationDeletionEvidence = z.infer<typeof installationDeletionEvidenceSchema>;
export type InstallationDeletionInventoryVerification = {
  installationId: string;
  sha256: string;
  outcome: "verified" | "missing-inventory";
  verifiedAt: number;
  inspectionEpochId?: string;
};

/** Deployment-owned verifier checks enumeration evidence and owner identity reports. */
export interface InstallationDeletionInventoryResolver {
  verifyInstallationDeletionInventory(input: {
    manifest: InstallationDeletionManifest;
    sha256: string;
    evidence?: InstallationDeletionEvidence;
  }): Promise<InstallationDeletionInventoryVerification>;
}

export async function installationDeletionManifestDigest(input: InstallationDeletionManifest): Promise<{ manifest: InstallationDeletionManifest; json: string; sha256: string }> {
  const manifest = installationDeletionManifestSchema.parse(input);
  manifest.owners.sort((left, right) => left.id.localeCompare(right.id));
  const ids = manifest.owners.map((owner) => owner.id);
  if (new Set(ids).size !== ids.length || !["accounts", "gateway", "inference"].every((id) => ids.includes(id))) {
    throw new Error("installation deletion inventory is missing a required owner or repeats an owner");
  }
  for (const owner of manifest.owners) {
    owner.resources.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    owner.evidence.sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(owner.resources.map((resource) => JSON.stringify(resource))).size !== owner.resources.length
      || new Set(owner.evidence.map((evidence) => evidence.id)).size !== owner.evidence.length) {
      throw new Error("installation deletion inventory repeats a resource or evidence record");
    }
  }
  const json = JSON.stringify(manifest);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > 1_000_000) throw new Error("installation deletion inventory is too large");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { manifest, json, sha256 };
}

/** Only verified discovery manifests become selectable by deletion admission. */
export class InstallationDeletionInventories {
  constructor(
    private readonly db: D1Database,
    private readonly resolver: InstallationDeletionInventoryResolver | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  async register(input: InstallationDeletionManifest, evidenceInput?: InstallationDeletionEvidence): Promise<InstallationDeletionInventoryVerification> {
    const { manifest, json, sha256 } = await installationDeletionManifestDigest(input);
    const evidence = installationDeletionEvidenceSchema.parse(evidenceInput ?? []);
    let evidenceBytes = 0;
    if (new Set(evidence.map((record) => record.reference)).size !== evidence.length) throw new Error("installation deletion evidence repeats a reference");
    const references = manifest.owners.flatMap((owner) => owner.evidence);
    for (const record of evidence) {
      const bytes = new TextEncoder().encode(record.body);
      evidenceBytes += bytes.byteLength;
      if (bytes.byteLength > 512 * 1024 || evidenceBytes > 8 * 1024 * 1024) throw new Error("installation deletion evidence is too large");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const contentSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (contentSha256 !== record.sha256 || !references.some((reference) => reference.reference === record.reference && reference.sha256 === record.sha256)) {
        throw new Error("installation deletion evidence does not match the manifest");
      }
    }
    const missing: InstallationDeletionInventoryVerification = {
      installationId: manifest.installationId, sha256, outcome: "missing-inventory", verifiedAt: this.clock(),
    };
    if (!this.resolver || manifest.capturedAt > this.clock()) return missing;
    const result = await this.resolver.verifyInstallationDeletionInventory({ manifest, sha256, evidence });
    if (result.outcome !== "verified" || result.installationId !== manifest.installationId || result.sha256 !== sha256
      || !Number.isSafeInteger(result.verifiedAt) || result.verifiedAt < manifest.capturedAt || result.verifiedAt > this.clock()) return missing;
    const epochId = result.inspectionEpochId ?? null;
    if (epochId && !z.uuid().safeParse(epochId).success) return missing;
    const epoch = epochId ? await this.db.prepare(`SELECT sealed_manifest_sha256 FROM installation_deletion_inspections
      WHERE id = ? AND installation_id = ?`).bind(epochId, manifest.installationId).first<{ sealed_manifest_sha256: string | null }>() : null;
    if (epochId && (!epoch || (epoch.sealed_manifest_sha256 !== null && epoch.sealed_manifest_sha256 !== sha256))) return missing;
    const previous = await this.db.prepare("SELECT manifest_json FROM installation_deletion_inventories WHERE sha256 = ? AND installation_id = ?")
      .bind(sha256, manifest.installationId).first<{ manifest_json: string }>();
    if (previous) {
      const saved = (await this.db.prepare("SELECT reference, sha256 FROM installation_deletion_evidence WHERE manifest_sha256 = ?")
        .bind(sha256).all<{ reference: string; sha256: string }>()).results;
      if ((epochId && epoch?.sealed_manifest_sha256 !== sha256) || previous.manifest_json !== json || saved.length !== evidence.length
        || saved.some((record) => !evidence.some((candidate) => candidate.reference === record.reference && candidate.sha256 === record.sha256))) return missing;
      return result;
    }
    const registrationId = crypto.randomUUID();
    const inserted = await this.db.batch([this.db.prepare(`INSERT INTO installation_deletion_inventories
      (sha256, installation_id, manifest_json, registration_id, verified_at)
      SELECT ?, id, ?, ?, ? FROM installations WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = installations.id)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM installation_deletion_inspections
          WHERE id = ? AND installation_id = installations.id AND sealed_manifest_sha256 IS NULL))
      ON CONFLICT DO NOTHING`).bind(sha256, json, registrationId, result.verifiedAt, manifest.installationId, epochId, epochId),
      ...evidence.map((record) => this.db.prepare(`INSERT INTO installation_deletion_evidence (manifest_sha256, reference, sha256, body)
        SELECT sha256, ?, ?, ? FROM installation_deletion_inventories WHERE sha256 = ? AND installation_id = ? AND registration_id = ?
          AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = ?)
        ON CONFLICT DO NOTHING`).bind(record.reference, record.sha256, record.body, sha256, manifest.installationId, registrationId, manifest.installationId)),
      ...(epochId ? [this.db.prepare(`UPDATE installation_deletion_inspections SET sealed_manifest_sha256 = ?, sealed_at = ?
        WHERE id = ? AND installation_id = ? AND sealed_manifest_sha256 IS NULL
          AND EXISTS (SELECT 1 FROM installation_deletion_inventories WHERE sha256 = ? AND registration_id = ?)`)
        .bind(sha256, result.verifiedAt, epochId, manifest.installationId, sha256, registrationId)] : []),
    ]);
    if (inserted[0].meta.changes !== 1) return missing;
    return result;
  }

  async require(installationId: string, sha256: string): Promise<{ sha256: string; owners: string[] }> {
    if (!sha256Schema.safeParse(sha256).success) throw new Error("installation deletion inventory hash is invalid");
    const record = await this.db.prepare("SELECT manifest_json FROM installation_deletion_inventories WHERE sha256 = ? AND installation_id = ?")
      .bind(sha256, installationId).first<{ manifest_json: string }>();
    if (!record) throw new Error("installation deletion is missing-inventory");
    const manifest = installationDeletionManifestSchema.parse(JSON.parse(record.manifest_json));
    return { sha256, owners: manifest.owners.map((owner) => owner.id) };
  }
}
