import { installationDeletionRequestSchema, type InstallationDeletionRequest, type InstallationDeletionReceipt } from "../../../../packages/gsv/src/services/lifecycle.js";
import { ADAPTER_RETIREMENT_PREFIX, AdapterRetirement, type AdapterDataScope } from "./retirement";
import type { AdapterResourceInspection } from "./peer-retirement";

export type PairingOwnership = {
  resourceName?: string;
  owner?: AdapterDataScope;
  retired?: boolean;
  cleanup?: { installationId: string };
  cleanupComplete?: boolean;
};
const BACKUP_MS = 30 * 24 * 60 * 60_000 + 60_000;

/** One pairing may retain a previous space's unlink receipt after its new route commits. */
export class AdapterPairingRetirement<Record extends PairingOwnership> {
  constructor(private readonly storage: DurableObjectStorage, private readonly fence: AdapterRetirement, private readonly key: string) {}

  async inspect(installationId: string): Promise<AdapterResourceInspection> {
    const record = await this.storage.get<Record>(this.key);
    if ([...this.storage.kv.list()].some(([key]) => key !== this.key && !key.startsWith(ADAPTER_RETIREMENT_PREFIX))) return { outcome: "unidentified" };
    const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 5) != '__cf_' AND name NOT IN ('_cf_KV', '_cf_METADATA')").toArray();
    if (tables.length) return { outcome: "unidentified" };
    if (!record) return { outcome: "empty" };
    if (!record.resourceName || record.owner === undefined) return { outcome: "unidentified" };
    return record.owner?.installationId === installationId || record.cleanup?.installationId === installationId
      ? { name: record.resourceName, outcome: "identified", installationId }
      : { name: record.resourceName, outcome: "unrelated" };
  }
  async quiesce(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    this.fence.quiesce(input);
    return await this.status(input);
  }
  async erase(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    const stopped = await this.quiesce(input);
    if (stopped.phase === "quiescing" || stopped.outcome === "missing-inventory") return stopped;
    await this.storage.transaction(async (txn) => {
      const record = await txn.get<Record>(this.key);
      if (!record) return;
      if (record.owner?.installationId === input.installationId) {
        if (!record.cleanup || record.cleanup.installationId === input.installationId) {
          await txn.delete(this.key);
          await txn.deleteAlarm();
          return;
        }
        // The old space still owns this unlink operation. Disable the retired
        // pairing capability while retaining that other space's cleanup receipt.
        record.owner = null;
        record.retired = true;
      }
      if (record.cleanup?.installationId === input.installationId) {
        delete record.cleanup;
        record.cleanupComplete = true;
      }
      await txn.put(this.key, record);
    });
    this.fence.complete(input);
    return await this.status(input);
  }
  async status(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    const state = this.fence.status(input);
    const inspection = await this.inspect(input.installationId);
    const base: InstallationDeletionReceipt = {
      ...input, phase: !state.startedAt ? "pending" : state.active ? "quiescing" : "quiesced",
      updatedAt: state.startedAt ?? Date.now(), pendingResources: state.active + (inspection.outcome === "identified" ? 1 : 0),
      outcome: inspection.outcome === "unidentified" ? "missing-inventory" : "progress", retainedCopies: [],
    };
    if (!state.erasedAt || base.pendingResources || base.outcome === "missing-inventory") return base;
    const expiresAt = state.erasedAt + BACKUP_MS;
    return Date.now() < expiresAt
      ? { ...base, phase: "live-erased", outcome: "retention-pending", retainedCopies: [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }] }
      : { ...base, phase: "erased", outcome: "complete" };
  }
}
