import type { InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { installationDeletionInspectionSchema, installationDeletionInspectionResultSchema, installationDeletionInventoryImportSchema,
  type InstallationDeletionDiscoveryService, type InstallationDeletionInspection, type InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { InstallationDeletionCoordinator, type InstallationDeletionProgress } from "./deletion";
import { AccountsDeletionOwner, DEFAULT_D1_BACKUP_RETENTION_MS } from "./deletion-owner";
import { InstallationDeletionInventories, installationDeletionManifestSchema, type InstallationDeletionInventoryResolver, type InstallationDeletionManifest, type InstallationDeletionEvidence } from "./deletion-inventory";
import { parseHandle, parseOpaqueId } from "./domain";

export type AccountsDeletionEnvironment = {
  DELETION_INVENTORY?: InstallationDeletionInventoryResolver;
  ACCOUNTS_D1_BACKUP_RETENTION_MS?: number;
  DELETION_OWNER_GATEWAY?: InstallationDeletionService & InstallationDeletionDiscoveryService;
  [binding: `DELETION_OWNER_${string}`]: InstallationDeletionService | undefined;
};

export function createAccountsDeletionRuntime(db: D1Database, env: AccountsDeletionEnvironment): AccountsDeletionRuntime {
  const owners: Record<string, InstallationDeletionService> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("DELETION_OWNER_") || !value) continue;
    const id = name.slice("DELETION_OWNER_".length).toLowerCase().replaceAll("_", "-");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || id === "accounts") throw new Error("installation deletion owner binding is invalid");
    // SAFETY: deployment-owned prefixed service bindings implement the lifecycle contract.
    owners[id] = value as InstallationDeletionService;
  }
  return new AccountsDeletionRuntime(db, owners, env.DELETION_INVENTORY,
    env.ACCOUNTS_D1_BACKUP_RETENTION_MS ?? DEFAULT_D1_BACKUP_RETENTION_MS, Date.now, env.DELETION_OWNER_GATEWAY);
}

export class AccountsDeletionRuntime {
  readonly inventories: InstallationDeletionInventories;
  readonly coordinator: InstallationDeletionCoordinator;
  private readonly accountOwner: AccountsDeletionOwner;

  constructor(
    private readonly db: D1Database,
    owners: Readonly<Record<string, InstallationDeletionService>>,
    resolver?: InstallationDeletionInventoryResolver,
    backupRetentionMs = DEFAULT_D1_BACKUP_RETENTION_MS,
    clock: () => number = Date.now,
    private readonly discovery?: InstallationDeletionDiscoveryService,
  ) {
    this.accountOwner = new AccountsDeletionOwner(db, backupRetentionMs, clock);
    this.inventories = new InstallationDeletionInventories(db, resolver, clock);
    this.coordinator = new InstallationDeletionCoordinator(db, { ...owners, accounts: this.accountOwner }, clock);
  }

  async registerInventory(installationId: string, manifest: InstallationDeletionManifest, evidence?: InstallationDeletionEvidence) {
    if (manifest.installationId !== parseOpaqueId(installationId, "installationId")) throw new Error("installation inventory scope does not match");
    const row = await this.db.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first<{ state: string }>();
    if (row?.state !== "retained") throw new Error("installation inventory requires retirement before discovery");
    return this.inventories.register(manifest, evidence);
  }

  async inspect(installationId: string, input: InstallationDeletionInspection) {
    const request = installationDeletionInspectionSchema.parse(input);
    if (request.installationId !== installationId) throw new Error("installation inspection scope does not match");
    if (!this.discovery) throw new Error("installation deletion discovery is not configured");
    const result = installationDeletionInspectionResultSchema.parse(await this.discovery.inspectInstallationDeletion(request));
    if (result.installationId !== installationId) throw new Error("installation inspection response does not match");
    return result;
  }

