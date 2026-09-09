import { normalizeLibraryPath } from "./libraryModel";

/** Resolve a wiki reference within its repository, independently of the site's URL. */
export function resolveLibraryLink(rawHref: string, selectedDb: string, selectedPath: string): string | null {
  const href = rawHref.trim();
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return null;
  try {
    const path = decodeURIComponent(href.split(/[?#]/)[0]);
    if (!path || /[\\\x00-\x1f]/.test(path)) return null;
    const trimmed = path.replace(/^\.\//, "").replace(/^\//, "");
    let scoped: string;
    if (/^[a-z0-9._-]+\/(?:index\.md$|pages\/)/i.test(trimmed)) {
      scoped = trimmed;
    } else if (trimmed === "index.md" || trimmed.startsWith("pages/")) {
      scoped = `${selectedDb}/${trimmed}`;
    } else {
      if (path.startsWith("/")) return null;
      const base = new URL(normalizeLibraryPath(selectedPath).split("/").map(encodeURIComponent).join("/"), "https://library.local/");
      scoped = decodeURIComponent(new URL(href, base).pathname.slice(1));
      if (!scoped.startsWith(`${selectedDb}/`)) return null;
    }
    return normalizeLibraryPath(scoped);
  } catch {
    return null;
  }
}

export function assignLibraryHeadingIds(container: HTMLElement): void {
  const seen = new Map<string, number>();
  container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const base = (heading.textContent || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${count + 1}`;
  });
}
