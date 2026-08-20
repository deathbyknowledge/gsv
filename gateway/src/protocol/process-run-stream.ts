import type { SignalFrame } from "./frames";

const MAX_PROCESS_RUN_STREAM_RECORD_BYTES = 1_048_576;

export function encodeProcessRunStreamFrame(frame: SignalFrame): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
  if (bytes.byteLength > MAX_PROCESS_RUN_STREAM_RECORD_BYTES) {
    throw new Error("Process run stream record is too large");
  }
  return bytes;
}

export async function consumeProcessRunStream(
  processId: string,
  stream: ReadableStream<Uint8Array>,
  consume: (frame: SignalFrame) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let buffered = "";
  let streamRunId: string | null = null;
  let previousSeq: number | null = null;

  const consumeBufferedRecords = async (complete: boolean): Promise<void> => {
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const record = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (record.length > 0) {
        const frame = parseProcessRunStreamFrame(processId, record);
        const payload = frame.payload as Record<string, unknown>;
        const runId = payload.runId as string;
        const seq = payload.seq as number;
        if (streamRunId !== null && runId !== streamRunId) {
          throw new Error("Process run stream changed run IDs");
        }
        if (previousSeq !== null && seq !== previousSeq + 1) {
          throw new Error("Process run stream sequence is not contiguous");
        }
        streamRunId = runId;
        previousSeq = seq;
        await consume(frame);
      }
      newline = buffered.indexOf("\n");
    }
    if (complete && buffered.length > 0) {
      throw new Error("Process run stream ended with an incomplete record");
    }
    if (
      buffered.length > 0
      && new TextEncoder().encode(buffered).byteLength > MAX_PROCESS_RUN_STREAM_RECORD_BYTES
    ) {
      throw new Error("Process run stream record is too large");
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      await consumeBufferedRecords(false);
    }
    buffered += decoder.decode();
    await consumeBufferedRecords(true);
  } catch (error) {
    await reader.cancel("Process run stream is invalid").catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseProcessRunStreamFrame(
  processId: string,
  record: string,
): SignalFrame {
  if (new TextEncoder().encode(record).byteLength > MAX_PROCESS_RUN_STREAM_RECORD_BYTES) {
    throw new Error("Process run stream record is too large");
  }
  const value: unknown = JSON.parse(record);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Process run stream frame is invalid");
  }
  const frame = value as Record<string, unknown>;
  if (frame.type !== "sig" || frame.signal !== "proc.run.stream") {
    throw new Error("Process run stream signal is invalid");
  }
  const payload = frame.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Process run stream payload is invalid");
  }
  const fields = payload as Record<string, unknown>;
  if (
    fields.pid !== processId
    || typeof fields.runId !== "string"
    || fields.runId.length === 0
    || !Number.isSafeInteger(fields.seq)
    || (fields.seq as number) < 1
    || !Number.isFinite(fields.timestamp)
    || !fields.event
    || typeof fields.event !== "object"
    || Array.isArray(fields.event)
  ) {
    throw new Error("Process run stream payload is invalid");
  }
  return value as SignalFrame;
}
