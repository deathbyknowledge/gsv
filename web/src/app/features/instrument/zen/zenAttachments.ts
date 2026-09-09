import type { ChatMediaUpload } from "../../chat/domain/processes";
import { chatMediaKind } from "../../chat/domain/media";
import { randomId } from "../../../services/ids";

export type ZenAttachment = ChatMediaUpload & { id: string };
export type ZenSendIntent = {
  idempotencyKey: string;
  pid: string;
  text: string;
  media: readonly ZenAttachment[];
};

export function zenAttachment(file: File): ZenAttachment {
  const mimeType = file.type || "application/octet-stream";
  return { id: randomId(), type: chatMediaKind({ mimeType }), mimeType, filename: file.name || "attachment", body: file };
}

export function zenSendIntent(previous: ZenSendIntent | null, pid: string, text: string, media: readonly ZenAttachment[]): ZenSendIntent {
  if (previous?.pid === pid && previous.text === text && previous.media.length === media.length
    && previous.media.every((file, index) => file.id === media[index]?.id)) return previous;
  return { idempotencyKey: randomId(), pid, text, media };
}
