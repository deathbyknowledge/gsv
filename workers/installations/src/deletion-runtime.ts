import type { InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { installationDeletionInventoryImportSchema, installationDeletionInspectionResultSchema,
  type InstallationDeletionDiscoveryService, type InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { InstallationDeletionCoordinator, type InstallationDeletionProgress } from "./deletion";
import { AccountsDeletionOwner, DEFAULT_D1_BACKUP_RETENTION_MS } from "./deletion-owner";
import { InstallationDeletionInventories, installationDeletionManifestSchema, type InstallationDeletionInventoryResolver, type InstallationDeletionManifest, type InstallationDeletionEvidence } from "./deletion-inventory";
import { AccountsDeletionInspections, type AccountsDeletionInspection } from "./deletion-inspections";
import { accountsDeletionNamespacesSchema, type AccountsDeletionDiscovery, type AccountsDeletionNamespaces } from "./deletion-discovery";
import { parseHandle, parseOpaqueId } from "./domain";
import { AccountsOperatorResources } from "./operator-resources";
import { OPERATOR_RESOURCE_OWNER, type OperatorResourceCatalog } from "./operator-resource-contracts";

type DiscoverableDeletionOwner = InstallationDeletionService & Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion">;

export type AccountsDeletionEnvironment = {
  DELETION_INVENTORY?: InstallationDeletionInventoryResolver;
  ACCOUNTS_D1_BACKUP_RETENTION_MS?: number;
  DELETION_OWNER_GATEWAY?: InstallationDeletionService & InstallationDeletionDiscoveryService;
  DELETION_OWNER_INFERENCE?: InstallationDeletionService & Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion">;
  DELETION_OWNER_MAIL?: InstallationDeletionService & Pick<InstallationDeletionDiscoveryService, "inspectInstallationDeletion">;
  DELETION_DISCOVERY_NAMESPACES?: AccountsDeletionNamespaces;
  OPERATOR_DELETION_CATALOG?: OperatorResourceCatalog;
};

export function createAccountsDeletionRuntime(db: D1Database, env: AccountsDeletionEnvironment): AccountsDeletionRuntime {
  const owners: Record<string, DiscoverableDeletionOwner> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("DELETION_OWNER_") || !value) continue;
    const id = name.slice("DELETION_OWNER_".length).toLowerCase().replaceAll("_", "-");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || id === "accounts") throw new Error("installation deletion owner binding is invalid");
    // SAFETY: deployment-owned prefixed service bindings implement the lifecycle contract.
    owners[id] = value as DiscoverableDeletionOwner;
  }
  return new AccountsDeletionRuntime(db, owners, env.DELETION_INVENTORY,
    env.ACCOUNTS_D1_BACKUP_RETENTION_MS ?? DEFAULT_D1_BACKUP_RETENTION_MS, Date.now, {
      gateway: env.DELETION_OWNER_GATEWAY,
      owners,
      namespaces: accountsDeletionNamespacesSchema.parse(env.DELETION_DISCOVERY_NAMESPACES ?? {}),
    }, env.OPERATOR_DELETION_CATALOG);
}

export class AccountsDeletionRuntime {
  readonly inspections: AccountsDeletionInspections;
  readonly inventories: InstallationDeletionInventories;
  readonly coordinator: InstallationDeletionCoordinator;
  private readonly accountOwner: AccountsDeletionOwner;
  readonly operatorResources?: AccountsOperatorResources;

  constructor(
    private readonly db: D1Database,
    owners: Readonly<Record<string, InstallationDeletionService>>,
    resolver?: InstallationDeletionInventoryResolver,
    backupRetentionMs = DEFAULT_D1_BACKUP_RETENTION_MS,
    clock: () => number = Date.now,
    private readonly discovery: AccountsDeletionDiscovery = {},
    operatorCatalog?: OperatorResourceCatalog,
  ) {
    this.inspections = new AccountsDeletionInspections(db, clock);
    this.accountOwner = new AccountsDeletionOwner(db, backupRetentionMs, clock);
    this.inventories = new InstallationDeletionInventories(db, resolver, clock);
    this.operatorResources = operatorCatalog ? new AccountsOperatorResources(db, operatorCatalog, clock) : undefined;
    const coordinatedOwners = { ...owners };
    coordinatedOwners.accounts = this.accountOwner;
    if (this.operatorResources) coordinatedOwners[OPERATOR_RESOURCE_OWNER] = this.operatorResources;
    this.coordinator = new InstallationDeletionCoordinator(db, coordinatedOwners, clock);
  }

  async registerInventory(installationId: string, manifest: InstallationDeletionManifest, evidence?: InstallationDeletionEvidence) {
    if (manifest.installationId !== parseOpaqueId(installationId, "installationId")) throw new Error("installation inventory scope does not match");
    const row = await this.db.prepare("SELECT state FROM installations WHERE id = ?").bind(installationId).first<{ state: string }>();
    if (row?.state !== "retained") throw new Error("installation inventory requires retirement before discovery");
    if (this.operatorResources && !await this.operatorResources.verifyAdditionalEvidence({ manifest })) throw new Error("installation inventory omits configured operator resources");
    return this.inventories.register(manifest, evidence);
  }

