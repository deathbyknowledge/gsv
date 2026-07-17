import { normalizeAdapterAccountId } from "@humansandmachines/gsv/protocol/adapters";
import {
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  normalizeManagedProviderIds,
  validateManagedObjectDescriptor,
  type ManagedObjectDescriptor,
  type ManagedObjectDescriptorBatch,
} from "@humansandmachines/gsv/protocol/managed-objects";
import type {
  ManagedObjectRestoreControl,
  ManagedObjectSnapshotRequest,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import type { ManagedAdapterRestoreResult } from "./managed-portability";

export const MANAGED_LIFECYCLE_STORAGE_KEY = "__gsv:managed:lifecycle";

export type ManagedLifecycleStatus = "active" | "paused" | "erased";

export type ManagedLifecycleState = {
  status: ManagedLifecycleStatus;
  epoch: number;
  updatedAt: number;
};

export type ManagedLifecycleInventory = ManagedLifecycleState & {
  accountId: string;
};

export type ManagedLifecycleResult = {
  accountIds: string[];
};

export type ManagedAdapterDescriptorRequest = {
  kind: "adapter_account" | "adapter_admission";
  providerIds: string[];
};

export function assertManagedAdapterDescriptorRequest(
  value: unknown,
): asserts value is ManagedAdapterDescriptorRequest {
  if (
    !value
    || typeof value !== "object"
    || ((value as { kind?: unknown }).kind !== "adapter_account"
      && (value as { kind?: unknown }).kind !== "adapter_admission")
    || !Array.isArray((value as { providerIds?: unknown }).providerIds)
  ) {
    throw new TypeError("Managed adapter descriptor request is invalid");
  }
}

export interface ManagedLifecycleAccountStub {
  managedPause(accountId: string): Promise<ManagedLifecycleInventory>;
  managedResume(accountId: string): Promise<ManagedLifecycleInventory>;
  managedErase(accountId: string): Promise<ManagedLifecycleInventory>;
}

export interface ManagedDescriptorAccountStub extends ManagedLifecycleAccountStub {
  managedDescriptor(): Promise<ManagedObjectDescriptor>;
}

type ManagedDescriptorAccountNamespace = {
  idFromString(providerId: string): DurableObjectId;
  idFromName(logicalName: string): DurableObjectId;
  get(id: DurableObjectId): ManagedDescriptorAccountStub;
};

export interface ManagedLifecycleWorkerInterface {
  managedPause(accountIds: string[]): Promise<ManagedLifecycleResult>;
  managedResume(accountIds: string[]): Promise<ManagedLifecycleResult>;
  managedErase(accountIds: string[]): Promise<ManagedLifecycleResult>;
  managedDescribeObjects(input: ManagedAdapterDescriptorRequest): Promise<ManagedObjectDescriptorBatch>;
  managedSnapshot(input: ManagedObjectSnapshotRequest): Promise<ReadableStream<Uint8Array>>;
  managedRestore(
    control: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ): Promise<ManagedAdapterRestoreResult>;
  managedFenceAll(): Promise<{
    status: "fenced" | "erased";
    epoch: number;
    drained: boolean;
  }>;
  managedResumeAll(): Promise<{ status: "active"; epoch: number }>;
  managedEraseAll(): Promise<
    | { status: "erased"; epoch: number; drained: true }
    | { status: "fenced"; epoch: number; drained: false }
  >;
}

export class ManagedLifecycleUnavailableError extends Error {
  constructor(readonly status: Exclude<ManagedLifecycleStatus, "active">) {
    super(`Managed adapter account is ${status}`);
    this.name = "ManagedLifecycleUnavailableError";
  }
}

const INITIAL_LIFECYCLE: ManagedLifecycleState = {
  status: "active",
  epoch: 0,
  updatedAt: 0,
};

const MAX_MANAGED_ACCOUNTS_PER_CALL = 1_000;
const MANAGED_LIFECYCLE_CONCURRENCY = 8;

/**
 * Durable lifecycle fence for a single adapter account.
 *
 * Epochs make continuations from an earlier active generation harmless even
 * when the account is paused and resumed before the continuation completes.
 */
export class ManagedLifecycleFence {
  private current: ManagedLifecycleState = INITIAL_LIFECYCLE;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  async load(): Promise<void> {
    const stored = await this.storage.get<unknown>(MANAGED_LIFECYCLE_STORAGE_KEY);
    if (stored === undefined) {
      this.current = { ...INITIAL_LIFECYCLE, updatedAt: Date.now() };
      await this.storage.put(MANAGED_LIFECYCLE_STORAGE_KEY, this.current);
      return;
    }
    this.current = parseManagedLifecycleState(stored);
  }

  snapshot(accountId: string): ManagedLifecycleInventory {
    return { accountId, ...this.current };
  }

  status(): ManagedLifecycleStatus {
    return this.current.status;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release = (): void => {};
    this.transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  activeEpoch(): number {
    if (this.current.status !== "active") {
      throw new ManagedLifecycleUnavailableError(this.current.status);
    }
    return this.current.epoch;
  }

  isActive(epoch?: number): boolean {
    return (
      this.current.status === "active" &&
      (epoch === undefined || this.current.epoch === epoch)
    );
  }

  assertActive(epoch?: number): void {
    if (!this.isActive(epoch)) {
      const status = this.current.status === "active" ? "paused" : this.current.status;
      throw new ManagedLifecycleUnavailableError(status);
    }
  }

  async pause(): Promise<ManagedLifecycleState> {
    return this.transition("paused");
  }

  async prepareRestore(expectedEpoch: number): Promise<ManagedLifecycleState> {
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) {
      throw new TypeError("Managed restore fence epoch is invalid");
    }
    if (this.current.status === "erased") {
      throw new ManagedLifecycleUnavailableError("erased");
    }
    if (this.current.status === "paused") {
      if (this.current.epoch !== expectedEpoch) {
        throw new Error("Managed restore does not match the existing pause fence");
      }
      return this.current;
    }
    if (expectedEpoch !== this.current.epoch + 1) {
      throw new Error("Managed restore fence epoch is not the next generation");
    }
    return this.transition("paused");
  }

  assertPaused(expectedEpoch: number): void {
    if (this.current.status !== "paused" || this.current.epoch !== expectedEpoch) {
      throw new ManagedLifecycleUnavailableError(
        this.current.status === "erased" ? "erased" : "paused",
      );
    }
  }

  async resume(): Promise<ManagedLifecycleState> {
    if (this.current.status === "erased") {
      throw new ManagedLifecycleUnavailableError("erased");
    }
    return this.transition("active");
  }

  async erase(): Promise<ManagedLifecycleState> {
    return this.transition("erased");
  }

  /**
   * Atomically removes account data while retaining the erased fence and the
   * minimal identity needed to verify retries.
   */
  async eraseStorage(tombstone: Record<string, unknown> = {}): Promise<void> {
    if (this.current.status !== "erased") {
      throw new Error("Managed adapter storage can only be erased after fencing");
    }

    const keys = Array.from((await this.storage.list()).keys());
    const lifecycle = this.current;
    await this.storage.transaction(async (transaction) => {
      if (keys.length > 0) {
        await transaction.delete(keys);
      }
      await transaction.put({
        ...tombstone,
        [MANAGED_LIFECYCLE_STORAGE_KEY]: lifecycle,
      });
    });
  }

  private async transition(
    status: ManagedLifecycleStatus,
  ): Promise<ManagedLifecycleState> {
    if (this.current.status === status) {
      return this.current;
    }
    if (this.current.status === "erased") {
      throw new ManagedLifecycleUnavailableError("erased");
    }

    const previous = this.current;
    const next: ManagedLifecycleState = {
      status,
      epoch: previous.epoch + 1,
      updatedAt: Date.now(),
    };

    // Fence in-flight continuations immediately. Durable storage input/output
    // gates prevent a new event from observing the transition before it commits.
    this.current = next;
    try {
      await this.storage.put(MANAGED_LIFECYCLE_STORAGE_KEY, next);
      return next;
    } catch (error) {
      this.current = previous;
      throw error;
    }
  }
}

export async function runManagedLifecycleAction(
  accountIds: string[],
  action: "managedPause" | "managedResume" | "managedErase",
  getAccount: (accountId: string) => ManagedLifecycleAccountStub,
): Promise<ManagedLifecycleResult> {
  const normalized = normalizeManagedAccountIds(accountIds);
  const expectedStatus: ManagedLifecycleStatus =
    action === "managedPause"
      ? "paused"
      : action === "managedResume"
        ? "active"
        : "erased";

  await mapWithConcurrency(
    normalized,
    MANAGED_LIFECYCLE_CONCURRENCY,
    async (accountId) => {
      const inventory = await getAccount(accountId)[action](accountId);
      if (
        inventory.accountId !== accountId ||
        inventory.status !== expectedStatus ||
        !Number.isSafeInteger(inventory.epoch) ||
        inventory.epoch < 0 ||
        !Number.isFinite(inventory.updatedAt) ||
        inventory.updatedAt < 0
      ) {
        throw new Error(
          `Adapter account ${accountId} returned invalid ${expectedStatus} inventory`,
        );
      }
    },
  );

  return { accountIds: normalized };
}

export function normalizeManagedAccountIds(accountIds: string[]): string[] {
  if (!Array.isArray(accountIds)) {
    throw new TypeError("Managed lifecycle accountIds must be an array");
  }
  if (accountIds.length > MAX_MANAGED_ACCOUNTS_PER_CALL) {
    throw new RangeError(
      `Managed lifecycle supports at most ${MAX_MANAGED_ACCOUNTS_PER_CALL} accounts per call`,
    );
  }

  const normalized = accountIds.map((accountId) => {
    if (typeof accountId !== "string") {
      throw new TypeError("Managed lifecycle account IDs must be strings");
    }
    const value = normalizeAdapterAccountId(accountId);
    if (value === null) {
      throw new TypeError("Managed lifecycle account ID is invalid");
    }
    return value;
  });

  return Array.from(new Set(normalized)).sort();
}

export async function describeManagedAdapterAccounts(
  namespace: ManagedDescriptorAccountNamespace,
  providerIds: unknown,
): Promise<ManagedObjectDescriptorBatch> {
  const normalized = normalizeManagedProviderIds(providerIds);
  const objects = await mapValuesWithConcurrency(
    normalized,
    MANAGED_LIFECYCLE_CONCURRENCY,
    async (providerId) => {
      const id = namespace.idFromString(providerId);
      const descriptor = validateManagedObjectDescriptor(
        await namespace.get(id).managedDescriptor(),
        "adapter_account",
        providerId,
      );
      if (
        descriptor.logicalName !== null
        && namespace.idFromName(descriptor.logicalName).toString() !== providerId
      ) {
        throw new Error("Managed adapter descriptor logical identity does not match provider ID");
      }
      return descriptor;
    },
  );

  return {
    schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
    kind: "adapter_account",
    objects,
  };
}

function parseManagedLifecycleState(value: unknown): ManagedLifecycleState {
  if (!value || typeof value !== "object") {
    return INITIAL_LIFECYCLE;
  }

  const candidate = value as Partial<ManagedLifecycleState>;
  if (
    (candidate.status !== "active" &&
      candidate.status !== "paused" &&
      candidate.status !== "erased") ||
    !Number.isSafeInteger(candidate.epoch) ||
    (candidate.epoch ?? -1) < 0 ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    // A malformed lifecycle record is an external/storage boundary failure.
    // Fail closed instead of accidentally reviving an account.
    return {
      status: "erased",
      epoch: 0,
      updatedAt: 0,
    };
  }

  const epoch = candidate.epoch;
  return {
    status: candidate.status,
    epoch: typeof epoch === "number" ? epoch : 0,
    updatedAt: candidate.updatedAt,
  };
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length && !failed) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          await operation(values[index]);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
}

async function mapValuesWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length && !failed) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await operation(values[index]);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
