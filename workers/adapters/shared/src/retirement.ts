import type { InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";

export type AdapterDataOwner = { installationId: string; generation: string };
export type AdapterDataScope = AdapterDataOwner | null;
export const ADAPTER_RETIREMENT_PREFIX = "adapter_retirement:v1:";
type RetirementStatus = { active: number; startedAt: number | undefined; erasedAt: number | undefined };
type RetirementProgress = { active: number; startedAt: number };
type RetirementRecord = { version: 1; operationId: string; startedAt: number; erasedAt?: number };

/** A peer may serve another space after relinking; only the retired space is fenced. */
export class AdapterRetirement {
  private readonly active = new Map<string, number>();
  private readonly cancellation = new Map<string, AbortController>();

  constructor(private readonly storage: DurableObjectStorage) {}

  retired(owner: AdapterDataScope | undefined): boolean {
    return isAdapterOwnerRetired(this.storage, owner);
  }

  requireLive(owner: AdapterDataScope | undefined): void {
    if (this.retired(owner)) throw new Error("Adapter installation is retired");
  }

  start(owner: AdapterDataScope | undefined): () => void {
    this.requireLive(owner);
    if (!owner) return () => {};
    const id = owner.installationId;
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.active.get(id) ?? 1) - 1;
      if (remaining) this.active.set(id, remaining);
      else this.active.delete(id);
    };
  }

  signal(owner: AdapterDataOwner): AbortSignal {
    this.requireLive(owner);
    let controller = this.cancellation.get(owner.installationId);
    if (!controller) {
      controller = new AbortController();
      this.cancellation.set(owner.installationId, controller);
    }
    return controller.signal;
  }

  status(input: InstallationDeletionRequest): RetirementStatus {
    const record = this.storage.kv.get<RetirementRecord>(this.key(input.installationId));
    if (record && record.operationId !== input.operationId) throw new Error("Adapter deletion operation is immutable");
    return { active: this.active.get(input.installationId) ?? 0, startedAt: record?.startedAt, erasedAt: record?.erasedAt };
  }

  quiesce(input: InstallationDeletionRequest): RetirementProgress {
    const status = this.status(input);
    const startedAt = status.startedAt ?? Date.now();
    if (!status.startedAt) this.storage.kv.put(this.key(input.installationId), { version: 1, operationId: input.operationId, startedAt } satisfies RetirementRecord);
    this.cancellation.get(input.installationId)?.abort(new Error("Adapter installation is retired"));
    return { active: status.active, startedAt };
  }

  complete(input: InstallationDeletionRequest): number {
    const { active } = this.quiesce(input);
    if (active) throw new Error("Adapter installation still owns active work");
    const key = this.key(input.installationId);
    const record = this.storage.kv.get<RetirementRecord>(key)!;
    if (!record.erasedAt) {
      record.erasedAt = Date.now();
      this.storage.kv.put(key, record);
    }
    return record.erasedAt;
  }

  private key(installationId: string): string { return ADAPTER_RETIREMENT_PREFIX + installationId; }
}

export function sameAdapterDataOwner(left: AdapterDataScope | undefined, right: AdapterDataScope | undefined): boolean {
  return left === right || Boolean(left && right && left.installationId === right.installationId && left.generation === right.generation);
}

export function isAdapterOwnerRetired(storage: DurableObjectStorage, owner: AdapterDataScope | undefined): boolean {
  return Boolean(owner && storage.kv.get(ADAPTER_RETIREMENT_PREFIX + owner.installationId));
}
