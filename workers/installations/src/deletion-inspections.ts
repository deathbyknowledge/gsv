import { z } from "zod";
import {
  installationDeletionInspectionSchema,
  installationResourceKindSchema,
  installationResourceObservationSchema,
  type InstallationDeletionInspection,
  type InstallationResourceObservation,
} from "@humansandmachines/gsv/services/lifecycle-discovery";
import { inspectDeletionResources, type AccountsDeletionDiscovery } from "./deletion-discovery";
import { parseOpaqueId } from "./domain";

export const accountsDeletionInspectionSchema = installationDeletionInspectionSchema.extend({ inspectionEpochId: z.uuid() });
export type AccountsDeletionInspection = z.infer<typeof accountsDeletionInspectionSchema>;
export type DeletionInspectionEpoch = { id: string; installationId: string; createdAt: number };
type EpochRow = { id: string; installation_id: string; created_at: number; sealed_manifest_sha256: string | null };
type CapturedObservationRow = { namespace_id: string; object_id: string; request_json: string; observation_json: string; observed_at: number };
type ObservationRow = { object_id: string; kind: string; observation_json: string; observed_at: number };
export type DeletionObservationRead = {
  installationId: string; inspectionEpochId: string; namespaceId: string;
  kind: InstallationDeletionInspection["resources"][number]["kind"];
  objectIds: string[]; beforeCapturedAt: number; afterCapturedAt: number;
};

/** Bounded trusted probes persist metadata so registration never reopens an entire DO namespace. */
export class AccountsDeletionInspections {
  constructor(private readonly db: D1Database, private readonly clock: () => number = Date.now) {}

