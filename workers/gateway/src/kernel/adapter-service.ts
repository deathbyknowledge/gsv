import type {
  AdapterActivity,
  AdapterAccountStatus,
  AdapterInstallationContext,
  AdapterPairingWorkerInterface,
  AdapterService,
  AdapterServiceDescriptor,
  AdapterSurface,
} from "../adapter-interface";
import type {
  AdapterConnectConfig,
  AdapterListArgs,
  AdapterListEntry,
  AdapterListResult,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterStatusArgs,
  AdapterStatusResult,
} from "@humansandmachines/gsv/protocol";
import {
  adapterAccountStatusSchema,
  adapterWorkerActivityResultSchema,
} from "@humansandmachines/gsv/protocol";
import {
  adapterServiceDescriptorSchema,
} from "@humansandmachines/gsv/services/adapters";
import type {
  AdapterTargetCancelResult,
  AdapterTargetDescriptor,
  AdapterTargetResponseFrame,
} from "@humansandmachines/gsv/services/adapters";
import * as z from "zod/mini";
import {
  resolveCallerOwnerUid,
  type KernelContext,
} from "./context";
import type {
  GatewayEnv,
} from "../runtime-env";
import type {
  SurfaceRouteRecord,
} from "./surface-routes";
import type {
  AdapterStatusRecord,
} from "./adapter-status";
import {
  recordAdapterStatusTransition,
} from "./lifecycle-responsibilities";

/** Adapter service bindings, status projection, and the shared helpers every adapter handler uses. */
type AdapterTargetServiceBinding = {
  adapterTargetList(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetList"]>>
  ): Promise<AdapterTargetDescriptor[] & Disposable>;
  adapterTargetExecute(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetExecute"]>>
  ): Promise<AdapterTargetResponseFrame & Disposable>;
  adapterTargetCancel(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetCancel"]>>
  ): Promise<AdapterTargetCancelResult & Disposable>;
};

export type AdapterServiceBinding = Fetcher
  & Partial<Omit<
    AdapterService,
    "adapterTargetList" | "adapterTargetExecute" | "adapterTargetCancel"
  >>
  & Partial<AdapterTargetServiceBinding>
  & Partial<AdapterPairingWorkerInterface>;

type AdapterBindingEnv = GatewayEnv & Record<
  `CHANNEL_${string}`,
  AdapterServiceBinding | undefined
>;

const adapterStatusListSchema = z.array(adapterAccountStatusSchema);

export type AdapterIngressWorkReturnRecovery = {
  kind: "work_return";
  uid: number;
  workPid: string;
  route: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: "dm";
    surfaceId: string;
    threadId?: string;
    mode: SurfaceRouteRecord["mode"];
  };
};

export function resolveAdapterService(
  env: GatewayEnv,
  adapter: string,
): AdapterServiceBinding | null {
  const key: `CHANNEL_${string}` = `CHANNEL_${adapter.trim().toUpperCase()}`;
  // SAFETY: CHANNEL_* is the Wrangler service-binding namespace for adapters.
  return (env as AdapterBindingEnv)[key] ?? null;
}

