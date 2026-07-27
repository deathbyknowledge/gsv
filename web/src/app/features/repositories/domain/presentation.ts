import type { TagTone } from "../../../components/ui/Tag";
import type {
  RepositoryCommit,
  RepositoryKind,
  RepositoryRefs,
  RepositorySummary,
  RepositoryTreeEntry,
} from "./models";

export type RepositoryPathCrumb = {
  label: string;
  path: string;
};

export function chooseInitialRepository(repos: readonly RepositorySummary[]): string | null {
  return repos.find((repo) => repo.writable)?.repo ?? repos[0]?.repo ?? null;
}

export function repoKindLabel(kind: RepositoryKind, rawKind = ""): string {
  if (kind === "home") return "HOME";
  if (kind === "package") return "PACKAGE";
  if (kind === "workspace") return "WORKSPACE";
  if (kind === "user") return "USER";
  return rawKind ? rawKind.toUpperCase() : "REPO";
}

export function repoKindTone(kind: RepositoryKind): TagTone {
  if (kind === "home") return "online";
  if (kind === "package") return "accent";
  if (kind === "workspace") return "info";
  if (kind === "user") return "idle";
  return "idle";
}

export function formatRepositoryOption(repo: RepositorySummary): string {
  return `${repo.owner}/${repo.name} · ${repoKindLabel(repo.kind, repo.rawKind)} · ${repo.public ? "PUBLIC" : "PRIVATE"}`;
}

export function repositoryDescription(repo: RepositorySummary): string {
  if (repo.description?.trim()) {
    return repo.description.trim();
  }
  if (repo.sources.length > 1) {
    const names = repo.sources.slice(0, 3).map((source) => source.name || source.packageId || source.subdir).join(", ");
    const more = repo.sources.length > 3 ? `, +${repo.sources.length - 3}` : "";
    return `Package source for ${names}${more}`;
  }
  const source = repo.sources[0];
  if (source) {
    return `Package source${source.name ? ` for ${source.name}` : ""}${source.subdir && source.subdir !== "." ? ` in ${source.subdir}` : ""}`;
  }
  return `${repo.public ? "Public" : "Private"} ripgit repository`;
}

export function initialRefForRepository(repo: RepositorySummary | null | undefined): string {
  return repo?.ref || repo?.baseRef || "main";
}

export function refsToOptions(refs: RepositoryRefs | null | undefined, activeRef: string): string[] {
  const options = new Set<string>();
  if (activeRef) {
    options.add(activeRef);
  }
  for (const head of Object.keys(refs?.heads ?? {}).sort((left, right) => left.localeCompare(right))) {
    options.add(head);
  }
  for (const tag of Object.keys(refs?.tags ?? {}).sort((left, right) => left.localeCompare(right))) {
    options.add(tag);
  }
  for (const remote of Object.keys(refs?.remotes ?? {}).sort((left, right) => left.localeCompare(right))) {
    options.add(`refs/remotes/${remote}`);
  }
  return [...options];
}

export function isLocalBranchRef(refs: RepositoryRefs | null | undefined, ref: string): boolean {
  return Boolean(ref && refs?.heads[ref]);
}

export function refHash(refs: RepositoryRefs | null | undefined, ref: string): string | null {
  if (!refs || !ref) {
    return null;
  }
  const remoteRef = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
  return refs.heads[ref] ?? refs.tags[ref] ?? refs.remotes[remoteRef] ?? null;
}

export function normalizeRepoPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.trim().replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === ".." || part.includes("\0")) {
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function parentRepoPath(path: string): string {
  const normalized = normalizeRepoPath(path);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function pathBasename(path: string): string {
  const normalized = normalizeRepoPath(path);
  if (!normalized) {
    return "root";
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function buildRepoPathCrumbs(path: string): RepositoryPathCrumb[] {
  const normalized = normalizeRepoPath(path);
  const parts = normalized.split("/").filter(Boolean);
  const crumbs: RepositoryPathCrumb[] = [{ label: "ROOT", path: "" }];
  parts.forEach((part, index) => {
    crumbs.push({ label: part, path: parts.slice(0, index + 1).join("/") });
  });
  return crumbs;
}

export function sortTreeEntries(entries: readonly RepositoryTreeEntry[]): RepositoryTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === "tree") return -1;
      if (right.type === "tree") return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function shortHash(hash: string | null | undefined): string {
  const value = hash?.trim() ?? "";
  return value.length <= 10 ? value : value.slice(0, 10);
}

export function firstLine(value: string | null | undefined): string {
  return value?.split(/\r?\n/g)[0]?.trim() || "Untitled commit";
}

export function formatCommitAuthor(commit: RepositoryCommit): string {
  return commit.author || commit.committer || "unknown";
}

export function formatAge(value: number | null | undefined): string {
  if (!value) {
    return "";
  }
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function prefixForDiffLine(tag: "context" | "add" | "delete" | "binary"): string {
  if (tag === "add") return "+";
  if (tag === "delete") return "-";
  if (tag === "binary") return "!";
  return " ";
}

export function diffStatusLabel(status: "added" | "deleted" | "modified"): string {
  if (status === "added") return "ADDED";
  if (status === "deleted") return "DELETED";
  return "MODIFIED";
}

export function diffStatusTone(status: "added" | "deleted" | "modified"): TagTone {
  if (status === "added") return "online";
  if (status === "deleted") return "error";
  return "update";
}
