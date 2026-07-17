import {
  DurableObject,
} from "cloudflare:workers";
import {
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  normalizeManagedProviderIds,
  validateManagedObjectDescriptor,
  type ManagedObjectDescriptor,
  type ManagedObjectDescriptorBatch,
} from "@humansandmachines/gsv/protocol/managed-objects";
import { runSqlMigrations } from "@humansandmachines/gsv-worker-runtime/schema";

export const MANAGED_ADMISSION_GATE_NAME = "singleton";
export const MANAGED_ADMISSION_DRAIN_TIMEOUT_MS = 10_000;
export const MANAGED_ADMISSION_LEASE_TTL_MS = 15_000;
export const MANAGED_ADMISSION_HEARTBEAT_MS = 3_000;
export const MAX_MANAGED_ADMISSION_OWNER_LENGTH = 512;

type AdmissionStatus = "active" | "fenced" | "erased";
type AdmissionStateRow = { status: AdmissionStatus; epoch: number };
type LeaseCountRow = { count: number };
type ManagedAdmissionEnv = {
  GSV_MANAGED_ADMISSION_LEASE_TTL_MS?: string;
  MANAGED_ADMISSION?: {
    idFromName(name: string): DurableObjectId;
  };
};

export type ManagedAdmissionLease = {
  admitted: true;
  leaseId: string;
  epoch: number;
};

export type ManagedAdmissionRejection = {
  admitted: false;
  status: Exclude<AdmissionStatus, "active">;
  epoch: number;
};

export type ManagedAdmissionResult = ManagedAdmissionLease | ManagedAdmissionRejection;

export interface ManagedAdmissionGateStub {
  acquire(owner: string): Promise<ManagedAdmissionResult>;
  renew(leaseId: string, epoch: number): Promise<void>;
  assertCurrent(leaseId: string, epoch: number): Promise<boolean>;
  release(leaseId: string): Promise<void>;
  managedFenceAll(timeoutMs?: number): Promise<{
    status: "fenced" | "erased";
    epoch: number;
    drained: boolean;
  }>;
  managedResumeAll(): Promise<{ status: "active"; epoch: number }>;
  managedEraseAll(timeoutMs?: number): Promise<
    | { status: "erased"; epoch: number; drained: true }
    | { status: "fenced"; epoch: number; drained: false }
  >;
  managedDescriptor(): Promise<ManagedObjectDescriptor>;
}

export type ManagedAdmissionNamespace = {
  getByName(name: string): ManagedAdmissionGateStub;
};

export type ManagedAdmissionDescriptorNamespace = ManagedAdmissionNamespace & {
  idFromString(providerId: string): DurableObjectId;
  idFromName(logicalName: string): DurableObjectId;
  get(id: DurableObjectId): ManagedAdmissionGateStub;
};

export class ManagedAdmissionUnavailableError extends Error {
  constructor(readonly status: Exclude<AdmissionStatus, "active">) {
    super(`Managed adapter admission is ${status}`);
    this.name = "ManagedAdmissionUnavailableError";
  }
}

