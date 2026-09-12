import { installationDeletionRequestSchema, type InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

export const INSTALLATION_RETIREMENT_KEY = "__gsv_installation_retirement__";
export const RESOURCE_IDENTITY_KEY = "__gsv_resource_identity__";
export const MULTIPART_UPLOAD_PREFIX = "__gsv_multipart__/";
export const VERIFIED_INVENTORY_KEY = "__gsv_verified_inventory__";

/** Lost restart replies are reconciled by reading the exact stored name on the next instance. */
export async function attachDurableResourceIdentity(state: DurableObjectState, namespace: Pick<DurableObjectNamespace, "idFromName">, name: string): Promise<void> {
  if (!namespace.idFromName(name).equals(state.id)) throw new Error("Resource identity does not match physical address");
  const existing = state.storage.kv.get<{ name: string }>(RESOURCE_IDENTITY_KEY);
  if (existing) {
    if (existing.name !== name) throw new Error("Resource identity conflicts with stored name");
    return;
  }
  state.storage.kv.put(RESOURCE_IDENTITY_KEY, { name, inventoriedSinceBirth: false });
  // abort discards uncommitted writes, so the identity must be durable before restarting.
  await state.storage.sync();
  state.abort("Installation resource identity attached; restart required");
}

export type ResourceStorageInspection = { name?: string; localId?: string; empty: boolean };

/** Reads ownership and emptiness only; never returns stored messages, prompts, keys, or file content. */
export function inspectResourceStorage(storage: DurableObjectStorage, localId?: string, emptyKvKeys: string[] = []): ResourceStorageInspection {
  const identity = storage.kv.get<{ name: string }>(RESOURCE_IDENTITY_KEY);
  const observation: ResourceStorageInspection = { empty: true };
  if (identity) observation.name = identity.name;
  if (localId) observation.localId = localId;
  for (const [key] of storage.kv.list()) {
    if (key !== RESOURCE_IDENTITY_KEY && key !== INSTALLATION_RETIREMENT_KEY && !emptyKvKeys.includes(key)) observation.empty = false;
  }
  const tables = storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name != '_gsv_schema_migrations' AND name != '__miniflare_do_name'
    AND substr(lower(name), 1, 4) != '_cf_' AND substr(lower(name), 1, 5) != '__cf_'`).toArray();
  for (const { name } of tables) {
    if (storage.sql.exec<{ present: number }>(`SELECT EXISTS(SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1) AS present`).one().present) observation.empty = false;
  }
  return observation;
}

export function durableResourceName(
  state: DurableObjectState,
  namespace: Pick<DurableObjectNamespace, "idFromName">,
): string {
  const stored = state.storage.kv.get<{ name: string; inventoriedSinceBirth: boolean }>(RESOURCE_IDENTITY_KEY);
  const name = state.id.name ?? stored?.name;
  if (!name) throw new Error("Historical resource identity requires operator discovery");
  if (!namespace.idFromName(name).equals(state.id) || (stored && stored.name !== name)) throw new Error("Durable resource identity mismatch");
  if (!stored) {
    const tables = state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name != '__miniflare_do_name' AND substr(lower(name), 1, 4) != '_cf_' AND substr(lower(name), 1, 5) != '__cf_'`).toArray();
    const inventoriedSinceBirth = tables.length === 0 && [...state.storage.kv.list()].length === 0;
    state.storage.kv.put(RESOURCE_IDENTITY_KEY, { name, inventoriedSinceBirth });
  }
  return name;
}

export function stateWithRetirementStorage<T>(state: DurableObjectState<T>, retirement: InstallationRetirement): DurableObjectState<T> {
  const storage = retirement.guardStorage();
  return new Proxy(state, {
    get(target, property) {
      if (property === "storage") return storage;
      // SAFETY: all state members retain their platform receiver; only storage is attenuated.
      const value = target[property as keyof DurableObjectState<T>];
      return value instanceof Function ? value.bind(target) : value;
    },
  });
}

export type ResourceRetirement = InstallationDeletionRequest & {
  phase: "quiescing" | "quiesced" | "live-erased";
  updatedAt: number;
};

/** The owning object keeps this record after erasing its application data. */
export class InstallationRetirement {
  private record: ResourceRetirement | undefined;
  private readonly writes = new Set<Promise<unknown>>();

  constructor(readonly raw: DurableObjectStorage, readonly installationId: string) {
    this.record = raw.kv.get<ResourceRetirement>(INSTALLATION_RETIREMENT_KEY);
    if (this.record && this.record.installationId !== installationId) throw new Error("Retirement identity mismatch");
  }

  get state(): ResourceRetirement | undefined { return this.record; }

  assertActive(): void {
    if (this.record) throw new Error("Installation is retired");
  }

  assertMutable(): void {
    if (this.record && this.record.phase !== "quiescing") throw new Error("Installation storage is retired");
  }

