import { DurableObject } from "cloudflare:workers";
import type {
  ActivateManagedTelegramClaimInput,
  ActivateManagedTelegramClaimResult,
  ManagedTelegramClaimInspection,
  ManagedTelegramPeerRoute,
  SuspendManagedTelegramClaimInput,
  SuspendManagedTelegramClaimResult,
} from "../../../packages/gsv/src/protocol/managed.js";
import { MANAGED_TELEGRAM_ACCOUNT_ID } from "../../../packages/gsv/src/protocol/managed.js";
import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
  type InboundDeliveryDisposition,
} from "../../shared/src/inbound-delivery";
import { callAdapterGateway } from "../../shared/src/gateway-rpc";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterInboundResult,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
} from "./types";
import {
  createManagedTelegramClaimToken,
  managedTelegramClaimUrl,
  parseAccountOrigin,
  verifyManagedTelegramClaimToken,
} from "./managed-claim";
import {
  activateManagedTelegramClaimState,
  bindManagedTelegramPeerIdentity,
  issueManagedTelegramClaim,
  publicManagedTelegramClaim,
  suspendManagedTelegramClaimState,
  type ManagedTelegramPeerState,
} from "./managed-peer-state";
import {
  ManagedTelegramDeliveryError,
  sendManagedTelegramLink,
  sendManagedTelegramText,
  setManagedTelegramTyping,
} from "./managed-telegram-api";
import {
  isManagedTelegramConnectCommand,
  type ManagedTelegramInbound,
} from "./managed-update";

export interface ManagedTelegramPeerEnv {
  GATEWAY: Fetcher & AdapterGatewayBinding;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CLAIM_SIGNING_KEY?: string;
  GSV_ACCOUNT_ORIGIN?: string;
}

type ManagedResponseContext =
  | { kind: "platform"; claimId?: string }
  | { kind: "installation"; installationId: string };

const STATE_KEY = "managed_telegram_peer:v1:state";
const INBOUND_PREFIX = "managed_telegram_peer:v1:inbound:";
const CLAIM_TTL_MS = 10 * 60 * 1000;
const INBOUND_WAKE_DELAY_MS = 25;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;
const LINK_DELIVERY_PREFIX = "managed-link:";
const UNSUPPORTED_TEXT =
  "Managed GSV Telegram currently accepts text messages only. Please send your request as text.";
const LINK_TEXT =
  "Connect this Telegram conversation to your GSV. Sign in on the secure GSV account page to choose an installation.";

export class ManagedTelegramPeer extends DurableObject<ManagedTelegramPeerEnv> {
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<
    ManagedTelegramInbound,
    ManagedResponseContext
  >;

