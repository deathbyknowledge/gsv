export type PreviewDirectoryEntry = {
  name: string;
  kind: "directory" | "file";
};

type PreviewBase = {
  title: string;
  sourceLabel: string;
  target: string;
  path: string;
  contentType?: string;
  size?: number;
};

export type PreviewWindowContent =
  | (PreviewBase & { kind: "text"; text: string })
  | (PreviewBase & { kind: "html"; text: string })
  | (PreviewBase & { kind: "blob"; bytes: Uint8Array; contentType: string })
  | (PreviewBase & { kind: "directory"; entries: PreviewDirectoryEntry[] })
  | (PreviewBase & { kind: "binary"; contentType: string });

export function mountPreviewWindow(container: HTMLElement, preview: PreviewWindowContent): () => void {
  const objectUrls: string[] = [];
  container.classList.add("window-content-full-bleed");
  container.replaceChildren();

  const root = document.createElement("main");
  root.className = "preview-window";
  root.dataset.previewKind = preview.kind;
  root.dataset.source = preview.sourceLabel;
  root.dataset.target = preview.target;
  root.dataset.path = preview.path;
  if (preview.contentType) {
    root.dataset.contentType = preview.contentType;
  }
  if (typeof preview.size === "number") {
    root.dataset.size = String(preview.size);
  }

  const stage = document.createElement("section");
  stage.className = "preview-stage";

  if (preview.kind === "text") {
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = preview.text;
    stage.append(pre);
  } else if (preview.kind === "html") {
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.title = preview.title || basename(preview.path) || "HTML preview";
    iframe.sandbox.add("allow-forms", "allow-popups", "allow-scripts");
    iframe.srcdoc = preview.text;
    stage.append(iframe);
  } else if (preview.kind === "directory") {
    stage.append(renderDirectoryPreview(preview.entries));
  } else if (preview.kind === "blob") {
    const bytes = new Uint8Array(preview.bytes.byteLength);
    bytes.set(preview.bytes);
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: preview.contentType }));
    objectUrls.push(url);
    stage.append(renderBlobPreview(preview, url));
  } else {
    stage.append(renderBinaryFallback(preview.contentType, preview.size));
  }

  root.append(stage);
  container.append(root);

  return () => {
    for (const url of objectUrls) {
      URL.revokeObjectURL(url);
    }
    container.classList.remove("window-content-full-bleed");
    container.replaceChildren();
  };
}

function renderDirectoryPreview(entries: PreviewDirectoryEntry[]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "preview-directory";

  const list = document.createElement("div");
  list.className = "preview-directory-list";
  for (const entry of entries) {
    const row = document.createElement("span");
    row.dataset.kind = entry.kind;
    row.textContent = entry.kind === "directory" ? `/${entry.name}` : entry.name;
    list.append(row);
  }

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "Empty directory";
    wrapper.append(empty);
  } else {
    wrapper.append(list);
  }
  return wrapper;
}

function renderBlobPreview(preview: Extract<PreviewWindowContent, { kind: "blob" }>, url: string): HTMLElement {
  if (preview.contentType === "application/pdf") {
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.title = preview.title || basename(preview.path) || "PDF";
    iframe.src = url;
    return iframe;
  }

  if (preview.contentType.startsWith("image/")) {
    const wrapper = document.createElement("div");
    wrapper.className = "preview-image-wrap";
    const image = document.createElement("img");
    image.src = url;
    image.alt = preview.title || preview.path;
    wrapper.append(image);
    return wrapper;
  }

  if (preview.contentType.startsWith("video/")) {
    const wrapper = document.createElement("div");
    wrapper.className = "preview-media-wrap";
    const video = document.createElement("video");
    video.controls = true;
    video.src = url;
    wrapper.append(video);
    return wrapper;
  }

  if (preview.contentType.startsWith("audio/")) {
    const wrapper = document.createElement("div");
    wrapper.className = "preview-audio-wrap";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = url;
    wrapper.append(audio);
    return wrapper;
  }

  return renderBinaryFallback(preview.contentType, preview.size);
}

function renderBinaryFallback(contentType: string, size?: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "preview-binary-fallback";

  const title = document.createElement("strong");
  title.textContent = "No preview available";

  const detail = document.createElement("span");
  detail.textContent = typeof size === "number" ? `${formatSize(size)} binary file` : "Binary file";

  const type = document.createElement("code");
  type.textContent = contentType || "application/octet-stream";

  wrapper.append(title, detail, type);
  return wrapper;
}

function basename(path: string): string {
  const clean = String(path ?? "").replace(/\/+$/, "");
  const index = clean.lastIndexOf("/");
  return index >= 0 ? clean.slice(index + 1) : clean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
