import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { AdapterRetirement } from "../../shared/src/retirement";
import { AdapterPairingRetirement } from "../../shared/src/pairing-retirement";
import { DurableObject } from "cloudflare:workers";
import { AdapterPairingClaim, type AdapterPairingClaimRecord } from "../../shared/src/pairing-claim";
import type { AdapterPairingActivateInput, AdapterPairingPrepareInput } from "../../shared/src/types";
import type { SharedDiscordEnv } from "./shared-application";

export class DiscordPairing extends DurableObject<SharedDiscordEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly lifecycle = new AdapterPairingRetirement<AdapterPairingClaimRecord>(this.ctx.storage, this.retirement, "discord_pairing:v1");
  private readonly claim = new AdapterPairingClaim(this.ctx.storage, "discord_pairing:v1", (name) => this.env.DISCORD_PEER.getByName(name), this.env.GATEWAY, (task) => this.ctx.waitUntil(task), this.retirement);
  async initialize(input: AdapterPairingClaimRecord) { if (!this.ctx.id.name) throw new Error("Discord pairing name is unavailable"); return await this.claim.initialize({ ...input, resourceName: this.ctx.id.name, owner: null }); }
  async inspect() { return await this.claim.inspect(); }
  async prepare(input: AdapterPairingPrepareInput) {
    const release = this.retirement.start({ installationId: input.installationId, generation: input.operationId });
    try {
      if (!this.ctx.id.name) throw new Error("Discord pairing name is unavailable");
      await this.env.DISCORD_INSTALLATIONS.getByName(input.installationId).registerResource({ kind: "adapter-pairing", name: this.ctx.id.name, objectId: this.ctx.id.toString(), generation: input.operationId });
      return await this.claim.prepare(input);
    } finally { release(); }
  }
  async activate(input: AdapterPairingActivateInput) { const release = this.retirement.start(input.route); try { return await this.claim.activate(input); } finally { release(); } }
  async finalize(input: AdapterPairingActivateInput) { const release = this.retirement.start(input.route); try { return await this.claim.finalize(input); } finally { release(); } }
  async inspectInstallationResource(installationId: string) { return await this.lifecycle.inspect(installationId); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.quiesce(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.erase(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.lifecycle.status(input); }
  async alarm() { await this.claim.alarm(); }
}
