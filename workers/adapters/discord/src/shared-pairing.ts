import { DurableObject } from "cloudflare:workers";
import { AdapterPairingClaim, type AdapterPairingClaimRecord } from "../../shared/src/pairing-claim";
import type { AdapterPairingActivateInput, AdapterPairingPrepareInput } from "../../shared/src/types";
import type { SharedDiscordEnv } from "./shared-application";

export class DiscordPairing extends DurableObject<SharedDiscordEnv> {
  private readonly claim = new AdapterPairingClaim(this.ctx.storage, "discord_pairing:v1", (name) => this.env.DISCORD_PEER.getByName(name), this.env.GATEWAY, (task) => this.ctx.waitUntil(task));
  async initialize(input: AdapterPairingClaimRecord) { return await this.claim.initialize(input); }
  async inspect() { return await this.claim.inspect(); }
  async prepare(input: AdapterPairingPrepareInput) { return await this.claim.prepare(input); }
  async activate(input: AdapterPairingActivateInput) { return await this.claim.activate(input); }
  async finalize(input: AdapterPairingActivateInput) { return await this.claim.finalize(input); }
  async alarm() { await this.claim.alarm(); }
}
