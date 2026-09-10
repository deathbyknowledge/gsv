import { normalizeLibraryDbId, normalizeLibraryPath } from "../../../services/memory/libraryModel";
import { resolveLibraryLink } from "../../../services/memory/libraryLinks";
import type { MemoryPageRef } from "../shared/navigation";

export type MemoryLink = MemoryPageRef & { fragment: string };

export function resolveMemoryLink(href: string, page: MemoryPageRef): MemoryLink | null {
  const path = href.startsWith("#") ? page.path : resolveLibraryLink(href, page.db, page.path);
  if (!path) return null;
  try {
    const hash = href.indexOf("#");
    return { db: path.split("/")[0], path, fragment: hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1)) };
  } catch {
    return null;
  }
}

export function memoryLinkHref(link: MemoryLink): string {
  const query = new URLSearchParams({ db: link.db, path: link.path });
  return `/memory?${query}${link.fragment ? `#${encodeURIComponent(link.fragment)}` : ""}`;
}

/** Real page URLs let copied links and new tabs open the same Memory page. */
export function memoryLinkFromUrl(url: URL): MemoryLink | null {
  try {
    const db = normalizeLibraryDbId(url.searchParams.get("db"));
    const path = normalizeLibraryPath(url.searchParams.get("path"));
    if (!path.startsWith(`${db}/`)) return null;
    return { db, path, fragment: decodeURIComponent(url.hash.slice(1)) };
  } catch {
    return null;
  }
}
