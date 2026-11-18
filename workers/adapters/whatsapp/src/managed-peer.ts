import { exceptionDiagnostics } from "../../../../packages/gsv/src/diagnostics.js";
import {
  AdapterRetirement,
  sameAdapterDataOwner,
  type AdapterDataOwner,
  type AdapterDataScope,
} from "../../shared/src/retirement";
import { AdapterPeerRetirement } from "../../shared/src/peer-retirement";
import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { InstallationDirectoryService } from "../../../../packages/gsv/src/services/directory.js";
import type { ManagedWhatsAppPairing } from "./managed-pairing";
import { DurableObject } from "cloudflare:workers";
import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
  MAX_DELIVERY_MESSAGE_IDS,
  type DeliveryClaim,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  adapterInboundRequiresPairing,
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
  type InboundDeliveryDisposition,
} from "../../shared/src/inbound-delivery";
import { splitTextAtLimit } from "../../shared/src/paragraph-messages";
import { runAdapterHilSqlMigrations } from "../../shared/src/schema/migrations";
import { callAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  cancelBinaryBody,
  readAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  validateAdapterMediaBody,
} from "../../shared/src/media-body";
import { adapterActionText, type AdapterSendAction } from "../../../../packages/gsv/src/protocol/adapters.js";
import { messageChoicesText } from "../../../../packages/gsv/src/protocol/message-choices.js";
import type {
  AdapterOutboundMessage,
  AdapterDeliveryContext,
  AdapterPairingActivateInput,
  AdapterPairingCandidate,
  AdapterPairingDisconnectInput,
  AdapterPairingPreparation,
  AdapterPairingPrepareInput,
  AdapterPairingRoute,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
} from "./types";
import {
  attachWhatsAppApprovalMessage,
  buildWhatsAppInteractivePayload,
  describeWhatsAppApproval,
  handleWhatsAppApprovalReply,
  prepareWhatsAppApproval,
  WHATSAPP_INTERACTIVE_BODY_LIMIT,
  type WhatsAppApprovalControls,
} from "./whatsapp-approval";
import { buildWhatsAppChoicesPayload, whatsAppChoicesControl } from "./whatsapp-choices";
import { managedWhatsAppTemplate, type ManagedWhatsAppTemplateEnv } from "./managed-config";
import {
  buildWhatsAppTemplatePayload,
  WHATSAPP_NO_TEMPLATE_ERROR,
  WHATSAPP_TEMPLATE_BUTTON_LABEL,
  WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR,
} from "./whatsapp-template";
import { retireWhatsAppOutbox } from "./whatsapp-upgrade";
import type { ManagedWhatsAppPairingEnv } from "./managed-pairing";
import type { AdapterPairingLinkBinding } from "../../shared/src/pairing-claim";
import {
  isPairingLinkMessage,
  messengerSignupUrl,
  pairingLinkCode,
  shipHost,
} from "../../shared/src/pairing-link";
import {
  answersLinkMove,
  keepsLink,
  platformReplies,
  type PlatformReplies,
} from "../../shared/src/platform-replies";
import { whatsAppReplyLanguage } from "./whatsapp-address";
import {
  activateManagedWhatsAppPairing,
  bindManagedWhatsAppPeerIdentity,
  disconnectManagedWhatsAppPeer,
  finalizeManagedWhatsAppPairing,
  MANAGED_WHATSAPP_ACCOUNT_ID,
  pairingCandidate,
  prepareManagedWhatsAppPairing,
  whatsAppWindowOpen,
  type ManagedWhatsAppPeerRoute,
  type ManagedWhatsAppPeerState,
} from "./managed-peer-state";
import {
  downloadWhatsAppMedia,
  lookupWhatsAppMedia,
  ManagedWhatsAppDeliveryError,
  markWhatsAppMessageRead,
  reactToWhatsAppMessage,
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  WHATSAPP_WINDOW_CLOSED_ERROR,
  type ManagedWhatsAppFetch,
  type WhatsAppOutboundPayload,
  type WhatsAppSentMessage,
} from "./whatsapp-api";
import {
  renderWhatsAppText,
  WHATSAPP_PARTITION,
  whatsAppPartition,
  whatsAppPartitionVersion,
  whatsAppPromptMessages,
  whatsAppTextMessages,
} from "./whatsapp-formatting";
import {
  loadWhatsAppInboundMedia,
  type WhatsAppInboundMediaLoadResult,
} from "./whatsapp-inbound-media";
import {
  sendWhatsAppMediaMessage,
  whatsAppCaptionFits,
  whatsAppMediaSupportsCaption,
} from "./whatsapp-outbound-media";
import {
  addressWhatsAppEvent,
  isManagedWhatsAppPairCommand,
  whatsAppDeliveryToken,
  whatsAppEventActor,
  type ManagedWhatsAppInbound,
  type ManagedWhatsAppPeerEvent,
  type WhatsAppApprovalReply,
  type WhatsAppTemplateTap,
} from "./whatsapp-webhook";

export interface ManagedWhatsAppPeerEnv extends ManagedWhatsAppPairingEnv, ManagedWhatsAppTemplateEnv {
  GATEWAY: Fetcher & AdapterGatewayBinding & ManagedWhatsAppPairingEnv["GATEWAY"];
  MANAGED_WHATSAPP_PAIRING: DurableObjectNamespace<ManagedWhatsAppPairing>;
  ACCOUNTS: InstallationDirectoryService;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_API?: Fetcher;
  GSV_SIGNUP_URL?: string;
}

type InboundPayload =
  | {
      kind: "message";
      inbound: ManagedWhatsAppInbound;
      routeGeneration?: string;
    }
  | {
      kind: "approval";
      reply: Extract<ManagedWhatsAppPeerEvent, { kind: "approval" }>["reply"];
      routeGeneration?: string;
    }
  | {
      kind: "release";
      tap: WhatsAppTemplateTap;
      routeGeneration?: string;
    }
  | {
      kind: "release-held";
      routeGeneration: string;
    };

type ResponseContext =
  | { kind: "platform"; claimId?: string; routeGeneration?: string | null }
  | { kind: "installation"; installationId: string; generation: string };

type DeliveryOptions = {
  splitParagraphs?: boolean;
  controls?: WhatsAppApprovalControls;
};
/** One provider message of a delivery; resolves to the WhatsApp message id it produced. */
type DeliveryPart = () => Promise<string | undefined>;
type ClaimedDelivery = Extract<DeliveryClaim, { claimed: true }>;
type FailDelivery = (kind: DeliveryFailureKind, detail?: string, cause?: unknown) => Promise<AdapterSendResult>;
type ManagedPairingStub = { bind(surfaceId: string): Promise<AdapterPairingLinkBinding | null> };
/** A link code bound to this sender, as the Kernel redeems it. */
type BoundLink = Pick<AdapterPairingLinkBinding, "claimId" | "expiresAt" | "installationId"> & { code: string };

const STATE_KEY = "managed_whatsapp_peer:v1:state";
/**
 * Kept by the peer named for a user ID that Meta first sent beside the number of a person this
 * adapter already knew by number: that person's peer holds their link and delivery history.
 */
const ALIAS_KEY = "managed_whatsapp_peer:v1:alias";
type ManagedWhatsAppPeerAlias = { version: 1; surfaceId: string };
const INBOUND_PREFIX = "managed_whatsapp_peer:v1:inbound:";
/** How often an unlinked sender hears how to connect; messages between are quiet. */
const HINT_INTERVAL_MS = 10 * 60 * 1000;
const INBOUND_WAKE_DELAY_MS = 25;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;
const INBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INBOUND_MAX_RECORDS = 4_096;