export async function handleAdapterStatus(
  args: AdapterStatusArgs,
  ctx: KernelContext,
): Promise<AdapterStatusResult> {
  const adapter = normalizeAdapterName(args.adapter);
  if (!adapter) throw new Error("adapter is required");
  const accountId = args.accountId?.trim() || undefined;

  const service = resolveAdapterService(ctx.env, adapter);
  if (service?.adapterStatus) {
    const refreshAccountIds = adapterStatusRefreshAccountIds(ctx, adapter, accountId);
    for (const refreshAccountId of refreshAccountIds) {
      try {
        const decoded = adapterStatusListSchema.safeParse(
          await callAdapterStatus(service, ctx, refreshAccountId),
        );
        if (!decoded.success) {
          logAdapterBoundaryFailure("error", "status_invalid_response");
          continue;
        }
        const statuses = decoded.data;
        const allowedAccountIds = refreshAccountId ? new Set([refreshAccountId]) : null;
        for (const status of statuses) {
          if (allowedAccountIds && !allowedAccountIds.has(status.accountId.trim())) {
            continue;
          }
          const localized = localizeAdapterStatus(ctx, adapter, status);
          const previous = ctx.adapters.status.get(adapter, localized.accountId);
          const current = ctx.adapters.status.upsert(
            adapter,
            localized.accountId,
            localized,
          );
          if (!ctx.adapters.status.isLifecycleActive(adapter, localized.accountId)) {
            recordAdapterStatusTransition(previous, current, ctx);
          }
        }
      } catch {
        // status syscall should still return last known state when live check fails
      }
    }
  }

  const accounts = visibleAdapterStatusRecords(ctx, adapter, accountId)
    .map((row): AdapterAccountStatus => ({
      accountId: row.accountId,
      connected: row.connected,
      authenticated: row.authenticated,
      mode: row.mode,
      lastActivity: row.lastActivity,
      error: row.error,
      extra: row.extra,
    }));

  return { adapter, accounts };
}

export async function handleAdapterList(
  _args: AdapterListArgs,
  ctx: KernelContext,
): Promise<AdapterListResult> {
  const entries = new Map<string, AdapterListEntry>();
  const deployed = Object.keys(ctx.env)
    .map((key) => adapterNameFromBindingKey(key))
    .filter((adapter): adapter is string => adapter !== null);

  await Promise.all(deployed.map(async (adapter) => {
    const service = resolveAdapterService(ctx.env, adapter);
    const descriptor = await describeAdapterService(adapter, service);
    entries.set(adapter, adapterListEntry(adapter, service, descriptor));
  }));

  const statuses = visibleAdapterStatusRecords(ctx);

  for (const status of statuses) {
    const adapter = normalizeAdapterName(status.adapter);
    if (!adapter) continue;

    const entry = entries.get(adapter) ?? adapterListEntry(adapter, null);
    entry.accounts.push(adapterAccountStatusFromRecord(status));
    entries.set(adapter, entry);
  }

  return {
    adapters: Array.from(entries.values())
      .map((entry) => ({
        ...entry,
        accounts: entry.accounts.sort((left, right) => left.accountId.localeCompare(right.accountId)),
      }))
      .sort((left, right) => left.adapter.localeCompare(right.adapter)),
  };
}

function adapterStatusRefreshAccountIds(
  ctx: KernelContext,
  adapter: string,
  accountId: string | undefined,
): Array<string | undefined> {
  if (canSeeAllAdapterStatuses(ctx)) {
    return [accountId];
  }

  const linkedAccounts = visibleAdapterAccounts(ctx, adapter, accountId);
  return linkedAccounts.map((account) => account.accountId);
}

function visibleAdapterStatusRecords(
  ctx: KernelContext,
  adapterFilter?: string,
  accountIdFilter?: string,
): AdapterStatusRecord[] {
  const adapter = adapterFilter ? normalizeAdapterName(adapterFilter) : undefined;
  const accountId = accountIdFilter?.trim();
  const statusStore = ctx.adapters.status;

  if (canSeeAllAdapterStatuses(ctx)) {
    if (adapter) {
      return statusStore.list(adapter, accountId);
    }
    return statusStore.listAll();
  }

  const accounts = visibleAdapterAccounts(ctx, adapter, accountId);
  const records: AdapterStatusRecord[] = [];
  for (const account of accounts) {
    records.push(
      ...statusStore
        .list(account.adapter, account.accountId)
        .map((status) => ({ ...status, adapter: account.adapter })),
    );
  }
  return records;
}

