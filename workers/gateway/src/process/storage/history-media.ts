import { parseStoredProcessMedia, type StoredProcessMedia } from "../media";
import type { MessageRecord } from "./records";

/** Media whose lifetime belongs to Process history, including typed members of a turn. */
export function storedHistoryMedia(message: MessageRecord): StoredProcessMedia[] {
  const media = parseStoredProcessMedia(message.media);
  for (const record of message.records ?? []) {
    if (record.kind !== "message" && record.kind !== "note" && record.kind !== "result") continue;
    for (const item of record.payload.media ?? []) {
      if (item.type !== "resource") media.push(item);
    }
  }
  return media;
}
