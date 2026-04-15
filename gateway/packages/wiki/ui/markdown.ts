import type { WikiPreviewPayload, WikiPreviewRequest } from "./types";

type MarkedGlobal = {
  parse(markdown: string, options?: Record<string, unknown>): string;
};

type DomPurifyGlobal = {
  sanitize(html: string): string;
};

type RenderOptions = {
  markdown: string;
  articleTitle: string;
  routeBase: string;
  selectedDb: string;
  selectedPath: string;
  onNavigate(path: string): void;
  onPreviewOpen(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void;
  onPreviewHide(force: boolean): void;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizePath(value: unknown): string {
  return String(value ?? "").trim().replace(/^\/+/, "").replace(/\/+$/g, "").replace(/\/+/, "/").replace(/\/{2,}/g, "/");
}

export function normalizeDbScopedPath(value: unknown, db: string): string {
  const path = normalizePath(value);
  if (!path) {
    return "";
  }
  if (db && (path === "index.md" || path.startsWith("pages/") || path.startsWith("inbox/"))) {
    return `${db}/${path}`;
  }
  return path;
}

export function buildEntryHref(routeBase: string, db: string, path: string): string {
  const href = new URL(routeBase, window.location.origin);
  const effectiveDb = db || (path && path.includes("/") ? String(path).split("/")[0] : "");
  if (effectiveDb) {
    href.searchParams.set("db", effectiveDb);
  }
  if (path) {
    href.searchParams.set("path", path);
  }
  return href.pathname + href.search;
}

export function stripFrontmatter(markdown: string): string {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return text;
  }
  return text.slice(end + 5);
}

export function extractTitle(markdown: string, fallback: string): string {
  const text = stripFrontmatter(markdown);
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

export function slugifyHeading(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}

export function extractHeadings(markdown: string): Array<{ level: number; text: string; id: string }> {
  return stripFrontmatter(markdown)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^(#{2,4})\s+(.+)$/);
      if (!match) {
        return [];
      }
      const text = match[2].trim();
      return [{ level: match[1].length, text, id: slugifyHeading(text) }];
    });
}

export function prepareArticleMarkdown(markdown: string, articleTitle: string): string {
  const text = stripFrontmatter(markdown).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let offset = 0;
  while (offset < lines.length && !lines[offset].trim()) {
    offset += 1;
  }
  const firstLine = lines[offset] ?? "";
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (headingMatch?.[1]?.trim() === articleTitle) {
    offset += 1;
    while (offset < lines.length && !lines[offset].trim()) {
      offset += 1;
    }
  }
  return lines.slice(offset).join("\n").trim();
}

function parseRenderedSourceRef(value: string): { target: string; path: string; title: string } | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^\[([^\]]+)\]\s+(.+?)(?:\s+\|\s+(.+))?$/);
  if (!match) {
    return null;
  }
  return {
    target: match[1].trim(),
    path: match[2].trim(),
    title: match[3]?.trim() || "",
  };
}

function resolveRelativeWikiPath(rawHref: string, selectedPath: string): string | null {
  const href = String(rawHref ?? "").trim();
  if (!href || !selectedPath) {
    return null;
  }
  const cleanHref = href.split("#")[0]?.split("?")[0]?.trim() || "";
  if (!cleanHref || cleanHref.startsWith("/")) {
    return null;
  }
  const basePath = normalizePath(selectedPath);
  if (!basePath) {
    return null;
  }
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "";
  const resolved = new URL(cleanHref, `https://wiki.local/${baseDir}`).pathname.replace(/^\/+/, "");
  return resolved ? normalizePath(resolved) : null;
}

