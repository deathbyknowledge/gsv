import { z } from "zod";
import { installationDeletionInventoryImportSchema, type InstallationDeletionInventoryImport,
  type InstallationDeletionInventoryImported } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { installationDeletionReceiptSchema, installationDeletionRequestSchema, type InstallationDeletionReceipt,
  type InstallationDeletionRequest, type InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";

const batchSize = 16;
const backupLifetimeMs = 30 * 24 * 60 * 60_000 + 60_000;
const registrationSchema = z.strictObject({ kind: z.enum(["adapter-peer", "adapter-pairing", "adapter-account"]),
  name: z.string().min(1).max(1024), objectId: z.string().regex(/^[a-f0-9]{64}$/),
  namespaceId: z.string().regex(/^[a-f0-9]{32}$/).optional(), generation: z.string().min(1).max(200).optional() });
export type AdapterInstallationResource = InstallationDeletionInventoryImport["resources"][number];
export type AdapterInstallationRegistration = z.infer<typeof registrationSchema>;
export type AdapterInstallationRetirementOptions = {
  self: AdapterInstallationResource & { kind: "adapter-installation" };
  /** Validates kind, physical namespace/name, and address before returning a trusted owner capability. */
  resolve(resource: AdapterInstallationResource): InstallationDeletionService | null;
  clock?: () => number;
};
type RetirementState = {
  installation_id: string; self_name: string; self_object_id: string;
  phase: "active" | "importing" | "quiescing" | "quiesced" | "erasing" | "live-erased" | "erased";
  operation_id: string | null; discovery_sha256: string | null; manifest_sha256: string | null;
  manifest_count: number; import_cursor: number; inventory_complete: number; status_cursor: number;
  updated_at: number; backup_expires_at: number | null;
};
type ResourceRow = { seq: number; kind: AdapterInstallationRegistration["kind"]; name: string; object_id: string; namespace_id: string | null;
  state: "live" | "quiesced" | "live-erased" | "erased"; receipt_json: string | null };

/** One immutable space owns this index; individual shared peers own generation-specific cleanup. */
export class AdapterInstallationRetirement implements InstallationDeletionService {
  private readonly clock: () => number;

  constructor(private readonly storage: DurableObjectStorage, readonly installationId: string,
    private readonly options: AdapterInstallationRetirementOptions) {
    this.clock = options.clock ?? Date.now;
    installationDeletionRequestSchema.parse({ version: 1, installationId, operationId: "validate" });
    if (options.self.kind !== "adapter-installation") throw new Error("Adapter coordinator identity is invalid");
    const existing = storage.sql.exec<RetirementState>("SELECT * FROM adapter_installation_retirement WHERE id = 1").toArray()[0];
    if (existing) {
      if (existing.installation_id !== installationId || existing.self_name !== options.self.name
        || existing.self_object_id !== options.self.objectId) throw new Error("Adapter coordinator identity is immutable");
    } else storage.sql.exec(`INSERT INTO adapter_installation_retirement
      (id, installation_id, self_name, self_object_id, phase, updated_at) VALUES (1, ?, ?, ?, 'active', ?)`,
      installationId, options.self.name, options.self.objectId, this.clock());
  }

  registerResource(input: AdapterInstallationRegistration): void {
    const resource = registrationSchema.parse(input);
    if (this.state().phase !== "active") throw new Error("Adapter installation registration is closed");
    const owner = this.options.resolve(resource);
    if (!owner) throw new Error("Adapter resource kind is unsupported");
    const previous = this.storage.sql.exec<ResourceRow>("SELECT * FROM adapter_installation_resources WHERE kind = ? AND object_id = ?", resource.kind, resource.objectId).toArray()[0];
    if (previous && (previous.name !== resource.name || (previous.namespace_id && resource.namespaceId && previous.namespace_id !== resource.namespaceId))) throw new Error("Adapter resource identity is immutable");
    this.storage.sql.exec(`INSERT INTO adapter_installation_resources(kind, name, object_id, namespace_id, generation) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, object_id) DO UPDATE SET namespace_id = COALESCE(namespace_id, excluded.namespace_id), generation = COALESCE(excluded.generation, generation)`,
      resource.kind, resource.name, resource.objectId, resource.namespaceId ?? null, resource.generation ?? null);
  }

  registeredResource(kind: AdapterInstallationResource["kind"], objectId: string): AdapterInstallationResource | null {
    const row = this.storage.sql.exec<ResourceRow>("SELECT * FROM adapter_installation_resources WHERE kind = ? AND object_id = ?", kind, objectId).toArray()[0];
    if (!row) return null;
    const resource: AdapterInstallationResource = { kind: row.kind, name: row.name, objectId: row.object_id };
    if (row.namespace_id) resource.namespaceId = row.namespace_id;
    return resource;
  }

  async importInstallationDeletionInventory(input: InstallationDeletionInventoryImport): Promise<InstallationDeletionInventoryImported> {
    const request = installationDeletionInventoryImportSchema.parse(input);
    if (request.installationId !== this.installationId) throw new Error("Adapter inventory belongs to another installation");
    const resources = [...request.resources].sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)));
    const byKey = new Map(resources.map((resource) => [resourceKey(resource), resource]));
    if (byKey.size !== resources.length) throw new Error("Adapter inventory repeats a physical resource");
    const selves = resources.filter((resource) => resource.kind === "adapter-installation");
    if (selves.length !== 1 || selves[0].name !== this.options.self.name || selves[0].objectId !== this.options.self.objectId
      || (this.options.self.namespaceId && selves[0].namespaceId !== this.options.self.namespaceId)) throw new Error("Adapter inventory must include its exact coordinator identity");
    if (resources.some((resource) => !["adapter-installation", "adapter-peer", "adapter-pairing", "adapter-account"].includes(resource.kind))) throw new Error("Adapter inventory contains an unsupported resource kind");
    const manifestSha256 = await digest(JSON.stringify(resources));
    let state = this.state();
    if (state.phase === "erased") throw new Error("Adapter installation is erased");
    if (state.manifest_sha256 && (state.manifest_sha256 !== manifestSha256 || state.discovery_sha256 !== request.discoverySha256)) throw new Error("Adapter inventory import is immutable");
    if (!state.manifest_sha256) {
      const known = this.storage.sql.exec<ResourceRow>("SELECT * FROM adapter_installation_resources").toArray();
      if (known.some((resource) => {
        const candidate = byKey.get(`${resource.kind}:${resource.object_id}`);
        return !candidate || candidate.name !== resource.name || (resource.namespace_id && candidate.namespaceId !== resource.namespace_id);
      })) throw new Error("Adapter inventory omits a registered resource");
      this.storage.sql.exec(`UPDATE adapter_installation_retirement SET phase = CASE WHEN phase = 'active' THEN 'importing' ELSE phase END,
        discovery_sha256 = ?, manifest_sha256 = ?, manifest_count = ?, updated_at = ? WHERE id = 1`,
        request.discoverySha256, manifestSha256, resources.length, this.clock());
      state = this.state();
    }
    if (state.inventory_complete) return this.importReceipt(request.discoverySha256, "verified");
    const batch = resources.slice(state.import_cursor, state.import_cursor + batchSize);
    for (const resource of batch) if (resource.kind !== "adapter-installation" && !this.options.resolve(resource)) {
      return this.importReceipt(request.discoverySha256, "missing-inventory");
    }
    this.storage.transactionSync(() => {
      for (const resource of batch) {
        if (resource.kind === "adapter-installation") continue;
        this.storage.sql.exec(`INSERT INTO adapter_installation_resources(kind, name, object_id, namespace_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(kind, object_id) DO UPDATE SET namespace_id = COALESCE(namespace_id, excluded.namespace_id)`,
          resource.kind, resource.name, resource.objectId, resource.namespaceId ?? null);
      }
      const cursor = state.import_cursor + batch.length;
      this.storage.sql.exec("UPDATE adapter_installation_retirement SET import_cursor = ?, inventory_complete = ?, updated_at = ? WHERE id = 1",
        cursor, Number(cursor === resources.length), this.clock());
    });
    return this.importReceipt(request.discoverySha256, this.state().inventory_complete ? "verified" : "missing-inventory");
  }

  async quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const state = this.begin(input);
    if (["quiesced", "erasing", "live-erased", "erased"].includes(state.phase)) return this.receipt(input);
    if (!state.inventory_complete) return this.receipt(input, "missing-inventory");
    const outcome = await this.visit(input, "quiesce", this.rows("live"));
    if (outcome) return this.receipt(input, outcome);
    if (!this.count("live")) this.storage.sql.exec("UPDATE adapter_installation_retirement SET phase = 'quiesced', updated_at = ? WHERE id = 1 AND phase = 'quiescing'", this.clock());
    return this.receipt(input);
  }

  async eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const state = this.begin(input);
    if (state.phase === "live-erased" || state.phase === "erased") return this.installationDeletionStatus(input);
    if (!state.inventory_complete) return this.receipt(input, "missing-inventory");
    if (state.phase === "quiescing" || this.count("live")) return this.receipt(input);
    this.storage.sql.exec("UPDATE adapter_installation_retirement SET phase = 'erasing', updated_at = ? WHERE id = 1 AND phase = 'quiesced'", this.clock());
    const outcome = await this.visit(input, "erase", this.rows("quiesced"));
    if (outcome) return this.receipt(input, outcome);
    if (!this.count("quiesced")) {
      const now = this.clock();
      this.storage.sql.exec("UPDATE adapter_installation_retirement SET phase = 'live-erased', updated_at = ?, backup_expires_at = ? WHERE id = 1 AND phase = 'erasing'", now, now + backupLifetimeMs);
    }
    return this.receipt(input);
  }

  async installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const state = this.validateRequest(input);
    if (state.phase !== "live-erased") return this.receipt(input);
    let rows = this.rows("live-erased", state.status_cursor);
    if (!rows.length && state.status_cursor) rows = this.rows("live-erased");
    const outcome = await this.visit(input, "status", rows);
    if (rows.length) this.storage.sql.exec("UPDATE adapter_installation_retirement SET status_cursor = ? WHERE id = 1 AND phase = 'live-erased'", rows.at(-1)!.seq);
    if (outcome) return this.receipt(input, outcome);
    if (this.state().phase === "live-erased" && !this.count("live-erased") && state.backup_expires_at !== null && this.clock() >= state.backup_expires_at) {
      this.storage.transactionSync(() => {
        this.storage.sql.exec("DELETE FROM adapter_installation_resources");
        this.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'adapter_installation_resources'");
        this.storage.sql.exec(`UPDATE adapter_installation_retirement SET phase = 'erased', discovery_sha256 = NULL, manifest_sha256 = NULL,
          manifest_count = 0, import_cursor = 0, status_cursor = 0, updated_at = ? WHERE id = 1`, this.clock());
      });
    }
    return this.receipt(input);
  }

  private begin(input: InstallationDeletionRequest): RetirementState {
    const state = this.validateRequest(input);
    if (!state.operation_id) this.storage.sql.exec(`UPDATE adapter_installation_retirement SET operation_id = ?, phase = 'quiescing', updated_at = ? WHERE id = 1`, input.operationId, this.clock());
    return this.state();
  }

  private validateRequest(input: InstallationDeletionRequest): RetirementState {
    const request = installationDeletionRequestSchema.parse(input);
    if (request.installationId !== this.installationId) throw new Error("Adapter deletion belongs to another installation");
    const state = this.state();
    if (state.operation_id && state.operation_id !== request.operationId) throw new Error("Adapter deletion operation is immutable");
    return state;
  }

  private async visit(input: InstallationDeletionRequest, action: "quiesce" | "erase" | "status", rows: ResourceRow[]): Promise<InstallationDeletionReceipt["outcome"] | null> {
    for (const row of rows) {
      const resource: AdapterInstallationResource = { kind: row.kind, name: row.name, objectId: row.object_id };
      if (row.namespace_id) resource.namespaceId = row.namespace_id;
      const owner = this.options.resolve(resource);
      if (!owner) return "missing-inventory";
      const receipt = installationDeletionReceiptSchema.parse(await (action === "quiesce" ? owner.quiesceInstallation(input)
        : action === "erase" ? owner.eraseInstallation(input) : owner.installationDeletionStatus(input)));
      if (receipt.installationId !== this.installationId || receipt.operationId !== input.operationId) throw new Error("Adapter resource receipt belongs to another operation");
      const current = this.storage.sql.exec<ResourceRow>("SELECT * FROM adapter_installation_resources WHERE seq = ?", row.seq).toArray()[0];
      // Another retry can finish while this RPC is awaiting its child. Terminal progress wins.
      if (!current || this.state().phase === "erased") continue;
      const previous = current.receipt_json ? installationDeletionReceiptSchema.parse(JSON.parse(current.receipt_json)) : null;
      if (previous && rank(receipt.phase) < rank(previous.phase) && current.receipt_json !== row.receipt_json) continue;
      if (previous && rank(receipt.phase) < rank(previous.phase)) throw new Error("Adapter resource receipt regressed");
      if (["missing-inventory", "missing-owner", "retry"].includes(receipt.outcome)) return receipt.outcome;
      const state = receipt.phase === "erased" ? "erased" : receipt.phase === "live-erased" ? "live-erased" : rank(receipt.phase) >= rank("quiesced") ? "quiesced" : "live";
      this.storage.sql.exec("UPDATE adapter_installation_resources SET state = ?, receipt_json = ? WHERE seq = ?", state, JSON.stringify(receipt), row.seq);
    }
    return null;
  }

  private receipt(input: InstallationDeletionRequest, override?: InstallationDeletionReceipt["outcome"]): InstallationDeletionReceipt {
    const state = this.state();
    if (state.phase === "erased") return { ...input, phase: "erased", outcome: "complete", pendingResources: 0, retainedCopies: [], updatedAt: state.updated_at };
    const retained = new Map<InstallationDeletionReceipt["retainedCopies"][number]["kind"], number | null>();
    for (const copy of this.storage.sql.exec<{ kind: InstallationDeletionReceipt["retainedCopies"][number]["kind"]; expires_at: number | null }>(`
      SELECT json_extract(copy.value, '$.kind') AS kind,
        CASE WHEN SUM(json_extract(copy.value, '$.expiresAt') IS NULL) > 0 THEN NULL
          ELSE MAX(json_extract(copy.value, '$.expiresAt')) END AS expires_at
      FROM adapter_installation_resources, json_each(receipt_json, '$.retainedCopies') AS copy
      WHERE state != 'erased' GROUP BY json_extract(copy.value, '$.kind')`).toArray()) retained.set(copy.kind, copy.expires_at);
    if (state.backup_expires_at !== null && this.clock() < state.backup_expires_at && retained.get("backup") !== null) {
      retained.set("backup", Math.max(retained.get("backup") ?? 0, state.backup_expires_at));
    }
    const phase = state.phase === "active" || state.phase === "importing" ? "pending" : state.phase;
    return { ...input, phase, updatedAt: state.updated_at,
      outcome: override ?? (!state.inventory_complete ? "missing-inventory" : phase === "live-erased" ? "retention-pending" : "progress"),
      pendingResources: this.count("live") + this.count("quiesced") + this.count("live-erased"),
      retainedCopies: [...retained].map(([kind, expiresAt]) => ({ id: `adapter-${kind}`, kind, expiresAt })),
    };
  }

  private state(): RetirementState { return this.storage.sql.exec<RetirementState>("SELECT * FROM adapter_installation_retirement WHERE id = 1").one(); }
  private count(state: ResourceRow["state"]): number { return this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM adapter_installation_resources WHERE state = ?", state).one().count; }
  private rows(state: ResourceRow["state"], after = 0): ResourceRow[] {
    return this.storage.sql.exec<ResourceRow>("SELECT * FROM adapter_installation_resources WHERE state = ? AND seq > ? ORDER BY seq LIMIT ?", state, after, batchSize).toArray();
  }
  private importReceipt(discoverySha256: string, outcome: InstallationDeletionInventoryImported["outcome"]): InstallationDeletionInventoryImported {
    return { installationId: this.installationId, discoverySha256, outcome, verifiedAt: this.clock() };
  }
}

function resourceKey(resource: AdapterInstallationResource): string { return `${resource.kind}:${resource.objectId}`; }
function rank(phase: InstallationDeletionReceipt["phase"]): number { return ["pending", "quiescing", "quiesced", "erasing", "live-erased", "erased"].indexOf(phase); }
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
