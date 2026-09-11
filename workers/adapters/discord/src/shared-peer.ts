import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import { AdapterRetirement } from "../../shared/src/retirement";
import { AdapterPeerRetirement } from "../../shared/src/peer-retirement";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import { InboundDeliveryLedger, adapterInboundResultDisposition, type InboundDeliveryDisposition } from "../../shared/src/inbound-delivery";
import { activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing, type AdapterPeerLink, type AdapterPeerPairing, type AdapterPeerRoute } from "../../shared/src/pairing-route";
import { callAdapterGateway } from "../../shared/src/gateway-rpc";
import { cancelBinaryBody, cancelResponseBody } from "../../shared/src/media-body";
import type { AdapterDeliveryContext, AdapterOutboundMessage, AdapterPairingActivateInput, AdapterPairingCandidate, AdapterPairingDisconnectInput, AdapterPairingPreparation, AdapterPairingPrepareInput, AdapterSendResult, AdapterSurface, BinaryBody } from "../../shared/src/types";
import { deliverDiscordMessage } from "./discord-delivery";
import { extractDiscordMedia } from "./discord-inbound-media";
import { discordMessagePayloadSchema, type DiscordMessagePayload } from "./discord-events";
import { discordActor, discordId, discordPeerName, discordUser, newDiscordPairingCode, parseDiscordAccount } from "./shared-identity";
import type { SharedDiscordEnv } from "./shared-application";

export type DiscordPeerInbound = { accountId: string; actorId: string; message: DiscordMessagePayload; mentioned: boolean };
type PeerState = AdapterPeerLink & {
  version: 1; accountId: string; actorId: string; actorName: string; dmSurfaceId?: string;
  observedSurfaces: AdapterSurface[];
};
type Inbound = DiscordPeerInbound & { generation?: string };
type ResponseContext = { kind: "route"; installationId: string; generation: string } | { kind: "pairing"; claimId: string };
const STATE_KEY = "discord_peer:v1";
const RETRY_MS = 10_000;
const routeSchema = z.object({ installationId: z.string().trim().min(1).max(200), localUid: z.number().int().min(1000), generation: z.string().trim().min(1).max(200) });

