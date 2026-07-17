import { canonicalJsonBytes, parseCanonicalJson } from "./canonical-json";
import type { PortableCrypto } from "./crypto";
import { fail } from "./error";
import type { ArchiveDataFrameInput } from "./inner";
import {
  assertArchiveInventory,
  createArchiveManifest,
  type ArchiveInventoryKind,
  type ArchiveInventoryObjectV1,
  type ArchiveManifestTotalsV1,
  type ArchiveManifestV1,
  type ArchiveObjectStorageV1,
} from "./manifest";
import { ObjectSemanticDigestV1 } from "./semantic";
import { ContiguousObjectRunTracker } from "./object-run";

export type ArchiveInventoryRegistrationV1 = Readonly<{
  objectId: string;
  kind: ArchiveInventoryKind;
  component: string;
  logicalName: string;
  storage: ArchiveObjectStorageV1;
}>;

export type ArchiveInventorySummaryV1 = Readonly<{
  inventory: readonly ArchiveInventoryObjectV1[];
  totals: ArchiveManifestTotalsV1;
}>;

export type ArchiveManifestBaseV1 = Omit<
  ArchiveManifestV1,
  "inventory" | "totals"
>;

type MutableInventoryState = {
  registration: ArchiveInventoryRegistrationV1;
  semantic: ObjectSemanticDigestV1 | null;
  frameCount: bigint;
  bodyBytes: bigint;
};

/**
 * One-pass inventory builder for streaming exporters. Register logical objects
 * before writing, await `observe` for every emitted data frame, then finalize
 * the exact sorted inventory and totals used by the deferred manifest.
 */
export class ArchiveInventoryAccumulator {
  readonly #crypto?: PortableCrypto;
  readonly #states = new Map<string, MutableInventoryState>();
  readonly #objectRuns = new ContiguousObjectRunTracker();
  #busy = false;
  #failed = false;
  #failure: unknown;
  #summary: ArchiveInventorySummaryV1 | null = null;

  constructor(
    registrations: Iterable<ArchiveInventoryRegistrationV1>,
    options: Readonly<{ crypto?: PortableCrypto }> = {},
  ) {
    this.#crypto = options.crypto;
    for (const registration of registrations) {
      if (this.#states.has(registration.objectId)) {
        fail("invalid_argument", "archive inventory registration objectId is duplicated");
      }
      const owned = Object.freeze({
        objectId: registration.objectId,
        kind: registration.kind,
        component: registration.component,
        logicalName: registration.logicalName,
        storage: cloneStorage(registration.storage),
      });
      this.#states.set(registration.objectId, {
        registration: owned,
        semantic: null,
        frameCount: 0n,
        bodyBytes: 0n,
      });
    }
  }

  /** Observe one frame in archive order and return the same frame for piping. */
  async observe(frame: ArchiveDataFrameInput): Promise<ArchiveDataFrameInput> {
    if (this.#summary) {
      fail("invalid_argument", "archive inventory is already finalized");
    }
    if (this.#failed) throw this.#failure;
    if (this.#busy) {
      fail("invalid_argument", "archive inventory frames must be observed serially");
    }
    this.#busy = true;
    try {
      const state = this.#states.get(frame.objectId);
      if (!state) {
        fail("invalid_frame", "archive frame objectId is not registered in inventory");
      }
      this.#objectRuns.observe(
        frame.objectId,
        (message) => fail("invalid_frame", message),
      );
      state.semantic ??= await ObjectSemanticDigestV1.create(
        frame.objectId,
        this.#crypto,
      );
      await state.semantic.append(frame);
      state.frameCount += 1n;
      state.bodyBytes += BigInt(frame.body.byteLength);
      return frame;
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** Tap an iterable without changing its frame objects or order. */
  async *observeFrames(
    frames: Iterable<ArchiveDataFrameInput> | AsyncIterable<ArchiveDataFrameInput>,
  ): AsyncGenerator<ArchiveDataFrameInput> {
    for await (const frame of frames) yield await this.observe(frame);
  }

  /** Finalize exact per-object digests/counts plus manifest-wide totals. */
  finish(): ArchiveInventorySummaryV1 {
    if (this.#summary) return this.#summary;
    if (this.#failed) throw this.#failure;
    if (this.#busy) {
      fail("invalid_argument", "archive inventory cannot finalize during observation");
    }

    let dataFrames = 0n;
    let dataBodyBytes = 0n;
    let r2Objects = 0n;
    let r2Bytes = 0n;
    const inventory = [...this.#states.values()]
      .sort((left, right) => compareStrings(
        left.registration.objectId,
        right.registration.objectId,
      ))
      .map((state): ArchiveInventoryObjectV1 => {
        if (!state.semantic || state.frameCount === 0n) {
          fail(
            "invalid_manifest",
            "every registered archive inventory object must emit a data frame",
          );
        }
        dataFrames += state.frameCount;
        dataBodyBytes += state.bodyBytes;
        if (state.registration.storage.r2) {
          r2Objects += storageCount(
            state.registration.storage.r2.objectCount,
            "R2 objectCount",
          );
          r2Bytes += storageCount(
            state.registration.storage.r2.totalBytes,
            "R2 totalBytes",
          );
        }
        return Object.freeze({
          ...state.registration,
          frameCount: state.frameCount.toString(10),
          bodyBytes: state.bodyBytes.toString(10),
          semanticSha256: state.semantic.digestBase64Url(),
        });
      });
    const totals = Object.freeze({
      dataFrames: dataFrames.toString(10),
      dataBodyBytes: dataBodyBytes.toString(10),
      r2Objects: r2Objects.toString(10),
      r2Bytes: r2Bytes.toString(10),
    });
    assertArchiveInventory(inventory, totals);
    this.#summary = Object.freeze({
      inventory: Object.freeze(inventory),
      totals,
    });
    return this.#summary;
  }

  /** Build and validate the deferred manifest from caller-supplied header data. */
  createManifest(base: ArchiveManifestBaseV1): ArchiveManifestV1 {
    const summary = this.finish();
    return createArchiveManifest(Object.freeze({
      ...base,
      inventory: summary.inventory,
      totals: summary.totals,
    }));
  }
}

function cloneStorage(storage: ArchiveObjectStorageV1): ArchiveObjectStorageV1 {
  const clone = parseCanonicalJson(canonicalJsonBytes(storage));
  freezeJson(clone);
  return clone as unknown as ArchiveObjectStorageV1;
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function storageCount(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_manifest", `${label} must be a canonical unsigned decimal`);
  }
  const count = BigInt(value);
  if (count > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_manifest", `${label} exceeds the v1 unsigned 64-bit range`);
  }
  return count;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