  async importInventory(installationId: string, input: InstallationDeletionInventoryImport) {
    const request = installationDeletionInventoryImportSchema.parse(input);
    if (request.installationId !== installationId) throw new Error("installation inventory scope does not match");
    if (!this.discovery) throw new Error("installation deletion discovery is not configured");
    await this.inventories.require(installationId, request.discoverySha256);
    const record = await this.db.prepare("SELECT manifest_json FROM installation_deletion_inventories WHERE sha256 = ? AND installation_id = ?")
      .bind(request.discoverySha256, installationId).first<{ manifest_json: string }>();
    if (!record) throw new Error("installation deletion is missing-inventory");
    const manifest = installationDeletionManifestSchema.parse(JSON.parse(record.manifest_json));
    const resources = manifest.owners.filter((owner) => owner.id === "gateway" || owner.id === "ripgit")
      .flatMap((owner) => owner.resources).filter((resource) => resource.kind === "durable-object");
    if (resources.length !== request.resources.length || new Set(request.resources.map((resource) => resource.objectId)).size !== request.resources.length
      || request.resources.some((resource) => !resources.some((registered) => registered.resourceId === resource.objectId && registered.name === resource.name))) {
      throw new Error("installation inventory import is outside the verified manifest");
    }
    const previous = await this.db.prepare("SELECT verified_at FROM installation_deletion_imports WHERE manifest_sha256 = ?")
      .bind(request.discoverySha256).first<{ verified_at: number }>();
    if (previous) return { installationId, discoverySha256: request.discoverySha256, outcome: "verified" as const, verifiedAt: previous.verified_at };
    const result = await this.discovery.importInstallationDeletionInventory(request);
    if (result.installationId !== installationId || result.discoverySha256 !== request.discoverySha256
      || !Number.isSafeInteger(result.verifiedAt) || result.verifiedAt < 0) throw new Error("installation inventory import response does not match");
    if (result.outcome === "verified") await this.db.prepare(`INSERT INTO installation_deletion_imports (manifest_sha256, verified_at)
      VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(request.discoverySha256, result.verifiedAt).run();
    return result;
  }

  async retire(installationIdValue: string, input: { operationId: string; confirmHandle: string }) {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const handle = parseHandle(input.confirmHandle);
    const previous = await this.db.prepare("SELECT operation_id FROM installation_account_deletions WHERE installation_id = ?")
      .bind(installationId).first<{ operation_id: string }>();
    if (previous) {
      if (previous.operation_id !== operationId) throw new Error("installation deletion operation does not match");
      return this.accountOwner.installationDeletionStatus({ version: 1, operationId, installationId });
    }
    const changed = await this.db.prepare(`UPDATE installations SET state = 'retained', reservation_expires_at = NULL
      WHERE id = ? AND handle = ? AND state IN ('active', 'restricted', 'reserved', 'provisioning', 'retained')
        AND NOT EXISTS (SELECT 1 FROM installation_reset_operations r JOIN installation_reset_participants p USING(operation_id)
          WHERE (r.previous_installation_id = installations.id OR r.replacement_installation_id = installations.id) AND p.state != 'prepared')`)
      .bind(installationId, handle).run();
    if (changed.meta.changes !== 1) throw new Error("installation cannot retire from its current state or reset preparation is pending");
    return this.accountOwner.quiesceInstallation({ version: 1, operationId, installationId });
  }

  async begin(installationIdValue: string, input: { operationId: string; inventorySha256: string }): Promise<InstallationDeletionProgress> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const existing = await this.db.prepare("SELECT operation_id, inventory_sha256 FROM installation_deletions WHERE installation_id = ?")
      .bind(installationId).first<{ operation_id: string; inventory_sha256: string }>();
    if (existing) {
      if (existing.operation_id !== operationId || existing.inventory_sha256 !== input.inventorySha256) throw new Error("installation deletion operation does not match");
      return this.coordinator.status(operationId);
    }
    const inventory = await this.inventories.require(installationId, input.inventorySha256);
    const manifest = await this.db.prepare("SELECT manifest_json FROM installation_deletion_inventories WHERE sha256 = ?")
      .bind(inventory.sha256).first<{ manifest_json: string }>();
    const requiresImport = manifest && installationDeletionManifestSchema.parse(JSON.parse(manifest.manifest_json)).owners
      .some((owner) => (owner.id === "gateway" || owner.id === "ripgit") && owner.resources.some((resource) => resource.kind === "durable-object"));
    if (requiresImport && !await this.db.prepare("SELECT manifest_sha256 FROM installation_deletion_imports WHERE manifest_sha256 = ?")
      .bind(inventory.sha256).first()) throw new Error("installation deletion is missing-inventory import");
    const previous = await this.db.prepare("SELECT operation_id FROM installation_account_deletions WHERE installation_id = ?")
      .bind(installationId).first<{ operation_id: string }>();
    if (previous && previous.operation_id !== operationId) throw new Error("installation deletion operation does not match retirement");
    return this.coordinator.begin({ version: 1, operationId, installationId }, inventory);
  }

  async status(installationIdValue: string): Promise<InstallationDeletionProgress> {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const row = await this.db.prepare("SELECT operation_id FROM installation_deletions WHERE installation_id = ?")
      .bind(installationId).first<{ operation_id: string }>();
    if (!row) throw new Error("installation deletion is missing-inventory or has not begun");
    return this.coordinator.status(row.operation_id);
  }

  async retry(installationId: string): Promise<InstallationDeletionProgress> {
    const operation = await this.status(installationId);
    return this.coordinator.advance(operation.operationId);
  }

  async resumePending(): Promise<void> {
    // A verified registration authorizes the already-pending reset cleanup job.
    const pending = await this.db.prepare(`SELECT r.previous_installation_id AS installation_id, i.sha256
      FROM installation_reset_operations r JOIN installation_deletion_inventories i ON i.installation_id = r.previous_installation_id
      WHERE r.data_deletion_state IN ('pending', 'deleting', 'failed')
        AND NOT EXISTS (SELECT 1 FROM installation_deletions d WHERE d.installation_id = r.previous_installation_id)
        AND NOT EXISTS (SELECT 1 FROM installation_reset_participants p WHERE p.operation_id = r.operation_id AND p.state != 'prepared')
      ORDER BY i.verified_at DESC LIMIT 10`).all<{ installation_id: string; sha256: string }>();
    for (const record of pending.results) {
      try { await this.begin(record.installation_id, { operationId: crypto.randomUUID(), inventorySha256: record.sha256 }); }
      catch { /* Another job may have admitted the same immutable identity. */ }
    }
    await this.coordinator.resumePending();
  }
}