function visibleAdapterAccounts(
  ctx: KernelContext,
  adapter: string | undefined,
  accountId: string | undefined,
): Array<{ adapter: string; accountId: string }> {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    return [];
  }

  const ownerUid = resolveCallerOwnerUid(ctx);
  const seen = new Set<string>();
  const accounts: Array<{ adapter: string; accountId: string }> = [];
  const add = (candidateAdapter: string, candidateAccountId: string): void => {
    const normalizedAdapter = normalizeAdapterName(candidateAdapter);
    const normalizedAccountId = candidateAccountId.trim();
    const key = `${normalizedAdapter}\0${normalizedAccountId}`;
    if (
      !normalizedAdapter || !normalizedAccountId || seen.has(key)
      || (adapter && normalizedAdapter !== adapter)
      || (accountId && normalizedAccountId !== accountId)
    ) {
      return;
    }
    seen.add(key);
    accounts.push({ adapter: normalizedAdapter, accountId: normalizedAccountId });
  };
  for (const status of ctx.adapters.status.listByOwner(ownerUid)) {
    add(status.adapter, status.accountId);
  }
  for (const link of ctx.adapters.identityLinks.list(ownerUid)) {
    add(link.adapter, link.accountId);
  }
  return accounts.sort((left, right) =>
    left.adapter.localeCompare(right.adapter) || left.accountId.localeCompare(right.accountId)
  );
}

function canSeeAllAdapterStatuses(ctx: KernelContext): boolean {
  const identity = ctx.identity;
  if (!identity) {
    return false;
  }
  if (identity.role === "service") {
    return true;
  }
  return identity.role === "user" && resolveCallerOwnerUid(ctx) === 0;
}

export function handleAdapterStateUpdate(
  args: AdapterStateUpdateArgs,
  ctx: KernelContext,
): AdapterStateUpdateResult {
  const identity = ctx.identity;
  if (!identity || identity.role !== "service") {
    throw new Error("adapter.state.update requires a service identity");
  }

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();
  if (!adapter) {
    throw new Error("adapter is required");
  }
  if (!accountId) {
    throw new Error("accountId is required");
  }

  const localized = localizeAdapterStatus(ctx, adapter, {
    ...args.status,
    accountId,
  });
  const previous = ctx.adapters.status.get(adapter, accountId);
  const status = ctx.adapters.status.upsert(adapter, accountId, localized);
  if (!ctx.adapters.status.isLifecycleActive(adapter, accountId)) {
    recordAdapterStatusTransition(previous, status, ctx);
  }
  const uids = new Set([0]);
  if (status.ownerUid !== null) {
    uids.add(status.ownerUid);
  }
  for (const link of ctx.adapters.identityLinks.listByAccount(adapter, accountId)) {
    uids.add(link.uid);
  }
  for (const uid of uids) {
    ctx.broadcastToUserUid(uid, "adapter.status", { adapter, accountId });
  }

  return { ok: true };
}

function adapterNameFromBindingKey(key: string): string | null {
  if (!key.startsWith("CHANNEL_")) {
    return null;
  }
  return normalizeAdapterName(key.slice("CHANNEL_".length)) || null;
}

export function normalizeAdapterName(adapter: string): string {
  return adapter.trim().toLowerCase();
}

function adapterListEntry(
  adapter: string,
  service: AdapterServiceBinding | null,
  descriptor: AdapterServiceDescriptor | null = null,
): AdapterListEntry {
  const capabilities = descriptor?.capabilities;
  return {
    adapter,
    available: service !== null,
    descriptor: descriptor ?? undefined,
    supportsConnect: capabilities?.connect ?? false,
    supportsDisconnect: capabilities?.disconnect ?? false,
    supportsSend: capabilities?.send ?? false,
    supportsStatus: capabilities?.status ?? false,
    supportsActivity: capabilities?.activity ?? false,
    supportsPairing: capabilities?.pairing ?? false,
    accounts: [],
  };
}

