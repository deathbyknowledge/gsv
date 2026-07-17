import type { AdapterMedia } from "./adapters";
import type { BinaryBody } from "./body";

export type AdapterMediaPart = {
  media: Omit<AdapterMedia, "body">;
  body?: BinaryBody;
};

export type AdapterMediaBundle = {
  media: AdapterMedia[];
  body?: BinaryBody;
};

export type ReadAdapterMediaBodyOptions = {
  maxBytes?: number;
  maxPartBytes?: number;
  signal?: AbortSignal;
};

export type AdapterMediaBodyDescriptorOptions = Pick<
  ReadAdapterMediaBodyOptions,
  "maxBytes" | "maxPartBytes"
>;

export type AdapterMediaBodyPlanPart = {
  mediaIndex: number;
  offset: number;
  length: number;
};

export type AdapterMediaBodyPlan = {
  parts: AdapterMediaBodyPlanPart[];
  totalLength: number;
};

export type AdapterMediaBodyStreamPart = {
  mediaIndex: number;
  media: AdapterMedia;
  body: BinaryBody & { length: number };
};

export type AdapterMediaBodyPartConsumer = (
  part: AdapterMediaBodyStreamPart,
) => void | Promise<void>;

export function binaryBodyFromBytes(bytes: Uint8Array): BinaryBody {
  const chunk = new Uint8Array(bytes.byteLength);
  chunk.set(bytes);
  return {
    length: chunk.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        if (chunk.byteLength > 0) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  };
}

/**
 * Packs media streams into the one binary body supported by a GSV frame.
 * Body-backed media are laid out contiguously in media order.
 */
export async function bundleAdapterMedia(
  parts: AdapterMediaPart[],
): Promise<AdapterMediaBundle> {
  const bodies: Array<Required<Pick<BinaryBody, "length">> & BinaryBody> = [];
  const media: AdapterMedia[] = [];
  let offset = 0;

  try {
    for (const part of parts) {
      if (!part.body) {
        media.push(part.media);
        continue;
      }
      if (part.media.url) {
        throw new Error("Adapter media cannot use both a URL and a binary body");
      }
      if (part.body.stream.locked) {
        throw new Error("Adapter media body stream is already locked");
      }
      const length = requireLength(part.body.length, "Adapter media body");
      const nextOffset = offset + length;
      if (!Number.isSafeInteger(nextOffset)) {
        throw new Error("Adapter media body length exceeds the safe integer range");
      }
      media.push({
        ...part.media,
        body: { offset, length },
        size: length,
      });
      bodies.push({ ...part.body, length });
      offset = nextOffset;
    }
  } catch (error) {
    await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
    throw error;
  }

  return {
    media,
    ...(bodies.length > 0
      ? { body: concatenateBodies(bodies, offset) }
      : {}),
  };
}

/**
 * Validates only media body descriptors and returns their sequential read plan.
 * This function never locks, reads, or cancels a frame body.
 */
export function validateAdapterMediaBodyDescriptors(
  media: AdapterMedia[] | undefined,
  options: AdapterMediaBodyDescriptorOptions = {},
): AdapterMediaBodyPlan {
  const maxBytes = normalizeLimit(options.maxBytes, "maxBytes");
  const maxPartBytes = normalizeLimit(options.maxPartBytes, "maxPartBytes");
  const parts: AdapterMediaBodyPlanPart[] = [];
  let expectedOffset = 0;

  for (const [mediaIndex, item] of (media ?? []).entries()) {
    if (!item.body) {
      continue;
    }
    if (item.url) {
      throw new Error("Adapter media cannot use both a URL and a binary body");
    }
    const offset = requireLength(item.body.offset, "Adapter media body offset");
    const length = requireLength(item.body.length, "Adapter media body length");
    if (offset !== expectedOffset) {
      throw new Error(
        `Adapter media bodies must be contiguous (expected offset ${expectedOffset}, got ${offset})`,
      );
    }
    if (length > maxPartBytes) {
      throw new Error(`Adapter media body exceeds per-item limit (${length} bytes)`);
    }
    const nextOffset = expectedOffset + length;
    if (!Number.isSafeInteger(nextOffset)) {
      throw new Error("Adapter media body length exceeds the safe integer range");
    }
    if (nextOffset > maxBytes) {
      throw new Error(`Adapter media body exceeds total limit (${nextOffset} bytes)`);
    }
    parts.push({ mediaIndex, offset, length });
    expectedOffset = nextOffset;
  }

  return { parts, totalLength: expectedOffset };
}

/**
 * Validates descriptor/body pairing without locking, consuming, or cancelling
 * the body. Callers that transfer ownership later can use this as preflight.
 */