  async open(installationIdValue: string): Promise<DeletionInspectionEpoch> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const id = crypto.randomUUID();
    const createdAt = this.clock();
    const result = await this.db.prepare(`INSERT INTO installation_deletion_inspections (id, installation_id, created_at)
      SELECT ?, id, ? FROM installations WHERE id = ? AND state = 'retained'
        AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = installations.id)`)
      .bind(id, createdAt, installationId).run();
    if (result.meta.changes !== 1) throw new Error("installation inspection requires retirement before deletion begins");
    return { id, installationId, createdAt };
  }

  async capture(input: AccountsDeletionInspection, configuration: AccountsDeletionDiscovery) {
    const { inspectionEpochId, ...request } = accountsDeletionInspectionSchema.parse(input);
    const epoch = await this.require(request.installationId, inspectionEpochId);
    const candidates = [...new Set(request.candidateInstallationIds ?? [])].sort();
    const fingerprints = request.resources.map((resource) => {
      const namespace = resource.namespaceId ? configuration.namespaces?.[resource.namespaceId] : undefined;
      if (!namespace || namespace.kind !== resource.kind) throw new Error("installation inspection namespace is not configured for this resource kind");
      return JSON.stringify({ resource, candidateInstallationIds: candidates, ownerId: namespace.ownerId });
    });
    const keys = request.resources.map((resource) => `${resource.namespaceId}:${resource.objectId}`);
    if (new Set(keys).size !== keys.length) throw new Error("installation inspection repeats a resource");
    const load = async () => (await this.db.prepare(`SELECT namespace_id, object_id, request_json, observation_json, observed_at
      FROM installation_deletion_observations WHERE inspection_id = ?
        AND (namespace_id || ':' || object_id) IN (SELECT value FROM json_each(?))`)
      .bind(inspectionEpochId, JSON.stringify(keys)).all<CapturedObservationRow>()).results;
    let saved = await load();
    const missing = request.resources.filter((resource, index) => {
      const persisted = saved.find((row) => row.namespace_id === resource.namespaceId && row.object_id === resource.objectId);
      if (persisted && persisted.request_json !== fingerprints[index]) throw new Error("installation inspection request changed; open a new epoch");
      return !persisted;
    });
    if (missing.length) {
      if (epoch.sealed_manifest_sha256) throw new Error("installation inspection epoch is sealed");
      const writable = await this.db.prepare(`SELECT 1 FROM installations WHERE id = ? AND state = 'retained'
        AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = installations.id)`)
        .bind(request.installationId).first();
      if (!writable) throw new Error("installation inspection requires retirement before deletion begins");
      const result = await inspectDeletionResources({ ...request, resources: missing }, configuration);
      const observedAt = this.clock();
      if (observedAt < epoch.created_at) throw new Error("installation inspection clock moved backwards");
      await this.db.batch(result.observations.map((observation) => this.db.prepare(`INSERT INTO installation_deletion_observations
          (inspection_id, installation_id, namespace_id, object_id, kind, request_json, observation_json, observed_at)
        SELECT id, installation_id, ?, ?, ?, ?, ?, ? FROM installation_deletion_inspections
        WHERE id = ? AND installation_id = ? AND sealed_manifest_sha256 IS NULL
          AND EXISTS (SELECT 1 FROM installations WHERE id = installation_id AND state = 'retained')
          AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = installation_deletion_inspections.installation_id)
        ON CONFLICT DO NOTHING`).bind(observation.namespaceId!, observation.objectId, observation.kind,
        fingerprints[keys.indexOf(`${observation.namespaceId}:${observation.objectId}`)], JSON.stringify(observation), observedAt,
        inspectionEpochId, request.installationId)));
      saved = await load();
      if (result.observations.some((observation) => saved.find((row) => row.namespace_id === observation.namespaceId
        && row.object_id === observation.objectId)?.observation_json !== JSON.stringify(observation))) {
        throw new Error("installation inspection changed or was sealed; open a new epoch");
      }
    }
    if (saved.length !== request.resources.length) throw new Error("installation inspection is missing persisted observations");
    const observations = request.resources.map((resource, index) => {
      const row = saved.find((row) => row.namespace_id === resource.namespaceId && row.object_id === resource.objectId)!;
      if (row.request_json !== fingerprints[index]) throw new Error("installation inspection request changed; open a new epoch");
      return installationResourceObservationSchema.parse(JSON.parse(row.observation_json));
    });
    return { installationId: request.installationId, observations, inspectionEpochId,
      observedAt: Math.max(epoch.created_at, ...saved.map((row) => row.observed_at)) };
  }

  async read(input: DeletionObservationRead): Promise<InstallationResourceObservation[]> {
    const epoch = await this.require(input.installationId, input.inspectionEpochId);
    installationResourceKindSchema.parse(input.kind);
    z.string().regex(/^[a-f0-9]{32}$/).parse(input.namespaceId);
    z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32).parse(input.objectIds);
    if (new Set(input.objectIds).size !== input.objectIds.length || !Number.isSafeInteger(input.beforeCapturedAt)
      || !Number.isSafeInteger(input.afterCapturedAt) || input.beforeCapturedAt > input.afterCapturedAt
      || input.afterCapturedAt > this.clock()) throw new Error("installation inspection snapshot interval is invalid");
    if (!input.objectIds.length) return [];
    const rows = (await this.db.prepare(`SELECT object_id, kind, observation_json, observed_at FROM installation_deletion_observations
      WHERE inspection_id = ? AND installation_id = ? AND namespace_id = ? AND object_id IN (SELECT value FROM json_each(?))`)
      .bind(input.inspectionEpochId, input.installationId, input.namespaceId, JSON.stringify(input.objectIds)).all<ObservationRow>()).results;
    if (rows.length !== input.objectIds.length) throw new Error("installation inspection is missing persisted observations");
    return input.objectIds.map((objectId) => {
      const row = rows.find((candidate) => candidate.object_id === objectId)!;
      if (row.kind !== input.kind || row.observed_at < Math.max(input.beforeCapturedAt, epoch.created_at) || row.observed_at > input.afterCapturedAt) {
        throw new Error("installation inspection observation is outside the snapshot interval or resource kind");
      }
      return installationResourceObservationSchema.parse(JSON.parse(row.observation_json));
    });
  }

  private async require(installationId: string, epochId: string): Promise<EpochRow> {
    z.uuid().parse(epochId);
    const row = await this.db.prepare("SELECT id, installation_id, created_at, sealed_manifest_sha256 FROM installation_deletion_inspections WHERE id = ? AND installation_id = ?")
      .bind(epochId, parseOpaqueId(installationId, "installationId")).first<EpochRow>();
    if (!row) throw new Error("installation inspection epoch is unavailable");
    return row;
  }
}
