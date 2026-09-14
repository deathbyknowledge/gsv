import { installationDeletionRequestSchema, installationDeletionReceiptSchema, type InstallationDeletionReceipt, type InstallationDeletionRequest, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { installationDeletionManifestSchema, type InstallationDeletionManifest } from "./deletion-inventory";
import { enumerationIsEmpty, OPERATOR_RESOURCE_OWNER, operatorResourceAttestationSchema, operatorResourceCaptureSchema,
  operatorResourceCatalogSchema, operatorResourceDigest, operatorResourceManifestResources, operatorResourceSelector,
  type OperatorResource, type OperatorResourceAttestation, type OperatorResourceCapture, type OperatorResourceCatalog } from "./operator-resource-contracts";

type Operation = { installation_id: string; operation_id: string; catalog_json: string; catalog_sha256: string;
  phase: "quiesced" | "erasing" | "live-erased" | "finalizing" | "erased"; evidence_revision: number; created_at: number; updated_at: number };
type Evidence = { resource_id: string; sha256: string; captured_at: number; recorded_at: number; capture_json: string };
export type OperatorResourceStatus = { id: string; kind: OperatorResource["kind"]; namespace: string; disposition: OperatorResource["disposition"];
  state: "unknown" | "pending" | "retained" | "cleared"; expiresAt: number | null;
  evidence: { provenance: "operator-attested"; sha256: string; capturedAt: number; recordedAt: number; reference: string } | null };
export type OperatorResourceProgress = { installationId: string; operationId: string | null; provenance: "operator-attested";
  phase: Operation["phase"] | "pending"; resources: OperatorResourceStatus[] };

/** External API credentials stay with the operator. Only authenticated operator HTTP writes attest facts. */
export class AccountsOperatorResources implements InstallationDeletionService {
  readonly catalog: OperatorResourceCatalog;
  constructor(private readonly db: D1Database, catalog: OperatorResourceCatalog, private readonly clock: () => number = Date.now) {
    this.catalog = operatorResourceCatalogSchema.parse(catalog).sort((left, right) => left.id.localeCompare(right.id));
  }

  verifyAdditionalEvidence(input: { manifest: InstallationDeletionManifest }): Promise<boolean> {
    const expected = operatorResourceManifestResources(this.catalog, input.manifest.installationId);
    const actual = input.manifest.owners.find((owner) => owner.id === OPERATOR_RESOURCE_OWNER)?.resources;
    return Promise.resolve(!!actual && resourceKeys(actual) === resourceKeys(expected));
  }

  async inspect(installationId: string): Promise<OperatorResourceProgress> {
    const operation = await this.operation(installationId);
    if (!operation) return { installationId, operationId: null, provenance: "operator-attested", phase: "pending",
      resources: this.catalog.map((resource) => this.resourceStatus(resource)) };
    return { installationId, operationId: operation.operation_id, provenance: "operator-attested", phase: operation.phase,
      resources: await this.resources(operation) };
  }

  async record(installationId: string, value: OperatorResourceAttestation): Promise<OperatorResourceProgress> {
    const input = operatorResourceAttestationSchema.parse(value);
    const capture = input.capture;
    const operation = await this.operation(installationId);
    if (!operation || ["finalizing", "erased"].includes(operation.phase)) throw new Error("installation operator evidence requires an unfinished deletion operation");
    if (operation.catalog_sha256 !== await operatorResourceDigest(this.catalog)) throw new Error("installation operator catalog changed during deletion");
    const catalog = operatorResourceCatalogSchema.parse(JSON.parse(operation.catalog_json));
    const resource = catalog.find((item) => item.id === capture.resourceId);
    if (!resource || capture.installationId !== installationId || capture.operationId !== operation.operation_id
      || capture.namespace !== resource.namespace || capture.source !== resource.source
      || capture.selector !== operatorResourceSelector(resource, installationId)) throw new Error("installation operator evidence scope does not match");
    if (capture.facts.kind === "retention-policy" && resource.disposition !== "retained") throw new Error("installation live resources require empty enumeration evidence");
    enumerationIsEmpty(capture);
    if (await operatorResourceDigest(capture) !== input.sha256) throw new Error("installation operator evidence hash does not match");
    const previous = await this.latest(installationId, resource.id);
    if (previous?.sha256 === input.sha256) return this.inspect(installationId);
    const now = this.clock();
    if (capture.capturedAt < operation.created_at || capture.capturedAt > now || (previous && capture.capturedAt <= previous.captured_at)) {
      throw new Error("installation operator evidence capture time is invalid or stale");
    }
    // A cleanup capture follows the final application write boundary, not merely the retirement request.
    const owners = (await this.db.prepare("SELECT owner_id, receipt_json FROM installation_deletion_owners WHERE operation_id = ?")
      .bind(operation.operation_id).all<{ owner_id: string; receipt_json: string | null }>()).results
      .filter((owner) => owner.owner_id !== "accounts" && owner.owner_id !== OPERATOR_RESOURCE_OWNER);
    for (const owner of owners) {
      const receipt = owner.receipt_json ? installationDeletionReceiptSchema.parse(JSON.parse(owner.receipt_json)) : null;
      if (!receipt || !["live-erased", "erased"].includes(receipt.phase) || capture.capturedAt < receipt.updatedAt) {
        throw new Error("installation operator evidence must follow application cleanup");
      }
    }
    await this.db.batch([this.db.prepare(`INSERT INTO installation_operator_resource_evidence
      (installation_id, resource_id, sha256, captured_at, recorded_at, capture_json)
      SELECT installation_id, ?, ?, ?, ?, ? FROM installation_operator_resources WHERE installation_id = ? AND operation_id = ? AND phase IN ('quiesced', 'erasing', 'live-erased')
        AND NOT EXISTS (SELECT 1 FROM installation_operator_resource_evidence WHERE installation_id = ? AND resource_id = ? AND captured_at >= ?)`)
      .bind(resource.id, input.sha256, capture.capturedAt, now, JSON.stringify(capture), installationId, operation.operation_id,
        installationId, resource.id, capture.capturedAt),
      this.db.prepare(`UPDATE installation_operator_resources SET evidence_revision = evidence_revision + 1,
        phase = CASE WHEN ? THEN 'erasing' ELSE phase END, updated_at = ?
        WHERE installation_id = ? AND phase IN ('quiesced', 'erasing', 'live-erased')`)
        .bind(resource.disposition === "live" && !enumerationIsEmpty(capture) ? 1 : 0, now, installationId)]);
    if ((await this.latest(installationId, resource.id))?.sha256 !== input.sha256) throw new Error("installation operator evidence conflicts with a newer capture");
    return this.inspect(installationId);
  }

  async quiesceInstallation(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    let operation = await this.operation(input.installationId);
    if (!operation) {
      const manifestRow = await this.db.prepare(`SELECT i.manifest_json FROM installation_deletions d
        JOIN installation_deletion_inventories i ON i.sha256 = d.inventory_sha256
        JOIN installations s ON s.id = d.installation_id WHERE d.installation_id = ? AND d.operation_id = ? AND s.state = 'retained'`)
        .bind(input.installationId, input.operationId).first<{ manifest_json: string }>();
      if (!manifestRow || !await this.verifyAdditionalEvidence({ manifest: installationDeletionManifestSchema.parse(JSON.parse(manifestRow.manifest_json)) })) throw new Error("installation operator resources require the configured verified inventory");
      const now = this.clock();
      await this.db.prepare(`INSERT INTO installation_operator_resources
        (installation_id, operation_id, catalog_json, catalog_sha256, phase, created_at, updated_at) VALUES (?, ?, ?, ?, 'quiesced', ?, ?) ON CONFLICT DO NOTHING`)
        .bind(input.installationId, input.operationId, JSON.stringify(this.catalog), await operatorResourceDigest(this.catalog), now, now).run();
      operation = await this.operation(input.installationId);
    }
    if (!operation || operation.operation_id !== input.operationId) throw new Error("installation operator resource operation does not match");
    if (operation.phase !== "erased" && operation.catalog_sha256 !== await operatorResourceDigest(this.catalog)) throw new Error("installation operator catalog changed during deletion");
    return this.receipt(input, operation);
  }

  async eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    await this.quiesceInstallation(input);
    return this.advance(input);
  }
  async installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> { return this.eraseInstallation(input); }

  private async advance(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const operation = (await this.operation(input.installationId))!;
    if (operation.phase === "erased") return this.receipt(input, operation);
    let phase: Operation["phase"] = operation.phase;
    if (phase !== "finalizing") {
      const states = await this.resources(operation);
      const pending = states.some((resource) => resource.disposition === "live" && resource.state !== "cleared");
      phase = pending ? "erasing" : states.every((resource) => resource.state === "cleared") ? "finalizing" : "live-erased";
      const changed = await this.db.prepare(`UPDATE installation_operator_resources SET phase = ?, updated_at = ?
        WHERE installation_id = ? AND operation_id = ? AND evidence_revision = ? AND phase = ?`)
        .bind(phase, this.clock(), input.installationId, input.operationId, operation.evidence_revision, operation.phase).run();
      if (changed.meta.changes !== 1) return this.receipt(input, (await this.operation(input.installationId))!);
    }
    if (phase !== "finalizing") return this.receipt(input, (await this.operation(input.installationId))!);
    await this.db.prepare(`DELETE FROM installation_operator_resource_evidence WHERE rowid IN
      (SELECT rowid FROM installation_operator_resource_evidence WHERE installation_id = ? LIMIT 100)`)
      .bind(input.installationId).run();
    if (!await this.db.prepare("SELECT 1 FROM installation_operator_resource_evidence WHERE installation_id = ? LIMIT 1").bind(input.installationId).first()) phase = "erased";
    await this.db.prepare(`UPDATE installation_operator_resources SET phase = ?, updated_at = ?, catalog_json = CASE WHEN ? = 'erased' THEN '[]' ELSE catalog_json END
      WHERE installation_id = ? AND operation_id = ? AND phase = 'finalizing'`).bind(phase, this.clock(), phase, input.installationId, input.operationId).run();
    return this.receipt(input, (await this.operation(input.installationId))!);
  }

  private async receipt(input: InstallationDeletionRequest, operation: Operation): Promise<InstallationDeletionReceipt> {
    const resources = await this.resources(operation);
    const pendingResources = resources.filter((resource) => resource.disposition === "live" && resource.state !== "cleared").length;
    const retainedCopies = resources.filter((resource) => resource.disposition === "retained" && resource.state !== "cleared")
      .map((resource) => ({ id: resource.id, kind: retainedKind(resource.kind), expiresAt: resource.expiresAt }));
    const phase = pendingResources && operation.phase === "live-erased" ? "erasing" : operation.phase === "finalizing" ? "live-erased" : operation.phase;
    return { ...input, phase, updatedAt: operation.updated_at, pendingResources, retainedCopies,
      outcome: operation.phase === "erased" ? "complete" : pendingResources ? "progress" : retainedCopies.length ? "retention-pending" : "progress" };
  }
  private async resources(operation: Operation): Promise<OperatorResourceStatus[]> {
    if (["finalizing", "erased"].includes(operation.phase)) return [];
    return Promise.all(operatorResourceCatalogSchema.parse(JSON.parse(operation.catalog_json))
      .map(async (resource) => this.resourceStatus(resource, await this.latest(operation.installation_id, resource.id))));
  }
  private resourceStatus(resource: OperatorResource, evidence?: Evidence | null): OperatorResourceStatus {
    const capture: OperatorResourceCapture | null = evidence ? operatorResourceCaptureSchema.parse(JSON.parse(evidence.capture_json)) : null;
    const expiresAt = capture?.facts.kind === "retention-policy" && capture.facts.enforced && capture.facts.retentionMs !== null
      ? evidence!.recorded_at + capture.facts.retentionMs : null;
    const cleared = capture && (enumerationIsEmpty(capture) || (expiresAt !== null && expiresAt <= this.clock()));
    return { id: resource.id, kind: resource.kind, namespace: resource.namespace, disposition: resource.disposition,
      state: cleared ? "cleared" : !capture ? "unknown" : resource.disposition === "retained" ? "retained" : "pending", expiresAt,
      evidence: evidence && capture ? { provenance: "operator-attested", sha256: evidence.sha256,
        capturedAt: evidence.captured_at, recordedAt: evidence.recorded_at, reference: capture.reference } : null };
  }
  private latest(installationId: string, resourceId: string): Promise<Evidence | null> {
    return this.db.prepare(`SELECT resource_id, sha256, captured_at, recorded_at, capture_json FROM installation_operator_resource_evidence
      WHERE installation_id = ? AND resource_id = ? ORDER BY captured_at DESC LIMIT 1`).bind(installationId, resourceId).first<Evidence>();
  }
  private operation(installationId: string): Promise<Operation | null> {
    return this.db.prepare("SELECT * FROM installation_operator_resources WHERE installation_id = ?").bind(installationId).first<Operation>();
  }
}

function resourceKeys(resources: InstallationDeletionManifest["owners"][number]["resources"]): string {
  return JSON.stringify(resources.map(({ kind, namespace, resourceId, name }) => JSON.stringify([kind, namespace, resourceId, name ?? null])).sort());
}
function retainedKind(kind: OperatorResource["kind"]): "logs" | "provider" | "backup" | "cache" {
  if (kind === "r2" || kind === "queue") throw new Error("installation live resource cannot become a retained copy");
  return kind;
}
