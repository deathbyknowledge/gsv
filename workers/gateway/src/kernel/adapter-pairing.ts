import { activeHumanOwner, adapterPairingOwner, canLinkAdapter, interactivePairingOwner } from "./adapter-pairing-policy";
import { authorizeNestedOperation } from "./tool-approval";
import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingWorkerInterface,
} from "../adapter-interface";
import type {
  AdapterPairConfirmArgs,
  AdapterPairConfirmResult,
  AdapterPairCreateArgs,
  AdapterPairCreateResult,
  AdapterPairDisconnectArgs,
  AdapterPairDisconnectResult,
  AdapterPairInfoArgs,
  AdapterPairInfoResult,
  AdapterPairInspectArgs,
  AdapterPairInspectResult,
} from "@humansandmachines/gsv/protocol";
import { adapterDisplayName } from "@humansandmachines/gsv/protocol";
import type { RedeemAdapterPairingInput, RedeemAdapterPairingResult } from "@humansandmachines/gsv/services/adapters";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import * as z from "zod/mini";
import { hashToken } from "../auth/shadow";
import { principalOf, type KernelContext } from "./context";
import type { IdentityLinkRecord } from "./identity-links";
import {
  stableOpaqueId,
} from "../shared/stable-id";
import {
  recordAdapterStatusTransition,
} from "./lifecycle-responsibilities";
import {
  adapterInstallationContext,
  adapterSupportsPairing,
  describeAdapterService,
  readAdapterPairingInfo,
  normalizeAdapterName,
  resolveAdapterService,
} from "./adapter-service";

/** Managed adapter pairing. */
const pairingCandidateSchema = z.object({
  accountId: z.string().check(z.minLength(1), z.maxLength(200)),
  actorId: z.string().check(z.minLength(1), z.maxLength(200)),
  surfaceId: z.string().check(z.minLength(1), z.maxLength(200)),
  routeScope: z.optional(z.enum(["surface", "actor"])),
  actorName: z.optional(z.string()),
  actorHandle: z.optional(z.string()),
  expiresAt: z.number(),
  linked: z.boolean(),
});

const pairingRouteSchema = z.object({
  installationId: z.string(),
  localUid: z.number().check(z.int(), z.nonnegative()),
  generation: z.string().check(
    z.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/),
  ),
});

const pairingPreparationSchema = z.object({
  candidate: pairingCandidateSchema,
  route: pairingRouteSchema,
  previousRoute: z.optional(pairingRouteSchema),
});

const pairingLinkSchema = z.object({ url: z.string().check(z.maxLength(2048)) });

/** Letters and digits that read unambiguously: no I, O, 0 or 1. */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISPLAY_TEXT_LIMIT = 160;

const UNAVAILABLE_LINK: RedeemAdapterPairingResult = {
  paired: false,
  reason: "unavailable",
  message: "This link expired or was already used",
};

/**
 * A pairing the Kernel will not complete. Any other failure, such as a lost adapter call, may
 * succeed when tried again, so a messenger redeeming a link code retries its delivery instead.
 */
class PairingRefusedError extends Error {}

const managedIdentityLinkMetadataSchema = z.looseObject({
  managed: z.literal(true),
  surfaceId: z.string().check(z.minLength(1)),
  routeScope: z.optional(z.enum(["surface", "actor"])),
  routeGeneration: z.string().check(z.minLength(1)),
});

function requirePairingOwner(ctx: KernelContext, syscall: string): number {
  const uid = syscall === "adapter.pair.disconnect" ? interactivePairingOwner(ctx) : adapterPairingOwner(ctx);
  if (uid === null) throw new Error(`${syscall} requires a direct signed-in user or an authorized process owned by an active human account`);
  if (syscall === "adapter.pair.confirm" && !canLinkAdapter(ctx)) throw new Error("This account cannot complete messenger linking");
  return uid;
}

