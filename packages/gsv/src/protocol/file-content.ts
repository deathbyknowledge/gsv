const CONTENT_TYPES = new Map([
  ["md", "text/markdown"],
  ["json", "application/json"],
  ["map", "application/json"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["xml", "application/xml"],
  ["toml", "application/toml"],
  ["js", "application/javascript"],
  ["cjs", "application/javascript"],
  ["mjs", "application/javascript"],
  ["jsx", "application/javascript"],
  ["ts", "application/typescript"],
  ["tsx", "application/typescript"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["css", "text/css"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["csv", "text/csv"],
  ["sh", "text/x-shellscript"],
  ["py", "text/x-python"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["webm", "audio/webm"],
  ["m4a", "audio/mp4"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["pdf", "application/pdf"],
  ["wasm", "application/wasm"],
  ["data", "application/octet-stream"],
]);

export function inferFsContentType(path: string): string {
  return extensionContentType(path) ?? "text/plain";
}

/** How many leading bytes decide a new file's type, on gsv and on machines alike. */
export const FS_CONTENT_SNIFF_BYTES = 8192;

/** A new file's content type: its extension's, else text only when its leading bytes read as text. */
export function sniffFsContentType(path: string, header: Uint8Array): string {
  return extensionContentType(path)
    ?? (readsAsText(header.subarray(0, FS_CONTENT_SNIFF_BYTES)) ? "text/plain" : "application/octet-stream");
}

function extensionContentType(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension ? CONTENT_TYPES.get(extension) : undefined;
}

// UTF-8 without NUL bytes; a character cut off by the end of the header still counts.
function readsAsText(header: Uint8Array): boolean {
  if (header.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function isTextContentType(contentType: string): boolean {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/")
    || type === "application/json"
    || type.endsWith("+json")
    || type === "application/yaml"
    || type === "application/xml"
    || type === "application/javascript"
    || type === "application/x-javascript"
    || type === "application/typescript"
    || type === "application/toml"
    || type === "image/svg+xml";
}
