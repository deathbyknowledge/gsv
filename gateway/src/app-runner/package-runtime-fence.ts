import {
  SHIP_KERNEL_NAME,
  userKernelName,
} from "../shared/kernel-names";
import {
  buildAppDataRunnerName,
  buildAppRunnerName,
} from "../protocol/app-session";

export const APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY =
  "app-runner:package-runtime-fence:v1";
export const APP_RUNNER_RUNTIME_EPOCH_KEY =
  "app-runner:runtime-epoch:v1";

const MAX_AUTHORIZATION_LENGTH = 256;
const MAX_FENCE_ID_LENGTH = 128;
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type AppRunnerPackageRuntimeFenceAction = "prepare" | "clear";
export type AppRunnerRuntimeFenceKind = "package-projection" | "user-lifecycle";

export type AppRunnerPackageRuntimeFenceInput = {
  authorization: string;
  fenceKind: AppRunnerRuntimeFenceKind;
  sourceKernelName: string;
  runnerName: string;
  /** Run-as actor whose uid participates in the deterministic runner name. */
  ownerUid: number;
  ownerUsername: string;
  /** Human-owned Kernel that has authority to fence this runner. */
  kernelOwnerUid: number;
  kernelOwnerUsername: string;
  packageId: string;
  generation: number;
  fenceId: string;
};

export type AppRunnerPackageRuntimeFenceAuthorizationInput =
  AppRunnerPackageRuntimeFenceInput & {
    action: AppRunnerPackageRuntimeFenceAction;
  };

export type AppRunnerPackageRuntimeFenceIdentity = Omit<
  AppRunnerPackageRuntimeFenceInput,
  "authorization"
>;

export type AppRunnerPackageRuntimeFenceAck =
  AppRunnerPackageRuntimeFenceIdentity & {
    state: "fenced" | "cleared";
  };

export type AppRunnerRuntimeFenceInput = AppRunnerPackageRuntimeFenceInput;
export type AppRunnerRuntimeFenceAuthorizationInput =
  AppRunnerPackageRuntimeFenceAuthorizationInput;
export type AppRunnerRuntimeFenceAck = AppRunnerPackageRuntimeFenceAck;

export type PersistedAppRunnerPackageRuntimeFence =
  AppRunnerPackageRuntimeFenceIdentity & {
    version: 1;
    state: "fenced" | "cleared";
    startedAt: number;
    updatedAt: number;
  };

export type AppRunnerPackageRuntimeOperation = {
  readonly signal: AbortSignal;
  readonly runtimeEpoch: number;
  assertCurrent(): void;
  /**
   * Worker Loader RPC promises do not expose a cancellation handle. Stop
   * waiting when the fence aborts this operation while continuing to observe
   * the underlying promise so a late rejection cannot become unhandled.
   */
  waitForOpaqueCall<T>(start: () => Promise<T>): Promise<T>;
  release(): void;
};

type FenceStorage = Pick<SyncKvStorage, "get" | "put">;
type FenceAuthorization = (
  input: AppRunnerPackageRuntimeFenceAuthorizationInput,
) => Promise<boolean>;
type FenceCleanup = () => void | Promise<void>;

type ActiveOperation = {
  controller: AbortController;
  runtimeEpoch: number;
  released: boolean;
};

const INVALID_PERSISTED_FENCE = Symbol("invalid-persisted-fence");
const INVALID_RUNTIME_EPOCH = Symbol("invalid-runtime-epoch");

/**
 * Per-AppRunner admission and drain gate. The durable record is deliberately
 * stored through the hidden DO KV API so app-data SQL cannot read or mutate it.
 */
export class AppRunnerPackageRuntimeFenceGate {
  readonly #storage: FenceStorage;
  readonly #runnerName: string;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveOperation>();
  readonly #drainWaiters = new Set<() => void>();
  #state: PersistedAppRunnerPackageRuntimeFence | null | typeof INVALID_PERSISTED_FENCE;
  #runtimeEpoch: number | typeof INVALID_RUNTIME_EPOCH;
  #transitionTail: Promise<void> = Promise.resolve();

