import * as z from "zod/mini";
import { installationDeletionRequestSchema, type InstallationDeletionReceipt, type InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import {
  adapterAccountDurableObjectName, LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  resolveAdapterAccountDurableObjectIdentity, type AdapterAccountDurableObjectIdentity,
} from "../../shared/src/installation";
import type { AdapterResourceInspection } from "../../shared/src/peer-retirement";

const IDENTITY_KEY = "discord_account_identity:v1";
const RETIREMENT_KEY = "discord_account_retirement:v1";
const BACKUP_LIFETIME_MS = 30 * 24 * 60 * 60_000 + 60_000;
const accountStateSchema = z.object({ accountId: z.optional(z.nullable(z.string())) });
const identitySchema = z.strictObject({ installationId: z.string(), accountId: z.string(), name: z.string() });
const retirementSchema = z.strictObject({ version: z.literal(1), installationId: z.string(), operationId: z.string(), startedAt: z.number(), erasedAt: z.optional(z.number()) });
type AccountIdentity = z.infer<typeof identitySchema>;
type AccountRetirementRecord = z.infer<typeof retirementSchema>;

/** Legacy account objects own all their data; shared application objects never acquire this identity. */
export class DiscordAccountRetirement {
  private active = 0;
  private readonly cancellation = new AbortController();

  constructor(
    private readonly raw: DurableObjectStorage,
    private readonly objectId: string,
    private readonly namespace: Pick<DurableObjectNamespace, "idFromName"> | undefined,
  ) {}

  get retired(): boolean { return this.raw.kv.get(RETIREMENT_KEY) !== undefined; }
  requireLive(): void { if (this.retired) throw new Error("Discord account installation is retired"); }
  get signal(): AbortSignal { this.requireLive(); return this.cancellation.signal; }
  operation(): Disposable {
    this.requireLive();
    this.active++;
    return { [Symbol.dispose]: () => { this.active--; } };
  }

  identity(): AdapterAccountDurableObjectIdentity | undefined {
    const stored = this.raw.kv.get(IDENTITY_KEY);
    if (stored === undefined) return undefined;
    const identity = identitySchema.parse(stored);
    if (!this.matches(identity)) throw new Error("Discord account physical identity mismatch");
    return identity;
  }

  inspect(targetInstallationId: string, candidates: string[] = []): AdapterResourceInspection {
    if (!this.knownTables()) return { outcome: "unidentified" };
    const storedState = this.raw.kv.get("state");
    const parsedState = accountStateSchema.safeParse(storedState);
    if (storedState !== undefined && !parsedState.success) return { outcome: "unidentified" };
    const state = parsedState.success ? parsedState.data : undefined;
    let identity: AccountIdentity | undefined;
    const saved = this.raw.kv.get(IDENTITY_KEY);
    if (saved !== undefined) {
      const parsed = identitySchema.safeParse(saved);
      if (!parsed.success || !this.matches(parsed.data)) return { outcome: "unidentified" };
      if (state && state.accountId !== parsed.data.accountId) return { outcome: "unidentified" };
      identity = parsed.data;
    } else if (state?.accountId?.trim()) {
      // Singleton is a supported reserved projection, never an inferred managed installation.
      for (const installationId of new Set([targetInstallationId, ...candidates, LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID])) {
        try {
          const name = adapterAccountDurableObjectName({ installationId }, state.accountId);
          const candidate = { ...resolveAdapterAccountDurableObjectIdentity(name, { installationId, accountId: state.accountId }), name };
          if (this.matches(candidate)) { identity = candidate; break; }
        } catch { /* An invalid candidate cannot establish physical ownership. */ }
      }
      if (identity) this.raw.kv.put(IDENTITY_KEY, identity);
    }
    if (!identity) return this.dataKeys(1).length || saved !== undefined || this.retired ? { outcome: "unidentified" } : { outcome: "empty" };
    return identity.installationId === targetInstallationId
      ? { name: identity.name, installationId: targetInstallationId, outcome: "identified" }
      : { name: identity.name, outcome: "unrelated" };
  }

  async quiesce(value: InstallationDeletionRequest, cancel: () => void): Promise<InstallationDeletionReceipt> {
    const input = installationDeletionRequestSchema.parse(value);
    this.requireIdentity(input.installationId);
    const existing = this.record(input);
    if (!existing) this.raw.kv.put(RETIREMENT_KEY, { version: 1, installationId: input.installationId, operationId: input.operationId, startedAt: Date.now() } satisfies AccountRetirementRecord);
    this.cancellation.abort(new Error("Discord account installation is retired"));
    cancel();
    await this.raw.deleteAlarm();
    return this.status(input);
  }

  erase(value: InstallationDeletionRequest): InstallationDeletionReceipt {
    const input = installationDeletionRequestSchema.parse(value);
    const status = this.status(input);
    const record = this.record(input);
    if (!record || this.active || status.outcome === "missing-inventory") return status;
    this.raw.transactionSync(() => {
      for (const key of this.dataKeys(32)) this.raw.kv.delete(key);
      if (!this.dataKeys(1).length && !record.erasedAt) this.raw.kv.put(RETIREMENT_KEY, { ...record, erasedAt: Date.now() });
    });
    const next = this.status(input);
    return next.phase === "quiesced" ? { ...next, phase: "erasing" } : next;
  }

  status(value: InstallationDeletionRequest): InstallationDeletionReceipt {
    const input = installationDeletionRequestSchema.parse(value);
    this.requireIdentity(input.installationId);
    const record = this.record(input);
    const remaining = this.dataKeys(33).length;
    const receipt: InstallationDeletionReceipt = {
      ...input, phase: !record ? "pending" : this.active ? "quiescing" : "quiesced",
      updatedAt: record?.erasedAt ?? record?.startedAt ?? Date.now(),
      pendingResources: this.active + remaining,
      outcome: this.knownTables() ? "progress" : "missing-inventory", retainedCopies: [],
    };
    if (!record?.erasedAt || receipt.pendingResources || receipt.outcome === "missing-inventory") return receipt;
    const expiresAt = record.erasedAt + BACKUP_LIFETIME_MS;
    return Date.now() < expiresAt
      ? { ...receipt, phase: "live-erased", outcome: "retention-pending", retainedCopies: [{ id: "cloudflare-durable-object-pitr", kind: "backup", expiresAt }] }
      : { ...receipt, phase: "erased", outcome: "complete" };
  }

  /** Ledgers and delayed callbacks share one durable mutation fence, including transaction continuations. */
  guardStorage(): DurableObjectStorage {
    const check = () => this.requireLive();
    const kv = guardedMethods(this.raw.kv, check, new Set(["put", "delete"]));
    const sql = guardedMethods(this.raw.sql, check, new Set(["exec"]));
    return new Proxy(this.raw, {
      get: (target, property) => {
        if (property === "kv") return kv;
        if (property === "sql") return sql;
        if (property === "transaction") return <T>(operation: (txn: DurableObjectTransaction) => Promise<T>) => {
          check();
          return target.transaction((txn) => operation(guardedMethods(txn, check, new Set(["put", "delete", "setAlarm"]))));
        };
        // SAFETY: the proxy preserves the platform API and binds native methods to their receiver.
        const value = target[property as keyof DurableObjectStorage];
        if (!(value instanceof Function)) return value;
        return (...args: unknown[]) => {
          if (["put", "delete", "deleteAll", "transactionSync", "setAlarm"].includes(String(property))) check();
          return Function.prototype.apply.call(value, target, args);
        };
      },
    });
  }

  private requireIdentity(installationId: string): void {
    if (this.inspect(installationId).outcome !== "identified") throw new Error("Discord account installation ownership is not verified");
  }
  private matches(identity: AccountIdentity): boolean {
    try {
      return adapterAccountDurableObjectName({ installationId: identity.installationId }, identity.accountId) === identity.name
        && this.namespace?.idFromName(identity.name).toString() === this.objectId;
    } catch { return false; }
  }
  private record(input: InstallationDeletionRequest): AccountRetirementRecord | undefined {
    const value = this.raw.kv.get(RETIREMENT_KEY);
    if (value === undefined) return undefined;
    const record = retirementSchema.parse(value);
    if (record.installationId !== input.installationId || record.operationId !== input.operationId) throw new Error("Discord account deletion operation is immutable");
    return record;
  }
  private dataKeys(limit: number): string[] {
    const keys: string[] = [];
    for (const [key] of this.raw.kv.list({ limit: limit + 2 })) {
      if (key !== IDENTITY_KEY && key !== RETIREMENT_KEY) keys.push(key);
      if (keys.length === limit) break;
    }
    return keys;
  }
  private knownTables(): boolean {
    return !this.raw.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 5) != '__cf_' AND name NOT IN ('_cf_METADATA', '_cf_KV', '__miniflare_do_name') LIMIT 1").toArray().length;
  }
}

function guardedMethods<T extends object>(object: T, check: () => void, methods: Set<string>): T {
  return new Proxy(object, {
    get(target, property) {
      // SAFETY: proxy property access delegates to the original native object.
      const value = target[property as keyof T];
      if (!(value instanceof Function)) return value;
      return (...args: unknown[]) => {
        if (methods.has(String(property))) check();
        return Function.prototype.apply.call(value, target, args);
      };
    },
  });
}
