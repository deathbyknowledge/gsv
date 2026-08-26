import type { AdapterMedia } from "../../shared/src/types";

export function isWhatsAppEncryptionPreparationFailure(error: Error): boolean {
  return error instanceof Error && error.message === "All encryptions failed";
}

export type WhatsAppOutboundDelivery =
  | { kind: "text"; text: string }
  | { kind: "media"; mediaIndex: number; caption: string };

export function planWhatsAppOutboundDeliveries(
  text: string,
  media: readonly AdapterMedia[],
): WhatsAppOutboundDelivery[] {
  const trimmed = text.trim();
  if (media.length === 0) {
    return trimmed ? [{ kind: "text", text: trimmed }] : [];
  }

  const deliveries: WhatsAppOutboundDelivery[] = [];
  const firstAcceptsCaption = media[0].type !== "audio";
  if (trimmed && !firstAcceptsCaption) {
    deliveries.push({ kind: "text", text: trimmed });
  }
  for (const [mediaIndex] of media.entries()) {
    deliveries.push({
      kind: "media",
      mediaIndex,
      caption: mediaIndex === 0 && firstAcceptsCaption ? trimmed : "",
    });
  }
  return deliveries;
}

export function defaultWhatsAppFilename(media: AdapterMedia): string {
  const provided = media.filename?.trim();
  if (provided) return provided.slice(0, 240);
  const mime = media.mimeType.toLowerCase().split(";", 1)[0];
  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  } satisfies Record<string, string>;
  const extension = Object.entries(extensions).find(([key]) => key === mime)?.[1];
  return `attachment.${extension ?? (media.type === "document" ? "bin" : media.type)}`;
}
