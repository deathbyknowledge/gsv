import type {
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingWorkerInterface,
} from "../adapter-interface";
import type {
  AdapterPairConfirmArgs,
  AdapterPairConfirmResult,
  AdapterPairDisconnectArgs,
  AdapterPairDisconnectResult,
  AdapterPairInfoArgs,
  AdapterPairInfoResult,
  AdapterPairInspectArgs,
  AdapterPairInspectResult,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { principalOf,
  type KernelContext,
} from "./context";
import {
  stableOpaqueId,
} from "../shared/stable-id";
import {
  recordAdapterStatusTransition,
} from "./lifecycle-responsibilities";
import {
  SINGLETON_INSTALLATION_ID,
} from "../installation/identity";
import {
  isLocked,
} from "../auth/shadow";
import {
  adapterInstallationContext,
  normalizeAdapterName,
  resolveAdapterService,
} from "./adapter-service";

/** Managed adapter pairing. */
const pairingInfoSchema = z.object({
  accountId: z.string().check(z.minLength(1)),
  configured: z.boolean(),
  botUsername: z.optional(z.string()),
  installUrl: z.optional(z.string().check(z.minLength(1))),
});

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

const managedIdentityLinkMetadataSchema = z.looseObject({
  managed: z.literal(true),
  surfaceId: z.string().check(z.minLength(1)),
  routeScope: z.optional(z.enum(["surface", "actor"])),
  routeGeneration: z.string().check(z.minLength(1)),
});

function requireInteractivePairingOwner(ctx: KernelContext, syscall: string): number {
  const identity = principalOf(ctx);
  if (
    !identity
    || identity.kind !== "human"
    || !ctx.connection
    || ctx.processId
  ) {
    throw new Error(`${syscall} requires a direct signed-in user`);
  }
  const uid = identity.account.uid;
  const user = ctx.auth.getPasswdByUid(uid);
  const shadow = user ? ctx.auth.getShadowByUsername(user.username) : null;
  if (
    !user
    || uid < 1000
    || ctx.auth.isPersonalAgentUid(uid)
    || !shadow
    || isLocked(shadow)
  ) {
    throw new Error(`${syscall} requires an active human account`);
  }
  return uid;
}

export async function handleAdapterPairInfo(
  args: AdapterPairInfoArgs,
  ctx: KernelContext,
): Promise<AdapterPairInfoResult> {
  requireInteractivePairingOwner(ctx, "adapter.pair.info");
  const adapter = normalizeAdapterName(args.adapter);
  const service = requirePairingService(ctx, adapter);
  const info = pairingInfoSchema.safeParse(
    await service.adapterPairingInfo(adapterInstallationContext(ctx)),
  );
  if (!info.success) {
    throw new Error("Adapter returned invalid pairing information");
  }
  const result: AdapterPairInfoResult = {
    adapter,
    accountId: info.data.accountId,
    configured: info.data.configured,
  };
  if (info.data.botUsername) result.botUsername = info.data.botUsername;
  if (info.data.installUrl) result.installUrl = info.data.installUrl;
  return result;
}

export async function handleAdapterPairInspect(
  args: AdapterPairInspectArgs,
  ctx: KernelContext,
): Promise<AdapterPairInspectResult> {
  requireInteractivePairingOwner(ctx, "adapter.pair.inspect");
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  const service = requirePairingService(ctx, adapter);
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
  const uid = requireInteractivePairingOwner(ctx, "adapter.pair.confirm");
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  const service = requirePairingService(ctx, adapter);
  const canonicalOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!canonicalOrigin || ctx.installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("Managed adapter pairing is not available in this installation");
  }
  const operationId = await stableOpaqueId("adapter-pair", [
    adapter,
    ctx.installationId,
    uid,
    code,
  ]);
  const existingCandidate = requirePairingCandidate(await service.adapterPairingInspect!(
    adapterInstallationContext(ctx),
    code,
  ).catch(async () => {
    const prepared = await service.adapterPairingPrepare!(adapterInstallationContext(ctx), {
      code,
      installationId: ctx.installationId,
      localUid: uid,
      operationId,
      canonicalOrigin,
    });
    return requirePairingPreparation(prepared, ctx.installationId, uid).candidate;
  }));
  const existingLink = ctx.adapters.identityLinks.get(
    adapter,
    existingCandidate.accountId,
    existingCandidate.actorId,
  );
  if (existingLink && existingLink.uid !== uid) {
    throw new Error("This external identity is linked to another user in this GSV");
  }

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
  if (
    prepared.candidate.actorId !== existingCandidate.actorId
    || prepared.candidate.surfaceId !== existingCandidate.surfaceId
    || prepared.candidate.accountId !== existingCandidate.accountId
    || pairingRouteScope(prepared.candidate) !== pairingRouteScope(existingCandidate)
  ) {
    throw new Error("Adapter pairing changed during preparation");
  }

  ctx.adapters.identityLinks.link(
    adapter,
    prepared.candidate.accountId,
    prepared.candidate.actorId,
    uid,
    uid,
    {
      managed: true,
      surfaceKind: "dm",
      surfaceId: prepared.candidate.surfaceId,
      routeScope: pairingRouteScope(prepared.candidate),
      routeGeneration: prepared.route.generation,
      operationId,
    },
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
  if (
    activated.candidate.actorId !== prepared.candidate.actorId
    || activated.candidate.surfaceId !== prepared.candidate.surfaceId
    || activated.candidate.accountId !== prepared.candidate.accountId
    || pairingRouteScope(activated.candidate) !== pairingRouteScope(prepared.candidate)
    || activated.route.generation !== prepared.route.generation
  ) {
    throw new Error("Adapter pairing changed during confirmation");
  }
  await service.adapterPairingFinalize!(adapterInstallationContext(ctx), {
    code,
    operationId,
    route: activated.route,
    canonicalOrigin,
  });
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
  const uid = requireInteractivePairingOwner(ctx, "adapter.pair.disconnect");
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();
  const actorId = args.actorId.trim();
  if (!accountId || !actorId) throw new Error("Adapter pairing identity is required");
  const link = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
  if (!link) return { disconnected: false, adapter, accountId, actorId };
  if (link.uid !== uid) throw new Error("Permission denied");
  const metadata = managedIdentityLinkMetadataSchema.safeParse(link.metadata);
  if (!metadata.success) {
    throw new Error("This identity is not managed by adapter pairing");
  }
  const { surfaceId, routeGeneration: generation } = metadata.data;
  const service = requirePairingService(ctx, adapter);
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
    const current = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
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

function requirePairingService(
  ctx: KernelContext,
  adapter: string,
): AdapterPairingWorkerInterface {
  if (!adapter) throw new Error("adapter is required");
  if (ctx.installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("Managed adapter pairing is not available in standalone GSV");
  }
  const service = resolveAdapterService(ctx.env, adapter);
  if (
    !service
    || !service.adapterPairingInfo
    || !service.adapterPairingInspect
    || !service.adapterPairingPrepare
    || !service.adapterPairingActivate
    || !service.adapterPairingFinalize
    || !service.adapterPairingDisconnect
  ) {
    throw new Error(`Adapter does not support managed pairing: ${adapter}`);
  }
  return {
    adapterPairingInfo: (...args) => service.adapterPairingInfo!(...args),
    adapterPairingInspect: (...args) => service.adapterPairingInspect!(...args),
    adapterPairingPrepare: (...args) => service.adapterPairingPrepare!(...args),
    adapterPairingActivate: (...args) => service.adapterPairingActivate!(...args),
    adapterPairingFinalize: (...args) => service.adapterPairingFinalize!(...args),
    adapterPairingDisconnect: (...args) => service.adapterPairingDisconnect!(...args),
  };
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