  constructor(
    storage: FenceStorage,
    runnerName: string,
    now: () => number = Date.now,
  ) {
    this.#storage = storage;
    this.#runnerName = runnerName;
    this.#now = now;
    this.#state = parsePersistedFence(
      storage.get<unknown>(APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY),
      runnerName,
    );
    this.#runtimeEpoch = parseRuntimeEpoch(
      storage.get<unknown>(APP_RUNNER_RUNTIME_EPOCH_KEY),
    );
  }

  isAdmissionClosed(): boolean {
    return this.#state === INVALID_PERSISTED_FENCE
      || this.#runtimeEpoch === INVALID_RUNTIME_EPOCH
      || this.#state?.state === "fenced";
  }

  persistedState(): PersistedAppRunnerPackageRuntimeFence | null {
    return this.#state && this.#state !== INVALID_PERSISTED_FENCE
      ? structuredClone(this.#state)
      : null;
  }

  acquireOperation(expectedRuntimeEpoch?: number): AppRunnerPackageRuntimeOperation {
    this.#assertAdmissionOpen();
    const runtimeEpoch = this.#readRuntimeEpoch();
    if (
      expectedRuntimeEpoch !== undefined
      && expectedRuntimeEpoch !== runtimeEpoch
    ) {
      throw new Error("AppRunner runtime epoch is stale");
    }
    const operationId = crypto.randomUUID();
    const operation: ActiveOperation = {
      controller: new AbortController(),
      runtimeEpoch,
      released: false,
    };
    this.#active.set(operationId, operation);

    const assertCurrent = () => {
      if (
        operation.released
        || operation.controller.signal.aborted
        || operation.runtimeEpoch !== this.#runtimeEpoch
        || this.isAdmissionClosed()
      ) {
        const reason = operation.controller.signal.reason;
        throw reason instanceof Error
          ? reason
          : new Error("Package runtime authority is fenced");
      }
    };
    const waitForOpaqueCall = <T>(start: () => Promise<T>): Promise<T> => {
      assertCurrent();
      let call: Promise<T>;
      try {
        call = Promise.resolve(start());
      } catch (error) {
        return Promise.reject(error);
      }

      const signal = operation.controller.signal;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          complete();
        };
        const onAbort = () => {
          const reason = signal.reason;
          finish(() => reject(reason instanceof Error
            ? reason
            : new Error("Package runtime authority is fenced")));
        };

        signal.addEventListener("abort", onAbort, { once: true });
        call.then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
        if (signal.aborted) onAbort();
      });
    };
    return {
      signal: operation.controller.signal,
      runtimeEpoch: operation.runtimeEpoch,
      assertCurrent,
      waitForOpaqueCall,
      release: () => {
        if (operation.released) return;
        operation.released = true;
        this.#active.delete(operationId);
        if (this.#active.size === 0) {
          for (const resolve of this.#drainWaiters) resolve();
          this.#drainWaiters.clear();
        }
      },
    };
  }

  async prepare(
    input: AppRunnerPackageRuntimeFenceInput,
    authorize: FenceAuthorization,
    onFence: FenceCleanup = () => {},
    onDrained: FenceCleanup = () => {},
  ): Promise<AppRunnerPackageRuntimeFenceAck> {
    const command = captureFenceCommand(input, this.#runnerName);
    if (!await authorize({ ...command, action: "prepare" })) {
      throw new Error("AppRunner package fence authorization failed");
    }
    return this.#runTransition(async () => {
      this.#assertPersistedFenceReadable();
      const current = readableFence(this.#state);
      if (current?.state === "fenced") {
        if (!sameFence(current, command)) {
          throw new Error("A different AppRunner package fence is active");
        }
      } else {
        const now = this.#safeNow();
        this.#incrementRuntimeEpoch();
        const sameClearedFence = current?.state === "cleared"
          && sameFence(current, command);
        this.#writeState({
          version: 1,
          ...withoutAuthorization(command),
          state: "fenced",
          startedAt: sameClearedFence ? current.startedAt : now,
          updatedAt: now,
        });
      }

      const reason = new Error("Package runtime authority is fenced");
      for (const operation of this.#active.values()) {
        operation.controller.abort(reason);
      }

      let cleanupError: unknown;
      try {
        await onFence();
      } catch (error) {
        cleanupError = error;
      }
      await this.#waitForDrain();
      try {
        await onDrained();
      } catch (error) {
        cleanupError ??= error;
      }
      if (
        this.#state === INVALID_PERSISTED_FENCE
        || this.#state?.state !== "fenced"
        || !sameFence(this.#state, command)
      ) {
        throw new Error("AppRunner package fence changed before acknowledgment");
      }
      if (cleanupError) throw cleanupError;
      return fenceAck(command, "fenced");
    });
  }

  async clear(
    input: AppRunnerPackageRuntimeFenceInput,
    authorize: FenceAuthorization,
    onClear: FenceCleanup = () => {},
  ): Promise<AppRunnerPackageRuntimeFenceAck> {
    const command = captureFenceCommand(input, this.#runnerName);
    if (!await authorize({ ...command, action: "clear" })) {
      throw new Error("AppRunner package fence authorization failed");
    }
    return this.#runTransition(async () => {
      this.#assertPersistedFenceReadable();
      const current = readableFence(this.#state);
      if (!current || !sameFence(current, command)) {
        throw new Error("AppRunner package fence does not match the active fence");
      }
      if (current.state === "cleared") {
        return fenceAck(command, "cleared");
      }

      await this.#waitForDrain();
      if (
        this.#state === INVALID_PERSISTED_FENCE
        || this.#state?.state !== "fenced"
        || !sameFence(this.#state, command)
      ) {
        throw new Error("AppRunner package fence changed before clear");
      }
      const fenced = readableFence(this.#state);
      if (!fenced) {
        throw new Error("AppRunner package fence changed before clear");
      }
      await onClear();
      const afterCleanup = readableFence(this.#state);
      if (
        afterCleanup?.state !== "fenced"
        || !sameFence(afterCleanup, command)
      ) {
        throw new Error("AppRunner package fence changed during clear cleanup");
      }
      this.#writeState({
        ...afterCleanup,
        state: "cleared",
        updatedAt: this.#safeNow(),
      });
      return fenceAck(command, "cleared");
    });
  }

  #assertAdmissionOpen(): void {
    if (this.#state === INVALID_PERSISTED_FENCE) {
      throw new Error("AppRunner package fence state is invalid");
    }
    if (this.#state?.state === "fenced") {
      throw new Error("Package runtime authority is fenced");
    }
    this.#readRuntimeEpoch();
  }

  #assertPersistedFenceReadable(): void {
    if (this.#state === INVALID_PERSISTED_FENCE) {
      throw new Error("AppRunner package fence state is invalid");
    }
    this.#readRuntimeEpoch();
  }

  #writeState(state: PersistedAppRunnerPackageRuntimeFence): void {
    this.#storage.put(APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY, state);
    this.#state = state;
  }

  #readRuntimeEpoch(): number {
    if (this.#runtimeEpoch === INVALID_RUNTIME_EPOCH) {
      throw new Error("AppRunner runtime epoch state is invalid");
    }
    return this.#runtimeEpoch;
  }

  #incrementRuntimeEpoch(): void {
    const current = this.#readRuntimeEpoch();
    if (current >= Number.MAX_SAFE_INTEGER) {
      this.#runtimeEpoch = INVALID_RUNTIME_EPOCH;
      throw new Error("AppRunner runtime epoch is exhausted");
    }
    this.#writeRuntimeEpoch(current + 1);
  }

  #writeRuntimeEpoch(runtimeEpoch: number): void {
    this.#storage.put(APP_RUNNER_RUNTIME_EPOCH_KEY, {
      version: 1,
      runtimeEpoch,
    });
    this.#runtimeEpoch = runtimeEpoch;
  }

  #safeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new Error("AppRunner package fence clock is invalid");
    }
    return now;
  }

  #waitForDrain(): Promise<void> {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  async #runTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitionTail;
    const next = Promise.withResolvers<void>();
    this.#transitionTail = next.promise;
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve();
    }
  }
}

