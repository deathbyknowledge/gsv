import { z } from "zod";
import {
  type InstallationDeletionReceipt,
  type InstallationDeletionRequest,
} from "@humansandmachines/gsv/services/lifecycle";
import type { Kernel } from "../kernel/do";
import { conversationDurableObjectName, processDurableObjectName } from "./routing";
import { RESOURCE_IDENTITY_KEY, VERIFIED_INVENTORY_KEY, type ResourceRetirement } from "./retirement";
import { installationStoragePrefix } from "./storage";

const batchSize = 16;
const backupLifetimeMs = 30 * 24 * 60 * 60_000;
const ripgitProgressSchema = z.strictObject({
  version: z.literal(1), installationId: z.string(), operationId: z.string(),
  phase: z.enum(["quiescing", "quiesced", "live-erased"]), pendingResources: z.number().int().nonnegative(),
});
type ResourceRetirementService = {
  quiesceInstallationResource(input: InstallationDeletionRequest): Promise<ResourceRetirement>;
  eraseInstallationResource(input: InstallationDeletionRequest): Promise<ResourceRetirement>;
};
type Resource = { kind: "process" | "conversation"; resource_id: string; state: "live" | "quiesced" | "live-erased" };

/** Owns erasure order. Child addresses remain durable until every child acknowledges. */
export class GatewayDeletion {
  constructor(private readonly host: Kernel) {}

  async quiesce(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const state = this.host.retirement.begin(input);
    if (state.phase === "live-erased") return this.status(input);
    for (const socket of this.host.ctx.getWebSockets()) socket.close(1008, "Installation retired");
    if (state.phase === "quiescing") {
      for (const [id, request] of this.host.transport.activeRequests) {
        this.host.transport.cancelRequest(request.origin, id, "Installation retired", false);
      }
    }
    await Promise.allSettled([...this.host.transport.routedBodies.values()].map((body) => body.cancel("Installation retired")));
    for (const row of this.resources("live")) {
      const result = await this.resource(row).quiesceInstallationResource(input);
      this.accept(input, row, result, "quiesced");
    }
    if (this.count("live")) return this.receipt(input, "quiescing", "progress");
    await this.host.retirement.drain();
    if (await this.host.retirement.abortMultipart(this.host.env.STORAGE)) return this.receipt(input, "quiescing", "progress");
    await this.host.retirement.quiesced();
    const ripgit = await this.ripgit(input, "quiesce");
    if (ripgit && ripgit.phase === "quiescing") return this.receipt(input, "quiescing", "progress");
    if (!this.inventoryComplete()) return this.receipt(input, "quiescing", "missing-inventory");
    return this.receipt(input, "quiesced", "progress");
  }

  async erase(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const state = this.host.retirement.begin(input);
    if (state.phase === "live-erased") return this.status(input);
    if (state.phase !== "quiesced" || this.count("live")) return this.receipt(input, "quiescing", "progress");
    if (!this.inventoryComplete()) return this.receipt(input, "quiescing", "missing-inventory");
    for (const row of this.resources("quiesced")) {
      const result = await this.resource(row).eraseInstallationResource(input);
      this.accept(input, row, result, "live-erased");
    }
    if (this.count("quiesced")) return this.receipt(input, "erasing", "progress");
    const ripgit = await this.ripgit(input, "erase");
    if (ripgit && ripgit.phase !== "live-erased") return this.receipt(input, "erasing", "progress");
    // Always start at the prefix head: deleting a page must not invalidate a saved list cursor.
    const prefix = installationStoragePrefix(input.installationId);
    if (!prefix) throw new Error("Unscoped standalone storage cannot be erased by installation cleanup");
    const page = await this.host.env.STORAGE.list({ prefix, limit: 1000 });
    if (page.objects.length) {
      await this.host.env.STORAGE.delete(page.objects.map((object) => object.key));
      return this.receipt(input, "erasing", "progress");
    }
    this.host.retirement.erase();
    return this.status(input);
  }

