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

type SourcesLocation = {
  repo: string | null;
  ref: string;
  path: string;
  mode: SourceMode;
  commit: string | null;
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
  repositoryRoute: string | null;
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
  showRepositoryList(): Promise<void>;
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
  const initialRoute = readSourcesLocation();
  const [state, setState] = useState<SourcesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setModeState] = useState<SourceMode>(initialRoute.mode);
  const [repo, setRepo] = useState<string | null>(initialRoute.repo);
  const [ref, setRef] = useState(initialRoute.ref);
  const [path, setPath] = useState(initialRoute.path);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResult, setSearchResult] = useState<SourceSearchResult | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(initialRoute.commit);
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
    void loadLocation(readSourcesLocation());
    const onPopState = () => {
      void loadLocation(readSourcesLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  async function loadLocation(route: SourcesLocation): Promise<void> {
    setRepo(route.repo);
    setRef(route.ref);
    setPath(route.path);
    setModeState(route.mode);
    setSearchResult(null);
    await refresh({
      repo: route.repo,
      ref: route.ref,
      path: route.path,
      mode: route.mode,
    }, { commitHash: route.commit });
  }

  async function refresh(
    overrides: { repo?: string | null; ref?: string; path?: string; mode?: SourceMode } = {},
    options: { commitHash?: string | null } = {},
  ): Promise<void> {
    setLoading(true);
    setError(null);
    const nextRepo = overrides.repo !== undefined ? overrides.repo : repo;
    const nextRef = overrides.ref !== undefined ? overrides.ref : ref;
    const nextPath = overrides.path !== undefined ? overrides.path : path;
    const nextMode = overrides.mode ?? mode;
    const nextCommitHash = options.commitHash ?? null;
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
      setModeState(nextMode);
      setSelectedCommitHash(nextCommitHash);
      setDiffResult(null);
      setDiffError(null);
      setCreateForm((current) => ({
        ...current,
        owner: current.owner || nextState.selectedRepo?.owner || nextState.repos[0]?.owner || "",
      }));
      if (nextCommitHash && resolvedRepo) {
        await loadDiffForRepo(resolvedRepo, nextCommitHash);
      } else {
        setDiffBusy(false);
      }
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function showRepositoryList(): Promise<void> {
    setRepo(null);
    setRef("");
    setPath("");
    setModeState("code");
    setSearchResult(null);
    clearCommitDetail();
    writeLocation(null, "", "", "code", null);
    await refresh({ repo: null, ref: "", path: "", mode: "code" });
  }

  async function selectRepo(nextRepo: string): Promise<void> {
    setRepo(nextRepo);
    setRef("");
    setPath("");
    setSearchResult(null);
    clearCommitDetail();
    setModeState("code");
    writeLocation(nextRepo, "", "", "code", null);
    await refresh({ repo: nextRepo, ref: "", path: "", mode: "code" });
  }

  async function selectRef(nextRef: string): Promise<void> {
    setRef(nextRef);
    setPath("");
    setSearchResult(null);
    clearCommitDetail();
    setModeState("code");
    writeLocation(repo, nextRef, "", "code", null);
    await refresh({ ref: nextRef, path: "", mode: "code" });
  }

  async function openPath(nextPath: string): Promise<void> {
    setPath(nextPath);
    setSearchResult(null);
    clearCommitDetail();
    setModeState("code");
    writeLocation(repo, ref, nextPath, "code", null);
    await refresh({ path: nextPath, mode: "code" });
  }

  async function openParent(): Promise<void> {
    await openPath(parentPath(path));
  }

  function setMode(nextMode: SourceMode): void {
    setModeState(nextMode);
    clearCommitDetail();
    writeLocation(repo, ref, path, nextMode, null);
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
    setModeState("code");
    writeLocation(repo, ref, path, "code", null);
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
    setDiffBusy(false);
  }

  async function selectCommit(hash: string): Promise<void> {
    if (!repo || !hash) return;
    if (mode !== "history") {
      writeLocation(repo, ref, path, "history", null);
    }
    setSelectedCommitHash(hash);
    setModeState("history");
    writeLocation(repo, ref, path, "history", hash);
    await loadDiffForRepo(repo, hash);
  }

  function closeCommit(): void {
    clearCommitDetail();
    writeLocation(repo, ref, path, "history", null);
  }

  async function loadDiffForRepo(targetRepo: string, hash: string): Promise<void> {
    setDiffBusy(true);
    setDiffResult(null);
    setDiffError(null);
    try {
      setDiffResult(await backend.diffSourceRepo({ repo: targetRepo, commit: hash, context: 3 }));
    } catch (cause) {
      setDiffError(errorToText(cause));
    } finally {
      setDiffBusy(false);
    }
  }

  async function loadCommitPage(offset: number): Promise<void> {
    if (!repo) return;
    const normalizedOffset = Math.max(0, offset);
    setHistoryBusy(true);
    setError(null);
    clearCommitDetail();
    writeLocation(repo, ref, path, "history", null);
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
      clearCommitDetail();
      setModeState("code");
      writeLocation(result.repo, result.ref, "", "code", null);
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
    repositoryRoute: repo,
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
    showRepositoryList,
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

function readSourcesLocation(): SourcesLocation {
  const url = new URL(window.location.href);
  const commit = url.searchParams.get("commit")?.trim() || null;
  return {
    repo: url.searchParams.get("repo")?.trim() || null,
    ref: url.searchParams.get("ref")?.trim() || "",
    path: normalizeLocationPath(url.searchParams.get("path")?.trim() || ""),
    mode: readMode(url, commit),
    commit,
  };
}

function readMode(url: URL, commit: string | null): SourceMode {
  const value = url.searchParams.get("mode");
  return value === "history" || commit ? "history" : "code";
}

function normalizeLocationPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function writeLocation(
  repo: string | null,
  ref: string,
  path: string,
  mode: SourceMode,
  commit: string | null,
): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "sources");
  setOptionalParam(url, "repo", repo ?? undefined);
  setOptionalParam(url, "ref", ref);
  setOptionalParam(url, "path", path && path !== "." ? path : undefined);
  setOptionalParam(url, "commit", commit ?? undefined);
  if (mode === "code") {
    url.searchParams.delete("mode");
  } else {
    url.searchParams.set("mode", mode);
  }
  window.history.pushState({}, "", url);
}

function setOptionalParam(url: URL, key: string, value: string | undefined): void {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
}
