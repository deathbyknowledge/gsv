import { normalizeAdapterAccountId } from "@humansandmachines/gsv/protocol/adapters";
import {
  validateManagedRestoreControl,
  validateManagedSnapshotRequest,
  type ManagedObjectRestoreControl,
  type ManagedObjectSnapshotRequest,
  type ManagedPortableComponent,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import {
  restoreLogicalDurableObjectStream,
  snapshotLogicalDurableObjectStream,
} from "@humansandmachines/gsv-worker-runtime/portable-do";

export const MANAGED_ADAPTER_RESTORE_TARGET_KEY = "__gsv:managed:restore-target";

const MANAGED_PREFIX = "__gsv:managed:";
const RESTORE_JOURNAL_PREFIX = "__gsv:restore:";

type AdapterComponent = Exclude<ManagedPortableComponent, "gateway" | "ripgit">;

type AdapterRestoreTarget = Readonly<{
  version: 1;
  restoreId: string;
  objectId: string;
  logicalName: string;
}>;

export type ManagedAdapterRestoreResult = Readonly<{
  status: "applied" | "replayed";
  providerId: string;
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
}>;

export interface ManagedPortableAdapterAccountStub {
  managedSnapshot(input: ManagedObjectSnapshotRequest): Promise<ReadableStream<Uint8Array>>;
  managedRestore(
    control: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ): Promise<ManagedAdapterRestoreResult>;
}

type ManagedPortableAdapterNamespace = {
  idFromString(providerId: string): DurableObjectId;
  idFromName(logicalName: string): DurableObjectId;
  get(id: DurableObjectId): ManagedPortableAdapterAccountStub;
};

export async function snapshotManagedAdapterAccount(
  namespace: ManagedPortableAdapterNamespace,
  component: AdapterComponent,
  input: unknown,
): Promise<ReadableStream<Uint8Array>> {
  const request = validateManagedSnapshotRequest(input);
  assertAdapterRequestIdentity(namespace, component, request);
  return namespace.get(namespace.idFromString(request.providerId)).managedSnapshot(request);
}

export async function restoreManagedAdapterAccount(
  namespace: ManagedPortableAdapterNamespace,
  component: AdapterComponent,
  input: unknown,
  stream: ReadableStream<Uint8Array>,
): Promise<ManagedAdapterRestoreResult> {
  let control: ManagedObjectRestoreControl;
  try {
    control = validateManagedRestoreControl(input);
    assertCanonicalAdapterLogicalName(control.logicalName);
    if (control.component !== component || control.kind !== "adapter_account") {
      throw new TypeError("Managed adapter restore component or kind is invalid");
    }
  } catch (error) {
    if (!stream.locked) await stream.cancel(error).catch(() => {});
    throw error;
  }
  const id = namespace.idFromName(control.logicalName);
  return namespace.get(id).managedRestore(control, stream);
}

export function snapshotManagedAdapterStorage(
  storage: DurableObjectStorage,
  objectId: string,
  assertFenced: () => void,
): ReadableStream<Uint8Array> {
  return snapshotLogicalDurableObjectStream(storage, {
    objectId,
    fence: { assertFenced },
  });
}

export async function restoreManagedAdapterStorage(
  storage: DurableObjectStorage,
  stream: ReadableStream<Uint8Array>,
  control: ManagedObjectRestoreControl,
  assertFenced: () => void,
): Promise<Omit<ManagedAdapterRestoreResult, "providerId">> {
  assertAdapterRestoreTarget(storage, control);
  return restoreLogicalDurableObjectStream(storage, stream, {
    restoreId: control.restoreId,
    objectId: control.objectId,
    fence: { assertFenced },
    schemaMode: "fresh-migrated",
    frameCount: control.frameCount,
    bodyBytes: control.bodyBytes,
    semanticSha256: control.semanticSha256,
  });
}

export function readAdapterRestoreTarget(
  storage: DurableObjectStorage,
): AdapterRestoreTarget | null {
  const value = storage.kv.get<unknown>(MANAGED_ADAPTER_RESTORE_TARGET_KEY);
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed adapter restore target marker is invalid");
  }
  const marker = value as Partial<AdapterRestoreTarget>;
  if (
    marker.version !== 1
    || typeof marker.restoreId !== "string"
    || typeof marker.objectId !== "string"
    || typeof marker.logicalName !== "string"
  ) {
    throw new Error("Managed adapter restore target marker is invalid");
  }
  return marker as AdapterRestoreTarget;
}

export async function prepareManagedAdapterRestoreTarget(
  storage: DurableObjectStorage,
  control: ManagedObjectRestoreControl,
): Promise<"prepared" | "replayed"> {
  const expected = markerFromControl(control);
  const existing = readAdapterRestoreTarget(storage);
  if (existing) {
    assertSameTarget(existing, expected);
    return "replayed";
  }
  if (await storage.getAlarm() !== null) {
    throw new Error("Managed adapter restore target has an application alarm");
  }
  storage.transactionSync(() => {
    const raced = readAdapterRestoreTarget(storage);
    if (raced) {
      assertSameTarget(raced, expected);
      return;
    }
    const journals = storage.kv
      .list({ prefix: RESTORE_JOURNAL_PREFIX, limit: 1 })[Symbol.iterator]().next();
    if (!journals.done) {
      throw new Error("Managed adapter restore target has another restore journal");
    }
    for (const [key] of storage.kv.list()) {
      if (!key.startsWith(MANAGED_PREFIX)) storage.kv.delete(key);
    }
    storage.kv.put(MANAGED_ADAPTER_RESTORE_TARGET_KEY, expected);
  });
  return "prepared";
}

function assertAdapterRestoreTarget(
  storage: DurableObjectStorage,
  control: ManagedObjectRestoreControl,
): void {
  const marker = readAdapterRestoreTarget(storage);
  if (!marker) throw new Error("Managed adapter restore target was not prepared");
  assertSameTarget(marker, markerFromControl(control));
}

function assertAdapterRequestIdentity(
  namespace: ManagedPortableAdapterNamespace,
  component: AdapterComponent,
  request: ManagedObjectSnapshotRequest,
): void {
  assertCanonicalAdapterLogicalName(request.logicalName);
  if (request.component !== component || request.kind !== "adapter_account") {
    throw new TypeError("Managed adapter snapshot component or kind is invalid");
  }
  let fromProvider: DurableObjectId;
  try {
    fromProvider = namespace.idFromString(request.providerId);
  } catch {
    throw new TypeError("Managed adapter snapshot providerId is invalid");
  }
  if (
    fromProvider.toString() !== request.providerId
    || namespace.idFromName(request.logicalName).toString() !== request.providerId
  ) {
    throw new TypeError("Managed adapter snapshot provider identity does not match logicalName");
  }
}

function assertCanonicalAdapterLogicalName(value: string): void {
  if (normalizeAdapterAccountId(value) !== value) {
    throw new TypeError("Managed adapter logicalName is not canonical");
  }
}

function markerFromControl(control: ManagedObjectRestoreControl): AdapterRestoreTarget {
  return Object.freeze({
    version: 1,
    restoreId: control.restoreId,
    objectId: control.objectId,
    logicalName: control.logicalName,
  });
}

function assertSameTarget(actual: AdapterRestoreTarget, expected: AdapterRestoreTarget): void {
  if (
    actual.version !== expected.version
    || actual.restoreId !== expected.restoreId
    || actual.objectId !== expected.objectId
    || actual.logicalName !== expected.logicalName
  ) {
    throw new Error("Managed adapter restore target belongs to another restore");
  }
}