  begin(input: InstallationDeletionRequest): ResourceRetirement {
    const request = installationDeletionRequestSchema.parse(input);
    if (request.installationId !== this.installationId) throw new Error("Retirement identity mismatch");
    if (this.record) {
      if (this.record.operationId !== request.operationId) throw new Error("Retirement operation mismatch");
      return this.record;
    }
    return this.save({ ...request, phase: "quiescing", updatedAt: Date.now() });
  }

  async write<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const pending = operation();
    this.writes.add(pending);
    try { return await pending; } finally { this.writes.delete(pending); }
  }

  async drain(): Promise<void> {
    while (this.writes.size) await Promise.allSettled(this.writes);
  }

  recordMultipart(upload: Pick<R2MultipartUpload, "key" | "uploadId">): void {
    this.raw.kv.put(`${MULTIPART_UPLOAD_PREFIX}${upload.uploadId}`, { key: upload.key, uploadId: upload.uploadId });
  }

  forgetMultipart(uploadId: string): void {
    this.raw.kv.delete(`${MULTIPART_UPLOAD_PREFIX}${uploadId}`);
  }

  async abortMultipart(bucket: R2Bucket): Promise<number> {
    if (!this.record) throw new Error("Retirement has not started");
    const uploads = [...this.raw.kv.list<{ key: string; uploadId: string }>({ prefix: MULTIPART_UPLOAD_PREFIX })].map(([, upload]) => upload);
    for (const upload of uploads.slice(0, 20)) {
      await bucket.resumeMultipartUpload(upload.key, upload.uploadId).abort();
      this.forgetMultipart(upload.uploadId);
    }
    return Math.max(0, uploads.length - 20);
  }

  async quiesced(): Promise<ResourceRetirement> {
    if (!this.record) throw new Error("Retirement has not started");
    if (this.record.phase !== "quiescing") return this.record;
    await this.drain();
    await this.raw.deleteAlarm();
    return this.save({ ...this.record, phase: "quiesced", updatedAt: Date.now() });
  }

  /** Only the retirement owner can use raw storage; normal continuations remain fenced. */
  erase(): ResourceRetirement {
    if (!this.record || this.record.phase === "quiescing") throw new Error("Resource must be quiesced before erasure");
    if (this.record.phase === "live-erased") return this.record;
    const next: ResourceRetirement = { ...this.record, phase: "live-erased", updatedAt: Date.now() };
    this.raw.transactionSync(() => {
      const tables = this.raw.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name != '__miniflare_do_name' AND substr(lower(name), 1, 4) != '_cf_' AND substr(lower(name), 1, 5) != '__cf_'`).toArray();
      for (const { name } of tables) this.raw.sql.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
      for (const [key] of this.raw.kv.list()) {
        if (key !== RESOURCE_IDENTITY_KEY) this.raw.kv.delete(key);
      }
      this.raw.kv.put(INSTALLATION_RETIREMENT_KEY, next);
    });
    this.record = next;
    return next;
  }

  guardStorage(): DurableObjectStorage {
    const sql = guardMethods(this.raw.sql, () => this.assertMutable(), new Set(["exec"]));
    const kv = guardMethods(this.raw.kv, () => this.assertMutable(), new Set(["put", "delete"]));
    return new Proxy(this.raw, {
      get: (target, property) => {
        if (property === "sql") return sql;
        if (property === "kv") return kv;
        if (property === "setAlarm") return (...args: Parameters<DurableObjectStorage["setAlarm"]>) => this.write(() => target.setAlarm(...args));
        if (property === "transaction") return <T>(operation: (txn: DurableObjectTransaction) => Promise<T>) => {
          this.assertMutable();
          return target.transaction((txn) => operation(guardMethods(txn, () => this.assertMutable(), new Set(["put", "delete", "setAlarm"]))));
        };
        // SAFETY: the proxy preserves the storage API and binds platform methods to their receiver.
        const value = target[property as keyof DurableObjectStorage];
        if (!(value instanceof Function)) return value;
        return (...args: unknown[]) => {
          if (["put", "delete", "deleteAll", "transaction", "transactionSync"].includes(String(property))) this.assertMutable();
          return Function.prototype.apply.call(value, target, args);
        };
      },
    });
  }

  private save(record: ResourceRetirement): ResourceRetirement {
    this.raw.kv.put(INSTALLATION_RETIREMENT_KEY, record);
    this.record = record;
    return record;
  }
}

function guardMethods<T extends object>(object: T, check: () => void, methods: Set<string>): T {
  return new Proxy(object, {
    get(target, property) {
      // SAFETY: proxy property access is delegated to the original platform object.
      const value = target[property as keyof T];
      if (!(value instanceof Function)) return value;
      return (...args: unknown[]) => {
        if (methods.has(String(property))) check();
        return Function.prototype.apply.call(value, target, args);
      };
    },
  });
}
