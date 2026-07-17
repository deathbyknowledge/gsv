import {
  decodeDataFrameStream,
  encodeDataFrameStream,
  type DataFrameStreamRecord,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import { ObjectSemanticDigestV1 } from "@humansandmachines/gsv-portable-archive";
import {
  beginLogicalDurableObjectRestore,
  type LogicalDurableObjectRestore,
} from "./portable-do-restore";
import { NonPortableDoError } from "./portable-do-schema";
import { snapshotLogicalDurableObject } from "./portable-do-snapshot";
import type {
  LogicalDoRestoreOptions,
  LogicalDoRestoreTranscript,
  LogicalDoSnapshotFrame,
  LogicalDoSnapshotOptions,
  LogicalDoStorage,
} from "./portable-do-types";

const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export type LogicalDoStreamExpectation = LogicalDoRestoreTranscript;

export type LogicalDoStreamRestoreOptions = Omit<LogicalDoRestoreOptions, "transcript"> &
  LogicalDoStreamExpectation;

export type LogicalDoStreamRestoreResult = Readonly<{
  status: "applied" | "replayed";
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
}>;

/**
 * Adapts the deterministic logical DO generator to the public bounded byte
 * transport. The returned stream remains lazy and cancellation closes the
 * underlying snapshot generator.
 */
export function snapshotLogicalDurableObjectStream(
  storage: LogicalDoStorage,
  options: LogicalDoSnapshotOptions,
): ReadableStream<Uint8Array> {
  return encodeDataFrameStream(snapshotLogicalDurableObject(storage, options));
}

/**
 * Applies a control-bound data stream using the runtime's journaled restore.
 * The caller owns identity and fence policy; this boundary owns body parsing,
 * semantic verification, finalization, and cancellation.
 */
export async function restoreLogicalDurableObjectStream(
  storage: LogicalDoStorage,
  stream: ReadableStream<Uint8Array>,
  options: LogicalDoStreamRestoreOptions,
): Promise<LogicalDoStreamRestoreResult> {
  let expectedFrames: bigint;
  let expectedBodyBytes: bigint;
  try {
    expectedFrames = parseExpectedCount(options.frameCount, "frameCount");
    expectedBodyBytes = parseExpectedCount(options.bodyBytes, "bodyBytes");
    if (!SHA256_BASE64URL.test(options.semanticSha256)) {
      throw new TypeError("Logical restore semanticSha256 is invalid");
    }
  } catch (error) {
    await cancelStream(stream, error);
    throw error;
  }

  let restore: LogicalDurableObjectRestore;
  try {
    restore = await beginLogicalDurableObjectRestore(storage, {
      ...options,
      transcript: restoreTranscript(options),
    });
  } catch (error) {
    await cancelStream(stream, error);
    throw error;
  }

  // A complete marker or an interrupted finalization is safe to resume before
  // reading only because both are bound to a previously verified transcript.
  // An accepting journal must consume and verify the complete retry stream,
  // even if its structural frame set happens to be complete already.
  if (restore.phase !== "accepting") {
    const status = restore.phase === "complete" ? "replayed" : "applied";
    try {
      await restore.finalize();
      await cancelStream(stream, "Logical restore transcript was already verified");
    } catch (error) {
      await cancelStream(stream, error);
      throw error;
    }
    return {
      status,
      frameCount: options.frameCount,
      bodyBytes: options.bodyBytes,
      semanticSha256: options.semanticSha256,
    };
  }

  let frameCount = 0n;
  let bodyBytes = 0n;
  try {
    const semantic = await ObjectSemanticDigestV1.create(options.objectId);
    for await (const record of decodeDataFrameStream(stream)) {
      const frame = asLogicalDoFrame(record);
      if (frame.objectId !== options.objectId) {
        throw new NonPortableDoError(
          "invalid_archive_record",
          "Logical restore frame belongs to another object",
        );
      }
      frameCount += 1n;
      bodyBytes += BigInt(frame.body.byteLength);
      if (frameCount > expectedFrames || bodyBytes > expectedBodyBytes) {
        throw new NonPortableDoError(
          "invalid_archive_record",
          "Logical restore stream exceeds its declared inventory",
        );
      }
      await semantic.append(frame);
      await restore.applyFrame(frame);
    }
    if (frameCount !== expectedFrames || bodyBytes !== expectedBodyBytes) {
      throw new NonPortableDoError(
        "restore_incomplete",
        "Logical restore stream does not match its declared inventory",
      );
    }
    const actualDigest = semantic.digestBase64Url();
    if (actualDigest !== options.semanticSha256) {
      throw new NonPortableDoError(
        "invalid_archive_record",
        "Logical restore stream does not match its semantic digest",
      );
    }
    await restore.finalize({
      frameCount: frameCount.toString(),
      bodyBytes: bodyBytes.toString(),
      semanticSha256: actualDigest,
    });
    return {
      status: "applied",
      frameCount: frameCount.toString(),
      bodyBytes: bodyBytes.toString(),
      semanticSha256: actualDigest,
    };
  } catch (error) {
    await cancelStream(stream, error);
    throw error;
  }
}

function restoreTranscript(options: LogicalDoStreamExpectation): LogicalDoRestoreTranscript {
  return {
    frameCount: options.frameCount,
    bodyBytes: options.bodyBytes,
    semanticSha256: options.semanticSha256,
  };
}

function asLogicalDoFrame(record: DataFrameStreamRecord): LogicalDoSnapshotFrame {
  switch (record.kind) {
    case "do.descriptor":
    case "do.sqlite.schema":
    case "do.sqlite.rows":
    case "do.sqlite.cell":
    case "do.kv":
      return record as LogicalDoSnapshotFrame;
    default:
      throw new NonPortableDoError(
        "invalid_archive_record",
        "Logical DO restore received a non-DO archive frame",
      );
  }
}

function parseExpectedCount(value: string, label: string): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw new TypeError(`Logical restore ${label} is invalid`);
  }
  return BigInt(value);
}

async function cancelStream(stream: ReadableStream<Uint8Array>, reason: unknown): Promise<void> {
  if (!stream.locked) await stream.cancel(reason).catch(() => {});
}
