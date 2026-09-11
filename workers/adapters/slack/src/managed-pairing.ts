import { DurableObject } from "cloudflare:workers";
import type { AdapterPairingActivateInput, AdapterPairingPrepareInput } from "./types";
import type { AdapterGatewayService } from "../../../../packages/gsv/src/services/adapters.js";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { AdapterPairingClaim, type AdapterPairingClaimState } from "../../shared/src/pairing-claim";
import { AdapterRetirement } from "../../shared/src/retirement";
import { AdapterPairingRetirement } from "../../shared/src/pairing-retirement";
import type { ManagedSlackPeer } from "./managed-peer";
import type { SlackInstallation } from "./lifecycle";

import { requireSlackId } from "./slack-api";
import { managedSlackPeerObjectName, requireWorkspaceAccountId } from "./managed-identity";

export type ManagedSlackPairingRecord = AdapterPairingClaimState & {
  version: 1;
  claimId: string;
  accountId: string;
  actorId: string;
  expiresAt: number;
  operationId?: string;
  stage?: "prepared" | "active" | "finalized";
  retainUntil?: number;
  cleanup?: {
    operationId: string;
    accountId: string;
    actorId: string;
    surfaceId: string;
    installationId: string;
    localUid: number;
    generation: string;
  };
  cleanupComplete?: boolean;
};

export interface ManagedSlackPairingEnv {
  MANAGED_SLACK_PEER: DurableObjectNamespace<ManagedSlackPeer>;
  SLACK_INSTALLATIONS: DurableObjectNamespace<SlackInstallation>;
  GATEWAY: Fetcher & AdapterGatewayService;
}

const RECORD_KEY = "managed_slack_pairing:v1";

export class ManagedSlackPairing extends DurableObject<ManagedSlackPairingEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly lifecycle = new AdapterPairingRetirement<ManagedSlackPairingRecord>(this.ctx.storage, this.retirement, RECORD_KEY);
  private readonly claim = new AdapterPairingClaim<ManagedSlackPairingRecord>(
    this.ctx.storage, RECORD_KEY, (record) => managedSlackPeerObjectName(record.accountId, record.actorId),
    // SAFETY: the managed peer namespace is owned by this worker and exposes the pairing RPCs.
    (name) => this.env.MANAGED_SLACK_PEER.getByName(name), this.env.GATEWAY,
    (task) => this.ctx.waitUntil(task), this.retirement,
  );

  async initialize(input: ManagedSlackPairingRecord) {
    if (!this.ctx.id.name) throw new Error("Slack pairing name is unavailable");
    return await this.claim.initialize({ ...normalizeRecord(input), resourceName: this.ctx.id.name, owner: null });
  }
  async inspect() { return await this.claim.inspect(); }
  async prepare(input: AdapterPairingPrepareInput) {
    const release = this.retirement.start({ installationId: input.installationId, generation: input.operationId });
    try {
      if (!this.ctx.id.name) throw new Error("Slack pairing name is unavailable");
      await this.env.SLACK_INSTALLATIONS.getByName(input.installationId).registerResource({ kind: "adapter-pairing", name: this.ctx.id.name, objectId: this.ctx.id.toString(), generation: input.operationId });
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

function normalizeRecord(input: ManagedSlackPairingRecord): ManagedSlackPairingRecord {
  if (input.version !== 1 || !input.claimId || input.claimId.length > 200) {
    throw new Error("Slack pairing record is invalid");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("Slack pairing record is invalid");
  }
  return {
    ...input,
    accountId: requireWorkspaceAccountId(input.accountId),
    actorId: requireSlackId(input.actorId, "Slack actor"),
  };
}
