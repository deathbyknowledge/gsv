const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  json: "application/json",
  map: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  toml: "application/toml",
  js: "application/javascript",
  cjs: "application/javascript",
  mjs: "application/javascript",
  jsx: "application/javascript",
  ts: "application/typescript",
  tsx: "application/typescript",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  sh: "text/x-shellscript",
  py: "text/x-python",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  wasm: "application/wasm",
  data: "application/octet-stream",
};

export function inferFsContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension ? CONTENT_TYPES[extension] ?? "text/plain" : "text/plain";
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
    || type === "application/toml";
}
