import { DurableObject } from "cloudflare:workers";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { cancelBinaryBody } from "../../shared/src/media-body";
import type { AdapterOutboundMessage, AdapterSendResult, BinaryBody } from "../../shared/src/types";
import { DiscordAccountRetirement } from "./discord-account-retirement";

interface Env { DISCORD_GATEWAY?: Pick<DurableObjectNamespace, "idFromName">; }

/** The historical class and namespace retain cleanup ownership, with no provider transport. */
export class DiscordGateway extends DurableObject<Env> {
  private readonly retirement: DiscordAccountRetirement;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.retirement = new DiscordAccountRetirement(ctx.storage, ctx.id.toString(), env.DISCORD_GATEWAY);
  }

  async inspectInstallationResource(installationId: string, candidates?: string[]) {
    return this.retirement.inspect(installationId, candidates);
  }
  async quiesceInstallation(input: InstallationDeletionRequest) {
    return await this.retirement.quiesce(input, () => {});
  }
  async eraseInstallation(input: InstallationDeletionRequest) {
    await this.quiesceInstallation(input);
    return this.retirement.erase(input);
  }
  async installationDeletionStatus(input: InstallationDeletionRequest) {
    return this.retirement.status(input);
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAlarm(); }
  async start(_botToken?: string, _accountId?: string): Promise<never> {
    throw new Error("Legacy Discord account transport is retired");
  }
  async getBotToken(): Promise<null> { return null; }
  async sendMessage(_message: AdapterOutboundMessage, body?: BinaryBody): Promise<AdapterSendResult> {
    await cancelBinaryBody(body, "Legacy Discord account transport is retired");
    return { ok: false, error: "Legacy Discord account transport is retired" };
  }
}