export class ManagedWhatsAppPeer extends DurableObject<ManagedWhatsAppPeerEnv> {
  private readonly retirement = new AdapterRetirement(this.ctx.storage);
  private readonly lifecycle: AdapterPeerRetirement<ManagedWhatsAppPeerState>;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<InboundPayload, ResponseContext>;
  private drainPromise?: Promise<void>;
  private workingReaction: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ManagedWhatsAppPeerEnv) {
    super(ctx, env);
    runAdapterHilSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage, { retirement: this.retirement });
    this.ctx.blockConcurrencyWhile(() => retireWhatsAppOutbox(this.ctx.storage));
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
      {
        retirement: this.retirement,
        completedRetentionMs: INBOUND_RETENTION_MS,
        maxRecords: INBOUND_MAX_RECORDS,
      },
    );
    this.lifecycle = new AdapterPeerRetirement(ctx.storage, this.retirement, {
      stateKey: STATE_KEY, inboundPrefix: INBOUND_PREFIX, inbound: this.inboundDeliveries,
      outbound: this.deliveries, hil: true,
      identity: (state) => ({ name: `managed:${state.surfaceId}`, understood: state.version === 1 && Boolean(state.actorId && state.surfaceId) }),
    });
  }

  async inspectInstallationResource(installationId: string) { return await this.lifecycle.inspect(installationId); }
  async quiesceInstallation(input: InstallationDeletionRequest) {
    const receipt = await this.lifecycle.quiesce(input);
    // A retired route can no longer stop its run's 👀, so quiescence clears it like a relink.
    // The cleanup keeps a 👀 owned by whichever route is still active.
    await this.clearWorkingReactionAfterRouteChange();
    return receipt;
  }
  async eraseInstallation(input: InstallationDeletionRequest) { return await this.lifecycle.erase(input); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return await this.lifecycle.status(input); }

  async handleWebhook(event: ManagedWhatsAppPeerEvent): Promise<{ ok: true }> {
    const knownAddress = await this.knownAddress(event);
    if (knownAddress) {
      const peer = this.env.MANAGED_WHATSAPP_PEER.getByName(`managed:${knownAddress}`);
      return await peer.handleWebhook(addressWhatsAppEvent(event, knownAddress));
    }
    const deliveryId = event.kind === "message"
      ? event.inbound.deliveryId
      : event.kind === "approval"
        ? `interactive:${whatsAppDeliveryToken(event.reply.interactionId)}`
        : `release:${whatsAppDeliveryToken(event.tap.interactionId)}`;
    const identity = event.kind === "message"
      ? event.inbound
      : event.kind === "approval"
        ? { ...event.reply, messageId: event.reply.interactionId }
        : { ...event.tap, messageId: event.tap.interactionId };
    const route = await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      // A stray button from a number that never messaged has nothing to resolve.
      if (!state && event.kind !== "message") return { skip: true as const };
      if (state && await this.inboundDeliveries.isRecorded(deliveryId, txn)) {
        return { skip: false as const, route: state.activeRoute, move: state.linkMove };
      }
      const next = bindManagedWhatsAppPeerIdentity(state, identity, Date.now());
      await txn.put(STATE_KEY, next);
      return { skip: false as const, route: next.activeRoute, move: next.linkMove };
    });
    if (route.skip || this.retirement.retired(route.route)) return { ok: true };
    const routeGeneration = route.route?.generation;
    let payload: InboundPayload;
    if (event.kind === "message") {
      payload = { kind: "message", inbound: event.inbound, routeGeneration };
    } else if (event.kind === "approval") {
      payload = { kind: "approval", reply: event.reply, routeGeneration };
    } else {
      payload = { kind: "release", tap: event.tap, routeGeneration };
    }
    await this.inboundDeliveries.enqueueAndArm(
      deliveryId,
      payload,
      Date.now() + INBOUND_WAKE_DELAY_MS,
      route.route ?? null,
    );
    // Connecting, or answering whether to move to another Ship, goes ahead of the queue, so a
    // reply still waiting on Meta or the Ship does not hold it up.
    const text = event.kind === "message" ? event.inbound.text : "";
    if (event.kind === "message" && (isManagedWhatsAppPairCommand(text) || pairingLinkCode(text) || answersLinkMove(route.move, text))) {
      await this.attemptInbound(deliveryId);
    }
    this.ctx.waitUntil(this.drainInbound());
    return { ok: true };
  }

  /** The number of the peer this user ID's sender was first known by, once recorded. */
  async aliasedAddress(): Promise<string | null> {
    return (await this.ctx.storage.get<ManagedWhatsAppPeerAlias>(ALIAS_KEY))?.surfaceId ?? null;
  }

  /** Whether anyone has messaged the platform number under this peer's address. */
  async knowsSender(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get<ManagedWhatsAppPeerState>(STATE_KEY));
  }

  /**
   * The address of the peer that already knew this event's sender by number, when this peer is
   * named for the user ID Meta now sends beside that number. The answer is kept, so later events
   * reach that peer even when Meta withholds the number. A user ID that came alone first, and only
   * heard how to connect, still joins that peer; one with a connection of its own keeps it.
   */
  private async knownAddress(event: ManagedWhatsAppPeerEvent): Promise<string | null> {
    const alias = await this.ctx.storage.get<ManagedWhatsAppPeerAlias>(ALIAS_KEY);
    if (alias) return alias.surfaceId;
    const { phoneNumber } = whatsAppEventActor(event);
    if (!phoneNumber || holdsConnection(await this.ctx.storage.get<ManagedWhatsAppPeerState>(STATE_KEY))) return null;
    if (!await this.env.MANAGED_WHATSAPP_PEER.getByName(`managed:${phoneNumber}`).knowsSender()) return null;
    return await this.ctx.storage.transaction(async (txn) => {
      // Another event may have connected this user ID's own peer meanwhile.
      if (holdsConnection(await txn.get<ManagedWhatsAppPeerState>(STATE_KEY))) return null;
      await txn.put(ALIAS_KEY, { version: 1, surfaceId: phoneNumber } satisfies ManagedWhatsAppPeerAlias);
      return phoneNumber;
    });
  }

  async sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    context?: AdapterDeliveryContext,
  ): Promise<AdapterSendResult> {
    let state: ManagedWhatsAppPeerState;
    try {
      state = await this.requireState();
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    const route = state.activeRoute;
    if (
      !route
      || route.installationId !== installationId
      || !message.routeGeneration
      || route.generation !== message.routeGeneration
    ) {
      await cancelBinaryBody(body, "WhatsApp route changed before delivery");
      return { ok: false, error: "WhatsApp route changed before delivery" };
    }
    try {
      this.retirement.requireLive(route);
      const approval = context?.hil ? describeWhatsAppApproval(context, context.hil) : null;
      const controls = approval ? await prepareWhatsAppApproval(this.ctx.storage, approval, route) : null;
      const { action: _action, ...withoutAction } = message;
      const renderedMessage = controls ? { ...withoutAction, text: controls.text } : message;
      const options: DeliveryOptions = {};
      if (approval && controls) {
        options.controls = controls;
      }
      const result = await this.deliverMessage(renderedMessage, {
        kind: "installation",
        installationId,
        generation: message.routeGeneration,
      }, body, options);
      // A template carries no approval controls, so it must not become the
      // provider message authorized to accept an approval callback.
      if (result.ok && controls) {
        await attachWhatsAppApprovalMessage(this.ctx.storage, controls.token, result.messageId);
      }
      return result;
    } catch (error) { await cancelBinaryBody(body, error); throw error; }
  }

  /**
   * Ship is working on `messageId`, the message that started run `runId`: mark it read and put 👀
   * on it. A stop removes the 👀 only while that run still owns it.
   */
  async setWorking(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    routeGeneration: string,
    active: boolean,
    runId: string,
    messageId?: string,
  ): Promise<{ accepted: boolean }> {
    const state = await this.requireState();
    this.assertPeerDestination(state, surface, actorId);
    if (
      state.activeRoute?.installationId !== installationId
      || state.activeRoute.generation !== routeGeneration
    ) {
      // Stopping never fails: a stale route has nothing of this run left to clear.
      return { accepted: !active };
    }
    const owner = { installationId, generation: routeGeneration };
    const release = this.retirement.start(owner);
    try {
      if (active && messageId) {
        try {
          await markWhatsAppMessageRead(this.accessToken(), this.phoneNumberId(), messageId, this.whatsAppFetch(owner));
        } catch {
          console.warn(JSON.stringify({
            component: "managed_whatsapp",
            event: "read_receipt_failed",
          }));
        }
      }
      const working = active && messageId && whatsAppWindowOpen(state, Date.now()) ? messageId : undefined;
      await this.moveWorkingReaction(working, runId, owner);
    } finally { release(); }
    return { accepted: true };
  }

  /**
   * WhatsApp shows typing only as a companion to a read receipt, so it rides the person's latest
   * message, which was already marked read when it arrived. Delivering the reply ends it.
   */
  async setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    routeGeneration: string,
  ): Promise<{ accepted: boolean }> {
    const state = await this.requireState();
    this.assertPeerDestination(state, surface, actorId);
    if (
      state.activeRoute?.installationId !== installationId
      || state.activeRoute.generation !== routeGeneration
    ) {
      return { accepted: false };
    }
    const owner = { installationId, generation: routeGeneration };
    if (state.lastInboundMessageId && whatsAppWindowOpen(state, Date.now())) {
      const release = this.retirement.start(owner);
      try {
        await markWhatsAppMessageRead(
          this.accessToken(),
          this.phoneNumberId(),
          state.lastInboundMessageId,
          this.whatsAppFetch(owner),
          { typing: true },
        );
      } catch {
        console.warn(JSON.stringify({
          component: "managed_whatsapp",
          event: "typing_delivery_failed",
        }));
      } finally { release(); }
    }
    return { accepted: true };
  }

  /**
   * Keeps 👀 on at most one message. Moves run one at a time, so a stop never
   * overtakes the start it clears. Reactions are best effort and never block delivery.
   */
  private moveWorkingReaction(
    target: string | undefined,
    runId: string | undefined,
    owner: AdapterDataScope,
  ): Promise<void> {
    const move = this.workingReaction.then(async () => {
      const state = await this.requireState();
      // A run's move applies only while its route is still active: a relink or disconnect may
      // have cleared 👀 while this move waited. The platform-scope cleanup after a route change
      // clears only a 👀 placed under another route; the new route's run may already own it.
      if (owner ? !sameAdapterDataOwner(owner, state.activeRoute)
        : state.activeRoute && sameAdapterDataOwner(state.workingReactionRoute, state.activeRoute)) return;
      const current = state.workingReactionMessageId;
      // A superseded run's stop can arrive after its successor started; it must not clear the successor's 👀.
      if (!target && runId && state.workingReactionRunId && state.workingReactionRunId !== runId) return;
      const react = async (messageId: string, emoji: string): Promise<"applied" | "ambiguous" | "throttled" | "failed"> => {
        try {
          await reactToWhatsAppMessage(
            this.accessToken(), this.phoneNumberId(), state.actorId, messageId, emoji, this.whatsAppFetch(owner),
          );
          return "applied";
        } catch (error) {
          const outcome = !(error instanceof ManagedWhatsAppDeliveryError) ? "failed"
            : error.kind === "ambiguous" ? "ambiguous"
              : error.rateLimited ? "throttled" : "failed";
          console.warn(JSON.stringify({
            component: "managed_whatsapp",
            event: "reaction_delivery_failed",
            action: emoji ? "add" : "remove",
            outcome,
            diagnostics: exceptionDiagnostics(error),
          }));
          return outcome;
        }
      };
      let next = current;
      if (target && current === target && runId !== state.workingReactionRunId) {
        // A new run on the message still recorded: an earlier removal with an unknown outcome
        // may have taken its 👀 off. Sending the same reaction again is harmless.
        await react(target, "👀");
      } else if (current !== target) {
        // A removal with an unknown outcome or a rate limit keeps its message recorded, so the next
        // start or stop retries it. One Meta refused is forgotten: retrying it would block every later 👀.
        const removal = current ? await react(current, "") : "applied";
        const cleared = removal === "applied" || removal === "failed";
        // Meta may have applied an addition whose outcome is unknown; removing an absent 👀 is harmless.
        if (cleared) {
          const addition = target ? await react(target, "👀") : "failed";
          next = addition === "applied" || addition === "ambiguous" ? target : undefined;
        }
      }
      const nextRunId = target ? runId : undefined;
      const nextRoute = target && owner
        ? { installationId: owner.installationId, generation: owner.generation }
        : next ? state.workingReactionRoute : undefined;
      try {
        await this.ctx.storage.transaction(async (txn) => {
          const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
          if (latest) {
            await txn.put(STATE_KEY, {
              ...latest, workingReactionMessageId: next, workingReactionRunId: nextRunId, workingReactionRoute: nextRoute,
            });
          }
        });
      } catch (error) {
        // Without its record no stop could find a 👀 just added, so take it back off.
        // A removal that went unrecorded is retried later, which is harmless.
        if (next && next !== current) await react(next, "");
        throw error;
      }
    });
    this.workingReaction = move.catch((error) => {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "reaction_record_failed",
        diagnostics: exceptionDiagnostics(error),
      }));
    });
    return this.workingReaction;
  }

  async inspectPairing(claimId: string, expiresAt: number): Promise<AdapterPairingCandidate> {
    const state = await this.requireState();
    const pairing = state.pairing;
    if (!pairing || pairing.claimId !== claimId || pairing.expiresAt !== expiresAt) {
      throw new Error("Pairing code is invalid");
    }
    if (pairing.status === "pending" && pairing.expiresAt <= Date.now()) {
      throw new Error("Pairing code expired");
    }
    return pairingCandidate(state, pairing.expiresAt);
  }

  async preparePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation> {
    const route: ManagedWhatsAppPeerRoute = {
      installationId: requireOpaque(input.installationId, "installationId"),
      localUid: requireLocalUid(input.localUid),
      generation: crypto.randomUUID(),
      canonicalOrigin: requireCanonicalOrigin(input.canonicalOrigin),
      linkedAt: Date.now(),
    };
    const current = await this.requireState();
    this.retirement.requireLive(route);
    await this.env.WHATSAPP_INSTALLATIONS.getByName(route.installationId).registerResource({ kind: "adapter-peer", name: `managed:${current.surfaceId}`, objectId: this.ctx.id.toString(), generation: route.generation });
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const existing = state.pairing?.preparedRoute;
      if (state.pairing?.operationId === input.operationId && existing && (existing.installationId !== route.installationId || existing.localUid !== route.localUid)) throw new Error("Pairing operation identity changed");
      const effectiveRoute = state.pairing?.operationId === input.operationId && existing
        ? existing
        : route;
      const prepared = prepareManagedWhatsAppPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route: effectiveRoute,
        now: Date.now(),
      });
      await txn.put(STATE_KEY, prepared.state);
      return prepared.preparation;
    });
  }

  async activatePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const route = routeWithOrigin(input.route, input.canonicalOrigin);
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const activated = activateManagedWhatsAppPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route,
      });
      await txn.put(STATE_KEY, activated.state);
      return activated.preparation;
    });
  }

  async finalizePairing(
    claimId: string,
    expiresAt: number,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation> {
    const route = routeWithOrigin(input.route, input.canonicalOrigin);
    const finalized = await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(route);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed WhatsApp peer is not initialized");
      const result = finalizeManagedWhatsAppPairing(state, {
        claimId,
        expiresAt,
        operationId: requireOpaque(input.operationId, "operationId"),
        route,
      });
      if (result.changed) await txn.put(STATE_KEY, result.state);
      return result;
    });
    if (finalized.changed) await this.clearWorkingReactionAfterRouteChange();
    return finalized.preparation;
  }

  async sendPairingConfirmation(operationId: string, canonicalOrigin: string): Promise<void> {
    const state = await this.requireState();
    const route = state.activeRoute;
    if (!route || state.pairing?.operationId !== operationId) return;
    const result = await this.deliverMessage({
      deliveryId: `managed-paired:${operationId}`,
      surface: { kind: "dm", id: state.surfaceId },
      actorId: state.actorId,
      text: replies(state).connected(requireCanonicalOrigin(canonicalOrigin)),
    }, {
      kind: "installation",
      installationId: route.installationId,
      generation: route.generation,
    });
    if (!result.ok && result.retryable) throw new Error("Pairing confirmation should be retried");
  }

  async disconnect(input: AdapterPairingDisconnectInput): Promise<{ disconnected: boolean }> {
    return await this.ctx.storage.transaction(async (txn) => {
      this.retirement.requireLive(input);
      const state = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!state) return { disconnected: false };
      if (state.actorId !== input.actorId || state.surfaceId !== input.surfaceId) {
        throw new Error("Managed WhatsApp peer identity mismatch");
      }
      const result = disconnectManagedWhatsAppPeer(state, {
        operationId: requireOpaque(input.operationId, "operationId"),
        route: parseRoute(input),
      });
      if (result.state !== state) await txn.put(STATE_KEY, result.state);
      return { disconnected: result.disconnected };
    }).then(async (result) => {
      if (result.disconnected) await this.clearWorkingReactionAfterRouteChange();
      return result;
    });
  }

  /**
   * A run on the previous route can no longer stop its 👀: its stop is refused as stale.
   * The platform clears the reaction itself when the route changes.
   */
  private async clearWorkingReactionAfterRouteChange(): Promise<void> {
    await this.moveWorkingReaction(undefined, undefined, null);
  }

  async alarm(): Promise<void> {
    await this.drainInbound();
    await this.inboundDeliveries.armIfPending(Date.now() + INBOUND_RETRY_DELAY_MS);
  }

  private async drainInbound(): Promise<void> {
    if (this.drainPromise) return await this.drainPromise;
    const running = (async () => {
      const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
      for (const deliveryId of ids) {
        if (!await this.attemptInbound(deliveryId)) break;
      }
    })();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  private async attemptInbound(deliveryId: string): Promise<boolean> {
    const result = await this.inboundDeliveries.attempt(
      deliveryId,
      async (payload) => await this.forwardInbound(payload),
      async (message, context) => await this.deliverMessage(
        message,
        context ?? { kind: "platform" },
        undefined,
        { splitParagraphs: false },
      ),
    );
    if (result.state !== "pending") return true;
    await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
    return false;
  }

  /** A reaction on the person's tap; like the 👀, it is best effort and never retries the decision. */
  private async acknowledgeApproval(reply: WhatsAppApprovalReply, emoji: string, route: ManagedWhatsAppPeerRoute): Promise<void> {
    try {
      await reactToWhatsAppMessage(
        this.accessToken(), this.phoneNumberId(), reply.actorId, reply.interactionId, emoji, this.whatsAppFetch(route),
      );
    } catch (error) {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "reaction_delivery_failed",
        action: "acknowledge_approval",
        diagnostics: exceptionDiagnostics(error),
      }));
    }
  }

  private async forwardInbound(
    payload: InboundPayload,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    // Retire old internal replay receipts without sending anything. The
    // canonical conversation already retains those messages.
    if (payload.kind === "release-held") return { terminal: true };
    if (payload.kind === "release") {
      if (!payload.routeGeneration) return { terminal: true };
      const { tap } = payload;
      payload = {
        kind: "message",
        routeGeneration: payload.routeGeneration,
        inbound: {
          deliveryId: `release:${whatsAppDeliveryToken(tap.interactionId)}`,
          messageId: tap.interactionId,
          actorId: tap.actorId,
          surfaceId: tap.surfaceId,
          text: tap.text ?? WHATSAPP_TEMPLATE_BUTTON_LABEL,
          replyToId: tap.providerMessageId,
          timestamp: tap.timestamp,
          unsupportedContent: false,
        },
      };
    }
    if (payload.kind === "approval") {
      const state = await this.requireState();
      const route = state.activeRoute;
      if (!route || this.retirement.retired(route) || !payload.routeGeneration || route.generation !== payload.routeGeneration) {
        return { terminal: true };
      }
      const answer = await handleWhatsAppApprovalReply(
        this.ctx.storage,
        this.env.GATEWAY,
        { installationId: route.installationId },
        payload.reply,
      );
      if (!answer) return { terminal: true };
      if (answer.kind === "acknowledge") {
        await this.acknowledgeApproval(payload.reply, answer.emoji, route);
        return { terminal: true };
      }
      return {
        terminal: true,
        responses: [{
          message: {
            deliveryId: `managed-approval:${whatsAppDeliveryToken(payload.reply.interactionId)}`,
            surface: { kind: "dm", id: payload.reply.surfaceId },
            actorId: payload.reply.actorId,
            text: answer.text,
            replyToId: payload.reply.providerMessageId,
          },
          context: { kind: "installation", installationId: route.installationId, generation: route.generation },
        }],
      };
    }
    const { inbound } = payload;
    const state = await this.requireState();
    if (!payload.routeGeneration) {
      // Nobody is linked yet: the platform answers on its own behalf.
      if (inbound.unsupportedContent) {
        return platformResponse(inbound, `managed-unsupported:${inbound.deliveryId}`, replies(inbound).unsupported, { kind: "platform" });
      }
      return await this.linkResponse(inbound, null) ?? await this.pairingResponse(inbound, null, false);
    }
    const active = state.activeRoute;
    const route = active && !this.retirement.retired(active) && active.generation === payload.routeGeneration ? active : null;
    if (route) await this.markRead(inbound.messageId, route);
    // A link's code, or the answer to moving, is the platform's to settle even once the route that
    // admitted it has changed, so a retry still finishes a connection that replaced that route.
    const link = await this.linkResponse(inbound, active?.generation ?? payload.routeGeneration);
    if (link) return link;
    if (!route) return { terminal: true };
    // Replies to a linked person's message belong to the route that admitted
    // it, so a delayed delivery cannot cross a relink.
    const linked: ResponseContext = { kind: "installation", installationId: route.installationId, generation: route.generation };
    if (isManagedWhatsAppPairCommand(inbound.text)) {
      return await this.pairingResponse(inbound, route.generation, true);
    }
    if (inbound.unsupportedContent) {
      return platformResponse(inbound, `managed-unsupported:${inbound.deliveryId}`, replies(inbound).unsupported, linked);
    }

    let transfer: WhatsAppInboundMediaLoadResult;
    try {
      transfer = await loadWhatsAppInboundMedia(inbound.media ?? [], {
        lookupMedia: async (mediaId) => await lookupWhatsAppMedia(
          this.accessToken(),
          mediaId,
          this.phoneNumberId(),
          this.whatsAppFetch(route),
        ),
        downloadMedia: async (url, expectedSize, maxBytes) => await downloadWhatsAppMedia(
          this.accessToken(),
          url,
          expectedSize,
          maxBytes,
          this.whatsAppFetch(route),
        ),
      });
    } catch (error) {
      // Media Meta no longer serves will not appear on retry; the person hears
      // that now instead of their later messages waiting behind this one.
      // Transient failures propagate and retry through the inbound ledger.
      if (error instanceof ManagedWhatsAppDeliveryError && error.kind === "permanent") {
        return platformResponse(inbound, `managed-media-unavailable:${inbound.deliveryId}`, replies(inbound).mediaUnavailable, linked);
      }
      throw error;
    }
    if (inbound.media?.length && transfer.media.length === 0) {
      return platformResponse(inbound, `managed-media-unavailable:${inbound.deliveryId}`, replies(inbound).mediaUnavailable, linked);
    }

    const current = await this.requireState();
    const currentRoute = current.activeRoute;
    if (
      !currentRoute
      || this.retirement.retired(route)
      || currentRoute.installationId !== route.installationId
      || currentRoute.generation !== route.generation
    ) {
      await cancelBinaryBody(transfer.body, "WhatsApp route changed before media delivery");
      return { terminal: true };
    }

    const result = await callAdapterGateway(
      this.env.GATEWAY,
      { installationId: route.installationId },
      "adapter.inbound",
      {
        adapter: "whatsapp",
        accountId: MANAGED_WHATSAPP_ACCOUNT_ID,
        deliveryId: inbound.deliveryId,
        routeGeneration: route.generation,
        message: {
          messageId: inbound.messageId,
          surface: {
            kind: "dm",
            id: inbound.surfaceId,
            name: current.actorName,
            handle: current.actorHandle,
          },
          actor: {
            id: inbound.actorId,
            name: current.actorName,
            handle: current.actorHandle,
          },
          text: inbound.text,
          media: transfer.media.length > 0 ? transfer.media : undefined,
          replyToId: inbound.replyToId,
          timestamp: inbound.timestamp,
          wasMentioned: true,
        },
      },
      transfer.body,
    );
    if (this.retirement.retired(route)) return { terminal: true };
    if (adapterInboundRequiresPairing(result)) {
      return await this.pairingResponse(inbound, route.generation, false);
    }
    const disposition = adapterInboundResultDisposition(result, {
      surface: { kind: "dm", id: inbound.surfaceId },
      providerMessageId: inbound.messageId,
      actorId: inbound.actorId,
    });
    return {
      terminal: disposition.terminal,
      error: disposition.error,
      responses: disposition.responses?.map((response) => ({
          ...response,
          context: {
            kind: "installation" as const,
            installationId: route.installationId,
            generation: route.generation,
          },
        })),
    };
  }

  /**
   * Tells a sender without a working link how to connect, or where they are connected when they
   * ask. An unlinked sender hears it at most once in a while; the platform number never
   * answers every stray message.
   */
  private async pairingResponse(
    inbound: ManagedWhatsAppInbound,
    routeGeneration: string | null,
    linked: boolean,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    const state = await this.requireState();
    if (!this.isCurrentPairingRoute(state, routeGeneration)) return { terminal: true };
    if (pairingInProgress(state)) {
      return platformResponse(
        inbound,
        `managed-pairing-in-progress:${state.pairing.claimId}:${inbound.deliveryId}`,
        replies(inbound).inProgress,
        { kind: "platform", claimId: state.pairing.claimId, routeGeneration },
      );
    }
    if (linked && state.activeRoute) {
      return platformResponse(
        inbound,
        `managed-linked:${inbound.deliveryId}`,
        replies(inbound).linked(shipHost(state.activeRoute.canonicalOrigin)),
        { kind: "platform", routeGeneration },
      );
    }
    const now = Date.now();
    const hint = await this.ctx.storage.transaction(async (txn) => {
      const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!latest || (latest.hintedAt !== undefined && now - latest.hintedAt < HINT_INTERVAL_MS)) return false;
      await txn.put(STATE_KEY, { ...latest, hintedAt: now } satisfies ManagedWhatsAppPeerState);
      return true;
    });
    if (!hint) return { terminal: true };
    const text = replies(inbound).unlinked(messengerSignupUrl(this.env.GSV_SIGNUP_URL, "whatsapp"));
    return platformResponse(inbound, `managed-unlinked:${inbound.deliveryId}`, text, { kind: "platform", routeGeneration });
  }

  /**
   * Answers a message that carries a link code, or the sender's answer to whether to move to
   * the Ship whose link they sent. Null when the message is neither, or when a linked sender
   * mentions a code that is no live link: that message is ordinary conversation for their Ship.
   */
  private async linkResponse(
    inbound: ManagedWhatsAppInbound,
    routeGeneration: string | null,
  ): Promise<InboundDeliveryDisposition<ResponseContext> | null> {
    const context: ResponseContext = { kind: "platform", routeGeneration };
    const state = await this.requireState();
    const move = state.linkMove;
    // The delivery whose "Move it" is connecting still answers the question once it has expired.
    if (move && (move.answeredBy === inbound.deliveryId || answersLinkMove(move, inbound.text))) {
      const keep = keepsLink(inbound.text);
      const answered = await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
        const open = latest?.linkMove;
        if (!latest || open?.claimId !== move.claimId) return false;
        // Another tap while a move connects changes nothing; the answering delivery's retry carries on.
        if (open.answeredBy !== undefined) return open.answeredBy === inbound.deliveryId;
        if (keep) {
          const { linkMove: _kept, ...rest } = latest;
          await txn.put(STATE_KEY, rest satisfies ManagedWhatsAppPeerState);
        } else {
          // The question stays open until the Kernel answers, so a retry after a failed call still reads as the answer.
          await txn.put(STATE_KEY, { ...latest, linkMove: { ...open, answeredBy: inbound.deliveryId } } satisfies ManagedWhatsAppPeerState);
        }
        return true;
      });
      if (!answered) return { terminal: true };
      if (keep) {
        return platformResponse(inbound, `managed-link-kept:${inbound.deliveryId}`, replies(inbound).kept(move.current), context);
      }
      const settled = await this.redeemLink(inbound, move, routeGeneration);
      await this.closeLinkMove(move.claimId);
      return settled;
    }
    const code = pairingLinkCode(inbound.text);
    if (!code) return null;
    const binding = await this.pairing(code).bind(state.surfaceId);
    if (!binding) {
      return routeGeneration && !isPairingLinkMessage(inbound.text)
        ? null
        : platformResponse(inbound, `managed-link-unavailable:${inbound.deliveryId}`, replies(inbound).unavailable, context);
    }
    const active = state.activeRoute;
    if (active && (active.installationId !== binding.installationId || active.localUid !== binding.localUid)) {
      // Moving to another Ship takes the person's tap, so a link someone else sent cannot move them quietly.
      const current = shipHost(active.canonicalOrigin);
      await this.ctx.storage.transaction(async (txn) => {
        const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
        if (!latest) throw new Error("Managed WhatsApp peer is not initialized");
        await txn.put(STATE_KEY, {
          ...latest,
          linkMove: { code, claimId: binding.claimId, expiresAt: binding.expiresAt, installationId: binding.installationId, current },
        } satisfies ManagedWhatsAppPeerState);
      });
      return platformResponse(
        inbound,
        `managed-link-move:${binding.claimId}:${inbound.deliveryId}`,
        replies(inbound).move(current, shipHost(binding.canonicalOrigin)),
        context,
        [...replies(inbound).moveChoices],
      );
    }
    return await this.redeemLink(inbound, { ...binding, code }, routeGeneration);
  }

  /** Closes the question about moving to another Ship once the Kernel has answered it. */
  private async closeLinkMove(claimId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!latest || latest.linkMove?.claimId !== claimId) return;
      const { linkMove: _closed, ...rest } = latest;
      await txn.put(STATE_KEY, rest satisfies ManagedWhatsAppPeerState);
    });
  }

  /**
   * Hands a code bound to this sender to the Kernel that minted it. The Kernel reads the pending
   * pairing back through the claim and connects this sender; its confirmation names the Ship.
   * A failed call throws, so the code's message is delivered again.
   */
  private async redeemLink(
    inbound: ManagedWhatsAppInbound,
    link: BoundLink,
    routeGeneration: string | null,
  ): Promise<InboundDeliveryDisposition<ResponseContext>> {
    const context: ResponseContext = { kind: "platform", routeGeneration };
    const pending = await this.ctx.storage.transaction(async (txn) => {
      const latest = await txn.get<ManagedWhatsAppPeerState>(STATE_KEY);
      if (!latest) throw new Error("Managed WhatsApp peer is not initialized");
      if (latest.pairing?.claimId === link.claimId) return true;
      if (pairingInProgress(latest)) return false;
      await txn.put(STATE_KEY, {
        ...latest,
        pairing: { claimId: link.claimId, code: link.code, expiresAt: link.expiresAt, status: "pending" },
      } satisfies ManagedWhatsAppPeerState);
      return true;
    });
    if (!pending) {
      return platformResponse(inbound, `managed-pairing-in-progress:${link.claimId}:${inbound.deliveryId}`, replies(inbound).inProgress, context);
    }
    const result = await this.env.GATEWAY.redeemAdapterPairing({ installationId: link.installationId }, { code: link.code });
    if (result.paired) return { terminal: true };
    return platformResponse(
      inbound,
      `managed-link-refused:${link.claimId}:${inbound.deliveryId}`,
      result.reason === "unavailable" ? replies(inbound).unavailable : replies(inbound).refused(result.message),
      context,
    );
  }

  private async deliverMessage(
    message: AdapterOutboundMessage,
    context: ResponseContext,
    body?: BinaryBody,
    options: DeliveryOptions = {},
  ): Promise<AdapterSendResult> {
    const owner = context.kind === "installation" ? context : null;
    let release: () => void;
    try { release = this.retirement.start(owner); }
    catch (error) { await cancelBinaryBody(body, error); throw error; }
    try { return await this.deliverOwnedMessage(message, context, owner, body, options); }
    finally { release(); }
  }

  private async deliverOwnedMessage(
    message: AdapterOutboundMessage, context: ResponseContext, owner: AdapterDataScope,
    body?: BinaryBody, options: DeliveryOptions = {},
  ): Promise<AdapterSendResult> {
    let state: ManagedWhatsAppPeerState;
    try {
      state = await this.requireState();
      this.assertPeerDestination(state, message.surface, message.actorId);
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    // A response bound to a route that has since changed is dropped for good:
    // retrying it would never make it valid and would hold up later inbound.
    const staleContext = this.deliveryContextIssue(state, context);
    if (staleContext) {
      await cancelBinaryBody(body, staleContext);
      return { ok: false, error: staleContext };
    }
    const media = message.media ?? [];
    // WhatsApp opens only https links from a button, and a button cannot ride on media.
    const linkButton = message.action && media.length === 0 && new URL(message.action.url).protocol === "https:"
      ? message.action
      : undefined;
    // Choices need an interactive message of their own, so beside media or an action they join the text.
    const choices = message.choices && media.length === 0 && !message.action ? whatsAppChoicesControl(message.choices) : null;
    const offered = message.choices && !choices ? messageChoicesText(message.text, message.choices) : message.text;
    const text = (message.action && !linkButton ? adapterActionText(offered, message.action) : offered).trim();
    if (!text && media.length === 0) {
      await cancelBinaryBody(body, "Managed WhatsApp requires text or media");
      return { ok: false, error: "Managed WhatsApp requires text or media" };
    }
    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "WhatsApp media body is invalid",
      };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        signal: owner ? this.retirement.signal(owner) : undefined,
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch {
      return { ok: false, error: "Could not read WhatsApp media body", retryable: true };
    }

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery(
        whatsAppFingerprintMessage(message, options),
        mediaBytes,
      );
    } catch {
      return { ok: false, error: "Could not fingerprint WhatsApp delivery", retryable: true };
    }
    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, fingerprint, owner);
    } catch {
      return { ok: false, error: "WhatsApp delivery ledger unavailable", retryable: true };
    }
    if (!claim.claimed) return claim.result;
    // A delivery that already sent part of itself resumes with the partition it began with.
    const partition = claim.progress.sent > 0 ? whatsAppPartition(claim.progress.formatVersion) : WHATSAPP_PARTITION;
    const legacyGrouping = partition === "legacy";
    const grouping = legacyGrouping || options.splitParagraphs !== false ? partition : null;

    const fail: FailDelivery = async (kind, detail, cause) => {
      const error = detail ?? `WhatsApp delivery failed (${kind})`;
      const diagnostics = exceptionDiagnostics(cause ?? error);
      if (kind === "retryable") {
        await this.deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
        return { ok: false, error, retryable: true, diagnostics };
      }
      if (kind === "ambiguous") {
        try {
          await this.deliveries.failAmbiguous(message.deliveryId, claim.attemptId, error, diagnostics);
        } catch {
          // The durable attempting receipt already prevents replay if this write fails.
        }
        return { ok: false, error, ambiguous: true, diagnostics };
      }
      await this.deliveries.failPermanent(message.deliveryId, claim.attemptId, error, diagnostics);
      return { ok: false, error, diagnostics };
    };

    // Platform pairing responses require an open window. Kernel deliveries
    // can use the operator's approved template instead.
    const fallbackOwner = owner;
    let sentInAttempt = 0;
    let attemptedProviderSend = false;
    let current = state;
    try {
      current = await this.requireState();
      this.assertPeerDestination(current, message.surface, message.actorId);
      const issue = this.deliveryContextIssue(current, context);
      if (issue) throw new Error(issue);
      if (!whatsAppWindowOpen(current, Date.now())) {
        if (!fallbackOwner || claim.progress.sent > 0) return await fail("permanent", WHATSAPP_WINDOW_CLOSED_ERROR);
        return await this.deliverOutsideWindow(message, fallbackOwner, claim, options, fail, current);
      }
      const token = this.accessToken();
      const phoneNumberId = this.phoneNumberId();
      const fetcher = this.whatsAppFetch(owner, context);
      const to = current.surfaceId;
      const replyToId = whatsAppMessageId(message.replyToId);
      // Only the first provider message quotes the inbound message.
      const send = async (payload: WhatsAppOutboundPayload, index: number): Promise<WhatsAppSentMessage> => {
        const quoted = index === 0 && replyToId ? { ...payload, context: { message_id: replyToId } } : payload;
        return await sendWhatsAppMessage(token, phoneNumberId, quoted, fetcher);
      };
      const parts: DeliveryPart[] = [];
      const addPart = (part: (index: number) => Promise<WhatsAppSentMessage>): void => {
        const index = parts.length;
        parts.push(async () => (await part(index)).messageId);
      };
      const addText = (body: string): void => {
        addPart((index) => send({ to, type: "text", text: { preview_url: true, body } }, index));
      };
      // The provider id reported for the delivery: the message that carries
      // the approval buttons when there are any, otherwise the first message.
      let anchor = 0;
      if (options.controls) {
        const controls = options.controls;
        const prompts = whatsAppPromptMessages(controls.text, WHATSAPP_INTERACTIVE_BODY_LIMIT, legacyGrouping);
        for (const prompt of prompts.slice(0, -1)) addText(prompt);
        const last = prompts.at(-1) ?? controls.text;
        addPart((index) => send(buildWhatsAppInteractivePayload(to, { ...controls, text: last }), index));
        anchor = parts.length - 1;
      } else if (linkButton) {
        const bodies = whatsAppTextMessages(text, grouping);
        const last = bodies.at(-1) ?? text;
        const fits = [...last].length <= WHATSAPP_INTERACTIVE_BODY_LIMIT;
        for (const body of fits ? bodies.slice(0, -1) : bodies) addText(body);
        addPart((index) => send(buildWhatsAppLinkPayload(to, fits ? last : linkButton.label, linkButton), index));
      } else if (choices) {
        const bodies = whatsAppTextMessages(text, grouping);
        // The control rides on the paragraph that asks, which must fit an interactive body.
        const asked = splitTextAtLimit(bodies.at(-1) ?? text, WHATSAPP_INTERACTIVE_BODY_LIMIT);
        for (const body of [...bodies.slice(0, -1), ...asked.slice(0, -1)]) addText(body);
        addPart((index) => send(buildWhatsAppChoicesPayload(to, asked.at(-1) ?? text, choices), index));
      } else if (media.length === 0) {
        for (const body of whatsAppTextMessages(text, grouping)) addText(body);
      } else {
        const rendered = renderWhatsAppText(text);
        const captionOnFirst = Boolean(rendered)
          && whatsAppMediaSupportsCaption(media[0]!.type)
          && whatsAppCaptionFits(rendered);
        if (rendered && !captionOnFirst) {
          for (const body of whatsAppTextMessages(text, grouping)) addText(body);
        }
        const upload = (bytes: Uint8Array, mimeType: string, filename: string) =>
          uploadWhatsAppMedia(token, phoneNumberId, bytes, mimeType, filename, fetcher);
        for (const [mediaIndex, item] of media.entries()) {
          addPart((index) => sendWhatsAppMediaMessage(
            { upload, send: (payload) => send(payload, index) },
            to,
            item,
            mediaBytes[mediaIndex],
            mediaIndex === 0 && captionOnFirst ? rendered : undefined,
          ));
        }
      }

      // Every accepted part is recorded before the next provider call, so a
      // retry of this delivery resumes after the parts the person already has.
      let anchorMessageId = claim.progress.messageId;
      const messageIds = [...claim.progress.messageIds ?? []];
      for (let index = claim.progress.sent; index < parts.length; index += 1) {
        if (sentInAttempt > 0) await this.typingBetweenParts(current, fetcher);
        attemptedProviderSend = true;
        const messageId = await parts[index]!();
        sentInAttempt += 1;
        if (index === anchor) anchorMessageId = messageId;
        if (messageId) messageIds.push(messageId);
        await this.deliveries.recordProgress(message.deliveryId, claim.attemptId, {
          sent: index + 1,
          messageId: anchorMessageId,
          messageIds,
          formatVersion: whatsAppPartitionVersion(partition),
        });
      }
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, anchorMessageId, messageIds);
      return {
        ok: true,
        messageId: anchorMessageId,
        ...(messageIds.length > 1 ? { messageIds: messageIds.slice(0, MAX_DELIVERY_MESSAGE_IDS) } : undefined),
      };
    } catch (error) {
      if (error instanceof ManagedWhatsAppDeliveryError) {
        // Meta knows the window better than the local receipt: when it refuses
        // the first part, the template path takes the whole message.
        if (error.windowClosed && fallbackOwner && sentInAttempt === 0 && claim.progress.sent === 0) {
          return await this.deliverOutsideWindow(message, fallbackOwner, claim, options, fail, current);
        }
        // A definite rejection resumes at the first unsent part on retry; an
        // unknown provider outcome stays ambiguous and is never replayed.
        return await fail(error.kind, error.message, error);
      }
      return await fail(attemptedProviderSend ? "ambiguous" : "retryable", undefined, error);
    }
  }

  /** A template is a delivery, never a promise to replay an adapter-owned copy. */
  private async deliverOutsideWindow(
    message: AdapterOutboundMessage,
    owner: AdapterDataOwner,
    claim: ClaimedDelivery,
    options: DeliveryOptions,
    fail: FailDelivery,
    observed: ManagedWhatsAppPeerState,
  ): Promise<AdapterSendResult> {
    const template = managedWhatsAppTemplate(this.env);
    if (!template) return await fail("permanent", WHATSAPP_NO_TEMPLATE_ERROR);
    if (message.media?.length) return await fail("permanent", WHATSAPP_WINDOW_CLOSED_MEDIA_ERROR);
    // Templates cannot carry approval buttons. Direct the person to the
    // original request in GSV instead of attaching a fake interactive anchor.
    const offered = message.choices ? messageChoicesText(message.text, message.choices) : message.text;
    const text = options.controls
      ? "An action needs your approval. Open GSV to review it."
      : message.action ? adapterActionText(offered, message.action) : offered;
    let sent: WhatsAppSentMessage;
    try {
      sent = await sendWhatsAppMessage(
        this.accessToken(),
        this.phoneNumberId(),
        buildWhatsAppTemplatePayload(observed.surfaceId, template, text),
        this.whatsAppFetch(owner),
      );
    } catch (error) {
      return await fail(
        error instanceof ManagedWhatsAppDeliveryError ? error.kind : "ambiguous",
        error instanceof ManagedWhatsAppDeliveryError ? error.message : undefined,
        error,
      );
    }
    try {
      const messageId = options.controls ? undefined : sent.messageId;
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
      return { ok: true, messageId };
    } catch (error) {
      return await fail("ambiguous", undefined, error);
    }
  }

  /** WhatsApp shows typing only as a companion to the read receipt of the person's last message. */
  private async typingBetweenParts(state: ManagedWhatsAppPeerState, fetcher: ManagedWhatsAppFetch): Promise<void> {
    if (!state.lastInboundMessageId) return;
    try {
      await markWhatsAppMessageRead(
        this.accessToken(),
        this.phoneNumberId(),
        state.lastInboundMessageId,
        fetcher,
        { typing: true },
      );
    } catch {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "typing_delivery_failed",
      }));
    }
  }

  private async markRead(messageId: string, route: ManagedWhatsAppPeerRoute): Promise<void> {
    try {
      await markWhatsAppMessageRead(this.accessToken(), this.phoneNumberId(), messageId, this.whatsAppFetch(route));
    } catch {
      console.warn(JSON.stringify({
        component: "managed_whatsapp",
        event: "read_receipt_failed",
      }));
    }
  }

  /** Why this delivery may no longer go out on its captured route or pairing, or null when it may. */
  private deliveryContextIssue(state: ManagedWhatsAppPeerState, context: ResponseContext): string | null {
    if (context.kind === "installation") {
      this.retirement.requireLive(context);
      if (
        state.activeRoute?.installationId !== context.installationId
        || state.activeRoute.generation !== context.generation
      ) {
        return "WhatsApp route changed before delivery";
      }
      return null;
    }
    if (context.claimId && state.pairing?.claimId !== context.claimId) {
      return "WhatsApp pairing changed before delivery";
    }
    if (context.routeGeneration !== undefined && !this.isCurrentPairingRoute(state, context.routeGeneration)) {
      return "WhatsApp route changed before delivery";
    }
    return null;
  }

  private isCurrentPairingRoute(state: ManagedWhatsAppPeerState, generation: string | null): boolean {
    return (state.activeRoute?.generation ?? null) === generation
      && (!state.activeRoute || !this.retirement.retired(state.activeRoute));
  }

  private assertPeerDestination(
    state: ManagedWhatsAppPeerState,
    surface: AdapterSurface,
    actorId: string | undefined,
  ): void {
    if (surface.kind !== "dm" || surface.id !== state.surfaceId || actorId !== state.actorId) {
      throw new Error("WhatsApp destination does not match this peer");
    }
  }

  private async requireState(): Promise<ManagedWhatsAppPeerState> {
    const state = await this.ctx.storage.get<ManagedWhatsAppPeerState>(STATE_KEY);
    if (!state) throw new Error("Managed WhatsApp peer is not initialized");
    return state;
  }

  private pairing(code: string): ManagedPairingStub {
    const id = this.env.MANAGED_WHATSAPP_PAIRING.idFromName(`pair:${code}`);
    return typedStub<ManagedPairingStub, DurableObjectStub<undefined>>(this.env.MANAGED_WHATSAPP_PAIRING.get(id));
  }

  private accessToken(): string {
    const value = this.env.WHATSAPP_ACCESS_TOKEN?.trim();
    if (!value) throw new Error("Managed WhatsApp access token is not configured");
    return value;
  }

  private phoneNumberId(): string {
    const value = this.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
    if (!value || !/^[0-9]{1,32}$/.test(value)) {
      throw new Error("Managed WhatsApp phone number id is not configured");
    }
    return value;
  }

  private whatsAppFetch(
    owner: AdapterDataScope = null,
    context: ResponseContext = owner ? { kind: "installation", ...owner } : { kind: "platform" },
  ): ManagedWhatsAppFetch {
    return async (input, init) => {
      let state: ManagedWhatsAppPeerState;
      try {
        state = await this.requireState();
      } catch {
        throw new ManagedWhatsAppDeliveryError("WhatsApp delivery route is unavailable", "retryable");
      }
      let issue: string | null;
      try {
        this.retirement.requireLive(owner);
        issue = this.deliveryContextIssue(state, context);
      } catch {
        issue = "WhatsApp route changed before delivery";
      }
      if (issue) throw new ManagedWhatsAppDeliveryError(issue, "permanent");
      const signal = owner ? this.retirement.signal(owner) : undefined;
      const request = { ...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal };
      return this.env.WHATSAPP_API ? this.env.WHATSAPP_API.fetch(input, request) : fetch(input, request);
    };
  }
}

