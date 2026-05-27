import type { SourceDiffFile, SourceMode, SourceRepoKind, SourceRepoRecord, SourceTreeEntry } from "./types";

export function repoKindLabel(kind: SourceRepoKind): string {
  if (kind === "home") return "Home";
  if (kind === "multi-package") return "Multi-package";
  if (kind === "package") return "Package";
  return "General";
}

export function repoKindTone(kind: SourceRepoKind): "is-home" | "is-package" | "is-user" {
  if (kind === "home") return "is-home";
  if (kind === "package" || kind === "multi-package") return "is-package";
  return "is-user";
}

export function repoDescription(repo: SourceRepoRecord): string {
  if (repo.description && repo.kind !== "package" && repo.kind !== "multi-package") {
    return repo.description;
  }
  if (repo.linkedPackages.length > 1) {
    const names = repo.linkedPackages.slice(0, 3).map((pkg) => pkg.name).join(", ");
    const more = repo.linkedPackages.length > 3 ? `, +${repo.linkedPackages.length - 3}` : "";
    return `${repo.linkedPackages.length} packages: ${names}${more}`;
  }
  if (repo.linkedPackages.length === 1) {
    return repo.linkedPackages[0].name;
  }
  return repo.description || "No description";
}

export function sourceModeLabel(mode: SourceMode): string {
  return mode === "history" ? "History" : "Code";
}

export function repoMatchesQuery(repo: SourceRepoRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    repo.repo,
    repo.owner,
    repo.name,
    repo.description ?? "",
    repoKindLabel(repo.kind),
    ...repo.linkedPackages.map((pkg) => pkg.name),
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function compareRepos(left: SourceRepoRecord, right: SourceRepoRecord): number {
  const owner = left.owner.localeCompare(right.owner);
  if (owner !== 0) return owner;
  return left.name.localeCompare(right.name);
}

export function visibleRepos(repos: SourceRepoRecord[], query: string): SourceRepoRecord[] {
  return repos.filter((repo) => repoMatchesQuery(repo, query)).sort(compareRepos);
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, ...rest] = repo.split("/").filter(Boolean);
  return {
    owner: owner || "unknown",
    name: rest.join("/") || repo || "unknown",
  };
}

export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export function sortTreeEntries(entries: SourceTreeEntry[]): SourceTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "tree" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function fileLanguageLabel(path: string): string {
  if (/\.(ts|tsx)$/.test(path)) return "TypeScript";
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return "JavaScript";
  if (/\.css$/.test(path)) return "CSS";
  if (/\.json$/.test(path)) return "JSON";
  if (/\.(md|mdx)$/.test(path)) return "Markdown";
  if (/\.(rs)$/.test(path)) return "Rust";
  if (/\.(toml)$/.test(path)) return "TOML";
  if (/\.(yml|yaml)$/.test(path)) return "YAML";
  return "Text";
}

export function diffStatusLabel(status: SourceDiffFile["status"]): string {
  if (status === "added") return "Added";
  if (status === "deleted") return "Deleted";
  return "Modified";
}

export function diffStatusTone(status: SourceDiffFile["status"]): "is-added" | "is-deleted" | "is-modified" {
  if (status === "added") return "is-added";
  if (status === "deleted") return "is-deleted";
  return "is-modified";
}

export function prefixForDiffLine(tag: string): string {
  if (tag === "add") return "+";
  if (tag === "delete") return "-";
  if (tag === "binary") return "#";
  return " ";
}

export function highlightLine(path: string, content: string): Array<{ text: string; className: string }> {
  const language = languageForPath(path);
  if (language === "plain" || content.trim().length === 0) {
    return [{ text: content, className: "" }];
  }
  const pattern = language === "css"
    ? /(\/\*.*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|#[a-fA-F0-9]{3,8}\b|\b(?:@media|@supports|display|grid|flex|color|background|border|padding|margin|font|width|height|min|max|gap|content)\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?\b)/g
    : /(\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\b(?:import|export|from|type|const|let|var|function|return|if|else|for|while|class|extends|async|await|try|catch|throw|new|true|false|null|undefined)\b|-?\b\d+(?:\.\d+)?\b)/g;
  const tokens: Array<{ text: string; className: string }> = [];
  let index = 0;
  for (const match of content.matchAll(pattern)) {
    const text = match[0];
    const start = match.index ?? 0;
    if (start > index) {
      tokens.push({ text: content.slice(index, start), className: "" });
    }
    tokens.push({ text, className: tokenClass(text) });
    index = start + text.length;
  }
  if (index < content.length) {
    tokens.push({ text: content.slice(index), className: "" });
  }
  return tokens;
}

function languageForPath(path: string): "js" | "css" | "plain" {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(path)) return "js";
  if (/\.(css|scss|less)$/.test(path)) return "css";
  return "plain";
}

function tokenClass(token: string): string {
  if (/^(\/\/|\/\*)/.test(token)) return "tok-comment";
  if (/^["'`]/.test(token)) return "tok-string";
  if (/^-?\d/.test(token) || /^#[a-fA-F0-9]/.test(token)) return "tok-number";
  return "tok-keyword";
}
