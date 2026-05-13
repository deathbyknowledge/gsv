import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import { parentPath, visibleRepos } from "./sources-domain";
import type {
  CreateSourceRepoResult,
  SourceCommit,
  SourceCommitsPage,
  SourceDiffResult,
  SourceMode,
  SourceRepoRecord,
  SourcesState,
  SourceSearchResult,
} from "./types";

const COMMIT_PAGE_SIZE = 20;

export type CreateRepoForm = {
  owner: string;
  name: string;
  ref: string;
  description: string;
};

export type SourcesRuntime = {
  state: SourcesState | null;
  loading: boolean;
  pendingAction: string | null;
  error: string | null;
  notice: string | null;
  query: string;
  setQuery(query: string): void;
  mode: SourceMode;
  setMode(mode: SourceMode): void;
  path: string;
  ref: string;
  selectedRepo: SourceRepoRecord | null;
  visibleRepos: SourceRepoRecord[];
  searchQuery: string;
  setSearchQuery(query: string): void;
  searchBusy: boolean;
  searchResult: SourceSearchResult | null;
  selectedCommitHash: string | null;
  selectedCommit: SourceCommit | null;
  commitsPage: SourceCommitsPage | null;
  historyBusy: boolean;
  diffBusy: boolean;
  diffResult: SourceDiffResult | null;
  diffError: string | null;
  createForm: CreateRepoForm;
  setCreateForm(form: CreateRepoForm | ((current: CreateRepoForm) => CreateRepoForm)): void;
  refresh(): Promise<void>;
  selectRepo(repo: string): Promise<void>;
  selectRef(ref: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openParent(): Promise<void>;
  runSearch(): Promise<void>;
  selectCommit(hash: string): Promise<void>;
  closeCommit(): void;
  previousCommitPage(): Promise<void>;
  nextCommitPage(): Promise<void>;
  pullRepo(): Promise<void>;
  setRepoPublic(publicValue: boolean): Promise<void>;
  createRepo(): Promise<CreateSourceRepoResult | null>;
};

export function useSources(backend: GsvBackend): SourcesRuntime {
  const [state, setState] = useState<SourcesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setModeState] = useState<SourceMode>(readModeFromLocation);
  const [repo, setRepo] = useState<string | null>(readRepoFromLocation);
  const [ref, setRef] = useState(readRefFromLocation);
  const [path, setPath] = useState(readPathFromLocation);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResult, setSearchResult] = useState<SourceSearchResult | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffResult, setDiffResult] = useState<SourceDiffResult | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateRepoForm>({
    owner: "",
    name: "",
    ref: "main",
    description: "",
  });

  const selectedRepo = state?.selectedRepo ?? null;
  const commitsPage = state?.commitsPage ?? null;
  const selectedCommit = useMemo(
    () => state?.commits.find((commit) => commit.hash === selectedCommitHash) ?? null,
    [selectedCommitHash, state],
  );
  const filteredRepos = useMemo(
    () => state ? visibleRepos(state.repos, query) : [],
    [query, state],
  );

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(
    overrides: { repo?: string | null; ref?: string; path?: string; mode?: SourceMode } = {},
  ): Promise<void> {
    setLoading(true);
    setError(null);
    const nextRepo = overrides.repo !== undefined ? overrides.repo : repo;
    const nextRef = overrides.ref !== undefined ? overrides.ref : ref;
    const nextPath = overrides.path !== undefined ? overrides.path : path;
    const nextMode = overrides.mode ?? mode;
    try {
      const nextState = await backend.loadSourcesState({
        repo: nextRepo ?? undefined,
        ref: nextRef || undefined,
        path: nextPath || undefined,
      });
      setState(nextState);
      const resolvedRepo = nextState.selectedRepo?.repo ?? null;
      const resolvedRef = nextState.refs?.activeRef ?? nextRef;
      const resolvedPath = nextState.read?.path ?? nextPath;
      setRepo(resolvedRepo);
      setRef(resolvedRef);
      setPath(resolvedPath);
      clearCommitDetail();
      setCreateForm((current) => ({
        ...current,
        owner: current.owner || nextState.selectedRepo?.owner || nextState.repos[0]?.owner || "",
      }));
      writeLocation(resolvedRepo, resolvedRef, resolvedPath, nextMode);
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function selectRepo(nextRepo: string): Promise<void> {
    setRepo(nextRepo);
    setPath("");
    setSearchResult(null);
    setDiffResult(null);
    setDiffError(null);
    setSelectedCommitHash(null);
    setMode("code");
    writeLocation(nextRepo, "", "", "code");
    await refresh({ repo: nextRepo, ref: "", path: "", mode: "code" });
  }

  async function selectRef(nextRef: string): Promise<void> {
    setRef(nextRef);
    setPath("");
    setSearchResult(null);
    clearCommitDetail();
    setMode("code");
    writeLocation(repo, nextRef, "", "code");
    await refresh({ ref: nextRef, path: "", mode: "code" });
  }

  async function openPath(nextPath: string): Promise<void> {
    setPath(nextPath);
    setSearchResult(null);
    clearCommitDetail();
    setMode("code");
    writeLocation(repo, ref, nextPath, "code");
    await refresh({ path: nextPath, mode: "code" });
  }

  async function openParent(): Promise<void> {
    await openPath(parentPath(path));
  }

  function setMode(nextMode: SourceMode): void {
    setModeState(nextMode);
    writeLocation(repo, ref, path, nextMode);
  }

  async function runMutation(action: string, task: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function runSearch(): Promise<void> {
    if (!repo || !searchQuery.trim()) return;
    setSearchBusy(true);
    setError(null);
    clearCommitDetail();
    setMode("code");
    try {
      const result = await backend.searchSourceRepo({
        repo,
        ref: ref || undefined,
        query: searchQuery,
        prefix: path || undefined,
      });
      setSearchResult(result);
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setSearchBusy(false);
    }
  }

  function clearCommitDetail(): void {
    setSelectedCommitHash(null);
    setDiffResult(null);
    setDiffError(null);
  }

  async function selectCommit(hash: string): Promise<void> {
    if (!repo || !hash) return;
    setSelectedCommitHash(hash);
    setDiffBusy(true);
    setDiffResult(null);
    setDiffError(null);
    setMode("history");
    try {
      setDiffResult(await backend.diffSourceRepo({ repo, commit: hash, context: 3 }));
    } catch (cause) {
      setDiffError(errorToText(cause));
    } finally {
      setDiffBusy(false);
    }
  }

  function closeCommit(): void {
    clearCommitDetail();
  }

  async function loadCommitPage(offset: number): Promise<void> {
    if (!repo) return;
    const normalizedOffset = Math.max(0, offset);
    setHistoryBusy(true);
    setError(null);
    clearCommitDetail();
    try {
      const page = await backend.loadSourceCommits({
        repo,
        ref: ref || state?.refs?.activeRef || undefined,
        limit: COMMIT_PAGE_SIZE,
        offset: normalizedOffset,
      });
      setState((current) => current ? {
        ...current,
        commits: page.commits,
        commitsPage: page,
      } : current);
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function previousCommitPage(): Promise<void> {
    const page = state?.commitsPage;
    if (!page || page.offset <= 0) return;
    await loadCommitPage(page.offset - page.limit);
  }

  async function nextCommitPage(): Promise<void> {
    const page = state?.commitsPage;
    if (!page || !page.hasNextPage) return;
    await loadCommitPage(page.offset + page.limit);
  }

  async function pullRepo(): Promise<void> {
    if (!repo) return;
    await runMutation(`source:pull:${repo}`, async () => {
      await backend.pullSourceRepo({ repo, ref: ref || undefined });
      setNotice(`Pulled upstream changes for ${repo}.`);
      await refresh();
    });
  }

  async function setRepoPublic(publicValue: boolean): Promise<void> {
    if (!repo) return;
    await runMutation(`source:public:${repo}`, async () => {
      await backend.setSourceRepoPublic({ repo, public: publicValue });
      setNotice(publicValue ? "Repository published." : "Repository made private.");
      await refresh();
    });
  }

  async function createRepo(): Promise<CreateSourceRepoResult | null> {
    const owner = createForm.owner.trim();
    const name = createForm.name.trim();
    if (!owner || !name) return null;
    let result: CreateSourceRepoResult | null = null;
    await runMutation("source:create", async () => {
      result = await backend.createSourceRepo({
        repo: `${owner}/${name}`,
        ref: createForm.ref.trim() || "main",
        description: createForm.description.trim() || undefined,
      });
      setCreateForm((current) => ({ ...current, name: "", description: "" }));
      setNotice(result.created ? "Repository created." : "Repository already existed.");
      setRepo(result.repo);
      setRef(result.ref);
      setPath("");
      writeLocation(result.repo, result.ref, "", "code");
      await refresh({ repo: result.repo, ref: result.ref, path: "", mode: "code" });
    });
    return result;
  }

  return {
    state,
    loading,
    pendingAction,
    error,
    notice,
    query,
    setQuery,
    mode,
    setMode,
    path,
    ref,
    selectedRepo,
    visibleRepos: filteredRepos,
    searchQuery,
    setSearchQuery,
    searchBusy,
    searchResult,
    selectedCommitHash,
    selectedCommit,
    commitsPage,
    historyBusy,
    diffBusy,
    diffResult,
    diffError,
    createForm,
    setCreateForm,
    refresh,
    selectRepo,
    selectRef,
    openPath,
    openParent,
    runSearch,
    selectCommit,
    closeCommit,
    previousCommitPage,
    nextCommitPage,
    pullRepo,
    setRepoPublic,
    createRepo,
  };
}

function readRepoFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("repo");
  return value?.trim() || null;
}

function readRefFromLocation(): string {
  return new URL(window.location.href).searchParams.get("ref")?.trim() || "";
}

function readPathFromLocation(): string {
  return new URL(window.location.href).searchParams.get("path")?.trim().replace(/^\/+|\/+$/g, "") || "";
}

function readModeFromLocation(): SourceMode {
  const value = new URL(window.location.href).searchParams.get("mode");
  return value === "history" ? "history" : "code";
}

function writeLocation(repo: string | null, ref: string, path: string, mode: SourceMode): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "sources");
  if (repo) {
    url.searchParams.set("repo", repo);
  } else {
    url.searchParams.delete("repo");
  }
  if (ref) {
    url.searchParams.set("ref", ref);
  } else {
    url.searchParams.delete("ref");
  }
  if (path) {
    url.searchParams.set("path", path);
  } else {
    url.searchParams.delete("path");
  }
  if (mode === "code") {
    url.searchParams.delete("mode");
  } else {
    url.searchParams.set("mode", mode);
  }
  window.history.replaceState({}, "", url);
}