type PairingConfirmation = AdapterPairConfirmArgs & {
  uid: number; credentialEpoch: number; operationId: string; canonicalOrigin: string; humanConfirmed: boolean;
};

/** What a managed link records beside its route: the route fences, then how the messenger named the person. */
type ManagedIdentityLinkMetadata = {
  managed: true;
  humanConfirmed: boolean;
  surfaceKind: "dm";
  surfaceId: string;
  routeScope: "surface" | "actor";
  routeGeneration: string;
  operationId: string;
  /** When the connection finished; a page waiting on its link watches for this. */
  linkedAt?: number;
  actorName?: string;
  actorHandle?: string;
};

export async function handleAdapterPairInfo(
  args: AdapterPairInfoArgs,
  ctx: KernelContext,
): Promise<AdapterPairInfoResult> {
  requirePairingOwner(ctx, "adapter.pair.info");
  const adapter = normalizeAdapterName(args.adapter);
  const service = await requirePairingService(ctx, adapter);
  const info = await readAdapterPairingInfo(service, ctx);
  const result: AdapterPairInfoResult = {
    adapter,
    accountId: info.accountId,
    configured: info.configured,
  };
  if (info.botUsername) result.botUsername = info.botUsername;
  if (info.installUrl) result.installUrl = info.installUrl;
  if (info.instructions) result.instructions = info.instructions;
  if (info.unreachableCallingCodes?.length) result.unreachableCallingCodes = info.unreachableCallingCodes;
  if (service.adapterPairingLink) result.pairingLinks = true;
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (origin) result.setupUrl = messengerSetupUrl(origin, adapter);
  return result;
}

/**
 * Mints a single-use code into a link that opens the messenger ready to send it. Whoever
 * sends it connects that messenger account to the caller, so only a person signed in
 * here mints one; Ship sends its owner the setup link instead and never holds a code.
 */
