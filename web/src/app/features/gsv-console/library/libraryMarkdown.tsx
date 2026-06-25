import DOMPurify from "dompurify";
import { parse as parseMarkdown } from "marked";
import { useEffect, useRef } from "preact/hooks";
import {
  normalizeDbScopedLibraryPath,
  normalizeLibraryPath,
  prepareLibraryArticleMarkdown,
} from "./libraryModel";
import type {
  LibraryNote,
  LibraryPreviewPayload,
  LibraryPreviewRequest,
} from "./libraryTypes";

type MarkdownViewProps = {
  note: LibraryNote;
  selectedDb: string;
  onOpenPage: (path: string) => void;
  onPreviewClose: (force: boolean) => void;
  onPreviewOpen: (anchor: HTMLElement, request: LibraryPreviewRequest, pin: boolean) => void;
};

export function LibraryMarkdownView({
  note,
  onOpenPage,
  onPreviewClose,
  onPreviewOpen,
  selectedDb,
}: MarkdownViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    return renderArticleInto(node, {
      markdown: note.markdown,
      noteTitle: note.title,
      selectedDb,
      selectedPath: note.path,
      onNavigate: onOpenPage,
      onPreviewClose,
      onPreviewOpen,
    });
  }, [note.markdown, note.path, note.title, onOpenPage, onPreviewClose, onPreviewOpen, selectedDb]);

  return <div class="gsv-library-markdown" ref={ref} />;
}

type RenderOptions = {
  markdown: string;
  noteTitle: string;
  selectedDb: string;
  selectedPath: string;
  onNavigate(path: string): void;
  onPreviewClose(force: boolean): void;
  onPreviewOpen(anchor: HTMLElement, request: LibraryPreviewRequest, pin: boolean): void;
};

