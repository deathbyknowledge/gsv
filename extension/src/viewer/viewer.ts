import "./viewer.css";
import { basename, normalizePath } from "../shared/paths";
import { bytesFromStoredContent, getPersistedEntry, openFsDatabase } from "../target/fs-persistence";

type ViewerState = {
  path: string;
  label: string;
  mime: string;
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}

void renderViewer(app).catch((error) => {
  app.innerHTML = renderError(error instanceof Error ? error.message : String(error));
});

async function renderViewer(root: HTMLElement): Promise<void> {
  const state = parseState();
  document.title = basename(state.label || state.path);
  root.innerHTML = renderShell();
  const stage = root.querySelector<HTMLElement>("[data-stage]");
  if (!stage) {
    throw new Error("Missing viewer stage");
  }

  const bytes = await readPersistedFile(state.path);
  const contentType = state.mime || inferContentType(state.path);
  const blob = new Blob([bytesToArrayBuffer(bytes)], { type: contentType });
  const objectUrl = URL.createObjectURL(blob);

  window.addEventListener("pagehide", () => URL.revokeObjectURL(objectUrl), { once: true });
  stage.classList.add(`stage--${viewerKind(contentType)}`);
  stage.replaceChildren(renderContent({
    objectUrl,
    bytes,
    contentType,
    path: state.path,
  }));
}

function parseState(): ViewerState {
  const params = new URLSearchParams(window.location.search);
  const path = normalizePath(params.get("path") ?? "");
  if (!path || path === "/") {
    throw new Error("Missing file path");
  }
  return {
    path,
    label: params.get("label") || path,
    mime: params.get("mime") || inferContentType(path),
  };
}

async function readPersistedFile(path: string): Promise<Uint8Array> {
  const db = await openFsDatabase();
  try {
    const entry = await getPersistedEntry(db, path);
    if (!entry) {
      throw new Error(`No such file: ${path}`);
    }
    if (entry.kind === "directory") {
      throw new Error(`Is a directory: ${path}`);
    }
    return bytesFromStoredContent(entry.content);
  } finally {
    db.close();
  }
}

function renderShell(): string {
  return `
    <main class="viewer">
      <section class="stage" data-stage>
        <p class="loading">Loading...</p>
      </section>
    </main>
  `;
}

function renderContent(options: {
  objectUrl: string;
  bytes: Uint8Array;
  contentType: string;
  path: string;
}): HTMLElement {
  const type = normalizeContentType(options.contentType);
  if (type.startsWith("image/")) {
    const image = document.createElement("img");
    image.className = "media media--image";
    image.src = options.objectUrl;
    image.alt = basename(options.path);
    return image;
  }
  if (type.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.className = "media media--audio";
    audio.src = options.objectUrl;
    audio.controls = true;
    return audio;
  }
  if (type.startsWith("video/")) {
    const video = document.createElement("video");
    video.className = "media media--video";
    video.src = options.objectUrl;
    video.controls = true;
    video.playsInline = true;
    return video;
  }
  if (type === "text/html" || type === "application/pdf") {
    const frame = document.createElement("iframe");
    frame.className = "frame";
    frame.src = options.objectUrl;
    if (type === "text/html") {
      frame.sandbox.add("allow-downloads", "allow-forms", "allow-modals", "allow-popups", "allow-scripts");
    }
    return frame;
  }
  if (isTextContentType(type)) {
    const pre = document.createElement("pre");
    pre.className = "text";
    pre.textContent = new TextDecoder().decode(options.bytes);
    return pre;
  }

  const fallback = document.createElement("div");
  fallback.className = "fallback";
  const link = document.createElement("a");
  link.href = options.objectUrl;
  link.download = basename(options.path);
  link.textContent = `Open ${basename(options.path)}`;
  fallback.append(link);
  const meta = document.createElement("p");
  meta.textContent = `${options.contentType || "application/octet-stream"} / ${formatSize(options.bytes.byteLength)}`;
  fallback.append(meta);
  return fallback;
}

function renderError(message: string): string {
  document.title = "Could not open file";
  return `
    <main class="viewer">
      <section class="stage">
        <div class="error">
          <span>GSV Viewer</span>
          <strong>Could not open file</strong>
          <p>${escapeHtml(message)}</p>
        </div>
      </section>
    </main>
  `;
}

function viewerKind(contentType: string): string {
  const type = normalizeContentType(contentType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "text/html" || type === "application/pdf") return "frame";
  if (isTextContentType(type)) return "text";
  return "fallback";
}

function inferContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".ts")) return "text/javascript";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function isTextContentType(type: string): boolean {
  return type.startsWith("text/")
    || type === "application/json"
    || type.endsWith("+json")
    || type === "application/javascript"
    || type === "application/x-javascript"
    || type === "image/svg+xml";
}

function normalizeContentType(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