export function captureFenceCommand(
  input: unknown,
  expectedRunnerName: string,
): AppRunnerPackageRuntimeFenceInput {
  const record = asRecord(input);
  const authorization = typeof record?.authorization === "string"
    ? record.authorization
    : "";
  const fenceKind = record?.fenceKind;
  const sourceKernelName = typeof record?.sourceKernelName === "string"
    ? record.sourceKernelName
    : "";
  const runnerName = typeof record?.runnerName === "string" ? record.runnerName : "";
  const ownerUid = record?.ownerUid;
  const ownerUsername = typeof record?.ownerUsername === "string"
    ? record.ownerUsername
    : "";
  const kernelOwnerUid = record?.kernelOwnerUid;
  const kernelOwnerUsername = typeof record?.kernelOwnerUsername === "string"
    ? record.kernelOwnerUsername
    : "";
  const packageId = typeof record?.packageId === "string" ? record.packageId : "";
  const generation = record?.generation;
  const fenceId = typeof record?.fenceId === "string" ? record.fenceId : "";

  let expectedKernelName = "";
  let canonicalOwnerUsername = "";
  let canonicalKernelOwnerUsername = "";
  try {
    canonicalOwnerUsername = userKernelName(ownerUsername).slice("user:".length);
    expectedKernelName = userKernelName(kernelOwnerUsername);
    canonicalKernelOwnerUsername = expectedKernelName.slice("user:".length);
  } catch {
  }
  if (
    !authorization
    || authorization.length > MAX_AUTHORIZATION_LENGTH
    || (fenceKind !== "package-projection" && fenceKind !== "user-lifecycle")
    || (sourceKernelName !== SHIP_KERNEL_NAME && sourceKernelName !== expectedKernelName)
    || ownerUsername !== canonicalOwnerUsername
    || kernelOwnerUsername !== canonicalKernelOwnerUsername
    || runnerName !== expectedRunnerName
    || !Number.isSafeInteger(ownerUid)
    || (ownerUid as number) < 0
    || !Number.isSafeInteger(kernelOwnerUid)
    || (kernelOwnerUid as number) < 0
    || packageId.trim() !== packageId
    || !packageId
    || !Number.isSafeInteger(generation)
    || (generation as number) <= 0
    || !UUID_RE.test(fenceId)
    || fenceId.length > MAX_FENCE_ID_LENGTH
    || !runnerNameMatchesOwner(
      runnerName,
      kernelOwnerUid as number,
      ownerUid as number,
      packageId,
    )
  ) {
    throw new Error("AppRunner package fence input is invalid");
  }
  return {
    authorization,
    fenceKind,
    sourceKernelName,
    runnerName,
    ownerUid: ownerUid as number,
    ownerUsername,
    kernelOwnerUid: kernelOwnerUid as number,
    kernelOwnerUsername,
    packageId,
    generation: generation as number,
    fenceId: fenceId.toLowerCase(),
  };
}

