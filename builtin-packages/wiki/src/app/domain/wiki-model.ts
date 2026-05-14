import { normalizePath } from "../markdown";

export function resolveTarget(mode: "gsv" | "custom", custom: string): string {
  return mode === "custom" ? (custom.trim() || "gsv") : "gsv";
}

export function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function displayTitleFromPath(path: string): string {
  const name = String(path || "").split("/").pop() || path || "Untitled";
  return name.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

export function slugifyDbId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

export function suggestPagePath(db: string, title: string, currentPath?: string): string {
  const slug = slugifyDbId(title || "new-page") || "new-page";
  const normalizedCurrent = normalizePath(currentPath || "");
  if (normalizedCurrent.includes("/pages/")) {
    const prefix = normalizedCurrent.slice(0, normalizedCurrent.lastIndexOf("/") + 1);
    return `${prefix}${slug}.md`;
  }
  return `${db}/pages/${slug}.md`;
}