export function validateAdapterMediaBody(
  media: AdapterMedia[] | undefined,
  body: BinaryBody | undefined,
  options: AdapterMediaBodyDescriptorOptions = {},
): AdapterMediaBodyPlan {
  const plan = validateAdapterMediaBodyDescriptors(media, options);
  if (plan.parts.length === 0) {
    if (body) {
      throw new Error("Adapter request included an unreferenced binary body");
    }
    return plan;
  }
  if (!body) {
    throw new Error("Adapter media references a missing binary body");
  }
  if (body.stream.locked) {
    throw new Error("Adapter media body stream is already locked");
  }
  if (body.length !== undefined) {
    const declaredLength = requireLength(body.length, "Adapter media body length");
    if (declaredLength !== plan.totalLength) {
      throw new Error(
        `Adapter media body length ${declaredLength} did not match described length ${plan.totalLength}`,
      );
    }
  }
  return plan;
}

/**
 * Gives one bounded media stream at a time to `consumePart` while retaining sole
 * ownership of the top-level frame body. A part must be fully consumed before
 * the callback returns. Success consumes the entire body; every failure cancels
 * the body and all later parts.
 */
export async function consumeAdapterMediaBodyParts(
  media: AdapterMedia[] | undefined,
  body: BinaryBody | undefined,
  consumePart: AdapterMediaBodyPartConsumer,
  options: ReadAdapterMediaBodyOptions = {},
): Promise<void> {
  const items = [...(media ?? [])];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort: (() => void) | undefined;

  try {
    const plan = validateAdapterMediaBody(items, body, options);
    if (plan.parts.length === 0) {
      return;
    }
    // validateAdapterMediaBody guarantees a body for every non-empty plan.
    const frameBody = body!;
    options.signal?.throwIfAborted();

    reader = frameBody.stream.getReader();
    abort = () => {
      void reader?.cancel(options.signal?.reason).catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const cursor = new AdapterMediaBodyCursor(reader, plan.totalLength, options.signal);

    for (const descriptor of plan.parts) {
      options.signal?.throwIfAborted();
      const part = createAdapterMediaPartStream(cursor, descriptor);
      await consumePart({
        mediaIndex: descriptor.mediaIndex,
        media: items[descriptor.mediaIndex],
        body: { stream: part.stream, length: descriptor.length },
      });
      options.signal?.throwIfAborted();
      if (part.failure) {
        throw part.failure;
      }
      if (!part.complete) {
        throw new Error(
          `Adapter media body part ${descriptor.mediaIndex} was not fully consumed`,
        );
      }
    }

    await cursor.requireEnd();
    options.signal?.throwIfAborted();
  } catch (error) {
    if (reader) {
      await reader.cancel(error).catch(() => {});
    } else {
      await cancelBinaryBody(body, error);
    }
    throw error;
  } finally {
    if (abort) {
      options.signal?.removeEventListener("abort", abort);
    }
    reader?.releaseLock();
  }
}

/**
 * Consumes and validates a frame body, returning bytes aligned with `media`.
 * The whole body is consumed on success and cancelled on every failure path.
 */
export async function readAdapterMediaBody(
  media: AdapterMedia[] | undefined,
  body: BinaryBody | undefined,
  options: ReadAdapterMediaBodyOptions = {},
): Promise<Array<Uint8Array | undefined>> {
  const items = media ?? [];
  const output: Array<Uint8Array | undefined> = items.map(() => undefined);
  await consumeAdapterMediaBodyParts(items, body, async (part) => {
    output[part.mediaIndex] = await readPartBytes(part.body, options.signal);
  }, options);
  return output;
}

class AdapterMediaBodyCursor {
  private pending: Uint8Array | undefined;
  private pendingOffset = 0;
  private received = 0;
  private ended = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    readonly totalLength: number,
    private readonly signal?: AbortSignal,
  ) {}

  get receivedLength(): number {
    return this.received;
  }

  async take(maxLength: number): Promise<Uint8Array | undefined> {
    if (maxLength <= 0) {
      return new Uint8Array();
    }

    while (true) {
      this.signal?.throwIfAborted();
      if (this.pending && this.pendingOffset < this.pending.byteLength) {
        const end = Math.min(this.pending.byteLength, this.pendingOffset + maxLength);
        const chunk = this.pending.subarray(this.pendingOffset, end);
        this.pendingOffset = end;
        if (this.pendingOffset === this.pending.byteLength) {
          this.pending = undefined;
          this.pendingOffset = 0;
        }
        return chunk;
      }
      if (this.ended) {
        return undefined;
      }

      const result = await this.reader.read();
      this.signal?.throwIfAborted();
      if (result.done) {
        this.ended = true;
        return undefined;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error("Adapter media body chunks must be Uint8Array values");
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      const nextReceived = this.received + result.value.byteLength;
      if (!Number.isSafeInteger(nextReceived) || nextReceived > this.totalLength) {
        throw new Error(
          `Adapter media body exceeded described length ${this.totalLength}`,
        );
      }
      this.received = nextReceived;
      this.pending = result.value;
      this.pendingOffset = 0;
    }
  }

  async requireEnd(): Promise<void> {
    if (this.pending && this.pendingOffset < this.pending.byteLength) {
      throw new Error("Adapter media body contained unreferenced bytes");
    }
    while (!this.ended) {
      this.signal?.throwIfAborted();
      const result = await this.reader.read();
      this.signal?.throwIfAborted();
      if (result.done) {
        this.ended = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error("Adapter media body chunks must be Uint8Array values");
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      throw new Error(
        `Adapter media body exceeded described length ${this.totalLength}`,
      );
    }
    if (this.received !== this.totalLength) {
      throw new Error(
        `Adapter media body length ${this.received} did not match described length ${this.totalLength}`,
      );
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    this.ended = true;
    await this.reader.cancel(reason).catch(() => {});
  }
}

function createAdapterMediaPartStream(
  cursor: AdapterMediaBodyCursor,
  descriptor: AdapterMediaBodyPlanPart,
): {
  stream: ReadableStream<Uint8Array>;
  readonly complete: boolean;
  readonly failure: Error | undefined;
} {
  let remaining = descriptor.length;
  let complete = remaining === 0;
  let failure: Error | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (complete) {
        controller.close();
      }
    },
    async pull(controller) {
      if (complete) {
        controller.close();
        return;
      }
      try {
        const chunk = await cursor.take(remaining);
        if (!chunk) {
          throw new Error(
            `Adapter media body length ${cursor.receivedLength} did not match described length ${cursor.totalLength}`,
          );
        }
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        if (remaining === 0) {
          complete = true;
          controller.close();
        }
      } catch (error) {
        failure = asError(error);
        controller.error(failure);
      }
    },
    async cancel(reason) {
      if (!complete) {
        failure = reason instanceof Error
          ? reason
          : new Error("Adapter media body part was cancelled before completion");
        await cursor.cancel(failure);
      }
    },
  }, { highWaterMark: 0 });

  return {
    stream,
    get complete() {
      return complete;
    },
    get failure() {
      return failure;
    },
  };
}