function resolveInternalPath(rawHref: string, selectedDb: string, selectedPath: string): string | null {
  const href = String(rawHref ?? "").trim();
  if (!href || /^(https?:|mailto:|#)/i.test(href) || /^[a-z0-9._-]+:\/\//i.test(href)) {
    return null;
  }
  const trimmedHref = href.replace(/^\.\//, "");
  if (/^[a-z0-9._-]+\/(pages|inbox)\//i.test(trimmedHref) || /^[a-z0-9._-]+\/index\.md$/i.test(trimmedHref)) {
    return normalizePath(trimmedHref);
  }
  if (selectedDb && (trimmedHref === "index.md" || trimmedHref.startsWith("pages/") || trimmedHref.startsWith("inbox/"))) {
    return normalizeDbScopedPath(trimmedHref, selectedDb);
  }
  if (/^(\.\.\/|\.\/|[^/]+\.md(?:[#?].*)?$)/i.test(href)) {
    return resolveRelativeWikiPath(href, selectedPath);
  }
  return null;
}

function getMarked(): MarkedGlobal | null {
  const value = (window as typeof window & { marked?: MarkedGlobal }).marked;
  return value && typeof value.parse === "function" ? value : null;
}

function getPurifier(): DomPurifyGlobal | null {
  const value = (window as typeof window & { DOMPurify?: DomPurifyGlobal }).DOMPurify;
  return value && typeof value.sanitize === "function" ? value : null;
}

function renderMarkdownHtml(markdown: string): string {
  const markedApi = getMarked();
  const purifier = getPurifier();
  if (!markedApi || !purifier) {
    return `<pre><code>${escapeHtml(markdown)}</code></pre>`;
  }
  const parsed = markedApi.parse(markdown, { async: false, breaks: true, gfm: true });
  return purifier.sanitize(typeof parsed === "string" ? parsed : String(parsed));
}


export function renderPreviewBodyHtml(payload: WikiPreviewPayload): string {
  if (!payload || payload.ok === false) {
    return `<div class="preview-empty">${escapeHtml(payload?.error || "Preview unavailable.")}</div>`;
  }
  if (payload.kind === "page") {
    const markdown = String(payload.markdown || "").trim();
    return markdown ? renderMarkdownHtml(markdown) : '<div class="preview-empty">This page has no previewable body yet.</div>';
  }
  if (payload.mode === "image" && payload.image?.data && payload.image?.mimeType) {
    const text = payload.text ? `<p>${escapeHtml(payload.text)}</p>` : "";
    return `${text}<img src="data:${payload.image.mimeType};base64,${payload.image.data}" alt="${escapeHtml(payload.title || payload.path)}" />`;
  }
  if (payload.mode === "directory") {
    const directories = Array.isArray(payload.directories) ? payload.directories : [];
    const files = Array.isArray(payload.files) ? payload.files : [];
    const dirsHtml = directories.length > 0
      ? `<p><strong>Directories</strong></p><ul>${directories.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";
    const filesHtml = files.length > 0
      ? `<p><strong>Files</strong></p><ul>${files.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";
    return dirsHtml + filesHtml;
  }
  const text = String(payload.text || "").trim();
  if (!text) {
    return '<div class="preview-empty">No previewable content.</div>';
  }
  if (payload.mode === "markdown" || /\.(md|markdown|mdown|mkd)$/i.test(payload.path)) {
    return renderMarkdownHtml(text);
  }
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

export function renderArticleInto(container: HTMLElement, options: RenderOptions): () => void {
  const articleMarkdown = prepareArticleMarkdown(options.markdown, options.articleTitle);
  container.innerHTML = articleMarkdown ? renderMarkdownHtml(articleMarkdown) : "";
  const cleanups: Array<() => void> = [];
  const seenHeadingIds = new Map<string, number>();

  container.querySelectorAll("h2, h3, h4, h5, h6").forEach((node) => {
    const base = slugifyHeading(node.textContent || "");
    const count = seenHeadingIds.get(base) || 0;
    seenHeadingIds.set(base, count + 1);
    node.id = count === 0 ? base : `${base}-${count + 1}`;
  });

  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const internalPath = resolveInternalPath(href, options.selectedDb, options.selectedPath);
    if (internalPath) {
      anchor.href = buildEntryHref(options.routeBase, options.selectedDb, internalPath);
      anchor.dataset.previewKind = "page";
      const onClick = (event: MouseEvent) => {
        event.preventDefault();
        options.onNavigate(internalPath);
      };
      const onEnter = () => options.onPreviewOpen(anchor, { kind: "page", db: options.selectedDb, path: internalPath }, false);
      const onLeave = () => options.onPreviewHide(false);
      const onFocus = () => options.onPreviewOpen(anchor, { kind: "page", db: options.selectedDb, path: internalPath }, false);
      const onBlur = () => options.onPreviewHide(false);
      anchor.addEventListener("click", onClick);
      anchor.addEventListener("mouseenter", onEnter);
      anchor.addEventListener("mouseleave", onLeave);
      anchor.addEventListener("focus", onFocus);
      anchor.addEventListener("blur", onBlur);
      cleanups.push(() => {
        anchor.removeEventListener("click", onClick);
        anchor.removeEventListener("mouseenter", onEnter);
        anchor.removeEventListener("mouseleave", onLeave);
        anchor.removeEventListener("focus", onFocus);
        anchor.removeEventListener("blur", onBlur);
      });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
    }
  });

  container.querySelectorAll("h2, h3, h4, h5, h6").forEach((heading) => {
    if ((heading.textContent || "").trim().toLowerCase() !== "sources") {
      return;
    }
    let sibling = heading.nextElementSibling;
    while (sibling && !/^H[2-6]$/.test(sibling.tagName)) {
      if (sibling.tagName === "UL" || sibling.tagName === "OL") {
        sibling.querySelectorAll("li").forEach((item) => {
          const parsedSource = parseRenderedSourceRef(item.textContent || "");
          if (!parsedSource) {
            return;
          }
          const label = parsedSource.title || parsedSource.path.split("/").pop() || parsedSource.path;
          item.innerHTML = `<div class="source-ref"><div class="source-ref-head"><a href="#" class="wiki-source-link">${escapeHtml(label)}</a><span class="source-ref-target">${escapeHtml(parsedSource.target)}</span></div><div class="source-ref-path">${escapeHtml(parsedSource.path)}</div></div>`;
          const link = item.querySelector<HTMLAnchorElement>(".wiki-source-link");
          if (!link) {
            return;
          }
          const request: WikiPreviewRequest = {
            kind: "source",
            target: parsedSource.target,
            path: parsedSource.path,
            title: label,
          };
          link.dataset.previewKind = "source";
          const onClick = (event: MouseEvent) => {
            event.preventDefault();
            options.onPreviewOpen(link, request, true);
          };
          const onEnter = () => options.onPreviewOpen(link, request, false);
          const onLeave = () => options.onPreviewHide(false);
          const onFocus = () => options.onPreviewOpen(link, request, false);
          const onBlur = () => options.onPreviewHide(false);
          link.addEventListener("click", onClick);
          link.addEventListener("mouseenter", onEnter);
          link.addEventListener("mouseleave", onLeave);
          link.addEventListener("focus", onFocus);
          link.addEventListener("blur", onBlur);
          cleanups.push(() => {
            link.removeEventListener("click", onClick);
            link.removeEventListener("mouseenter", onEnter);
            link.removeEventListener("mouseleave", onLeave);
            link.removeEventListener("focus", onFocus);
            link.removeEventListener("blur", onBlur);
          });
        });
      }
      sibling = sibling.nextElementSibling;
    }
  });

  return () => {
    cleanups.forEach((cleanup) => cleanup());
    container.innerHTML = "";
  };
}
