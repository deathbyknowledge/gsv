import { MAX_FRAME_BODY_BYTES } from "./constants";
import type {
  ArchiveDataFrameInput,
  ArchiveDataFrameKind,
} from "./inner";

export type FramedBodySource =
  | Iterable<ArchiveDataFrameInput>
  | AsyncIterable<ArchiveDataFrameInput>;

type FramedBodyFailure = (message: string) => never;

type FramedBodyContract = Readonly<{
  label: string;
  objectId: string;
  size: number;
  bodyKind: ArchiveDataFrameKind;
  bodyMediaType: string;
  fail: FramedBodyFailure;
}>;

/** Number of deterministic 4 MiB parts, including one part for an empty body. */
export function framedBodyPartCount(size: number): number {
  return Math.max(1, Math.ceil(size / MAX_FRAME_BODY_BYTES));
}

/**
 * Yield one already-validated descriptor followed by deterministic body parts.
 * The generator owns the response body and always consumes or cancels it.
 */
export async function* snapshotFramedBody(
  contract: FramedBodyContract & Readonly<{
    descriptorFrame: ArchiveDataFrameInput;
    response: Response;
  }>,
): AsyncGenerator<ArchiveDataFrameInput> {
  try {
    assertSourceResponse(contract);
  } catch (error) {
    await cancelOwnedResponse(contract.response, error);
    throw error;
  }

  const body = contract.response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    if (body) reader = body.getReader();
    else if (contract.size !== 0) {
      contract.fail(`${contract.label} response is missing its body`);
    }

    yield contract.descriptorFrame;
    if (!reader) {
      yield bodyFrame(contract, 0, new Uint8Array());
      complete = true;
      return;
    }

    let total = 0;
    let part = 0;
    let buffer = new Uint8Array(expectedPartBytes(contract.size, part));
    let buffered = 0;

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        contract.fail(`${contract.label} body returned a non-byte chunk`);
      }
      let offset = 0;
      while (offset < next.value.byteLength) {
        if (total >= contract.size) {
          contract.fail(`${contract.label} body exceeds its descriptor size`);
        }
        const copied = Math.min(
          buffer.byteLength - buffered,
          next.value.byteLength - offset,
        );
        buffer.set(next.value.subarray(offset, offset + copied), buffered);
        buffered += copied;
        offset += copied;
        total += copied;
        if (buffered === buffer.byteLength) {
          yield bodyFrame(contract, part, buffer);
          part += 1;
          buffered = 0;
          buffer = new Uint8Array(
            part < framedBodyPartCount(contract.size)
              ? expectedPartBytes(contract.size, part)
              : 0,
          );
        }
      }
    }

    if (total !== contract.size || buffered !== 0) {
      contract.fail(`${contract.label} body is shorter than its descriptor size`);
    }
    if (contract.size === 0) {
      yield bodyFrame(contract, 0, new Uint8Array());
      part = 1;
    }
    if (part !== framedBodyPartCount(contract.size)) {
      contract.fail(`${contract.label} body produced an inconsistent part count`);
    }
    complete = true;
  } catch (error) {
    await reader?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (reader) {
      if (!complete) {
        await reader.cancel(`Portable ${contract.label} snapshot stopped`).catch(() => undefined);
      }
      reader.releaseLock();
    } else if (!complete) {
      await cancelOwnedResponse(
        contract.response,
        `Portable ${contract.label} snapshot stopped`,
      );
    }
  }
}

/** Turn validated ordered parts into an exact-length, cancellation-safe stream. */
export function exactFramedBodyStream(
  contract: FramedBodyContract & Readonly<{
    partCount: number;
    frames: FramedBodySource;
  }>,
): ReadableStream<Uint8Array> {
  const iterator = toAsyncFrames(contract.frames)[Symbol.asyncIterator]();
  let expectedPart = 0;
  let terminal = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (expectedPart !== contract.partCount) {
            contract.fail(`Portable ${contract.label} body is missing archive parts`);
          }
          terminal = true;
          controller.close();
          return;
        }
        if (expectedPart >= contract.partCount) {
          contract.fail(`Portable ${contract.label} body has extra archive parts`);
        }
        assertBodyFrame(next.value, contract, expectedPart);
        expectedPart += 1;
        controller.enqueue(next.value.body);
      } catch (error) {
        terminal = true;
        await closeIterator(iterator);
        controller.error(error);
      }
    },
    async cancel() {
      if (terminal) return;
      terminal = true;
      await closeIterator(iterator);
    },
  });
}

export async function cancelOwnedResponse(
  response: Response,
  reason: unknown,
): Promise<void> {
  if (!response.body || response.body.locked) return;
  await response.body.cancel(reason).catch(() => undefined);
}

function bodyFrame(
  contract: FramedBodyContract,
  part: number,
  body: Uint8Array,
): ArchiveDataFrameInput {
  return Object.freeze({
    kind: contract.bodyKind,
    objectId: contract.objectId,
    part,
    bodyMediaType: contract.bodyMediaType,
    bodyEncoding: "identity",
    body,
  });
}

function assertBodyFrame(
  frame: ArchiveDataFrameInput,
  contract: FramedBodyContract,
  expectedPart: number,
): void {
  if (
    frame.kind !== contract.bodyKind
    || frame.objectId !== contract.objectId
    || frame.part !== expectedPart
    || frame.bodyMediaType !== contract.bodyMediaType
    || (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity")
    || !(frame.body instanceof Uint8Array)
    || frame.body.byteLength !== expectedPartBytes(contract.size, expectedPart)
  ) {
    contract.fail(`Portable ${contract.label} body frame is invalid or out of order`);
  }
}

function assertSourceResponse(
  contract: Pick<FramedBodyContract, "fail" | "label" | "size"> & Readonly<{
    response: Response;
  }>,
): void {
  if (contract.response.status !== 200 || contract.response.bodyUsed) {
    contract.fail(`${contract.label} response is not an unused successful body`);
  }
  const contentLength = contract.response.headers.get("content-length");
  if (contentLength === null) return;
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(contentLength)
    || Number(contentLength) !== contract.size
  ) {
    contract.fail(`${contract.label} Content-Length does not match its descriptor`);
  }
}

function expectedPartBytes(size: number, part: number): number {
  const parts = framedBodyPartCount(size);
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts) return -1;
  if (size === 0) return 0;
  return part === parts - 1
    ? size - (part * MAX_FRAME_BODY_BYTES)
    : MAX_FRAME_BODY_BYTES;
}

async function* toAsyncFrames(
  frames: FramedBodySource,
): AsyncGenerator<ArchiveDataFrameInput> {
  for await (const frame of frames) yield frame;
}

async function closeIterator(iterator: AsyncIterator<ArchiveDataFrameInput>): Promise<void> {
  await iterator.return?.().catch(() => undefined);
}