function buildWhatsAppLinkPayload(to: string, body: string, action: AdapterSendAction): WhatsAppOutboundPayload {
  return {
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: body },
      action: { name: "cta_url", parameters: { display_text: action.label, url: action.url } },
    },
  };
}

function whatsAppFingerprintMessage(
  message: AdapterOutboundMessage,
  options: DeliveryOptions,
): AdapterOutboundMessage {
  if (!options.controls) return message;
  return {
    ...message,
    text: `${message.text}\n\n[gsv-whatsapp-controls:${JSON.stringify(options.controls.buttons)}]`,
  };
}

function typedStub<T, V = T>(value: V): T {
  // SAFETY: The Durable Object namespace binding owns the declared RPC contract.
  return value as T & V;
}

function platformResponse(
  inbound: ManagedWhatsAppInbound,
  deliveryId: string,
  text: string,
  context: ResponseContext,
  choices?: string[],
): InboundDeliveryDisposition<ResponseContext> {
  const message: AdapterOutboundMessage = {
    deliveryId,
    surface: { kind: "dm", id: inbound.surfaceId },
    actorId: inbound.actorId,
    text,
    replyToId: inbound.messageId,
  };
  if (choices) message.choices = choices;
  return { terminal: true, responses: [{ message, context }] };
}

