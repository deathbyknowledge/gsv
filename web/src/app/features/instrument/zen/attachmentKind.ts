export type AttachmentPreviewKind = "image" | "pdf" | "markdown" | "text" | "unsupported";
export const TEXT_PREVIEW_LIMIT = 1024 * 1024;

/** Only inert text and browser-native formats; never navigate to active attachment content. */
export function attachmentPreviewKind(mimeType: string, filename: string): AttachmentPreviewKind {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (["text/html", "application/xhtml+xml", "image/svg+xml"].includes(mime)) return "unsupported";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  const genericText = mime === "text/plain" || mime === "application/octet-stream" || mime === "";
  if (genericText && /\.(md|markdown)$/i.test(filename)) return "markdown";
  if (mime.startsWith("text/") || /^application\/(json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|yaml|x-yaml|javascript)$/.test(mime)) return "text";
  if (genericText && /\.(txt|json|jsonl|csv|tsv|log|yaml|yml|xml|toml|ini|js|ts|tsx|jsx|py|rs|sh|css)$/i.test(filename)) return "text";
  return "unsupported";
}