/** The only Discord owner that can associate a provider actor with a space. */
export class DiscordPeer extends DurableObject<SharedDiscordEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly deliveries = new DeliveryLedger(this.ctx.storage, { retirement: this.retirement });
  private readonly inbound = new InboundDeliveryLedger<Inbound, ResponseContext>(this.ctx.storage, "discord_peer:inbound:", {
    retirement: this.retirement, completedRetentionMs: 7 * 24 * 60 * 60 * 1000, maxRecords: 4096, pendingOrder: "key",
  });
  private readonly lifecycle = new AdapterPeerRetirement<PeerState>(this.ctx.storage, this.retirement, {
    stateKey: STATE_KEY, inboundPrefix: "discord_peer:inbound:", inbound: this.inbound, outbound: this.deliveries, hil: false,
    identity: (state) => ({ name: discordPeerName(state.accountId, state.actorId), understood: state.version === 1
      && Object.keys(state).every((key) => ["version", "accountId", "actorId", "actorName", "dmSurfaceId", "observedSurfaces", "activeRoute", "pairing", "lastDisconnect"].includes(key)) }),
  });
  private draining?: Promise<void>;

  async inspectInstallationResource(installationId: string) { return await this.lifecycle.inspect(installationId); }
  async quiesceInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.quiesce(input); }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.erase(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.lifecycle.status(input); }

  async receive(input: DiscordPeerInbound): Promise<void> {
    const message = discordMessagePayloadSchema.parse(input.message);
    const account = parseDiscordAccount(input.accountId, this.applicationId());
    if (!message.author || message.author.bot || discordActor(message.author.id) !== input.actorId
      || (account.guildId ?? "") !== (message.guild_id ?? "")
      || this.ctx.id.name !== discordPeerName(input.accountId, input.actorId)) throw new Error("Discord peer identity mismatch");
    discordId(message.id);
    discordId(message.channel_id);
    const surface: AdapterSurface = { kind: account.guildId ? "group" : "dm", id: message.channel_id };
    const owner = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<PeerState>(STATE_KEY);
      const state: PeerState = {
        ...current, version: 1, accountId: input.accountId, actorId: input.actorId, actorName: message.author!.username,
        dmSurfaceId: surface.kind === "dm" ? surface.id : current?.dmSurfaceId,
        observedSurfaces: [surface, ...(current?.observedSurfaces ?? []).filter((old) => old.id !== surface.id)].slice(0, 128),
      };
      await txn.put(STATE_KEY, state);
      return state.activeRoute;
    });
    if (this.retirement.retired(owner)) return;
    await this.inbound.enqueueAndArm(message.id, { ...input, message, generation: owner?.generation }, Date.now() + 25, owner ?? null);
    this.ctx.waitUntil(this.drain());
  }

  async sendMessage(installationId: string, message: AdapterOutboundMessage, body?: BinaryBody, context?: AdapterDeliveryContext): Promise<AdapterSendResult> {
    let state: PeerState;
    try { state = await this.state(); } catch (error) { await cancelBinaryBody(body, error); throw error; }
    if (!state.activeRoute || state.activeRoute.installationId !== installationId || state.activeRoute.generation !== message.routeGeneration) {
      await cancelBinaryBody(body, "Discord route changed before delivery");
      return { ok: false, error: "Discord route changed before delivery" };
    }
    const rendered = context?.hil ? { ...message, text: `${message.text}\n\nOpen your GSV: ${state.activeRoute.canonicalOrigin}` } : message;
    return await this.deliver(rendered, { kind: "route", installationId, generation: state.activeRoute.generation }, body);
  }

  async inspectPairing(claimId: string, expiresAt: number): Promise<AdapterPairingCandidate> {
    const state = await this.state();
    const pairing = state.pairing;
    if (!pairing || pairing.claimId !== claimId || pairing.expiresAt !== expiresAt) throw new Error("Pairing code is invalid");
    if (pairing.status === "pending" && expiresAt <= Date.now()) throw new Error("Pairing code expired");
    return candidate(state, expiresAt);
  }

  async preparePairing(claimId: string, expiresAt: number, input: AdapterPairingPrepareInput): Promise<AdapterPairingPreparation> {
    const route: AdapterPeerRoute = { ...routeSchema.parse({ ...input, generation: crypto.randomUUID() }), canonicalOrigin: canonicalOrigin(input.canonicalOrigin), linkedAt: Date.now() };
    const current = await this.state();
    await this.env.DISCORD_INSTALLATIONS.getByName(input.installationId).registerResource({
      kind: "adapter-peer", name: discordPeerName(current.accountId, current.actorId), objectId: this.ctx.id.toString(), generation: route.generation,
    });
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(route);
      const state = await txn.get<PeerState>(STATE_KEY);
      if (!state) throw new Error("Discord peer is not initialized");
      const prepared = state.pairing?.operationId === input.operationId ? state.pairing.preparedRoute : undefined;
      if (prepared && (prepared.installationId !== route.installationId || prepared.localUid !== route.localUid)) {
        throw new Error("Pairing operation identity changed");
      }
      const next = prepareAdapterPairing(state, { claimId, expiresAt, operationId: input.operationId, route: prepared ?? route, now: Date.now() }, "Discord");
      await txn.put(STATE_KEY, next.state);
      return preparation(next.state, next.pairing);
    });
  }

  async activatePairing(claimId: string, expiresAt: number, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    return await this.transition(claimId, expiresAt, input, "activate");
  }
  async finalizePairing(claimId: string, expiresAt: number, input: AdapterPairingActivateInput): Promise<AdapterPairingPreparation> {
    return await this.transition(claimId, expiresAt, input, "finalize");
  }
  private async transition(claimId: string, expiresAt: number, input: AdapterPairingActivateInput, phase: "activate" | "finalize"): Promise<AdapterPairingPreparation> {
    const route: AdapterPeerRoute = { ...routeSchema.parse(input.route), canonicalOrigin: canonicalOrigin(input.canonicalOrigin), linkedAt: Date.now() };
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<PeerState>(STATE_KEY);
      if (!state) throw new Error("Discord peer is not initialized");
      this.retirement.requireLive(route);
      const next = (phase === "activate" ? activateAdapterPairing : finalizeAdapterPairing)(state, { claimId, expiresAt, operationId: input.operationId, route });
      await txn.put(STATE_KEY, next.state);
      return preparation(next.state, next.pairing);
    });
  }

  async disconnect(input: AdapterPairingDisconnectInput): Promise<{ disconnected: boolean }> {
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<PeerState>(STATE_KEY);
      if (!state) return { disconnected: false };
      if (state.accountId !== input.accountId || state.actorId !== input.actorId || state.dmSurfaceId !== input.surfaceId) throw new Error("Discord peer identity mismatch");
      const result = disconnectAdapterPeer(state, { operationId: input.operationId, route: routeSchema.parse(input) }, "Discord");
      await txn.put(STATE_KEY, result.state);
      return { disconnected: result.disconnected };
    });
  }

  async sendPairingConfirmation(operationId: string, origin: string): Promise<void> {
    const state = await this.state();
    const route = state.activeRoute;
    if (!route || state.pairing?.operationId !== operationId || !state.dmSurfaceId) return;
    await this.deliver({ deliveryId: `paired:${operationId}`, surface: { kind: "dm", id: state.dmSurfaceId }, actorId: state.actorId, text: `Connected to your GSV: ${canonicalOrigin(origin)}` }, { kind: "route", installationId: route.installationId, generation: route.generation });
  }

  async alarm(): Promise<void> {
    await this.inbound.armIfPending(Date.now() + RETRY_MS);
    await this.drain();
  }
  private async drain(): Promise<void> {
    if (this.draining) return await this.draining;
    const running = (async () => {
      await this.inbound.armIfPending(Date.now() + RETRY_MS);
      for (const id of await this.inbound.pendingIds(25)) {
        const outcome = await this.inbound.attempt(id, (payload) => this.forward(payload), (message, context) => {
          if (!context) throw new Error("Discord response has no owning context");
          return this.deliver(message, context);
        });
        if (outcome.state === "pending") break;
      }
    })();
    this.draining = running;
    try { await running; } finally { if (this.draining === running) this.draining = undefined; }
  }

  private async forward(input: Inbound): Promise<InboundDeliveryDisposition<ResponseContext>> {
    const state = await this.state();
    const text = (input.message.content ?? "").replace(/^<@!?[0-9]+>\s*/, "").trim();
    if (/^\/?(?:pair|connect)$/i.test(text) || !input.generation && !state.activeRoute) return await this.pairingResponse(input);
    const route = state.activeRoute;
    if (!route || !input.generation || route.generation !== input.generation) return { terminal: true };
    const media = await extractDiscordMedia(input.message, this.providerFetch());
    const surface: AdapterSurface = { kind: input.message.guild_id ? "group" : "dm", id: input.message.channel_id };
    const context: ResponseContext = { kind: "route", installationId: route.installationId, generation: route.generation };
    if (!await this.current(context, { surface, actorId: state.actorId })) { await cancelBinaryBody(media.body, "Discord route changed before ingress"); return { terminal: true }; }
    const result = await callAdapterGateway(this.env.GATEWAY, { installationId: route.installationId }, "adapter.inbound", {
      adapter: "discord", accountId: state.accountId, deliveryId: input.message.id, routeGeneration: route.generation,
      message: {
        messageId: input.message.id, surface, actor: { id: state.actorId, name: state.actorName },
        text: text || "[Media]", media: media.media, wasMentioned: input.mentioned,
        replyToId: input.message.message_reference?.message_id, timestamp: input.message.timestamp ? Date.parse(input.message.timestamp) : Date.now(),
      },
    }, media.body);
    const disposition = adapterInboundResultDisposition(result, { surface, providerMessageId: input.message.id });
    return { ...disposition, responses: disposition.responses?.map((response) => ({ ...response, message: { ...response.message, actorId: state.actorId }, context })) };
  }

  private async pairingResponse(input: Inbound): Promise<InboundDeliveryDisposition<ResponseContext>> {
    let state = await this.ensureDm();
    let pairing = state.pairing;
    if (pairing?.status === "prepared" || pairing?.status === "active") return { terminal: true };
    if (!pairing || pairing.status !== "pending" || pairing.expiresAt <= Date.now()) {
      const issue: AdapterPeerPairing = { code: newDiscordPairingCode(), claimId: crypto.randomUUID(), expiresAt: Date.now() + 10 * 60 * 1000, status: "pending" };
      const result = await this.env.DISCORD_PAIRING.getByName(`pair:${issue.code}`).initialize({
        version: 1, claimId: issue.claimId, peerName: discordPeerName(state.accountId, state.actorId), expiresAt: issue.expiresAt,
      });
      if (!result.created) throw new Error("Discord pairing code collision");
      state = await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get<PeerState>(STATE_KEY);
        if (!current || current.pairing?.claimId !== pairing?.claimId || current.pairing?.status !== pairing?.status) throw new Error("Discord pairing changed");
        const next = { ...current, pairing: issue };
        await txn.put(STATE_KEY, next);
        return next;
      });
      pairing = issue;
    }
    return { terminal: true, responses: [{
      message: {
        deliveryId: `pair:${pairing.claimId}:${input.message.id}`, surface: { kind: "dm", id: state.dmSurfaceId! }, actorId: state.actorId,
        text: `Connect this Discord identity to your GSV.\n\nPairing code: ${pairing.code.match(/.{4}/g)!.join("-")}\n\nOpen your GSV → Messengers → Discord, enter the code, and confirm the identity shown there. This code expires in 10 minutes.`,
      }, expiresAt: pairing.expiresAt, context: { kind: "pairing", claimId: pairing.claimId },
    }] };
  }

  private async ensureDm(): Promise<PeerState> {
    const state = await this.state();
    if (state.dmSurfaceId) return state;
    const response = await this.providerFetch()("https://discord.com/api/v10/users/@me/channels", {
      method: "POST", headers: this.headers(), body: JSON.stringify({ recipient_id: discordUser(state.actorId) }),
    });
    if (!response.ok) { await cancelResponseBody(response, "Discord direct message unavailable"); throw new Error("Discord direct message unavailable"); }
    const dm = z.object({ id: z.string() }).parse(await response.json());
    const id = discordId(dm.id);
    return await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<PeerState>(STATE_KEY);
      if (!current) throw new Error("Discord peer is not initialized");
      const next: PeerState = { ...current, dmSurfaceId: id, observedSurfaces: [{ kind: "dm", id } satisfies AdapterSurface, ...current.observedSurfaces].slice(0, 128) };
      await txn.put(STATE_KEY, next);
      return next;
    });
  }

  private async deliver(message: AdapterOutboundMessage, context: ResponseContext, body?: BinaryBody): Promise<AdapterSendResult> {
    const owner = context.kind === "route" ? context : null;
    let release: (() => void) | undefined;
    try {
      release = this.retirement.start(owner);
      if (!await this.current(context, message)) { await cancelBinaryBody(body, "Discord route changed before delivery"); return { ok: false, error: "Discord route changed before delivery" }; }
      return await deliverDiscordMessage(this.deliveries, this.env.DISCORD_BOT_TOKEN ?? null, message, body, {
        providerFetch: this.providerFetch(), isCurrent: () => this.current(context, message), owner,
        signal: owner ? this.retirement.signal(owner) : undefined,
      });
    } catch (error) { await cancelBinaryBody(body, error); throw error; }
    finally { release?.(); }
  }
  private async current(context: ResponseContext, message: Pick<AdapterOutboundMessage, "surface" | "actorId">): Promise<boolean> {
    if (context.kind === "route" && this.retirement.retired(context)) return false;
    const state = await this.state();
    if (message.actorId !== state.actorId || !state.observedSurfaces.some((surface) => surface.id === message.surface.id && surface.kind === message.surface.kind)) return false;
    return context.kind === "pairing" ? state.pairing?.claimId === context.claimId && state.pairing.status === "pending"
      : state.activeRoute?.installationId === context.installationId && state.activeRoute.generation === context.generation;
  }
  private async state(): Promise<PeerState> {
    const state = await this.ctx.storage.get<PeerState>(STATE_KEY);
    if (!state || this.ctx.id.name !== discordPeerName(state.accountId, state.actorId)) throw new Error("Discord peer is not initialized");
    parseDiscordAccount(state.accountId, this.applicationId());
    return state;
  }
  private applicationId(): string { return discordId(this.env.DISCORD_APPLICATION_ID ?? ""); }
  private providerFetch(): typeof fetch { return this.env.DISCORD_API ? this.env.DISCORD_API.fetch.bind(this.env.DISCORD_API) : fetch; }
  private headers(): Headers { return new Headers({ Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN ?? ""}`, "Content-Type": "application/json" }); }
}

function candidate(state: PeerState, expiresAt: number): AdapterPairingCandidate {
  if (!state.dmSurfaceId) throw new Error("Discord direct message is unavailable");
  return { accountId: state.accountId, actorId: state.actorId, actorName: state.actorName, surfaceId: state.dmSurfaceId, expiresAt, linked: Boolean(state.activeRoute), routeScope: "actor" };
}
function preparation(state: PeerState, pairing: AdapterPeerPairing): AdapterPairingPreparation {
  if (!pairing.preparedRoute) throw new Error("Discord pairing is not prepared");
  return { candidate: candidate(state, pairing.expiresAt), route: routeSchema.parse(pairing.preparedRoute), previousRoute: pairing.previousRoute ? routeSchema.parse(pairing.previousRoute) : undefined };
}
function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("Canonical origin is invalid");
  return value;
}