export function renderPreviewBodyHtml(payload: LibraryPreviewPayload): string {
  if (!payload) {
    return '<div class="gsv-library-preview-empty">Preview unavailable.</div>';
  }
  if (payload.ok === false) {
    return `<div class="gsv-library-preview-empty">${escapeHtml(payload.error || "Preview unavailable.")}</div>`;
  }
  if (payload.kind === "page") {
    const article = prepareLibraryArticleMarkdown({
      path: payload.path,
      title: payload.title,
      markdown: payload.markdown,
    });
    return article ? renderMarkdownHtml(article) : '<div class="gsv-library-preview-empty">This page has no previewable body yet.</div>';
  }
  if (payload.mode === "image" && payload.image?.data && payload.image.mimeType) {
    const text = payload.text ? `<p>${escapeHtml(payload.text)}</p>` : "";
    return `${text}<img src="data:${payload.image.mimeType};base64,${payload.image.data}" alt="${escapeHtml(payload.title || payload.path)}" />`;
  }
  if (payload.mode === "directory") {
    const directories = payload.directories ?? [];
    const files = payload.files ?? [];
    const dirsHtml = directories.length > 0
      ? `<p><strong>Directories</strong></p><ul>${directories.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";
    const filesHtml = files.length > 0
      ? `<p><strong>Files</strong></p><ul>${files.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";
    return dirsHtml + filesHtml || '<div class="gsv-library-preview-empty">Directory is empty.</div>';
  }
  const text = String(payload.text || "").trim();
  if (!text) {
    return '<div class="gsv-library-preview-empty">No previewable content.</div>';
  }
  if (payload.mode === "markdown" || /\.(md|markdown|mdown|mkd)$/i.test(payload.path)) {
    return renderMarkdownHtml(text);
  }
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function renderArticleInto(container: HTMLElement, options: RenderOptions): () => void {
  const article = prepareLibraryArticleMarkdown({
    path: options.selectedPath,
    title: options.noteTitle,
    markdown: options.markdown,
  });
  container.innerHTML = article ? renderMarkdownHtml(article) : '<div class="gsv-library-empty-copy">This page has no body yet.</div>';
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
    const internalPath = resolveLibraryLink(href, options.selectedDb, options.selectedPath);
    if (internalPath) {
      anchor.href = "#";
      anchor.dataset.previewKind = "page";
      const request: LibraryPreviewRequest = { kind: "page", db: options.selectedDb, path: internalPath };
      const onClick = (event: MouseEvent) => {
        event.preventDefault();
        options.onPreviewClose(true);
        options.onNavigate(internalPath);
      };
      const onEnter = () => options.onPreviewOpen(anchor, request, false);
      const onLeave = () => options.onPreviewClose(false);
      const onFocus = () => options.onPreviewOpen(anchor, request, false);
      const onBlur = () => options.onPreviewClose(false);
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

  wireSourceRefs(container, options, cleanups);

  return () => {
    cleanups.forEach((cleanup) => cleanup());
    container.innerHTML = "";
  };
}

function wireSourceRefs(
  container: HTMLElement,
  options: RenderOptions,
  cleanups: Array<() => void>,
): void {
  container.querySelectorAll("h2, h3, h4, h5, h6").forEach((heading) => {
    if ((heading.textContent || "").trim().toLowerCase() !== "sources") {
      return;
    }
    let sibling = heading.nextElementSibling;
    while (sibling && !/^H[2-6]$/.test(sibling.tagName)) {
      if (sibling.tagName === "UL" || sibling.tagName === "OL") {
        sibling.querySelectorAll("li").forEach((item) => {
          const parsed = parseRenderedSourceRef(item.textContent || "");
          if (!parsed) {
            return;
          }
          const label = parsed.title || parsed.path.split("/").pop() || parsed.path;
          const sourceLabel = escapeHtml(label);
          const sourceTarget = escapeHtml(parsed.target);
          const sourcePath = escapeHtml(parsed.path);
          item.innerHTML = `<div class="gsv-library-source-ref"><div class="gsv-library-source-ref-head"><a href="#" class="gsv-library-source-link" title="${sourceLabel}">${sourceLabel}</a><span>${sourceTarget}</span></div><div title="${sourcePath}">${sourcePath}</div></div>`;
          const link = item.querySelector<HTMLAnchorElement>(".gsv-library-source-link");
          if (!link) {
            return;
          }
          const request: LibraryPreviewRequest = {
            kind: "source",
            target: parsed.target,
            path: parsed.path,
            title: label,
          };
          const onClick = (event: MouseEvent) => {
            event.preventDefault();
            options.onPreviewOpen(link, request, true);
          };
          const onEnter = () => options.onPreviewOpen(link, request, false);
          const onLeave = () => options.onPreviewClose(false);
          const onFocus = () => options.onPreviewOpen(link, request, false);
          const onBlur = () => options.onPreviewClose(false);
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
}

function renderMarkdownHtml(markdown: string): string {
  const parsed = parseMarkdown(markdown, { async: false, breaks: true, gfm: true });
  return DOMPurify.sanitize(typeof parsed === "string" ? parsed : String(parsed));
}

function resolveLibraryLink(rawHref: string, selectedDb: string, selectedPath: string): string | null {
  const href = rawHref.trim();
  if (!href || /^(https?:|mailto:|#)/i.test(href) || /^[a-z0-9._-]+:\/\//i.test(href)) {
    return null;
  }
  const cleanHref = href.split("#")[0]?.split("?")[0]?.trim() || "";
  if (!cleanHref) {
    return null;
  }
  const trimmedHref = cleanHref.replace(/^\.\//, "");

  if (selectedDb && (trimmedHref === `${selectedDb}/index.md` || trimmedHref.startsWith(`${selectedDb}/pages/`))) {
    return normalizeLibraryPath(trimmedHref);
  }
  if (selectedDb && (trimmedHref === "index.md" || trimmedHref.startsWith("pages/"))) {
    return normalizeDbScopedLibraryPath(trimmedHref, selectedDb);
  }
  if (/^[a-z0-9._-]+\/(index\.md|pages\/)/i.test(trimmedHref)) {
    return normalizeLibraryPath(trimmedHref);
  }
  if (selectedPath && !cleanHref.startsWith("/")) {
    const basePath = normalizeLibraryPath(selectedPath);
    const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "";
    const resolved = new URL(cleanHref, `https://library.local/${baseDir}`).pathname.replace(/^\/+/, "");
    return resolved ? normalizeLibraryPath(resolved) : null;
  }
  return null;
}

function parseRenderedSourceRef(value: string): { target: string; path: string; title: string } | null {
  const text = value.trim();
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

function slugifyHeading(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
