import { installationDeletionRequestSchema, type InstallationDeletionReceipt, type InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { AdapterPeerLink, AdapterPeerRoute } from "./pairing-route";
import { ADAPTER_RETIREMENT_PREFIX, AdapterRetirement } from "./retirement";
import { eraseAdapterHilInstallation, inspectAdapterHilOwnership } from "./hil-approval";

type Ledger = {
  inspectOwnership(installationId?: string): Promise<{ installationIds: string[]; unattributed: number; ownedCount: number }>;
  eraseInstallation(installationId: string, limit?: number): Promise<number>;
};
/** An adapter-owned store of space-scoped records under its own key prefix. */
export type OwnedPeerStore = Ledger & { prefix: string };
export type AdapterResourceInspection = {
  name?: string;
  outcome: "identified" | "unrelated" | "empty" | "unidentified";
  installationId?: string;
};
const BACKUP_LIFETIME_MS = 30 * 24 * 60 * 60_000 + 60_000;

/** Selectively retires one space's state inside a shared external-identity owner. */
export class AdapterPeerRetirement<State extends AdapterPeerLink> {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly fence: AdapterRetirement,
    private readonly options: {
      stateKey: string;
      inboundPrefix: string;
      inbound: Ledger;
      outbound: Ledger;
      hil: boolean;
      /** Further adapter-owned stores whose records belong to one space each. */
      stores?: OwnedPeerStore[];
      identity(state: State): { name: string; understood: boolean };
      cancelWork?(installationId: string): Promise<void>;
    },
  ) {}

  async inspect(installationId: string): Promise<AdapterResourceInspection> {
    const state = await this.storage.get<State>(this.options.stateKey);
    const identity = state ? this.options.identity(state) : undefined;
    const ownership = await this.ownership(installationId);
    const stores = this.options.stores ?? [];
    const knownKeys = [...this.storage.kv.list()].every(([key]) =>
      key === this.options.stateKey || key === "outbound_delivery:v1:meta"
      || key.startsWith("outbound_delivery:v1:record:") || key.startsWith(this.options.inboundPrefix)
      || key.startsWith(ADAPTER_RETIREMENT_PREFIX)
      || stores.some((store) => key.startsWith(store.prefix)));
    const knownTables = this.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 5) != '__cf_' AND name NOT IN ('_cf_METADATA', '_cf_KV', '__miniflare_do_name')",
    ).toArray().every(({ name }) => name === "_gsv_schema_migrations" || this.options.hil && name === "adapter_hil_approvals");
    if (!knownKeys || !knownTables || identity && !identity.understood || ownership.unattributed) {
      return { outcome: "unidentified" };
    }
    if (!state) return ownership.count ? { outcome: "unidentified" } : { outcome: "empty" };
    const target = routes(state).some((route) => route.installationId === installationId) || ownership.count > 0;
    return target
      ? { name: identity!.name, outcome: "identified", installationId }
      : { name: identity!.name, outcome: "unrelated" };
  }

  async quiesce(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    this.fence.quiesce(input);
    await this.storage.transaction(async (txn) => {
      const state = await txn.get<State>(this.options.stateKey);
      if (state) await txn.put(this.options.stateKey, withoutInstallationRoutes(state, input.installationId));
    });
    await this.options.cancelWork?.(input.installationId);
    return await this.status(input);
  }

  async erase(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const quiesced = await this.quiesce(input);
    if (quiesced.phase === "quiescing" || quiesced.outcome === "missing-inventory") return quiesced;
    const [inbound, outbound, ...stores] = await Promise.all([
      this.options.inbound.eraseInstallation(input.installationId),
      this.options.outbound.eraseInstallation(input.installationId),
      ...(this.options.stores ?? []).map((store) => store.eraseInstallation(input.installationId)),
    ]);
    const approvals = this.options.hil ? eraseAdapterHilInstallation(this.storage, input.installationId) : 0;
    const remaining = inbound + outbound + approvals + stores.reduce((total, count) => total + count, 0);
    if (remaining) return { ...quiesced, phase: "erasing", pendingResources: remaining };
    this.fence.complete(input);
    return await this.status(input);
  }

  async status(value: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    const state = this.fence.status(input);
    const ownership = await this.ownership(input.installationId);
    const inspected = await this.inspect(input.installationId);
    const base: InstallationDeletionReceipt = {
      ...input, phase: !state.startedAt ? "pending" : state.active ? "quiescing" : "quiesced", updatedAt: state.startedAt ?? Date.now(),
      pendingResources: state.active + ownership.count, outcome: inspected.outcome === "unidentified" ? "missing-inventory" : "progress", retainedCopies: [],
    };
    const erasedAt = state.erasedAt;
    if (!erasedAt || base.pendingResources || base.outcome === "missing-inventory") return base;
    const expiresAt = erasedAt + BACKUP_LIFETIME_MS;
    return Date.now() < expiresAt
      ? { ...base, phase: "live-erased", outcome: "retention-pending", retainedCopies: [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }] }
      : { ...base, phase: "erased", outcome: "complete" };
  }

  private async ownership(installationId: string): Promise<{ count: number; unattributed: number }> {
    const ledgers = [this.options.inbound, this.options.outbound, ...(this.options.stores ?? [])];
    const owned = await Promise.all(ledgers.map((ledger) => ledger.inspectOwnership(installationId)));
    const hil = this.options.hil ? inspectAdapterHilOwnership(this.storage, installationId) : { ownedCount: 0, unattributed: 0 };
    return {
      count: owned.reduce((total, ownership) => total + ownership.ownedCount, hil.ownedCount),
      unattributed: owned.reduce((total, ownership) => total + ownership.unattributed, hil.unattributed),
    };
  }
}

export function routes(state: AdapterPeerLink): AdapterPeerRoute[] {
  return [state.activeRoute, state.pairing?.preparedRoute, state.pairing?.previousRoute, state.lastDisconnect?.route].filter((route): route is AdapterPeerRoute => Boolean(route));
}

export function withoutInstallationRoutes<State extends AdapterPeerLink>(state: State, installationId: string): State {
  const next = { ...state };
  if (next.activeRoute?.installationId === installationId) delete next.activeRoute;
  if (next.lastDisconnect?.route.installationId === installationId) delete next.lastDisconnect;
  if (next.pairing?.preparedRoute?.installationId === installationId) delete next.pairing;
  else if (next.pairing?.previousRoute?.installationId === installationId) {
    next.pairing = { ...next.pairing };
    delete next.pairing.previousRoute;
  }
  return next;
}
