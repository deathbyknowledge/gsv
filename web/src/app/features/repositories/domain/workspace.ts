import type { RepositorySummary } from "./models";
import { pathBasename, shortHash } from "./presentation";

export type RepositoryBrowserTab = {
  id: string;
  kind: "browser";
  repo: string;
  ref: string;
  path: string;
  commandInput: string;
  commandInputKey: number;
  searchQuery: string;
};

export type RepositoryFileTab = {
  id: string;
  kind: "file";
  repo: string;
  ref: string;
  path: string;
};

export type RepositoryHistoryTab = {
  id: string;
  kind: "history";
  repo: string;
  ref: string;
  offset: number;
};

export type RepositoryCommitTab = {
  id: string;
  kind: "commit";
  repo: string;
  ref: string;
  commit: string;
};

export type RepositoryCompareTab = {
  id: string;
  kind: "compare";
  repo: string;
  ref: string;
  base: string;
  head: string;
};

export type RepositoryWorkspaceTab =
  | RepositoryBrowserTab
  | RepositoryFileTab
  | RepositoryHistoryTab
  | RepositoryCommitTab
  | RepositoryCompareTab;

export function browserTabId(repo: string, ref: string): string {
  return `repo-browser:${repo}:${ref}`;
}

export function fileTabId(repo: string, ref: string, path: string): string {
  return `repo-file:${repo}:${ref}:${path}`;
}

export function historyTabId(repo: string, ref: string): string {
  return `repo-history:${repo}:${ref}`;
}

export function commitTabId(repo: string, commit: string): string {
  return `repo-commit:${repo}:${commit}`;
}

export function compareTabId(repo: string, base: string, head: string): string {
  return `repo-compare:${repo}:${base}:${head}`;
}

export function createBrowserTab(repo: string, ref: string, path = ""): RepositoryBrowserTab {
  return {
    id: browserTabId(repo, ref),
    kind: "browser",
    repo,
    ref,
    path,
    commandInput: "",
    commandInputKey: 0,
    searchQuery: "",
  };
}

export function createFileTab(repo: string, ref: string, path: string): RepositoryFileTab {
  return {
    id: fileTabId(repo, ref, path),
    kind: "file",
    repo,
    ref,
    path,
  };
}

export function createHistoryTab(repo: string, ref: string): RepositoryHistoryTab {
  return {
    id: historyTabId(repo, ref),
    kind: "history",
    repo,
    ref,
    offset: 0,
  };
}

export function createCommitTab(repo: string, ref: string, commit: string): RepositoryCommitTab {
  return {
    id: commitTabId(repo, commit),
    kind: "commit",
    repo,
    ref,
    commit,
  };
}

export function createCompareTab(repo: string, ref: string, base: string, head: string): RepositoryCompareTab {
  return {
    id: compareTabId(repo, base, head),
    kind: "compare",
    repo,
    ref,
    base,
    head,
  };
}

export function tabLabel(tab: RepositoryWorkspaceTab, repo: RepositorySummary | null | undefined): string {
  if (tab.kind === "browser") {
    const basename = pathBasename(tab.path);
    return basename === "root" ? repo?.name || tab.repo : basename;
  }
  if (tab.kind === "file") {
    return pathBasename(tab.path);
  }
  if (tab.kind === "history") {
    return "HISTORY";
  }
  if (tab.kind === "commit") {
    return shortHash(tab.commit);
  }
  return `${shortHash(tab.base)}...${shortHash(tab.head)}`;
}