async function readPartBytes(
  body: BinaryBody & { length: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (body.stream.locked) {
    throw new Error("Adapter media body part stream is already locked");
  }
  const output = new Uint8Array(body.length);
  const reader = body.stream.getReader();
  let offset = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      if (offset + value.byteLength > output.byteLength) {
        throw new Error(`Adapter media body part exceeded declared length ${body.length}`);
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== output.byteLength) {
      throw new Error(
        `Adapter media body part length ${offset} did not match ${body.length}`,
      );
    }
    return output;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function cancelBinaryBody(
  body: BinaryBody | undefined,
  reason?: unknown,
): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}

function concatenateBodies(
  bodies: Array<Required<Pick<BinaryBody, "length">> & BinaryBody>,
  length: number,
): BinaryBody {
  let bodyIndex = 0;
  let bodyBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const cancelRemaining = async (reason?: unknown): Promise<void> => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    if (reader) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
      reader = null;
      bodyIndex += 1;
    }
    await Promise.allSettled(
      bodies.slice(bodyIndex).map((body) => body.stream.cancel(reason)),
    );
  };

  return {
    length,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (bodyIndex < bodies.length) {
            const body = bodies[bodyIndex];
            reader ??= body.stream.getReader();
            const { done, value } = await reader.read();
            if (!done) {
              bodyBytes += value.byteLength;
              if (bodyBytes > body.length) {
                throw new Error(
                  `Adapter media body exceeded declared length ${body.length}`,
                );
              }
              controller.enqueue(value);
              return;
            }
            reader.releaseLock();
            reader = null;
            if (bodyBytes !== body.length) {
              throw new Error(
                `Adapter media body length ${bodyBytes} did not match ${body.length}`,
              );
            }
            bodyBytes = 0;
            bodyIndex += 1;
          }
          controller.close();
        } catch (error) {
          await cancelRemaining(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancelRemaining(reason);
      },
    }),
  };
}

function requireLength(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeLimit(value: number | undefined, label: string): number {
  const limit = value ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error(`${label} must be a non-negative safe integer or Infinity`);
  }
  return limit;
}
