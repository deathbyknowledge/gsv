import type { AdapterAccountStatus } from "../../shared/src/types";
import { DiscordGateway } from "./discord-gateway";
import { discordGuildSchema, discordReadyPayloadSchema, type DiscordDispatchPayload, type DiscordMessagePayload } from "./discord-events";
import { discordAccount, discordActor, discordId, discordPeerName } from "./shared-identity";
import type { DiscordPeer } from "./shared-peer";
import type { DiscordPairing } from "./shared-pairing";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import type { ManagedAdapterGatewayService } from "../../../../packages/gsv/src/protocol/managed.js";

export interface SharedDiscordEnv {
  DISCORD_APPLICATION: DurableObjectNamespace<DiscordApplication>;
  DISCORD_PEER: DurableObjectNamespace<DiscordPeer>;
  DISCORD_PAIRING: DurableObjectNamespace<DiscordPairing>;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_API?: Fetcher;
  GATEWAY: Fetcher & AdapterGatewayBinding & ManagedAdapterGatewayService;
}

/** One operator-owned provider connection. It never accepts an installation route or a human token. */
export class DiscordApplication extends DiscordGateway {
  constructor(ctx: DurableObjectState, private readonly applicationEnv: SharedDiscordEnv) { super(ctx, applicationEnv); }

  async ensureStarted(): Promise<void> {
    const applicationId = this.applicationId();
    await this.loadState();
    await this.startConnection(discordAccount(applicationId));
  }

  override async start(): Promise<void> { throw new Error("Discord application credentials are operator-owned"); }
  override async getBotToken(): Promise<null> { return null; }
  protected override connectionBotToken(): string | null { return this.applicationEnv.DISCORD_BOT_TOKEN?.trim() || null; }
  protected override connectionIntents(): number { return (1 << 0) | (1 << 9) | (1 << 12); }
  protected override async notifyGatewayStatus(_status: AdapterAccountStatus): Promise<void> {}

  protected override async handleDispatch(eventType: string, data: DiscordDispatchPayload): Promise<void> {
    if (eventType === "READY" && discordReadyPayloadSchema.parse(data).application?.id !== this.applicationId()) {
      throw new Error("Discord application identity mismatch");
    }
    if (eventType === "GUILD_CREATE" || eventType === "GUILD_DELETE") {
      const guild = discordGuildSchema.parse(data);
      const id = discordId(guild.id);
      await this.ctx.storage.put(`guild:${id}`, {
        id, name: guild.name, available: eventType === "GUILD_CREATE", observedAt: Date.now(),
      });
      return;
    }
    await super.handleDispatch(eventType, data);
  }

  protected override async handleMessageCreate(message: DiscordMessagePayload): Promise<void> {
    const author = message.author;
    if (!author || author.bot) return;
    const applicationId = this.applicationId();
    discordId(message.id);
    discordId(message.channel_id);
    if (message.guild_id) {
      const guild = await this.ctx.storage.get<{ available: boolean }>(`guild:${discordId(message.guild_id)}`);
      if (!guild?.available) return;
    }
    const accountId = discordAccount(applicationId, message.guild_id);
    const actorId = discordActor(author.id);
    const bot = await this.ctx.storage.get<{ id: string }>("botUser");
    if (!bot) throw new Error("Discord application is not ready");
    const mentioned = (message.mentions ?? []).some((mention) => mention.id === bot.id)
      || message.referenced_message?.author?.id === bot.id;
    if (message.guild_id && !mentioned) return;
    await this.applicationEnv.DISCORD_PEER.getByName(discordPeerName(accountId, actorId)).receive({
      accountId, actorId, message, mentioned,
    });
  }

  private applicationId(): string {
    const id = discordId(this.applicationEnv.DISCORD_APPLICATION_ID ?? "");
    if (this.ctx.id.name !== `application:${id}`) throw new Error("Discord application Durable Object identity mismatch");
    if (!this.connectionBotToken()) throw new Error("Discord application is not configured");
    return id;
  }
}

export function sharedDiscordConfigured(env: SharedDiscordEnv): boolean {
  return /^[1-9][0-9]{0,19}$/.test(env.DISCORD_APPLICATION_ID ?? "") && Boolean(env.DISCORD_BOT_TOKEN?.trim());
}
