import type { SignalFrame } from "./frames";

type ProcessRunStreamEventValue =
  | string
  | number
  | boolean
  | null
  | ProcessRunStreamEventValue[]
  | { [key: string]: ProcessRunStreamEventValue };

type ProcessRunStreamEvent = {
  type: string;
  [key: string]: ProcessRunStreamEventValue;
};

type ProcessRunStreamPayload = {
  pid: string;
  runId: string;
  seq: number;
  timestamp: number;
  event: ProcessRunStreamEvent;
};

type ProcessRunStreamFrame = {
  type: "sig";
  signal: "proc.run.stream";
  payload: ProcessRunStreamPayload;
};

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
        const payload = frame.payload;
        const runId = payload.runId;
        const seq = payload.seq;
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
): ProcessRunStreamFrame {
  if (new TextEncoder().encode(record).byteLength > MAX_PROCESS_RUN_STREAM_RECORD_BYTES) {
    throw new Error("Process run stream record is too large");
  }
  // SAFETY: this parser is the sole JSON boundary for the process-run stream protocol.
  const frame = JSON.parse(record) as ProcessRunStreamFrame;
  if (frame.type !== "sig" || frame.signal !== "proc.run.stream") {
    throw new Error("Process run stream signal is invalid");
  }
  const payload = frame.payload;
  if (
    payload.pid !== processId
    || payload.runId.length === 0
    || !Number.isSafeInteger(payload.seq)
    || payload.seq < 1
    || !Number.isFinite(payload.timestamp)
    || !payload.event
  ) {
    throw new Error("Process run stream payload is invalid");
  }
  return frame;
}
