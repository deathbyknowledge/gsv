import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import { parseAdapterInstallationContext } from "../../shared/src/installation";
import type {
  AdapterAccountStatus, AdapterDeliveryContext, AdapterInstallationContext, AdapterPairingActivateInput,
  AdapterPairingCandidate, AdapterPairingDisconnectInput, AdapterPairingDisconnectResult, AdapterPairingInfo,
  AdapterPairingPreparation, AdapterPairingPrepareInput, AdapterService, AdapterServiceDescriptor, GatewayRequestFrame, GatewayResponseFrame,
} from "../../shared/src/types";
import { sharedDiscordConfigured, type SharedDiscordEnv } from "./shared-application";
import { discordAccount, discordId, discordPairingCode, discordPeerName, discordUser, parseDiscordAccount } from "./shared-identity";
export { DiscordApplication } from "./shared-application";
export { DiscordPeer } from "./shared-peer";
export { DiscordPairing } from "./shared-pairing";
// Retained namespace export for the reviewed legacy cutover; it is never used by the shared entrypoint.
export { DiscordGateway } from "./discord-gateway";

export class SharedDiscordChannel extends WorkerEntrypoint<SharedDiscordEnv> implements AdapterService {
  readonly adapterId = "discord";
  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return { version: 1, id: "discord", displayName: "Discord", capabilities: {
      connect: false, disconnect: false, send: true, status: true, activity: false, pairing: true,
      surfaces: ["dm", "group"], media: { inbound: ["image", "audio", "video", "document"], outbound: ["image", "audio", "video", "document"] },
    } };
  }
  async adapterFrame(installation: AdapterInstallationContext, context: AdapterDeliveryContext, frame: GatewayRequestFrame): Promise<GatewayResponseFrame> {
    try {
      parseInstallation(installation);
      const peer = this.peer(context.accountId, context.actorId ?? "");
      return await handleAdapterFrame("discord", context, frame, { send: (delivery, body) => peer.sendMessage(installation.installationId, delivery.message, body, context) });
    } catch (error) { await cancelBinaryBody(frame.body, error); throw error; }
  }
  async adapterStatus(installation: AdapterInstallationContext, accountId?: string): Promise<AdapterAccountStatus[]> {
    parseInstallation(installation);
    if (!sharedDiscordConfigured(this.env)) return [];
    if (accountId) parseDiscordAccount(accountId, this.applicationId());
    const status = await this.application().getStatus();
    return [{ ...status, accountId: accountId ?? discordAccount(this.applicationId()), authenticated: false, mode: "managed-shared" }];
  }
  async adapterPairingInfo(installation: AdapterInstallationContext): Promise<AdapterPairingInfo> {
    parseInstallation(installation);
    const configured = sharedDiscordConfigured(this.env);
    if (!configured) return { accountId: "shared", configured: false };
    const applicationId = this.applicationId();
    this.ctx.waitUntil(this.application().ensureStarted());
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", applicationId);
    url.searchParams.set("scope", "bot");
    url.searchParams.set("permissions", "101376");
    return { accountId: discordAccount(applicationId), configured, installUrl: url.toString() };
  }
  async adapterPairingInspect(installation: AdapterInstallationContext, code: string): Promise<AdapterPairingCandidate> {
    parseInstallation(installation);
    return await this.pairing(code).inspect();
  }
  async adapterPairingPrepare(installation: AdapterInstallationContext, input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation> {
    this.assertInstallation(installation, input.installationId);
    return await this.pairing(input.code).prepare(input);
  }
  async adapterPairingActivate(installation: AdapterInstallationContext, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    this.assertInstallation(installation, input.route.installationId);
    return await this.pairing(input.code).activate(input);
  }
  async adapterPairingFinalize(installation: AdapterInstallationContext, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    this.assertInstallation(installation, input.route.installationId);
    return await this.pairing(input.code).finalize(input);
  }
  async adapterPairingDisconnect(installation: AdapterInstallationContext, input: AdapterPairingDisconnectInput): Promise<AdapterPairingDisconnectResult> {
    this.assertInstallation(installation, input.installationId);
    return await this.peer(input.accountId, input.actorId).disconnect(input);
  }
  private applicationId(): string { return discordId(this.env.DISCORD_APPLICATION_ID ?? ""); }
  private application() { return this.env.DISCORD_APPLICATION.getByName(`application:${this.applicationId()}`); }
  private peer(accountId: string, actorId: string) {
    parseDiscordAccount(accountId, this.applicationId());
    discordUser(actorId);
    return this.env.DISCORD_PEER.getByName(discordPeerName(accountId, actorId));
  }
  private pairing(code: string) { return this.env.DISCORD_PAIRING.getByName(`pair:${discordPairingCode(code)}`); }
  private assertInstallation(installation: AdapterInstallationContext, expected: string): void {
    if (parseInstallation(installation).installationId !== expected) throw new Error("Pairing installation does not match the caller");
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    return new URL(request.url).pathname === "/health" ? Response.json({ status: "ok", service: "gsv-channel-discord" }) : new Response("Not Found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: SharedDiscordEnv): Promise<void> {
    if (sharedDiscordConfigured(env)) await env.DISCORD_APPLICATION.getByName(`application:${discordId(env.DISCORD_APPLICATION_ID ?? "")}`).ensureStarted();
  },
} satisfies ExportedHandler<SharedDiscordEnv>;

function parseInstallation(installation: AdapterInstallationContext): AdapterInstallationContext {
  const parsed = parseAdapterInstallationContext(installation);
  if (parsed.installationId === "singleton") throw new Error("Shared Discord cannot address singleton");
  return parsed;
}
