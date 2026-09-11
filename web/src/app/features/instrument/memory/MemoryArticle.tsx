import { useLayoutEffect, useRef } from "preact/hooks";
import type { LibraryNote } from "../../../services/memory/libraryTypes";
import { assignLibraryHeadingIds } from "../../../services/memory/libraryLinks";
import { renderMarkdownHtml } from "../shared/markdown";
import { memoryLinkFromUrl, memoryLinkHref, resolveMemoryLink, type MemoryLink } from "./memoryLinks";

function scrollToHeading(article: HTMLElement, fragment: string): void {
  const heading = fragment ? [...article.querySelectorAll<HTMLElement>("[id]")].find((node) => node.id === fragment) : null;
  if (heading) heading.scrollIntoView({ block: "start" });
  else article.closest(".page-content")?.scrollTo({ top: 0 });
}

export function MemoryArticle({ note, db, fragment, onOpen }: {
  note: LibraryNote;
  db: string;
  fragment: string;
  onOpen(link: MemoryLink): void;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const article = ref.current;
    if (!article) return;
    article.innerHTML = renderMarkdownHtml(note.markdown);
    assignLibraryHeadingIds(article);
    for (const anchor of article.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      const link = resolveMemoryLink(href, { db, path: note.path });
      if (link) {
        anchor.href = memoryLinkHref(link);
        anchor.dataset.memoryLink = "true";
      } else if (/^(?:https?:|\/\/)/i.test(href)) {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        anchor.removeAttribute("href");
        anchor.setAttribute("aria-disabled", "true");
        anchor.title = "This link does not point to a Memory page.";
      }
    }
  }, [db, note.path, note.markdown]);

  useLayoutEffect(() => {
    const article = ref.current;
    if (!article) return;
    scrollToHeading(article, fragment);
  }, [db, note.path, note.markdown, fragment]);

  return <article class="prose" ref={ref} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-memory-link]") : null;
    if (!anchor) return;
    const link = memoryLinkFromUrl(new URL(anchor.href));
    if (!link) return;
    event.preventDefault();
    if (link.db === db && link.path === note.path && ref.current) scrollToHeading(ref.current, link.fragment);
    onOpen(link);
  }} />;
}
