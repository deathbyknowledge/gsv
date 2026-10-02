import { DurableObject } from "cloudflare:workers";
import type { AdapterPairingActivateInput, AdapterPairingPrepareInput } from "./types";
import type { AdapterGatewayService } from "../../../../packages/gsv/src/services/adapters.js";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { AdapterPairingClaim, type AdapterPairingClaimState } from "../../shared/src/pairing-claim";
import { AdapterRetirement } from "../../shared/src/retirement";
import { AdapterPairingRetirement } from "../../shared/src/pairing-retirement";
import type { ManagedWhatsAppPeer } from "./managed-peer";
import type { WhatsAppInstallation } from "./lifecycle";
import { MANAGED_WHATSAPP_ACCOUNT_ID } from "./managed-peer-state";

export type ManagedWhatsAppPairingRecord = AdapterPairingClaimState & {
  version: 1;
  claimId: string;
  surfaceId: string;
  expiresAt: number;
  operationId?: string;
  stage?: "prepared" | "active" | "finalized";
  retainUntil?: number;
  cleanup?: {
    operationId: string;
    actorId: string;
    surfaceId: string;
    installationId: string;
    localUid: number;
    generation: string;
  };
  cleanupComplete?: boolean;
};

export interface ManagedWhatsAppPairingEnv {
  MANAGED_WHATSAPP_PEER: DurableObjectNamespace<ManagedWhatsAppPeer>;
  WHATSAPP_INSTALLATIONS: DurableObjectNamespace<WhatsAppInstallation>;
  GATEWAY: Fetcher & AdapterGatewayService;
}

const RECORD_KEY = "managed_whatsapp_pairing:v1";

export class ManagedWhatsAppPairing extends DurableObject<ManagedWhatsAppPairingEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly lifecycle = new AdapterPairingRetirement<ManagedWhatsAppPairingRecord>(this.ctx.storage, this.retirement, RECORD_KEY);
  private readonly claim = new AdapterPairingClaim<ManagedWhatsAppPairingRecord>(
    this.ctx.storage, RECORD_KEY, (record) => `managed:${record.surfaceId}`,
    // SAFETY: the managed peer namespace is owned by this worker and exposes the pairing RPCs.
    (name) => this.env.MANAGED_WHATSAPP_PEER.getByName(name), this.env.GATEWAY,
    (task) => this.ctx.waitUntil(task), this.retirement, MANAGED_WHATSAPP_ACCOUNT_ID,
  );

  async initialize(input: ManagedWhatsAppPairingRecord) {
    if (!this.ctx.id.name) throw new Error("WhatsApp pairing name is unavailable");
    return await this.claim.initialize({ ...input, resourceName: this.ctx.id.name, owner: null });
  }
  async inspect() { return await this.claim.inspect(); }
  async prepare(input: AdapterPairingPrepareInput) {
    const release = this.retirement.start({ installationId: input.installationId, generation: input.operationId });
    try {
      if (!this.ctx.id.name) throw new Error("WhatsApp pairing name is unavailable");
      await this.env.WHATSAPP_INSTALLATIONS.getByName(input.installationId).registerResource({ kind: "adapter-pairing", name: this.ctx.id.name, objectId: this.ctx.id.toString(), generation: input.operationId });
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