async function describeAdapterService(
  adapter: string,
  service: AdapterServiceBinding | null,
): Promise<AdapterServiceDescriptor | null> {
  if (!service?.adapterDescribe) return null;
  try {
    const result = adapterServiceDescriptorSchema.safeParse(await service.adapterDescribe());
    if (!result.success || result.data.id !== adapter) {
      logAdapterBoundaryFailure("error", "descriptor_invalid_response");
      return null;
    }
    return result.data;
  } catch {
    logAdapterBoundaryFailure("error", "descriptor_worker_failed");
    return null;
  }
}

function adapterAccountStatusFromRecord(status: AdapterStatusRecord): AdapterAccountStatus {
  return {
    accountId: status.accountId,
    connected: status.connected,
    authenticated: status.authenticated,
    mode: status.mode,
    lastActivity: status.lastActivity,
    error: status.error,
    extra: status.extra,
  };
}

export async function setAdapterActivityForKernel(
  env: GatewayEnv,
  installationId: KernelContext["installationId"],
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  activity: AdapterActivity,
): Promise<void> {
  const service = resolveAdapterService(env, adapter);
  if (!service?.adapterSetActivity) {
    return;
  }

  try {
    const decoded = adapterWorkerActivityResultSchema.safeParse(
      await callAdapterSetActivity(
        service,
        installationId,
        accountId,
        surface,
        activity,
      ),
    );
    if (!decoded.success) {
      logAdapterBoundaryFailure("warn", "activity_invalid_response");
      return;
    }
    const result = decoded.data;
    if (!result.ok) {
      logAdapterBoundaryFailure("warn", "activity_rejected");
    }
  } catch {
    logAdapterBoundaryFailure("warn", "activity_worker_failed");
  }
}

export async function refreshAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  adapter: string,
  accountId: string,
): Promise<AdapterAccountStatus | null> {
  if (!service.adapterStatus) {
    return null;
  }

  try {
    const decoded = adapterStatusListSchema.safeParse(
      await callAdapterStatus(service, ctx, accountId),
    );
    if (!decoded.success) {
      logAdapterBoundaryFailure("error", "status_invalid_response");
      return null;
    }
    const statuses = decoded.data;
    const accountStatuses = statuses.filter((status) => status.accountId === accountId);
    for (const status of accountStatuses) {
      const localized = localizeAdapterStatus(ctx, adapter, status);
      ctx.adapters.status.upsert(adapter, localized.accountId, localized);
    }
    return accountStatuses[0] ?? null;
  } catch {
    logAdapterBoundaryFailure("error", "status_refresh_failed");
    return null;
  }
}

function localizeAdapterStatus(
  ctx: KernelContext,
  adapter: string,
  status: AdapterAccountStatus,
): AdapterAccountStatus {
  if (status.mode !== "managed-shared") return status;
  return {
    ...status,
    authenticated: ctx.adapters.identityLinks.listByAccount(
      adapter,
      status.accountId,
    ).length > 0,
  };
}

export function adapterInstallationContext(
  ctx: KernelContext,
): AdapterInstallationContext {
  return { installationId: ctx.installationId };
}

export function callAdapterConnect(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId: string,
  config?: AdapterConnectConfig,
) {
  return service.adapterConnect!(adapterInstallationContext(ctx), accountId, config);
}

export function callAdapterDisconnect(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId: string,
) {
  return service.adapterDisconnect!(adapterInstallationContext(ctx), accountId);
}

function callAdapterSetActivity(
  service: AdapterServiceBinding,
  installationId: KernelContext["installationId"],
  accountId: string,
  surface: AdapterSurface,
  activity: AdapterActivity,
) {
  return service.adapterSetActivity!({ installationId }, accountId, surface, activity);
}

function callAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId?: string,
) {
  return service.adapterStatus!(adapterInstallationContext(ctx), accountId);
}

export function logAdapterBoundaryFailure(
  level: "warn" | "error",
  event: string,
): void {
  const message = JSON.stringify({ component: "adapter", event });
  if (level === "error") {
    console.error(message);
  } else {
    console.warn(message);
  }
}

