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
export function renderCompactionTranscriptWindow(messages: MessageRecord[], maxChars: number): string {
  if (maxChars <= 0) return "";
  const records = messages.flatMap((message) =>
    (message.records ?? inferHistoryRecords(message)).map((record, index): CompactionRecord => ({
      messageId: message.id,
      index,
      generation: message.generation,
      runId: message.runId ?? null,
      createdAt: message.createdAt,
      ...record,
    })).filter((record) => record.kind !== "event" || (record.payload.audience !== "person" && record.payload.kind !== "process.approval")),
  );
  const complete: string[] = [];
  let completeChars = 0;
  for (const record of records) {
    const remaining = maxChars - completeChars - (complete.length > 0 ? 1 : 0);
    const line = jsonPrefix(record, remaining);
    if (!line.complete) break;
    complete.push(line.text);
    completeChars += line.text.length + (complete.length > 1 ? 1 : 0);
  }
  if (complete.length === records.length) return complete.join("\n");

  const omissionBudget = JSON.stringify({
    omitted_records: records.length,
    omitted_messages: messages.length,
  }).length + 2;
  const recordsBudget = Math.max(0, maxChars - omissionBudget);
  const headBudget = Math.floor(recordsBudget * 0.35);
  const tailBudget = recordsBudget - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  let firstOmitted = 0;
  let lastOmitted = records.length;

  while (firstOmitted < records.length) {
    const line = fitCompactionRecord(records[firstOmitted]!, headBudget - headChars);
    if (!line) break;
    head.push(line);
    headChars += line.length + 1;
    firstOmitted += 1;
  }
  while (lastOmitted > firstOmitted) {
    const line = fitCompactionRecord(records[lastOmitted - 1]!, tailBudget - tailChars);
    if (!line) break;
    tail.unshift(line);
    tailChars += line.length + 1;
    lastOmitted -= 1;
  }

  const omitted = JSON.stringify({
    omitted_records: lastOmitted - firstOmitted,
    omitted_messages: new Set(records.slice(firstOmitted, lastOmitted).map((record) => record.messageId)).size,
  });
  const lines = [...head, omitted, ...tail].join("\n");
  return lines.length <= maxChars ? lines : "";
}

function fitCompactionRecord(record: CompactionRecord, maxChars: number): string | null {
  if (maxChars <= 0) return null;
  const full = jsonPrefix(record, maxChars);
  if (full.complete) return full.text;

  const payload = jsonPrefix(record.payload, maxChars).text;
  const preview = (length: number) => JSON.stringify({
    messageId: record.messageId,
    index: record.index,
    kind: record.kind,
    payload_preview: payload.slice(0, length),
    record_truncated: true,
  });
  let low = 0;
  let high = payload.length;
  if (preview(0).length > maxChars) return null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (preview(middle).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return preview(low);
}

type JsonFrame =
  | { kind: "value"; value: JsonValue }
  | { kind: "array"; value: JsonValue[]; index: number }
  | { kind: "object"; value: JsonObject; keys: string[]; index: number };

type JsonPrefix = { text: string; complete: boolean };

/** Stop traversing at the window limit, including deeply nested values and long strings. */
function jsonPrefix(value: JsonValue, maxChars: number): JsonPrefix {
  const stack: JsonFrame[] = [{ kind: "value", value }];
  const parts: string[] = [];
  let remaining = Math.max(0, maxChars);
  const append = (text: string): boolean => {
    parts.push(text.slice(0, remaining));
    remaining -= text.length;
    return remaining >= 0;
  };
  const quote = (text: string): string => JSON.stringify(text.slice(0, remaining + 1));

  while (stack.length > 0 && remaining > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index === frame.value.length) {
        if (!append("]")) break;
      } else {
        if (frame.index > 0 && !append(",")) break;
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[frame.index]! });
      }
    } else if (frame.kind === "object") {
      if (frame.index === frame.keys.length) {
        if (!append("}")) break;
      } else {
        if (frame.index > 0 && !append(",")) break;
        const key = frame.keys[frame.index]!;
        if (!append(quote(key)) || !append(":")) break;
        stack.push({ ...frame, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.value[key]! });
      }
    } else if (Array.isArray(frame.value)) {
      if (!append("[")) break;
      stack.push({ kind: "array", value: frame.value, index: 0 });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is validated at the owning history boundary; this selects JSON encoding, not validation.
    } else if (frame.value !== null && typeof frame.value === "object") {
      if (!append("{")) break;
      const object = frame.value;
      stack.push({
        kind: "object", value: object,
        keys: Object.keys(object).filter((key) => object[key] !== undefined), index: 0,
      });
    } else {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON strings need bounded quoting; the other primitive values have constant-size encodings.
      if (!append(typeof frame.value === "string" ? quote(frame.value) : JSON.stringify(frame.value))) break;
    }
  }
  return { text: parts.join(""), complete: remaining >= 0 && stack.length === 0 };
}
