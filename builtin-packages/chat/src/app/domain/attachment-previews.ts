import type { Attachment } from "../types";

export function stripAttachmentPreview(attachment: Attachment): Attachment {
  const next = { ...attachment };
  delete next.previewUrl;
  return next;
}

export function revokeAttachmentPreview(attachment: Attachment): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function cleanupAttachmentPreview(attachment: Attachment, previewUrls: Set<string>): void {
  revokeAttachmentPreview(attachment);
  if (attachment.previewUrl) {
    previewUrls.delete(attachment.previewUrl);
  }
}