  async openInspection(installationIdValue: string) {
    const installationId = parseOpaqueId(installationIdValue, "installationId");
    const writable = await this.db.prepare(`SELECT 1 FROM installations WHERE id = ? AND state = 'retained'
      AND NOT EXISTS (SELECT 1 FROM installation_deletions WHERE installation_id = installations.id)`)
      .bind(installationId).first();
    if (!writable) throw new Error("installation inspection requires retirement before deletion begins");
    const ownerIds = new Set(Object.values(this.discovery.namespaces ?? {}).filter((namespace) => namespace.kind.startsWith("adapter-"))
      .map((namespace) => namespace.ownerId));
    await Promise.all([...ownerIds].map(async (ownerId) => {
      const owner = this.discovery.owners?.[ownerId];
      if (!owner) throw new Error("installation adapter discovery is not configured");
      const result = installationDeletionInspectionResultSchema.parse(await owner.inspectInstallationDeletion({ installationId, resources: [] }));
      if (result.installationId !== installationId || result.observations.length) throw new Error("installation adapter discovery preflight does not match");
    }));
    return this.inspections.open(installationId);
  }

  async inspect(installationId: string, input: AccountsDeletionInspection) {
    if (input.installationId !== installationId) throw new Error("installation inspection scope does not match");
    return this.inspections.capture(input, this.discovery);
  }

  async importInventory(installationId: string, input: InstallationDeletionInventoryImport) {
    const request = installationDeletionInventoryImportSchema.parse(input);
    if (request.installationId !== installationId) throw new Error("installation inventory scope does not match");
    if (!this.discovery.gateway) throw new Error("installation deletion discovery is not configured");
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
    const result = previous ? { installationId, discoverySha256: request.discoverySha256, outcome: "verified" as const, verifiedAt: previous.verified_at }
      : await this.discovery.gateway.importInstallationDeletionInventory(request);
    if (result.installationId !== installationId || result.discoverySha256 !== request.discoverySha256
      || !["verified", "missing-inventory"].includes(result.outcome)
      || !Number.isSafeInteger(result.verifiedAt) || result.verifiedAt < 0) throw new Error("installation inventory import response does not match");
    if (result.outcome === "verified") await this.db.prepare(`INSERT INTO installation_deletion_imports (manifest_sha256, verified_at)
      VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(request.discoverySha256, result.verifiedAt).run();
    const adapterResults = await Promise.all(this.adapterInventories(manifest).map(async ({ ownerId, resources }) => {
      const previous = await this.db.prepare("SELECT verified_at FROM installation_deletion_owner_imports WHERE manifest_sha256 = ? AND owner_id = ?")
        .bind(request.discoverySha256, ownerId).first<{ verified_at: number }>();
      if (previous) return "verified";
      const owner = this.discovery.owners?.[ownerId];
      if (!owner?.importInstallationDeletionInventory) throw new Error("installation adapter inventory import is not configured");
      const result = await owner.importInstallationDeletionInventory(installationDeletionInventoryImportSchema.parse({ ...request, resources }));
      if (result.installationId !== installationId || result.discoverySha256 !== request.discoverySha256
        || !["verified", "missing-inventory"].includes(result.outcome)
        || !Number.isSafeInteger(result.verifiedAt) || result.verifiedAt < 0) throw new Error("installation adapter inventory import response does not match");
      if (result.outcome === "verified") await this.db.prepare(`INSERT INTO installation_deletion_owner_imports (manifest_sha256, owner_id, verified_at)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).bind(request.discoverySha256, ownerId, result.verifiedAt).run();
      return result.outcome;
    }));
    return { ...result, outcome: result.outcome === "verified" && adapterResults.every((outcome) => outcome === "verified")
      ? "verified" as const : "missing-inventory" as const };
  }

  private adapterInventories(manifest: InstallationDeletionManifest): { ownerId: string; resources: InstallationDeletionInventoryImport["resources"] }[] {
    return manifest.owners.flatMap((owner) => {
      const namespaces = Object.entries(this.discovery.namespaces ?? {}).filter(([, namespace]) => namespace.ownerId === owner.id && namespace.kind.startsWith("adapter-"));
      if (!namespaces.length) {
        if (!["accounts", "gateway", "ripgit", "inference", "mail"].includes(owner.id) && owner.resources.some((resource) => resource.kind === "durable-object")) {
          throw new Error("installation adapter inventory namespace is not configured");
        }
        return [];
      }
      const resources = owner.resources.filter((resource) => resource.kind === "durable-object").map((resource) => {
        const namespace = namespaces.find(([id]) => id === resource.namespace)?.[1];
        if (!namespace || !resource.name) throw new Error("installation adapter inventory resource is outside its configured namespaces");
        return { kind: namespace.kind, namespaceId: resource.namespace, objectId: resource.resourceId, name: resource.name };
      });
      return [{ ownerId: owner.id, resources }];
    });
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
    const parsedManifest = manifest ? installationDeletionManifestSchema.parse(JSON.parse(manifest.manifest_json)) : null;
    const requiresImport = parsedManifest?.owners.some((owner) => (owner.id === "gateway" || owner.id === "ripgit") && owner.resources.some((resource) => resource.kind === "durable-object"));
    if (requiresImport && !await this.db.prepare("SELECT manifest_sha256 FROM installation_deletion_imports WHERE manifest_sha256 = ?")
      .bind(inventory.sha256).first()) throw new Error("installation deletion is missing-inventory import");
    if (parsedManifest) for (const { ownerId } of this.adapterInventories(parsedManifest)) {
      if (!await this.db.prepare("SELECT verified_at FROM installation_deletion_owner_imports WHERE manifest_sha256 = ? AND owner_id = ?")
        .bind(inventory.sha256, ownerId).first()) throw new Error("installation deletion is missing-inventory import for an adapter owner");
    }
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