/**
 * Whether this peer has a connection of its own, or a live code making one, that sending its
 * sender to another peer would cut off. A peer that only told a stray sender how to connect has none.
 */
function holdsConnection(state: ManagedWhatsAppPeerState | undefined): boolean {
  if (!state) return false;
  if (state.activeRoute) return true;
  return Boolean(state.pairing && state.pairing.status !== "finalized" && state.pairing.expiresAt > Date.now());
}

/** A pairing the Kernel is connecting right now; another code waits until it ends or expires. */
function pairingInProgress(state: ManagedWhatsAppPeerState): state is ManagedWhatsAppPeerState & { pairing: NonNullable<ManagedWhatsAppPeerState["pairing"]> } {
  return Boolean(state.pairing
    && (state.pairing.status === "prepared" || state.pairing.status === "active")
    && state.pairing.expiresAt > Date.now());
}

function whatsAppMessageId(value: string | undefined): string | undefined {
  return value && whatsAppDeliveryToken(value) ? value : undefined;
}

function routeWithOrigin(
  route: AdapterPairingRoute,
  canonicalOrigin: string,
): ManagedWhatsAppPeerRoute {
  return {
    ...parseRoute(route),
    canonicalOrigin: requireCanonicalOrigin(canonicalOrigin),
    linkedAt: Date.now(),
  };
}

function parseRoute(value: AdapterPairingRoute): AdapterPairingRoute {
  return {
    installationId: requireOpaque(value?.installationId, "installationId"),
    localUid: requireLocalUid(value?.localUid),
    generation: requireOpaque(value?.generation, "generation"),
  };
}

function requireOpaque(value: string, field: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireLocalUid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("localUid is invalid");
  }
  return value;
}

function requireCanonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== value.replace(/\/$/, "")
  ) {
    throw new Error("canonicalOrigin must be an HTTPS origin");
  }
  return url.origin;
}

/** The platform's own replies, in the language of the sender's country. */
function replies(sender: { actorId: string }): PlatformReplies {
  return platformReplies("WhatsApp", whatsAppReplyLanguage(sender.actorId));
}
