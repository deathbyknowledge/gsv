import type { JsonObject, JsonValue, ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import { inferHistoryRecords } from "../storage/history-records";
import type { MessageRecord } from "../storage/records";

type CompactionRecord = ProcHistoryRecordData & {
  messageId: number;
  index: number;
  generation: number;
  runId: string | null;
  createdAt: number;
};

/** Summary input is typed record JSONL; archive serialization has a separate lifetime contract. */
export function* renderCompactionTranscriptChunks(messages: MessageRecord[], maxChars: number): Generator<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("Invalid compaction chunk size");
  let chunk = "";
  for (const message of messages) {
    const records = message.records ?? inferHistoryRecords(message);
    for (const [index, record] of records.entries()) {
      if (record.kind === "event" && (record.payload.audience === "person" || record.payload.kind === "process.approval")) continue;
      const entry: CompactionRecord = {
        messageId: message.id, index, generation: message.generation,
        runId: message.runId ?? null, createdAt: message.createdAt, ...record,
      };
      let line = "";
      for (const fragment of recordFragments(entry)) {
        let offset = 0;
        while (offset < fragment.length) {
          const length = Math.min(maxChars - line.length, fragment.length - offset);
          line += fragment.slice(offset, offset + length);
          offset += length;
          if (line.length === maxChars) {
            if (chunk) {
              yield chunk;
              chunk = "";
            }
            yield line;
            line = "";
          }
        }
      }
      if (chunk.length + line.length > maxChars) {
        yield chunk;
        chunk = "";
      }
      chunk += line;
    }
  }
  if (chunk) yield chunk;
}

function* recordFragments(record: CompactionRecord): Generator<string> {
  yield* jsonFragments(record);
  yield "\n";
}

type JsonFrame =
  | { kind: "value"; value: JsonValue }
  | { kind: "array"; value: JsonValue[]; index: number }
  | { kind: "object"; value: JsonObject; keys: string[]; index: number };

/** Stop traversing at the window limit, including deeply nested values and long strings. */
function* jsonFragments(value: JsonValue): Generator<string> {
  const stack: JsonFrame[] = [{ kind: "value", value }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index === frame.value.length) yield "]";
      else {
        if (frame.index > 0) yield ",";
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[frame.index]! });
      }
    } else if (frame.kind === "object") {
      if (frame.index === frame.keys.length) yield "}";
      else {
        if (frame.index > 0) yield ",";
        const key = frame.keys[frame.index]!;
        yield JSON.stringify(key) + ":";
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[key]! });
      }
    } else if (Array.isArray(frame.value)) {
      yield "[";
      stack.push({ kind: "array", value: frame.value, index: 0 });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is validated at the owning history boundary; this selects JSON encoding, not validation.
    } else if (frame.value !== null && typeof frame.value === "object") {
      yield "{";
      const object = frame.value;
      stack.push({ kind: "object", value: object, keys: Object.keys(object).filter((key) => object[key] !== undefined), index: 0 });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON strings need bounded quoting; the other primitive values have constant-size encodings.
    } else if (typeof frame.value === "string") {
      yield '"';
      for (let offset = 0; offset < frame.value.length; offset += 1_024) {
        yield JSON.stringify(frame.value.slice(offset, offset + 1_024)).slice(1, -1);
      }
      yield '"';
    } else yield JSON.stringify(frame.value);
  }
}
