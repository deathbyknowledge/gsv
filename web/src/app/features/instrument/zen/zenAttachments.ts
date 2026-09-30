import type { ChatMediaUpload } from "../../../services/chat/domain/processes";
import { chatMediaKind } from "../../../services/chat/domain/media";
import { randomId } from "../../../services/ids";

export type ZenAttachment = ChatMediaUpload & { id: string };

export function zenAttachment(file: File): ZenAttachment {
  const mimeType = file.type || "application/octet-stream";
  return { id: randomId(), type: chatMediaKind({ mimeType }), mimeType, filename: file.name || "attachment", body: file };
}