export async function handleAdapterPairCreate(
  args: AdapterPairCreateArgs,
  ctx: KernelContext,
): Promise<AdapterPairCreateResult> {
  const uid = interactivePairingOwner(ctx);
  if (uid === null) throw new Error("adapter.pair.create requires a direct signed-in user");
  const adapter = normalizeAdapterName(args.adapter);
  const service = await requirePairingService(ctx, adapter);
  if (!service.adapterPairingLink) throw new Error(`${adapterDisplayName(adapter)} connects with a code it sends; confirm that code instead`);
  if (!(await readAdapterPairingInfo(service, ctx)).configured) throw new Error("The operator has not enabled this messenger");
  const canonicalOrigin = requireCanonicalOrigin(ctx);
  const code = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    // The alphabet has 32 characters, so each byte's low five bits choose one without bias.
    (byte) => PAIRING_CODE_ALPHABET[byte & 31],
  ).join("");
  const codeHash = await hashToken(code);
  const created = ctx.adapters.pairingLinks.create({
    adapter,
    ownerUid: uid,
    credentialEpoch: ctx.auth.credentialEpoch(uid),
    codeHash,
    now: Date.now(),
  });
  try {
    const link = pairingLinkSchema.parse(await service.adapterPairingLink(adapterInstallationContext(ctx), {
      code,
      localUid: uid,
      canonicalOrigin,
      expiresAt: created.expiresAt,
    }));
    return {
      adapter,
      code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`,
      url: requireHttpsUrl(link.url),
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    };
  } catch (error) {
    ctx.adapters.pairingLinks.cancel(codeHash, Date.now());
    throw error;
  }
}

/**
 * Connects the messenger account that sent a link code to the owner this Kernel minted it
 * for. The adapter vouches for the sender; the owner comes only from the Kernel's record.
 */
export async function redeemAdapterPairingLink(
  ctx: KernelContext,
  adapter: string,
  input: RedeemAdapterPairingInput,
): Promise<RedeemAdapterPairingResult> {
  let code: string;
  try {
    code = normalizePairingCode(input.code);
  } catch {
    return UNAVAILABLE_LINK;
  }
  const codeHash = await hashToken(code);
  const record = ctx.adapters.pairingLinks.get(adapter, codeHash);
  if (!record || record.cancelled) return UNAVAILABLE_LINK;
  const uid = record.ownerUid;
  const operationId = await pairingOperationId(adapter, ctx.installationId, uid, code);
  // The Kernel links the sender before the messenger activates its route.
  const linked = ctx.adapters.identityLinks.list(uid)
    .some((link) => link.adapter === adapter && link.metadata?.operationId === operationId);
  if (record.redeemed) {
    // A retried delivery of the code's message is answered as before, unless that connection has ended.
    return linked ? { paired: true } : UNAVAILABLE_LINK;
  }
  // An expired code connects no one new, but a connection it started in time still finishes.
  if (record.expiresAt <= Date.now() && !linked) return UNAVAILABLE_LINK;
  // A credential change cancels the owner's codes; the confirmation rechecks it before each commit.
  if (activeHumanOwner(ctx, uid) === null) {
    return { paired: false, reason: "refused", message: "The account that made this link is no longer active" };
  }
  try {
    const service = await requirePairingService(ctx, adapter);
    await confirmAdapterPairing(ctx, service, {
      adapter,
      code,
      uid,
      credentialEpoch: record.credentialEpoch,
      operationId,
      canonicalOrigin: requireCanonicalOrigin(ctx),
    }, true);
  } catch (error) {
    console.warn("[Kernel] Messenger link did not connect:", { adapter, ...exceptionDiagnostics(error) });
    // The messenger retries its delivery of the code after any other failure; the code stays live until then.
    if (!(error instanceof PairingRefusedError)) throw error;
    // The sender reads this in their messenger: the Kernel's own reason, never an adapter's error.
    return { paired: false, reason: "refused", message: error.message };
  }
  ctx.adapters.pairingLinks.redeemed(adapter, codeHash, Date.now());
  return { paired: true };
}

export async function handleAdapterPairInspect(
  args: AdapterPairInspectArgs,
  ctx: KernelContext,
): Promise<AdapterPairInspectResult> {
  requirePairingOwner(ctx, "adapter.pair.inspect");
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  const service = await requireCodePairingService(ctx, adapter);
  if (!(await readAdapterPairingInfo(service, ctx)).configured) throw new Error("The operator has not enabled this messenger");
  const candidate = requirePairingCandidate(await service.adapterPairingInspect!(
    adapterInstallationContext(ctx),
    code,
  ));
  return { adapter, ...candidate };
}

export async function handleAdapterPairConfirm(
  args: AdapterPairConfirmArgs,
  ctx: KernelContext,
): Promise<AdapterPairConfirmResult> {
  const uid = requirePairingOwner(ctx, "adapter.pair.confirm");
  const credentialEpoch = ctx.auth.credentialEpoch(uid);
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  await authorizeNestedOperation(ctx, "adapter.pair.confirm", { adapter });
  ctx.requestSignal?.throwIfAborted();
  const service = await requireCodePairingService(ctx, adapter);
  if (!(await readAdapterPairingInfo(service, ctx)).configured) throw new Error("The operator has not enabled this messenger");
  const canonicalOrigin = requireCanonicalOrigin(ctx);
  const operationId = await pairingOperationId(adapter, ctx.installationId, uid, code);
  return await confirmAdapterPairing(ctx, service, {
    adapter, code, uid, credentialEpoch, operationId, canonicalOrigin,
  }, !ctx.processId);
}

/**
 * Connects the account a live claim names to `uid` through the adapter's prepare, activate
 * and finalize. `interactive` says the person approved it themselves rather than through a process.
 */
async function confirmAdapterPairing(
  ctx: KernelContext,
  service: AdapterPairingWorkerInterface,
  confirmation: Omit<PairingConfirmation, "humanConfirmed">,
  interactive: boolean,
): Promise<AdapterPairConfirmResult> {
  const { adapter, code, uid, operationId, canonicalOrigin } = confirmation;
  const existingCandidate = requirePairingCandidate(await service.adapterPairingInspect!(
    adapterInstallationContext(ctx),
    code,
  ).catch(async () => {
    ctx.requestSignal?.throwIfAborted();
    const prepared = await service.adapterPairingPrepare!(adapterInstallationContext(ctx), {
      code,
      installationId: ctx.installationId,
      localUid: uid,
      operationId,
      canonicalOrigin,
    });
    return requirePairingPreparation(prepared, ctx.installationId, uid).candidate;
  }));
  ctx.requestSignal?.throwIfAborted();
  const existingLink = ctx.adapters.identityLinks.get(
    adapter,
    existingCandidate.accountId,
    existingCandidate.actorId,
  );
  if (existingLink && existingLink.uid !== uid) {
    throw new PairingRefusedError("This external identity is linked to another user in this GSV");
  }
  const humanConfirmed = interactive || (existingLink?.linkedByUid === uid
    && existingLink.metadata?.managed === true && existingLink.metadata.humanConfirmed !== false);
  const retainedLink = ctx.adapters.identityLinks.getForCleanup(adapter, existingCandidate.accountId, existingCandidate.actorId);
  const cleanup = retainedLink && (!existingLink || (
    retainedLink.metadata?.managed === true
    && retainedLink.metadata.operationId !== operationId
  )) ? retainedLink : null;
  const completion = prepareAdapterPairing(ctx, service, existingCandidate, cleanup, {
    ...confirmation, humanConfirmed,
  });
  // Replacing a link owns completion from the first destructive operation.
  if (cleanup) ctx.defer(completion);
  return completion;
}

async function prepareAdapterPairing(
  ctx: KernelContext,
  service: AdapterPairingWorkerInterface,
  existingCandidate: AdapterPairingCandidate,
  cleanup: IdentityLinkRecord | null,
  confirmation: PairingConfirmation,
): Promise<AdapterPairConfirmResult> {
  const { adapter, code, uid, credentialEpoch, operationId, canonicalOrigin } = confirmation;
  if (cleanup) {
    // Only a live, inspected external claim may release a revoked or superseded route for a successor.
    if (existingCandidate.expiresAt <= Date.now()) throw new PairingRefusedError("Pairing code expired");
    if (ctx.auth.isAccountDisabled(uid) || ctx.auth.credentialEpoch(uid) !== credentialEpoch) {
      throw new PairingRefusedError("Account credentials changed during pairing; sign in again");
    }
    if (cleanup.metadata?.managed === true) {
      await disconnectManagedIdentityLink(cleanup, ctx);
    } else {
      ctx.adapters.identityLinks.unlink(adapter, existingCandidate.accountId, existingCandidate.actorId);
    }
  }

  if (!cleanup) ctx.requestSignal?.throwIfAborted();
  const prepared = requirePairingPreparation(await service.adapterPairingPrepare!(
    adapterInstallationContext(ctx),
    {
      code,
      installationId: ctx.installationId,
      localUid: uid,
      operationId,
      canonicalOrigin,
    },
  ), ctx.installationId, uid);
  if (!cleanup) ctx.requestSignal?.throwIfAborted();
  if (
    prepared.candidate.actorId !== existingCandidate.actorId
    || prepared.candidate.surfaceId !== existingCandidate.surfaceId
    || prepared.candidate.accountId !== existingCandidate.accountId
    || pairingRouteScope(prepared.candidate) !== pairingRouteScope(existingCandidate)
  ) {
    throw new PairingRefusedError("Adapter pairing changed during preparation");
  }

  // A password reset or removal during provider preparation cannot restore the old user's link.
  if (ctx.auth.isAccountDisabled(uid) || ctx.auth.credentialEpoch(uid) !== credentialEpoch) {
    throw new PairingRefusedError("Account credentials changed during pairing; sign in again");
  }
  // Once activation starts, the Kernel owns completion even if the caller stops waiting.
  const completion = completeAdapterPairing(ctx, service, prepared, confirmation);
  if (!cleanup) ctx.defer(completion);
  return completion;
}

async function completeAdapterPairing(
  ctx: KernelContext,
  service: AdapterPairingWorkerInterface,
  prepared: AdapterPairingPreparation,
  { adapter, code, uid, credentialEpoch, operationId, canonicalOrigin, humanConfirmed }: PairingConfirmation,
): Promise<AdapterPairConfirmResult> {
  const metadata: ManagedIdentityLinkMetadata = {
    managed: true,
    humanConfirmed,
    surfaceKind: "dm",
    surfaceId: prepared.candidate.surfaceId,
    routeScope: pairingRouteScope(prepared.candidate),
    routeGeneration: prepared.route.generation,
    operationId,
  };
  const actorName = displayText(prepared.candidate.actorName);
  if (actorName) metadata.actorName = actorName;
  const actorHandle = displayText(prepared.candidate.actorHandle);
  if (actorHandle) metadata.actorHandle = actorHandle;
  ctx.adapters.identityLinks.link(
    adapter,
    prepared.candidate.accountId,
    prepared.candidate.actorId,
    uid,
    humanConfirmed ? uid : principalOf(ctx)!.account.uid,
    metadata,
  );
  const activated = requirePairingPreparation(await service.adapterPairingActivate!(
    adapterInstallationContext(ctx),
    {
      code,
      operationId,
      route: prepared.route,
      canonicalOrigin,
    },
  ), ctx.installationId, uid);
  if (ctx.auth.isAccountDisabled(uid) || ctx.auth.credentialEpoch(uid) !== credentialEpoch) {
    throw new PairingRefusedError("Account credentials changed during pairing; sign in again");
  }
  if (
    activated.candidate.actorId !== prepared.candidate.actorId
    || activated.candidate.surfaceId !== prepared.candidate.surfaceId
    || activated.candidate.accountId !== prepared.candidate.accountId
    || pairingRouteScope(activated.candidate) !== pairingRouteScope(prepared.candidate)
    || activated.route.generation !== prepared.route.generation
  ) {
    throw new PairingRefusedError("Adapter pairing changed during confirmation");
  }
  await service.adapterPairingFinalize!(adapterInstallationContext(ctx), {
    code,
    operationId,
    route: activated.route,
    canonicalOrigin,
  });
  if (ctx.auth.isAccountDisabled(uid) || ctx.auth.credentialEpoch(uid) !== credentialEpoch) {
    throw new PairingRefusedError("Account credentials changed during pairing; sign in again");
  }
  const finalizedLink = ctx.adapters.identityLinks.get(adapter, activated.candidate.accountId, activated.candidate.actorId);
  if (finalizedLink?.uid !== uid || finalizedLink.metadata?.routeGeneration !== activated.route.generation) {
    throw new PairingRefusedError("Adapter pairing changed during finalization");
  }
  // Only now is the connection whole; a lost finalization leaves the link without `linkedAt` until a retry completes it.
  ctx.adapters.identityLinks.link(adapter, finalizedLink.accountId, finalizedLink.actorId, uid, finalizedLink.linkedByUid, {
    ...finalizedLink.metadata,
    linkedAt: Date.now(),
  });
  // Ship's next private reply, such as the `adapter.connected` hello below, goes to the paired DM.
  ctx.shipReplies.recordAdapterPairing(uid, operationId, {
    kind: "adapter",
    adapter,
    accountId: activated.candidate.accountId,
    actorId: activated.candidate.actorId,
    surface: { kind: "dm", id: activated.candidate.surfaceId },
  }, ctx.adapters.privateDestinations, ctx.runRoutes);
  const previousStatus = ctx.adapters.status.get(
    adapter,
    activated.candidate.accountId,
  );
  ctx.adapters.status.setOwner(adapter, activated.candidate.accountId, uid);
  ctx.adapters.status.upsert(adapter, activated.candidate.accountId, {
    accountId: activated.candidate.accountId,
    connected: true,
    authenticated: true,
    mode: "managed-shared",
    lastActivity: Date.now(),
  });
  const currentStatus = ctx.adapters.status.get(
    adapter,
    activated.candidate.accountId,
  );
  if (currentStatus) {
    recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
      suppressAuthenticationRequired: true,
    });
  }
  ctx.broadcastToUserUid(uid, "adapter.status", {
    adapter,
    accountId: activated.candidate.accountId,
  });
  return {
    paired: true,
    adapter,
    accountId: activated.candidate.accountId,
    actorId: activated.candidate.actorId,
    surfaceId: activated.candidate.surfaceId,
    uid,
  };
}

export async function handleAdapterPairDisconnect(
  args: AdapterPairDisconnectArgs,
  ctx: KernelContext,
): Promise<AdapterPairDisconnectResult> {
  const uid = requirePairingOwner(ctx, "adapter.pair.disconnect");
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();
  const actorId = args.actorId.trim();
  if (!accountId || !actorId) throw new Error("Adapter pairing identity is required");
  const link = ctx.adapters.identityLinks.getForCleanup(adapter, accountId, actorId);
  if (!link) return { disconnected: false, adapter, accountId, actorId };
  if (link.uid !== uid) throw new Error("Permission denied");
  return await disconnectManagedIdentityLink(link, ctx);
}

/** The caller owns authorization; the saved link owns the exact remote route and retry identity. */
export async function disconnectManagedIdentityLink(
  link: IdentityLinkRecord,
  ctx: KernelContext,
): Promise<AdapterPairDisconnectResult> {
  const { adapter, accountId, actorId, uid } = link;
  const metadata = managedIdentityLinkMetadataSchema.safeParse(link.metadata);
  if (!metadata.success) {
    throw new Error("This identity is not managed by adapter pairing");
  }
  const { surfaceId, routeGeneration: generation } = metadata.data;
  const service = await requirePairingService(ctx, adapter);
  const operationId = await stableOpaqueId("adapter-pair-disconnect", [
    adapter,
    ctx.installationId,
    uid,
    actorId,
    generation,
  ]);
  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    const result = await service.adapterPairingDisconnect!(adapterInstallationContext(ctx), {
      operationId,
      installationId: ctx.installationId,
      accountId,
      actorId,
      surfaceId,
      localUid: uid,
      generation,
    });
    const current = ctx.adapters.identityLinks.getForCleanup(adapter, accountId, actorId);
    if (
      current?.uid === uid
      && current.metadata?.routeGeneration === generation
    ) {
      ctx.adapters.identityLinks.unlink(adapter, accountId, actorId);
    }
    const stillLinked = ctx.adapters.identityLinks.listByAccount(adapter, accountId).length > 0;
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: true,
      authenticated: stillLinked,
      mode: "managed-shared",
      lastActivity: Date.now(),
    });
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: !stillLinked,
      });
    }
    ctx.broadcastToUserUid(uid, "adapter.status", { adapter, accountId });
    return { disconnected: result.disconnected, adapter, accountId, actorId };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

/** The adapter's pairing RPCs; `adapterPairingLink` is present when the adapter pairs from Kernel-minted links. */
async function requirePairingService(
  ctx: KernelContext,
  adapter: string,
): Promise<AdapterPairingWorkerInterface> {
  if (!adapter) throw new Error("adapter is required");
  const service = resolveAdapterService(ctx.env, adapter);
  if (!adapterSupportsPairing(service)) throw new Error(`Adapter does not support managed pairing: ${adapter}`);
  const descriptor = await describeAdapterService(adapter, service);
  if (!descriptor?.capabilities.pairing) throw new Error(`Adapter does not advertise pairing: ${adapter}`);
  const pairing: AdapterPairingWorkerInterface = {
    adapterPairingInfo: (...args) => service.adapterPairingInfo!(...args),
    adapterPairingInspect: (...args) => service.adapterPairingInspect!(...args),
    adapterPairingPrepare: (...args) => service.adapterPairingPrepare!(...args),
    adapterPairingActivate: (...args) => service.adapterPairingActivate!(...args),
    adapterPairingFinalize: (...args) => service.adapterPairingFinalize!(...args),
    adapterPairingDisconnect: (...args) => service.adapterPairingDisconnect!(...args),
  };
  if (descriptor.capabilities.pairingLinks) pairing.adapterPairingLink = (...args) => service.adapterPairingLink!(...args);
  return pairing;
}

/** A pasted code reaches only adapters that send one; the others connect from a link a person makes in Settings. */
async function requireCodePairingService(
  ctx: KernelContext,
  adapter: string,
): Promise<AdapterPairingWorkerInterface> {
  const service = await requirePairingService(ctx, adapter);
  if (service.adapterPairingLink) {
    throw new Error(`${adapterDisplayName(adapter)} connects from a link in Settings → Messengers, not a pasted code`);
  }
  return service;
}

function requireCanonicalOrigin(ctx: KernelContext): string {
  const canonicalOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!canonicalOrigin) throw new Error("Managed adapter pairing is not available in this installation");
  return canonicalOrigin;
}

async function pairingOperationId(adapter: string, installationId: string, uid: number, code: string): Promise<string> {
  return await stableOpaqueId("adapter-pair", [adapter, installationId, uid, code]);
}

/** Where this Ship opens a messenger's setup, for its owner. */
function messengerSetupUrl(origin: string, adapter: string): string {
  const url = new URL("/chat/settings", origin);
  url.searchParams.set("section", "messengers");
  url.searchParams.set("messenger", adapter);
  return url.toString();
}

function requireHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Adapter returned an invalid pairing link");
  }
  if (url.protocol !== "https:") throw new Error("Adapter returned an invalid pairing link");
  return url.toString();
}

/** A name or handle the messenger reported, on one bounded line; untrusted text. */
function displayText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, DISPLAY_TEXT_LIMIT).join("") : undefined;
}

function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) {
    throw new Error("Pairing code is invalid");
  }
  return normalized;
}

function requirePairingCandidate(value: AdapterPairingCandidate): AdapterPairingCandidate {
  const parsed = pairingCandidateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter returned an invalid pairing candidate");
  }
  const accountId = parsed.data.accountId.trim();
  const actorId = parsed.data.actorId.trim();
  const surfaceId = parsed.data.surfaceId.trim();
  if (!accountId || !actorId || !surfaceId) {
    throw new Error("Adapter returned an invalid pairing candidate");
  }
  return {
    ...parsed.data,
    accountId,
    actorId,
    surfaceId,
  };
}

function pairingRouteScope(candidate: AdapterPairingCandidate): "surface" | "actor" {
  return candidate.routeScope ?? "surface";
}

function requirePairingPreparation(
  value: AdapterPairingPreparation,
  installationId: string,
  localUid: number,
): AdapterPairingPreparation {
  const parsed = pairingPreparationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter returned an invalid pairing preparation");
  }
  const preparation = parsed.data;
  const candidate = requirePairingCandidate(preparation.candidate);
  const route = preparation.route;
  if (
    !route
    || route.installationId !== installationId
    || route.localUid !== localUid
  ) {
    throw new Error("Adapter returned an invalid pairing route");
  }
  const previous = preparation.previousRoute;
  if (previous && (
    previous.installationId.length === 0
    || !Number.isSafeInteger(previous.localUid)
    || previous.generation.length === 0
  )) {
    throw new Error("Adapter returned an invalid previous pairing route");
  }
  const result: AdapterPairingPreparation = {
    candidate,
    route,
  };
  if (previous) result.previousRoute = previous;
  return result;
}