  constructor(ctx: DurableObjectState, env: ManagedTelegramPeerEnv) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
    );
  }

  async handleWebhook(inbound: ManagedTelegramInbound): Promise<{ ok: true }> {
    await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      await txn.put(STATE_KEY, bindManagedTelegramPeerIdentity(state, inbound));
    });
    await this.inboundDeliveries.enqueueAndArm(
      inbound.deliveryId,
      inbound,
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    this.ctx.waitUntil(this.deliverPendingInbound(inbound.deliveryId));
    return { ok: true };
  }

  async sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
  ): Promise<AdapterSendResult> {
    const installation = parseManagedInstallation({ installationId });
    return await this.deliverMessage(message, {
      kind: "installation",
      installationId: installation.installationId,
    });
  }

  async setTyping(
    installationId: string,
    surface: AdapterSurface,
    actorId: string,
    active: boolean,
  ): Promise<void> {
    if (!active) return;
    const installation = parseManagedInstallation({ installationId });
    const state = await this.requireState();
    this.assertPeerDestination(state, surface, actorId);
    this.assertActiveInstallation(state, installation.installationId);
    try {
      await setManagedTelegramTyping(this.botToken(), state.surfaceId);
    } catch {
      console.warn(JSON.stringify({
        component: "managed_telegram",
        event: "typing_delivery_failed",
      }));
    }
  }

  async inspectClaim(claimToken: string): Promise<ManagedTelegramClaimInspection> {
    const parsed = await this.verifiedClaim(claimToken);
    if (!parsed) return { ok: false, reason: "invalid" };
    const state = await this.ctx.storage.get<ManagedTelegramPeerState>(STATE_KEY);
    const claim = state?.claim;
    if (
      !state
      || !claim
      || claim.claimId !== parsed.claimId
      || claim.expiresAt !== parsed.expiresAt
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (claim.status === "used") return { ok: false, reason: "used" };
    if (claim.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
    return { ok: true, claim: publicManagedTelegramClaim(state, claim) };
  }

  async suspendClaim(
    input: SuspendManagedTelegramClaimInput,
  ): Promise<SuspendManagedTelegramClaimResult> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const parsed = await this.requireVerifiedClaim(input.claimToken);
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const suspended = suspendManagedTelegramClaimState(state, {
        claimId: parsed.claimId,
        expiresAt: parsed.expiresAt,
        operationId,
        now: Date.now(),
      });
      await txn.put(STATE_KEY, suspended.state);
      return {
        claim: publicManagedTelegramClaim(suspended.state, suspended.claim),
        ...(suspended.previousRoute
          ? { previousRoute: suspended.previousRoute }
          : {}),
      };
    });
  }

  async activateClaim(
    input: ActivateManagedTelegramClaimInput,
  ): Promise<ActivateManagedTelegramClaimResult> {
    const operationId = parseOpaqueId(input.operationId, "operationId");
    const parsed = await this.requireVerifiedClaim(input.claimToken);
    const installation = parseManagedInstallation({
      installationId: input.installationId,
    });
    const route: ManagedTelegramPeerRoute = {
      installationId: installation.installationId,
      localUid: parseLocalUid(input.localUid),
      canonicalOrigin: parseCanonicalOrigin(input.canonicalOrigin),
      linkedAt: Date.now(),
    };
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const existing = state.claim?.activatedRoute;
      if (existing && state.claim?.operationId === operationId && (
        existing.installationId !== route.installationId
        || existing.localUid !== route.localUid
        || existing.canonicalOrigin !== route.canonicalOrigin
      )) {
        throw new Error(
          "Managed Telegram claim was already used with different input",
        );
      }
      const activated = activateManagedTelegramClaimState(state, {
        claimId: parsed.claimId,
        expiresAt: parsed.expiresAt,
        operationId,
        route: existing && state.claim?.operationId === operationId
          ? existing
          : route,
      });
      await txn.put(STATE_KEY, activated.state);
      const activeRoute = activated.state.activeRoute;
      if (!activeRoute) throw new Error("Managed Telegram route activation failed");
      return {
        state: "active",
        claimId: activated.claim.claimId,
        actorId: activated.state.actorId,
        surfaceId: activated.state.surfaceId,
        route: activeRoute,
      };
    });
  }

  async alarm(): Promise<void> {
    await this.inboundDeliveries.armIfPending(
      Date.now() + INBOUND_RETRY_DELAY_MS,
    );
    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const deliveryId of ids) {
      await this.deliverPendingInbound(deliveryId);
    }
  }

  private async deliverPendingInbound(deliveryId: string): Promise<void> {
    const result = await this.inboundDeliveries.attempt(
      deliveryId,
      async (inbound) => await this.forwardInbound(inbound),
      async (message, context) => await this.deliverMessage(
        message,
        context ?? { kind: "platform" },
      ),
    );
    if (result.state === "pending") {
      await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
    }
  }

  private async forwardInbound(
    inbound: ManagedTelegramInbound,
  ): Promise<InboundDeliveryDisposition<ManagedResponseContext>> {
    const state = await this.requireState();
    if (inbound.unsupportedContent) {
      return this.platformResponse(
        inbound,
        `managed-unsupported:${inbound.deliveryId}`,
        UNSUPPORTED_TEXT,
      );
    }
    if (!state.activeRoute || isManagedTelegramConnectCommand(inbound.text)) {
      return await this.linkResponse(inbound, false);
    }

    const route = state.activeRoute;
    const result = await callAdapterGateway<AdapterInboundResult>(
      this.env.GATEWAY,
      { installationId: route.installationId },
      "adapter.inbound",
      {
        adapter: "telegram",
        accountId: MANAGED_TELEGRAM_ACCOUNT_ID,
        deliveryId: inbound.deliveryId,
        message: {
          messageId: inbound.messageId,
          surface: {
            kind: "dm",
            id: inbound.surfaceId,
            ...(state.actorName ? { name: state.actorName } : {}),
            ...(state.actorHandle ? { handle: state.actorHandle } : {}),
          },
          actor: {
            id: inbound.actorId,
            ...(state.actorName ? { name: state.actorName } : {}),
            ...(state.actorHandle ? { handle: state.actorHandle } : {}),
          },
          text: inbound.text,
          ...(inbound.replyToId ? { replyToId: inbound.replyToId } : {}),
          ...(inbound.timestamp ? { timestamp: inbound.timestamp } : {}),
          wasMentioned: true,
        },
      },
    );
    if (result.challenge) {
      return await this.linkResponse(inbound, true);
    }
    const disposition = adapterInboundResultDisposition(result, {
      surface: { kind: "dm", id: inbound.surfaceId },
      providerMessageId: inbound.messageId,
      actorId: inbound.actorId,
    });
    return {
      terminal: disposition.terminal,
      ...(disposition.error ? { error: disposition.error } : {}),
      ...(disposition.responses
        ? {
            responses: disposition.responses.map((response) => ({
              ...response,
              context: {
                kind: "installation" as const,
                installationId: route.installationId,
              },
            })),
          }
        : {}),
    };
  }

  private async linkResponse(
    inbound: ManagedTelegramInbound,
    suspendActiveRoute: boolean,
  ): Promise<InboundDeliveryDisposition<ManagedResponseContext>> {
    const issued = await this.issueClaim(suspendActiveRoute);
    return {
      terminal: true,
      responses: [{
        message: {
          deliveryId: `${LINK_DELIVERY_PREFIX}${issued.claim.claimId}:${inbound.deliveryId}`,
          surface: { kind: "dm", id: inbound.surfaceId },
          actorId: inbound.actorId,
          text: LINK_TEXT,
          replyToId: inbound.messageId,
        },
        expiresAt: issued.claim.expiresAt,
        context: { kind: "platform", claimId: issued.claim.claimId },
      }],
    };
  }

  private platformResponse(
    inbound: ManagedTelegramInbound,
    deliveryId: string,
    text: string,
  ): InboundDeliveryDisposition<ManagedResponseContext> {
    return {
      terminal: true,
      responses: [{
        message: {
          deliveryId,
          surface: { kind: "dm", id: inbound.surfaceId },
          actorId: inbound.actorId,
          text,
          replyToId: inbound.messageId,
        },
        context: { kind: "platform" },
      }],
    };
  }

  private async issueClaim(suspendActiveRoute: boolean): Promise<{
    state: ManagedTelegramPeerState;
    claim: NonNullable<ManagedTelegramPeerState["claim"]>;
  }> {
    const now = Date.now();
    return await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<ManagedTelegramPeerState>(STATE_KEY);
      if (!state) throw new Error("Managed Telegram peer is not initialized");
      const issued = issueManagedTelegramClaim(state, {
        claimId: crypto.randomUUID(),
        now,
        expiresAt: now + CLAIM_TTL_MS,
        suspendActiveRoute,
      });
      await txn.put(STATE_KEY, issued.state);
      return issued;
    });
  }

  private async deliverMessage(
    message: AdapterOutboundMessage,
    context: ManagedResponseContext,
  ): Promise<AdapterSendResult> {
    const state = await this.requireState();
    this.assertPeerDestination(state, message.surface, message.actorId);
    this.assertDeliveryContext(state, context);
    if (message.media?.length) {
      return { ok: false, error: "Managed Telegram does not support media yet" };
    }
    if (!message.text.trim()) {
      return { ok: false, error: "Managed Telegram requires text" };
    }

    let fingerprint: string;
    try {
      fingerprint = await fingerprintOutboundDelivery(message);
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint managed Telegram delivery: ${errorMessage(error)}`,
        retryable: true,
      };
    }
    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, fingerprint);
    } catch {
      return {
        ok: false,
        error: "Managed Telegram delivery ledger is unavailable",
        retryable: true,
      };
    }
    if (!claim.claimed) return claim.result;

    const fail = async (
      kind: DeliveryFailureKind,
      error: string,
    ): Promise<AdapterSendResult> => {
      if (kind === "retryable") {
        await this.deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
        return { ok: false, error, retryable: true };
      }
      if (kind === "ambiguous") {
        await this.deliveries.failAmbiguous(message.deliveryId, claim.attemptId, error);
        return { ok: false, error, ambiguous: true };
      }
      await this.deliveries.failPermanent(message.deliveryId, claim.attemptId, error);
      return { ok: false, error };
    };

    try {
      const current = await this.requireState();
      this.assertPeerDestination(current, message.surface, message.actorId);
      this.assertDeliveryContext(current, context);
      const replyToMessageId = parseTelegramMessageId(message.replyToId);
      const sent = context.kind === "platform" && context.claimId
        ? await this.sendClaimLink(current, context.claimId, message, replyToMessageId)
        : await sendManagedTelegramText(
            this.botToken(),
            current.surfaceId,
            message.text,
            replyToMessageId,
          );
      const messageId = String(sent.message_id);
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
      return { ok: true, messageId };
    } catch (error) {
      const kind = error instanceof ManagedTelegramDeliveryError
        ? error.kind
        : "permanent";
      try {
        return await fail(kind, safeDeliveryError(error));
      } catch {
        return {
          ok: false,
          error: "Managed Telegram delivery outcome could not be recorded",
          ambiguous: true,
        };
      }
    }
  }

  private async sendClaimLink(
    state: ManagedTelegramPeerState,
    claimId: string,
    message: AdapterOutboundMessage,
    replyToMessageId?: number,
  ) {
    const claim = state.claim;
    if (
      !claim
      || claim.claimId !== claimId
      || claim.status === "used"
      || claim.expiresAt <= Date.now()
    ) {
      throw new Error("Managed Telegram link claim is no longer active");
    }
    const token = await createManagedTelegramClaimToken({
      durableObjectId: this.ctx.id.toString(),
      claimId: claim.claimId,
      expiresAt: claim.expiresAt,
    }, this.claimSigningKey());
    const url = managedTelegramClaimUrl(this.accountOrigin(), token);
    return await sendManagedTelegramLink(this.botToken(), state.surfaceId, {
      text: message.text,
      buttonText: "Connect your GSV",
      url,
      replyToMessageId,
    });
  }

  private assertDeliveryContext(
    state: ManagedTelegramPeerState,
    context: ManagedResponseContext,
  ): void {
    if (context.kind === "installation") {
      this.assertActiveInstallation(state, context.installationId);
      return;
    }
    if (context.claimId && state.claim?.claimId !== context.claimId) {
      throw new Error("Managed Telegram claim changed before delivery");
    }
  }

  private assertPeerDestination(
    state: ManagedTelegramPeerState,
    surface: AdapterSurface,
    actorId: string | undefined,
  ): void {
    if (
      surface.kind !== "dm"
      || surface.id !== state.surfaceId
      || actorId !== state.actorId
    ) {
      throw new Error("Managed Telegram destination does not match this peer");
    }
  }

  private assertActiveInstallation(
    state: ManagedTelegramPeerState,
    installationId: string,
  ): void {
    if (state.activeRoute?.installationId !== installationId) {
      throw new Error("Managed Telegram peer is not linked to this installation");
    }
  }

  private async verifiedClaim(claimToken: string) {
    const parsed = await verifyManagedTelegramClaimToken(
      claimToken,
      this.claimSigningKey(),
    );
    return parsed?.durableObjectId === this.ctx.id.toString() ? parsed : null;
  }

  private async requireVerifiedClaim(claimToken: string) {
    const parsed = await this.verifiedClaim(claimToken);
    if (!parsed) throw new Error("Managed Telegram claim is invalid");
    return parsed;
  }

  private async requireState(): Promise<ManagedTelegramPeerState> {
    const state = await this.ctx.storage.get<ManagedTelegramPeerState>(STATE_KEY);
    if (!state) throw new Error("Managed Telegram peer is not initialized");
    return state;
  }

  private botToken(): string {
    const value = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!value) throw new Error("Managed Telegram bot token is not configured");
    return value;
  }

  private claimSigningKey(): string {
    const value = this.env.TELEGRAM_CLAIM_SIGNING_KEY?.trim();
    if (!value) throw new Error("Managed Telegram claim signing key is not configured");
    return value;
  }

  private accountOrigin(): string {
    return parseAccountOrigin(
      this.env.GSV_ACCOUNT_ORIGIN ?? "https://accounts.gsv.space",
    );
  }
}

function parseOpaqueId(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function parseManagedInstallation(
  value: unknown,
): { installationId: string } {
  const installation = parseAdapterInstallationContext(value);
  if (
    installation.installationId
    === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
  ) {
    throw new Error("Managed Telegram cannot address singleton");
  }
  return installation;
}

function parseLocalUid(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > 2_147_483_647
  ) {
    throw new Error("localUid is invalid");
  }
  return value as number;
}

function parseCanonicalOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("canonicalOrigin is invalid");
  }
  return parseAccountOrigin(value);
}

function parseTelegramMessageId(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeDeliveryError(error: unknown): string {
  if (error instanceof ManagedTelegramDeliveryError) {
    return `Telegram delivery failed (${error.kind})`;
  }
  return error instanceof Error ? error.message : "Managed Telegram delivery failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