function parsePersistedFence(
  input: unknown,
  expectedRunnerName: string,
): PersistedAppRunnerPackageRuntimeFence | null | typeof INVALID_PERSISTED_FENCE {
  if (input === undefined) return null;
  const record = asRecord(input);
  try {
    if (
      record?.version !== 1
      || (record.state !== "fenced" && record.state !== "cleared")
      || !Number.isSafeInteger(record.startedAt)
      || (record.startedAt as number) <= 0
      || !Number.isSafeInteger(record.updatedAt)
      || (record.updatedAt as number) < (record.startedAt as number)
    ) {
      return INVALID_PERSISTED_FENCE;
    }
    const command = captureFenceCommand({
      authorization: "persisted",
      fenceKind: record.fenceKind,
      sourceKernelName: record.sourceKernelName,
      runnerName: record.runnerName,
      ownerUid: record.ownerUid,
      ownerUsername: record.ownerUsername,
      kernelOwnerUid: record.kernelOwnerUid,
      kernelOwnerUsername: record.kernelOwnerUsername,
      packageId: record.packageId,
      generation: record.generation,
      fenceId: record.fenceId,
    }, expectedRunnerName);
    return {
      version: 1,
      ...withoutAuthorization(command),
      state: record.state,
      startedAt: record.startedAt as number,
      updatedAt: record.updatedAt as number,
    };
  } catch {
    return INVALID_PERSISTED_FENCE;
  }
}

function parseRuntimeEpoch(
  input: unknown,
): number | typeof INVALID_RUNTIME_EPOCH {
  if (input === undefined) return 1;
  const record = asRecord(input);
  if (
    record?.version !== 1
    || !Number.isSafeInteger(record.runtimeEpoch)
    || (record.runtimeEpoch as number) <= 0
  ) {
    return INVALID_RUNTIME_EPOCH;
  }
  return record.runtimeEpoch as number;
}

function runnerNameMatchesOwner(
  runnerName: string,
  kernelOwnerUid: number,
  actorUid: number,
  packageId: string,
): boolean {
  return runnerName === buildAppRunnerName(kernelOwnerUid, actorUid, packageId)
    || runnerName === buildAppDataRunnerName(kernelOwnerUid, actorUid, packageId);
}

function withoutAuthorization(
  input: AppRunnerPackageRuntimeFenceInput,
): AppRunnerPackageRuntimeFenceIdentity {
  return {
    fenceKind: input.fenceKind,
    sourceKernelName: input.sourceKernelName,
    runnerName: input.runnerName,
    ownerUid: input.ownerUid,
    ownerUsername: input.ownerUsername,
    kernelOwnerUid: input.kernelOwnerUid,
    kernelOwnerUsername: input.kernelOwnerUsername,
    packageId: input.packageId,
    generation: input.generation,
    fenceId: input.fenceId,
  };
}

function fenceAck(
  input: AppRunnerPackageRuntimeFenceInput,
  state: "fenced" | "cleared",
): AppRunnerPackageRuntimeFenceAck {
  return { ...withoutAuthorization(input), state };
}

function sameFence(
  left: AppRunnerPackageRuntimeFenceIdentity,
  right: AppRunnerPackageRuntimeFenceIdentity,
): boolean {
  return left.sourceKernelName === right.sourceKernelName
    && left.fenceKind === right.fenceKind
    && left.runnerName === right.runnerName
    && left.ownerUid === right.ownerUid
    && left.ownerUsername === right.ownerUsername
    && left.kernelOwnerUid === right.kernelOwnerUid
    && left.kernelOwnerUsername === right.kernelOwnerUsername
    && left.packageId === right.packageId
    && left.generation === right.generation
    && left.fenceId === right.fenceId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readableFence(
  state: PersistedAppRunnerPackageRuntimeFence | null | typeof INVALID_PERSISTED_FENCE,
): PersistedAppRunnerPackageRuntimeFence | null {
  return state === INVALID_PERSISTED_FENCE ? null : state;
}
