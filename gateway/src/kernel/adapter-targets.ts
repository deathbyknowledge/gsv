import type { AdapterStatusRecord } from "./adapter-status";
import { resolveCallerOwnerUid, type KernelContext } from "./context";

export type AdapterTarget = {
  targetId: string;
  adapter: string;
  accountId: string;
  label: string;
  description: string;
  status: AdapterStatusRecord;
};

export type AdapterTargetListOptions = {
  includeOffline?: boolean;
};

const ADAPTER_TARGET_PREFIX = "adapter:";

export function adapterTargetId(adapter: string, accountId: string): string {
  return `${ADAPTER_TARGET_PREFIX}${encodeURIComponent(normalizeAdapter(adapter))}:${encodeURIComponent(accountId.trim())}`;
}

export function parseAdapterTargetId(targetId: string | undefined): { adapter: string; accountId: string } | null {
  if (!targetId?.startsWith(ADAPTER_TARGET_PREFIX)) {
    return null;
  }

  const rest = targetId.slice(ADAPTER_TARGET_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }

  try {
    const adapter = normalizeAdapter(decodeURIComponent(rest.slice(0, separator)));
    const accountId = decodeURIComponent(rest.slice(separator + 1)).trim();
    if (!adapter || !accountId) {
      return null;
    }
    return { adapter, accountId };
  } catch {
    return null;
  }
}

export function listVisibleAdapterTargets(
  ctx: KernelContext,
  options: AdapterTargetListOptions = {},
): AdapterTarget[] {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    return [];
  }

  const adapters = ctx.adapters as KernelContext["adapters"] | undefined;
  if (!adapters?.status || !adapters.identityLinks) {
    return [];
  }

  const statuses = visibleAdapterStatuses(ctx);
  const targets = new Map<string, AdapterTarget>();

  for (const status of statuses) {
    const adapter = normalizeAdapter(status.adapter);
    const online = status.connected && status.authenticated;
    if (!status.authenticated || (!options.includeOffline && !online)) continue;
    if (!adapterShellExecServiceAvailable(ctx, adapter)) continue;

    const targetId = adapterTargetId(adapter, status.accountId);
    targets.set(targetId, {
      targetId,
      adapter,
      accountId: status.accountId,
      label: adapterDisplayName(adapter),
      description: [
        `${adapterDisplayName(adapter)} command target.`,
        "Run the target shell help command to discover supported messaging actions.",
      ].join(" "),
      status: { ...status, adapter },
    });
  }

  return Array.from(targets.values()).sort((left, right) => left.targetId.localeCompare(right.targetId));
}

export function getVisibleAdapterTarget(
  ctx: KernelContext,
  targetId: string,
  options: AdapterTargetListOptions = {},
): AdapterTarget | null {
  const parsed = parseAdapterTargetId(targetId);
  if (!parsed) {
    return null;
  }

  return listVisibleAdapterTargets(ctx, options).find((target) =>
    target.adapter === parsed.adapter && target.accountId === parsed.accountId
  ) ?? null;
}

export function isVisibleAdapterTarget(ctx: KernelContext, adapter: string, accountId: string): boolean {
  const targetId = adapterTargetId(adapter, accountId);
  return getVisibleAdapterTarget(ctx, targetId) !== null;
}

function adapterShellExecServiceAvailable(ctx: KernelContext, adapter: string): boolean {
  const service = adapterServiceBinding(ctx.env, adapter);
  return Boolean(service && typeof service.adapterShellExec === "function");
}

function visibleAdapterStatuses(ctx: KernelContext): AdapterStatusRecord[] {
  const identity = ctx.identity;
  const adapters = ctx.adapters as KernelContext["adapters"] | undefined;
  if (!identity || identity.role !== "user" || !adapters?.status) {
    return [];
  }

  const ownerUid = resolveCallerOwnerUid(ctx);
  if (ownerUid === 0) {
    const statusStore = adapters.status as typeof adapters.status & {
      listAll?: () => AdapterStatusRecord[];
    };
    return typeof statusStore.listAll === "function" ? statusStore.listAll() : [];
  }

  const links = adapters.identityLinks?.list(ownerUid) ?? [];
  const seen = new Set<string>();
  const statuses: AdapterStatusRecord[] = [];
  for (const link of links) {
    const adapter = normalizeAdapter(link.adapter);
    const accountId = link.accountId.trim();
    const key = `${adapter}\0${accountId}`;
    if (!adapter || !accountId || seen.has(key)) continue;
    seen.add(key);

    const status = adapters.status.list(adapter, accountId)[0];
    if (status) {
      statuses.push({ ...status, adapter });
    }
  }
  return statuses;
}

function adapterServiceBinding(env: Env | undefined, adapter: string): { adapterShellExec?: unknown } | null {
  if (!env) return null;
  const key = `CHANNEL_${normalizeAdapter(adapter).toUpperCase()}`;
  const binding = (env as unknown as Record<string, unknown>)[key];
  return binding && typeof binding === "object"
    ? binding as { adapterShellExec?: unknown }
    : null;
}

function normalizeAdapter(adapter: string): string {
  return adapter.trim().toLowerCase();
}

function adapterDisplayName(adapter: string): string {
  if (adapter === "whatsapp") return "WhatsApp";
  if (adapter === "discord") return "Discord";
  return adapter.charAt(0).toUpperCase() + adapter.slice(1);
}
