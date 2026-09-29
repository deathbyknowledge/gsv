import type {
  AdapterConnectArgs,
  AdapterConnectResult as AdapterConnectSyscallResult,
  AdapterDisconnectArgs,
  AdapterDisconnectResult as AdapterDisconnectSyscallResult,
  AdapterWorkerConnectResult,
  AdapterWorkerDisconnectResult,
} from "@humansandmachines/gsv/protocol";
import {
  adapterWorkerConnectResultSchema,
  adapterWorkerDisconnectResultSchema,
} from "@humansandmachines/gsv/protocol";
import { principalOf,
  resolveCallerOwnerUid,
  type KernelContext,
} from "./context";
import {
  recordAdapterStatusTransition,
} from "./lifecycle-responsibilities";
import {
  callAdapterConnect,
  callAdapterDisconnect,
  logAdapterBoundaryFailure,
  normalizeAdapterName,
  refreshAdapterStatus,
  resolveAdapterService,
} from "./adapter-service";

/** Adapter account connect and disconnect. */
export async function handleAdapterConnect(
  args: AdapterConnectArgs,
  ctx: KernelContext,
): Promise<AdapterConnectSyscallResult> {
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  const ownerUid = requireAdapterControlOwnerUid(ctx, "adapter.connect");

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (!service.adapterConnect) {
    return { ok: false, error: `Adapter service does not implement connect: ${adapter}` };
  }

  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  const needsOwnerClaim = adapterAccountNeedsOwnerClaim(ctx, adapter, accountId, ownerUid);
  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    if (needsOwnerClaim) {
      ctx.adapters.status.setOwner(adapter, accountId, ownerUid);
    }
    let connectResult: AdapterWorkerConnectResult;
    try {
      const decoded = adapterWorkerConnectResultSchema.safeParse(
        await callAdapterConnect(service, ctx, accountId, args.config),
      );
      if (!decoded.success) {
        logAdapterBoundaryFailure("error", "connect_invalid_response");
        return { ok: false, error: `Adapter returned an invalid connect response: ${adapter}` };
      }
      connectResult = decoded.data;
    } catch {
      logAdapterBoundaryFailure("error", "connect_worker_failed");
      return { ok: false, error: `Adapter connect failed: ${adapter}` };
    }
    if (!connectResult.ok) {
      return {
        ok: false,
        error: connectResult.error,
        challenge: connectResult.challenge,
      };
    }

    const previous = ctx.adapters.status.get(adapter, accountId);
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: connectResult.connected,
      authenticated: connectResult.authenticated,
      mode: previous?.mode,
      lastActivity: previous?.lastActivity,
      error: undefined,
      extra: previous?.extra,
    });
    const status = await refreshAdapterStatus(service, ctx, adapter, accountId);
    const connected = status?.connected ?? connectResult.connected;
    const authenticated = status?.authenticated ?? connectResult.authenticated;
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
      });
    }

    return {
      ok: true,
      adapter,
      accountId,
      connected,
      authenticated,
      message: connectResult.message,
      challenge: connectResult.challenge,
    };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

export async function handleAdapterDisconnect(
  args: AdapterDisconnectArgs,
  ctx: KernelContext,
): Promise<AdapterDisconnectSyscallResult> {
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };

  const ownerUid = requireAdapterControlOwnerUid(ctx, "adapter.disconnect");
  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  if (ownerUid !== 0 && previousStatus?.ownerUid !== ownerUid) {
    throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (!service.adapterDisconnect) {
    return { ok: false, error: `Adapter service does not implement disconnect: ${adapter}` };
  }

  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    let result: AdapterWorkerDisconnectResult;
    try {
      const decoded = adapterWorkerDisconnectResultSchema.safeParse(
        await callAdapterDisconnect(service, ctx, accountId),
      );
      if (!decoded.success) {
        logAdapterBoundaryFailure("error", "disconnect_invalid_response");
        return { ok: false, error: `Adapter returned an invalid disconnect response: ${adapter}` };
      }
      result = decoded.data;
    } catch {
      logAdapterBoundaryFailure("error", "disconnect_worker_failed");
      return { ok: false, error: `Adapter disconnect failed: ${adapter}` };
    }
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Keep local status store conservative even if adapter status polling fails.
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: false,
      authenticated: false,
      mode: "disconnected",
      lastActivity: Date.now(),
    });
    await refreshAdapterStatus(service, ctx, adapter, accountId);
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: true,
      });
    }

    return {
      ok: true,
      adapter,
      accountId,
      message: result.message,
    };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

function adapterAccountNeedsOwnerClaim(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  ownerUid: number,
): boolean {
  const account = ctx.adapters.status.get(adapter, accountId);
  if (account?.ownerUid != null) {
    if (ownerUid !== 0 && account.ownerUid !== ownerUid) {
      throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
    }
    return false;
  }
  if (ownerUid === 0) {
    return true;
  }
  const linkedUids = new Set(
    ctx.adapters.identityLinks.listByAccount(adapter, accountId).map((link) => link.uid),
  );
  if (!account && linkedUids.size === 0) {
    return true;
  }
  if (linkedUids.size !== 1 || !linkedUids.has(ownerUid)) {
    throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
  }
  return true;
}

function requireAdapterControlOwnerUid(ctx: KernelContext, syscall: string): number {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human") {
    throw new Error(`${syscall} requires a user identity`);
  }
  return resolveCallerOwnerUid(ctx);
}

