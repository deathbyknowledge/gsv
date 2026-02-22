import type { ImageContent, TextContent, UserMessage } from "@mariozechner/pi-ai";
import type { MediaAttachment } from "../protocol/channel";

type UserImageReference = { type: "image"; r2Key: string; mimeType: string };

export function buildUserMessage(
  text: string,
  media?: MediaAttachment[],
): UserMessage {
  const images = media?.filter((m) => m.type === "image") ?? [];
  const documents = media?.filter((m) => m.type === "document") ?? [];
  const audioWithTranscript =
    media?.filter((m) => m.type === "audio" && m.transcription) ?? [];
  const audioWithoutTranscript =
    media?.filter((m) => m.type === "audio" && !m.transcription) ?? [];

  if (
    images.length === 0 &&
    documents.length === 0 &&
    audioWithTranscript.length === 0 &&
    audioWithoutTranscript.length === 0
  ) {
    return {
      role: "user",
      content: text || "[Empty message]",
      timestamp: Date.now(),
    };
  }

  const content: Array<TextContent | ImageContent | UserImageReference> = [];

  if (text && text !== "[Media]") {
    content.push({ type: "text", text });
  }

  for (const img of images) {
    if (img.r2Key) {
      content.push({
        type: "image",
        r2Key: img.r2Key,
        mimeType: img.mimeType,
      });
    } else if (img.data && img.mimeType) {
      content.push({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      });
    }
  }

  for (const audio of audioWithTranscript) {
    content.push({
      type: "text",
      text: `[Voice message transcription: ${audio.transcription}]`,
    });
  }

  for (const _audio of audioWithoutTranscript) {
    content.push({
      type: "text",
      text: "[Voice message received - transcription unavailable]",
    });
  }

  for (const doc of documents) {
    const filename = doc.filename || "document";
    const mimeType = doc.mimeType || "application/octet-stream";
    const size = doc.size ? ` (${Math.round(doc.size / 1024)}KB)` : "";
    content.push({
      type: "text",
      text: `[Document attached: ${filename}${size}, type: ${mimeType}]`,
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "[Media message]" });
  }

  return {
    role: "user",
    content: content as UserMessage["content"],
    timestamp: Date.now(),
  };
}
