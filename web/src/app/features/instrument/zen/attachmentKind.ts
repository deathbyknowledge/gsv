export type AttachmentPreviewKind = "image" | "pdf" | "markdown" | "text" | "unsupported";
export const TEXT_PREVIEW_LIMIT = 1024 * 1024;

/** Only inert text and browser-native formats; never navigate to active attachment content. */
export function attachmentPreviewKind(mimeType: string, filename: string): AttachmentPreviewKind {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (/\.(html?|xhtml|svg)$/i.test(filename)) return "unsupported";
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (["text/html", "application/xhtml+xml", "image/svg+xml"].includes(mime)) return "unsupported";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  const genericText = mime === "text/plain" || mime === "application/octet-stream" || mime === "";
  if (genericText && /\.(md|markdown)$/i.test(filename)) return "markdown";
  if (mime.startsWith("text/") || /^application\/(json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|yaml|x-yaml|javascript)$/.test(mime)) return "text";
  if (genericText && /\.(txt|json|jsonl|csv|tsv|log|yaml|yml|xml|toml|ini|conf|js|ts|tsx|jsx|css|go|java|c|h|cpp|hpp|cc|rs|py|rb|php|cs|kt|kts|swift|scala|sh|bash|zsh|ps1|sql|tf|lua|pl|r|dart|ex|exs|erl|hrl|clj|hs|vue|svelte)$/i.test(filename)) return "text";
  if (genericText && /(^|[/\\])dockerfile$/i.test(filename)) return "text";
  return "unsupported";
}