  status(input: InstallationDeletionRequest): InstallationDeletionReceipt {
    const state = this.host.retirement.state;
    if (!state) return { ...input, phase: "pending", updatedAt: Date.now(), pendingResources: 1, outcome: "progress", retainedCopies: [] };
    this.host.retirement.begin(input);
    if (state.phase === "live-erased") {
      const expiresAt = state.updatedAt + backupLifetimeMs;
      return {
        ...input,
        phase: Date.now() >= expiresAt ? "erased" : "live-erased",
        updatedAt: state.updatedAt,
        pendingResources: 0,
        outcome: Date.now() >= expiresAt ? "complete" : "retention-pending",
        retainedCopies: Date.now() >= expiresAt ? [] : [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }],
      };
    }
    return this.receipt(input, this.inventoryComplete() ? state.phase : "quiescing", this.inventoryComplete() ? "progress" : "missing-inventory");
  }

  private resources(state: Resource["state"]): Resource[] {
    return this.host.retirement.raw.sql.exec<Resource>("SELECT kind, resource_id, state FROM installation_resources WHERE state = ? ORDER BY kind, resource_id LIMIT ?", state, batchSize).toArray();
  }

  private count(state: Resource["state"]): number {
    return this.host.retirement.raw.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM installation_resources WHERE state = ?", state).one().count;
  }

  private resource(row: Resource): ResourceRetirementService {
    if (row.kind === "process") {
      const stub = this.host.env.PROCESS.getByName(processDurableObjectName(this.host.installationId, row.resource_id));
      return {
        quiesceInstallationResource: (input) => stub.quiesceInstallationResource(input),
        eraseInstallationResource: (input) => stub.eraseInstallationResource(input),
      };
    }
    const stub = this.host.env.CONVERSATION.getByName(conversationDurableObjectName(this.host.installationId, row.resource_id));
    return {
      quiesceInstallationResource: (input) => stub.quiesceInstallationResource(input),
      eraseInstallationResource: (input) => stub.eraseInstallationResource(input),
    };
  }

  private accept(input: InstallationDeletionRequest, row: Resource, result: ResourceRetirement, expected: "quiesced" | "live-erased"): void {
    if (result.operationId !== input.operationId || result.installationId !== input.installationId || result.version !== 1) throw new Error("Resource retirement receipt mismatch");
    if (result.phase !== expected && result.phase !== "live-erased") return;
    this.host.retirement.raw.sql.exec("UPDATE installation_resources SET state = ? WHERE kind = ? AND resource_id = ?", result.phase, row.kind, row.resource_id);
  }

  private inventoryComplete(): boolean {
    return this.host.retirement.raw.kv.get<{ inventoriedSinceBirth: boolean }>(RESOURCE_IDENTITY_KEY)?.inventoriedSinceBirth === true
      || this.host.retirement.raw.kv.get(VERIFIED_INVENTORY_KEY) !== undefined;
  }

  private receipt(input: InstallationDeletionRequest, phase: InstallationDeletionReceipt["phase"], outcome: InstallationDeletionReceipt["outcome"]): InstallationDeletionReceipt {
    return {
      ...input, phase, outcome, updatedAt: Date.now(), retainedCopies: [],
      pendingResources: this.count("live") + this.count("quiesced") + 1,
    };
  }

  private async ripgit(input: InstallationDeletionRequest, action: "quiesce" | "erase") {
    if (!this.host.env.RIPGIT) return null;
    const response = await this.host.env.RIPGIT.fetch(`https://ripgit.invalid/.gsv/installation/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Ripgit retirement failed (${response.status})`);
    }
    const receipt = ripgitProgressSchema.parse(await response.json());
    if (receipt.installationId !== input.installationId || receipt.operationId !== input.operationId) throw new Error("Ripgit retirement receipt mismatch");
    return receipt;
  }
}