const MANAGED_ADMISSION_MIGRATIONS = [{
  id: 1,
  name: "initial_managed_admission_schema",
  statements: [
    `CREATE TABLE managed_admission_state (
       singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
       status TEXT NOT NULL CHECK (status IN ('active', 'fenced', 'erased')),
       epoch INTEGER NOT NULL CHECK (epoch >= 0)
     )`,
    `INSERT INTO managed_admission_state (singleton, status, epoch)
     VALUES (1, 'active', 0)`,
    `CREATE TABLE managed_admission_leases (
       lease_id TEXT PRIMARY KEY,
       epoch INTEGER NOT NULL,
       owner TEXT NOT NULL,
       admitted_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
    `CREATE INDEX managed_admission_leases_epoch
     ON managed_admission_leases (epoch)`,
  ],
}] as const;

/** Durable per-adapter singleton admission fence and in-flight lease ledger. */
export class ManagedAdmissionGate extends DurableObject<ManagedAdmissionEnv> {
  private readonly drainWaiters = new Set<() => void>();
  private readonly leaseTtlMs: number;

  constructor(ctx: DurableObjectState, env: ManagedAdmissionEnv) {
    super(ctx, env);
    this.leaseTtlMs = managedLeaseTtl(env.GSV_MANAGED_ADMISSION_LEASE_TTL_MS);
    runSqlMigrations(
      ctx.storage,
      "adapter-managed-admission",
      MANAGED_ADMISSION_MIGRATIONS,
    );
  }

  async acquire(owner: string): Promise<ManagedAdmissionResult> {
    const normalizedOwner = normalizeOwner(owner);
    return this.ctx.storage.transactionSync(() => {
      this.purgeExpiredLeases();
      const state = this.readState();
      if (state.status !== "active") {
        return { admitted: false, status: state.status, epoch: state.epoch };
      }

      const leaseId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO managed_admission_leases
           (lease_id, epoch, owner, admitted_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        leaseId,
        state.epoch,
        normalizedOwner,
        Date.now(),
        Date.now() + this.leaseTtlMs,
      );
      return { admitted: true, leaseId, epoch: state.epoch };
    });
  }

  async renew(leaseId: string, epoch: number): Promise<void> {
    const result = this.ctx.storage.sql.exec(
      `UPDATE managed_admission_leases
       SET expires_at = ?
       WHERE lease_id = ? AND epoch = ? AND expires_at > ?`,
      Date.now() + this.leaseTtlMs,
      leaseId,
      epoch,
      Date.now(),
    );
    if (result.rowsWritten !== 1) {
      throw new Error("Managed adapter admission lease is no longer live");
    }
  }

  async assertCurrent(leaseId: string, epoch: number): Promise<boolean> {
    this.purgeExpiredLeases();
    const state = this.readState();
    const rows = this.ctx.storage.sql.exec<{ lease_id: string }>(
      `SELECT lease_id FROM managed_admission_leases
       WHERE lease_id = ? AND epoch = ? AND expires_at > ?`,
      leaseId,
      epoch,
      Date.now(),
    ).toArray();
    return state.status === "active" && state.epoch === epoch && rows.length === 1;
  }

  async release(leaseId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM managed_admission_leases WHERE lease_id = ?",
      leaseId,
    );
    if (this.leaseCount() === 0) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
  }

  async managedFenceAll(
    timeoutMs = MANAGED_ADMISSION_DRAIN_TIMEOUT_MS,
  ): Promise<{
    status: "fenced" | "erased";
    epoch: number;
    drained: boolean;
  }> {
    const boundedTimeout = normalizeTimeout(timeoutMs);
    const state = this.ctx.storage.transactionSync(() => {
      this.purgeExpiredLeases();
      const current = this.readState();
      if (current.status === "erased") {
        return current;
      }
      if (current.status === "fenced") return current;
      const next: AdmissionStateRow = {
        status: "fenced",
        epoch: current.epoch + 1,
      };
      this.writeState(next);
      return next;
    });

    if (state.status === "erased") {
      return { status: "erased", epoch: state.epoch, drained: true };
    }
    const drained = await this.awaitDrain(boundedTimeout);
    return { status: "fenced", epoch: state.epoch, drained };
  }

  async managedResumeAll(): Promise<{ status: "active"; epoch: number }> {
    const next = this.ctx.storage.transactionSync(() => {
      this.purgeExpiredLeases();
      const current = this.readState();
      if (current.status === "erased") {
        throw new ManagedAdmissionUnavailableError("erased");
      }
      if (this.leaseCountInTransaction() !== 0) {
        throw new Error("Managed adapter admission cannot resume with live leases");
      }
      if (current.status === "active") return current;
      const active: AdmissionStateRow = {
        status: "active",
        epoch: current.epoch + 1,
      };
      this.writeState(active);
      return active;
    });
    return { status: "active", epoch: next.epoch };
  }

  async managedEraseAll(
    timeoutMs = MANAGED_ADMISSION_DRAIN_TIMEOUT_MS,
  ): Promise<
    | { status: "erased"; epoch: number; drained: true }
    | { status: "fenced"; epoch: number; drained: false }
  > {
    const fenced = await this.managedFenceAll(timeoutMs);
    if (fenced.status === "erased") {
      return { status: "erased", epoch: fenced.epoch, drained: true };
    }
    if (!fenced.drained) {
      return { status: "fenced", epoch: fenced.epoch, drained: false };
    }
    const next = this.ctx.storage.transactionSync(() => {
      const current = this.readState();
      if (current.status === "erased") return current;
      const erased: AdmissionStateRow = {
        status: "erased",
        epoch: current.epoch + 1,
      };
      this.writeState(erased);
      return erased;
    });
    return { status: "erased", epoch: next.epoch, drained: true };
  }

  async managedDescriptor(): Promise<ManagedObjectDescriptor> {
    const state = this.readState();
    const providerId = this.ctx.id.toString();
    if (
      this.env.MANAGED_ADMISSION
      && this.env.MANAGED_ADMISSION.idFromName(MANAGED_ADMISSION_GATE_NAME).toString()
        !== providerId
    ) {
      return {
        schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
        kind: "adapter_admission",
        providerId,
        logicalName: null,
        classification: state.status === "erased" ? "erased" : "uninitialized",
        lifecycle: state.status === "erased"
          ? { status: "erased", epoch: state.epoch }
          : { status: "uninitialized", epoch: state.epoch },
      };
    }
    return {
      schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
      kind: "adapter_admission",
      providerId,
      logicalName: MANAGED_ADMISSION_GATE_NAME,
      classification: state.status === "erased" ? "erased" : "initialized",
      lifecycle: {
        status: state.status === "fenced" ? "paused" : state.status,
        epoch: state.epoch,
      },
    };
  }

  private readState(): AdmissionStateRow {
    const [state] = this.ctx.storage.sql.exec<AdmissionStateRow>(
      "SELECT status, epoch FROM managed_admission_state WHERE singleton = 1",
    ).toArray();
    if (!state) throw new Error("Managed adapter admission state is missing");
    return state;
  }

  private writeState(state: AdmissionStateRow): void {
    this.ctx.storage.sql.exec(
      `UPDATE managed_admission_state SET status = ?, epoch = ?
       WHERE singleton = 1`,
      state.status,
      state.epoch,
    );
  }

  private leaseCount(): number {
    return this.ctx.storage.transactionSync(() => {
      this.purgeExpiredLeases();
      return this.leaseCountInTransaction();
    });
  }

  private leaseCountInTransaction(): number {
    const [row] = this.ctx.storage.sql.exec<LeaseCountRow>(
      "SELECT COUNT(*) AS count FROM managed_admission_leases",
    ).toArray();
    return row?.count ?? 0;
  }

  private purgeExpiredLeases(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM managed_admission_leases WHERE expires_at <= ?",
      Date.now(),
    );
  }

  private async awaitDrain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.leaseCount() !== 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await this.awaitLeaseChange(Math.min(250, remaining));
    }
    return true;
  }

  private awaitLeaseChange(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.drainWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.drainWaiters.add(finish);
    });
  }
}

export async function describeManagedAdmissionObjects(
  namespace: ManagedAdmissionDescriptorNamespace,
  providerIds: unknown,
): Promise<ManagedObjectDescriptorBatch> {
  const normalized = normalizeManagedProviderIds(providerIds);
  const objects = new Array<ManagedObjectDescriptor>(normalized.length);
  for (let offset = 0; offset < normalized.length; offset += 8) {
    await Promise.all(normalized.slice(offset, offset + 8).map(async (providerId, index) => {
      const id = namespace.idFromString(providerId);
      const descriptor = validateManagedObjectDescriptor(
        await namespace.get(id).managedDescriptor(),
        "adapter_admission",
        providerId,
      );
      if (
        descriptor.logicalName !== null
        && namespace.idFromName(descriptor.logicalName).toString() !== providerId
      ) {
        throw new Error("Managed adapter admission identity does not match provider ID");
      }
      objects[offset + index] = descriptor;
    }));
  }
  return {
    schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
    kind: "adapter_admission",
    objects,
  };
}

export async function runWithManagedAdmission<T>(
  namespace: ManagedAdmissionNamespace,
  owner: string,
  operation: () => Promise<T>,
  options: { heartbeatMs?: number } = {},
): Promise<T> {
  const gate = namespace.getByName(MANAGED_ADMISSION_GATE_NAME);
  const admission = await gate.acquire(owner);
  if (!admission.admitted) {
    throw new ManagedAdmissionUnavailableError(admission.status);
  }

  let heartbeatError: unknown;
  const heartbeatMs = options.heartbeatMs === undefined
    ? MANAGED_ADMISSION_HEARTBEAT_MS
    : normalizeHeartbeat(options.heartbeatMs);
  const heartbeat = setInterval(() => {
    gate.renew(admission.leaseId, admission.epoch).catch((error: unknown) => {
      heartbeatError = error;
    });
  }, heartbeatMs);
  try {
    const result = await operation();
    if (heartbeatError) throw heartbeatError;
    if (!await gate.assertCurrent(admission.leaseId, admission.epoch)) {
      throw new ManagedAdmissionUnavailableError("fenced");
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await gate.release(admission.leaseId);
  }
}

function normalizeOwner(owner: string): string {
  if (
    typeof owner !== "string"
    || owner.length === 0
    || owner.length > MAX_MANAGED_ADMISSION_OWNER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(owner)
  ) {
    throw new TypeError("Managed adapter admission owner is invalid");
  }
  return owner;
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("Managed adapter admission timeout must be 1-30000ms");
  }
  return timeoutMs;
}

function normalizeHeartbeat(heartbeatMs: number): number {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 10_000) {
    throw new RangeError("Managed adapter admission heartbeat must be 10-10000ms");
  }
  return heartbeatMs;
}

function managedLeaseTtl(value: string | undefined): number {
  if (value === undefined) return MANAGED_ADMISSION_LEASE_TTL_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new Error("GSV_MANAGED_ADMISSION_LEASE_TTL_MS must be 100-60000ms");
  }
  return parsed;
}
