import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type {
  CatalogEntry,
  CatalogRecord,
  PackageDetailTab,
  PackageRecord,
  PackageRepoDiffFile,
  PackageRepoDiffResult,
  PackageRepoReadResult,
  PackageRepoRoot,
  PackageRepoSearchResult,
  PackagesBackend,
  PackagesState,
  PackagesView,
  PackageScopeFilter,
  RepoTreeEntry,
  SourceRecord,
} from "./types";

type AppProps = {
  backend: PackagesBackend;
};

export function App({ backend }: AppProps) {
  const [state, setState] = useState<PackagesState | null>(null);
  const [view, setView] = useState<PackagesView>(readViewFromLocation());
  const [scopeFilter, setScopeFilter] = useState<PackageScopeFilter>(readScopeFromLocation());
  const [detailTab, setDetailTab] = useState<PackageDetailTab>(readTabFromLocation());
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(readPackageIdFromLocation());
  const [selectedSourceRepo, setSelectedSourceRepo] = useState<string | null>(readSourceFromLocation());
  const [selectedCatalogName, setSelectedCatalogName] = useState<string>(readCatalogFromLocation());
  const [query, setQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importSource, setImportSource] = useState("");
  const [importRef, setImportRef] = useState("main");
  const [importSubdir, setImportSubdir] = useState(".");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [checkoutRef, setCheckoutRef] = useState("");

  const [codeRoot, setCodeRoot] = useState<PackageRepoRoot>("package");
  const [codeRef, setCodeRef] = useState("");
  const [codePath, setCodePath] = useState("");
  const [codeRead, setCodeRead] = useState<PackageRepoReadResult | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSearch, setCodeSearch] = useState("");
  const [codeSearchResult, setCodeSearchResult] = useState<PackageRepoSearchResult | null>(null);
  const [codeSearchBusy, setCodeSearchBusy] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<PackageRepoDiffResult | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const updateRoute = useCallback((next: {
    view?: PackagesView;
    scope?: PackageScopeFilter;
    tab?: PackageDetailTab;
    packageId?: string | null;
    sourceRepo?: string | null;
    catalog?: string;
  }) => {
    const url = new URL(window.location.href);
    const nextView = next.view ?? view;
    const nextScope = next.scope ?? scopeFilter;
    const nextTab = next.tab ?? detailTab;
    const nextPackageId = next.packageId === undefined ? selectedPackageId : next.packageId;
    const nextSourceRepo = next.sourceRepo === undefined ? selectedSourceRepo : next.sourceRepo;
    const nextCatalog = next.catalog ?? selectedCatalogName;

    url.searchParams.set("view", nextView);
    url.searchParams.set("scope", nextScope);
    url.searchParams.set("tab", nextTab);

    if (nextPackageId) {
      url.searchParams.set("package", nextPackageId);
    } else {
      url.searchParams.delete("package");
    }
    if (nextSourceRepo) {
      url.searchParams.set("source", nextSourceRepo);
    } else {
      url.searchParams.delete("source");
    }
    if (nextCatalog) {
      url.searchParams.set("catalog", nextCatalog);
    } else {
      url.searchParams.delete("catalog");
    }

    window.history.pushState({}, "", url);
    setView(nextView);
    setScopeFilter(nextScope);
    setDetailTab(nextTab);
    setSelectedPackageId(nextPackageId ?? null);
    setSelectedSourceRepo(nextSourceRepo ?? null);
    setSelectedCatalogName(nextCatalog);
  }, [detailTab, scopeFilter, selectedCatalogName, selectedPackageId, selectedSourceRepo, view]);

  const refresh = useCallback(async (packageId: string | null) => {
    setPendingAction((current) => current ?? "load-state");
    try {
      const nextState = await backend.loadState(packageId ? { packageId } : {});
      setState(nextState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction((current) => current === "load-state" ? null : current);
    }
  }, [backend]);

  useEffect(() => {
    void refresh(selectedPackageId);
  }, [refresh, selectedPackageId]);

  useEffect(() => {
    const onPopState = () => {
      setView(readViewFromLocation());
      setScopeFilter(readScopeFromLocation());
      setDetailTab(readTabFromLocation());
      setSelectedPackageId(readPackageIdFromLocation());
      setSelectedSourceRepo(readSourceFromLocation());
      setSelectedCatalogName(readCatalogFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const visiblePackages = useMemo(() => {
    const packages = state?.packages ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    return packages
      .filter((pkg) => {
        if (scopeFilter === "mine") return pkg.scope.kind === "user";
        if (scopeFilter === "system") return pkg.scope.kind === "global";
        return true;
      })
      .filter((pkg) => {
        if (view === "updates") return pkg.updateAvailable;
        if (view === "review") return pkg.reviewPending;
        return view !== "sources";
      })
      .filter((pkg) => {
        if (!normalizedQuery) return true;
        return [pkg.name, pkg.description, pkg.source.repo].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        if (view === "updates") {
          return right.updatedAt - left.updatedAt || left.name.localeCompare(right.name);
        }
        if (view === "review") {
          return left.name.localeCompare(right.name);
        }
        if (left.enabled !== right.enabled) {
          return left.enabled ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  }, [query, scopeFilter, state?.packages, view]);

  useEffect(() => {
    if (!state || view === "sources") {
      return;
    }
    const hasSelected = selectedPackageId && visiblePackages.some((pkg) => pkg.packageId === selectedPackageId);
    if (!hasSelected) {
      updateRoute({ packageId: visiblePackages[0]?.packageId ?? null, sourceRepo: visiblePackages[0]?.source.repo ?? selectedSourceRepo });
    }
  }, [selectedPackageId, selectedSourceRepo, state, updateRoute, view, visiblePackages]);

  const selectedPackage = useMemo(() => {
    if (!state || view === "sources") {
      return null;
    }
    return visiblePackages.find((pkg) => pkg.packageId === selectedPackageId) ?? visiblePackages[0] ?? null;
  }, [selectedPackageId, state, view, visiblePackages]);

  const selectedSource = useMemo(() => {
    const sources = state?.sources ?? [];
    if (sources.length === 0) return null;
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = sources.filter((source) => {
      if (!normalizedQuery) return true;
      return [source.repo, ...source.packageNames].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
    if (filtered.length === 0) return null;
    return filtered.find((source) => source.repo === selectedSourceRepo) ?? filtered[0] ?? null;
  }, [query, selectedSourceRepo, state?.sources]);

  useEffect(() => {
    if (view !== "sources") {
      return;
    }
    if (!selectedSource && state?.sources?.length) {
      updateRoute({ sourceRepo: state.sources[0].repo });
    }
  }, [selectedSource, state?.sources, updateRoute, view]);

  const selectedCatalog = useMemo(() => {
    const catalogs = state?.catalogs ?? [];
    return catalogs.find((catalog) => catalog.name === selectedCatalogName) ?? catalogs[0] ?? null;
  }, [selectedCatalogName, state?.catalogs]);

  useEffect(() => {
    if (view === "sources" && selectedCatalog && selectedCatalog.name !== selectedCatalogName) {
      updateRoute({ catalog: selectedCatalog.name });
    }
  }, [selectedCatalog, selectedCatalogName, updateRoute, view]);

  useEffect(() => {
    if (!selectedPackage) {
      return;
    }
    setCheckoutRef(selectedPackage.source.ref);
    setCodeRoot("package");
    setCodeRef(selectedPackage.source.ref);
    setCodePath("");
    setCodeRead(null);
    setCodeError(null);
    setCodeSearch("");
    setCodeSearchResult(null);
    setSelectedCommit(null);
    setDiffResult(null);
    setDiffError(null);
  }, [selectedPackage?.packageId]);

  useEffect(() => {
    if (!selectedPackage || !state?.packageDetail) {
      return;
    }
    const commits = state.packageDetail.commits;
    if (commits.length === 0) {
      setSelectedCommit(null);
      return;
    }
    const next = selectedCommit && commits.some((commit) => commit.hash === selectedCommit)
      ? selectedCommit
      : commits[0].hash;
    if (next !== selectedCommit) {
      setSelectedCommit(next);
    }
  }, [selectedCommit, selectedPackage?.packageId, state?.packageDetail]);

  useEffect(() => {
    if (!selectedPackage || detailTab !== "code") {
      return;
    }
    let cancelled = false;
    setCodeBusy(true);
    setCodeError(null);
    void backend.readRepo({
      packageId: selectedPackage.packageId,
      ref: codeRef || undefined,
      path: codePath || undefined,
      root: codeRoot,
    }).then((result) => {
      if (cancelled) return;
      setCodeRead(result);
    }).catch((cause) => {
      if (cancelled) return;
      setCodeError(formatError(cause));
      setCodeRead(null);
    }).finally(() => {
      if (!cancelled) {
        setCodeBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backend, codePath, codeRef, codeRoot, detailTab, selectedPackage?.packageId]);

  useEffect(() => {
    if (!selectedPackage || detailTab !== "changes" || !selectedCommit) {
      return;
    }
    let cancelled = false;
    setDiffBusy(true);
    setDiffError(null);
    void backend.diffRepo({ packageId: selectedPackage.packageId, commit: selectedCommit, context: 3 }).then((result) => {
      if (cancelled) return;
      setDiffResult(result);
    }).catch((cause) => {
      if (cancelled) return;
      setDiffError(formatError(cause));
      setDiffResult(null);
    }).finally(() => {
      if (!cancelled) {
        setDiffBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backend, detailTab, selectedCommit, selectedPackage?.packageId]);

  const packagePermissionSummary = useMemo(() => {
    return selectedPackage ? buildPermissionSummary(selectedPackage) : [];
  }, [selectedPackage]);

  const browseRefs = useMemo(() => {
    return buildRefOptions(state?.packageDetail, selectedPackage?.source.ref);
  }, [selectedPackage?.source.ref, state?.packageDetail]);

  const selectedCommitRecord = useMemo(() => {
    return state?.packageDetail?.commits.find((commit) => commit.hash === selectedCommit) ?? null;
  }, [selectedCommit, state?.packageDetail]);

  const packageMutationBlockedReason = selectedPackage && !selectedPackage.canMutate
    ? "This package is outside your mutable package scope."
    : "";
  const packageVisibilityBlockedReason = selectedPackage && !selectedPackage.canChangeVisibility
    ? "Only root or the repo owner can change visibility for this source."
    : "";
  const sourceRefreshBlockedReason = selectedSource && !selectedSource.refreshable
    ? "You can only pull upstream for sources installed in your mutable package scope."
    : "";
  const sourceVisibilityBlockedReason = selectedSource && !selectedSource.canChangeVisibility
    ? "Only root or the repo owner can change visibility for this source."
    : "";

  async function runAction(name: string, work: () => Promise<void>) {
    setPendingAction(name);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }

  const handleSyncSources = useCallback(() => {
    void runAction("sync-sources", async () => {
      await backend.syncSources();
      await refresh(selectedPackage?.packageId ?? selectedPackageId);
      setNotice("Synced builtin packages and refreshed imported sources.");
    });
  }, [backend, refresh, selectedPackage?.packageId, selectedPackageId]);

  const handleImportPackage = useCallback(() => {
    void runAction("import-package", async () => {
      const result = await backend.importPackage({
        source: importSource,
        ref: importRef,
        subdir: importSubdir,
      });
      updateRoute({ view: "installed", packageId: result.package.packageId, sourceRepo: result.package.source.repo });
      await refresh(result.package.packageId);
      setNotice(`Imported ${result.package.name}.`);
    });
  }, [backend, importRef, importSource, importSubdir, refresh, updateRoute]);

  const handleAddRemote = useCallback(() => {
    void runAction("add-remote", async () => {
      await backend.addRemote({ name: remoteName, baseUrl: remoteUrl });
      await refresh(selectedPackage?.packageId ?? selectedPackageId);
      setRemoteName("");
      setRemoteUrl("");
      setNotice(`Added remote ${remoteName}.`);
    });
  }, [backend, refresh, remoteName, remoteUrl, selectedPackage?.packageId, selectedPackageId]);

  const handleRemoveRemote = useCallback((name: string) => {
    void runAction(`remove-remote:${name}`, async () => {
      await backend.removeRemote({ name });
      await refresh(selectedPackage?.packageId ?? selectedPackageId);
      setNotice(`Removed remote ${name}.`);
    });
  }, [backend, refresh, selectedPackage?.packageId, selectedPackageId]);

  const handleEnablePackage = useCallback((packageId: string) => {
    void runAction(`enable:${packageId}`, async () => {
      await backend.enablePackage({ packageId });
      await refresh(packageId);
      setNotice("Package enabled.");
    });
  }, [backend, refresh]);

  const handleDisablePackage = useCallback((packageId: string) => {
    void runAction(`disable:${packageId}`, async () => {
      await backend.disablePackage({ packageId });
      await refresh(packageId);
      setNotice("Package disabled.");
    });
  }, [backend, refresh]);

  const handleApproveReview = useCallback((packageId: string) => {
    void runAction(`approve:${packageId}`, async () => {
      await backend.approveReview({ packageId });
      await refresh(packageId);
      setNotice("Review approved.");
    });
  }, [backend, refresh]);

  const handleRefreshPackage = useCallback((packageId: string) => {
    void runAction(`refresh:${packageId}`, async () => {
      await backend.refreshPackage({ packageId });
      await refresh(packageId);
      setNotice("Pulled latest upstream changes for the package.");
    });
  }, [backend, refresh]);

  const handleRefreshSource = useCallback((repo: string) => {
    void runAction(`refresh-source:${repo}`, async () => {
      await backend.refreshSource({ repo });
      await refresh(selectedPackage?.packageId ?? selectedPackageId);
      setNotice(`Pulled latest upstream changes for ${repo}.`);
    });
  }, [backend, refresh, selectedPackage?.packageId, selectedPackageId]);

  const handleCheckout = useCallback((packageId: string) => {
    void runAction(`checkout:${packageId}`, async () => {
      await backend.checkoutPackage({ packageId, ref: checkoutRef });
      await refresh(packageId);
      setCodeRef(checkoutRef);
      setNotice(`Checked out ${checkoutRef}.`);
    });
  }, [backend, checkoutRef, refresh]);

  const handleSetPublic = useCallback((payload: { packageId?: string; repo?: string; public: boolean }) => {
    void runAction(`public:${payload.repo ?? payload.packageId ?? "unknown"}`, async () => {
      await backend.setPublic(payload);
      await refresh(selectedPackage?.packageId ?? selectedPackageId);
      setNotice(payload.public ? "Source is now public." : "Source is no longer public.");
    });
  }, [backend, refresh, selectedPackage?.packageId, selectedPackageId]);

  const handleStartReview = useCallback((packageId: string) => {
    void runAction(`review:${packageId}`, async () => {
      const spawned = await backend.startReview({ packageId });
      openChatProcess(spawned);
      setNotice("Opened package review in Chat.");
    });
  }, [backend]);

  const handleSearchRepo = useCallback(() => {
    if (!selectedPackage || !codeSearch.trim()) {
      setCodeSearchResult(null);
      return;
    }
    setCodeSearchBusy(true);
    setCodeError(null);
    void backend.searchRepo({
      packageId: selectedPackage.packageId,
      ref: codeRef || undefined,
      query: codeSearch,
      root: codeRoot,
      prefix: codeRead?.kind === "tree" ? codeRead.path || undefined : undefined,
    }).then((result) => {
      setCodeSearchResult(result);
    }).catch((cause) => {
      setCodeError(formatError(cause));
      setCodeSearchResult(null);
    }).finally(() => {
      setCodeSearchBusy(false);
    });
  }, [backend, codeRead?.kind, codeRead?.path, codeRef, codeRoot, codeSearch, selectedPackage]);

  const selectedPackageActions = selectedPackage ? renderEntryActions(selectedPackage) : [];

  return (
    <div class="packages-app-shell">
      <header class="packages-topbar">
        <div class="packages-topbar-copy">
          <p class="packages-eyebrow">Trust console</p>
          <h1>Packages</h1>
          <p>Review, update, browse source, and manage the code that enters GSV.</p>
        </div>
        <div class="packages-topbar-tools">
          <label class="packages-search-field">
            <span>Search</span>
            <input value={query} onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)} placeholder={view === "sources" ? "Search sources" : "Search packages"} />
          </label>
          <button class="packages-button packages-button--primary" type="button" disabled={pendingAction === "sync-sources"} onClick={handleSyncSources}>Sync sources</button>
        </div>
      </header>

      <nav class="packages-main-tabs" aria-label="Package views">
        {([
          ["installed", `Installed (${state?.counts.installed ?? 0})`],
          ["updates", `Updates (${state?.counts.updates ?? 0})`],
          ["review", `Review Queue (${state?.counts.review ?? 0})`],
          ["sources", "Sources"],
        ] as Array<[PackagesView, string]>).map(([tabView, label]) => (
          <button
            key={tabView}
            class={`packages-main-tab${view === tabView ? " is-active" : ""}`}
            onClick={() => updateRoute({ view: tabView })}
          >
            {label}
          </button>
        ))}
      </nav>

      {error ? <div class="packages-banner packages-banner--error">{error}</div> : null}
      {notice ? <div class="packages-banner">{notice}</div> : null}

      {view === "sources" ? (
        <div class="packages-layout packages-layout--sources">
          <aside class="packages-sidebar">
            <header class="packages-sidebar-head">
              <strong>Installed sources</strong>
              <span>{state?.sources.length ?? 0} repos</span>
            </header>
            <div class="packages-sidebar-list">
              {(state?.sources ?? [])
                .filter((source) => {
                  const normalized = query.trim().toLowerCase();
                  if (!normalized) return true;
                  return [source.repo, ...source.packageNames].some((value) => value.toLowerCase().includes(normalized));
                })
                .map((source) => (
                  <button
                    key={source.repo}
                    class={`packages-list-row${selectedSource?.repo === source.repo ? " is-active" : ""}`}
                    onClick={() => updateRoute({ sourceRepo: source.repo })}
                  >
                    <div>
                      <strong>{source.repo}</strong>
                      <span>{source.packageCount} package{source.packageCount === 1 ? "" : "s"}</span>
                    </div>
                    <div class="packages-list-meta">
                      {source.updateCount > 0 ? <span class="packages-badge is-update">{source.updateCount} update{source.updateCount === 1 ? "" : "s"}</span> : null}
                      {source.reviewPendingCount > 0 ? <span class="packages-badge is-review">{source.reviewPendingCount} review</span> : null}
                    </div>
                  </button>
                ))}
            </div>
          </aside>

          <main class="packages-main-pane">
            <section class="packages-section packages-section--toolbar">
              <div class="packages-toolbar-grid">
                <div>
                  <h2>Import package</h2>
                  <p>Bring in a repo or remote URL. Third-party imports stay disabled until reviewed.</p>
                </div>
                <div class="packages-inline-grid">
                  <input value={importSource} onInput={(event) => setImportSource((event.currentTarget as HTMLInputElement).value)} placeholder="owner/repo or https://..." />
                  <input value={importRef} onInput={(event) => setImportRef((event.currentTarget as HTMLInputElement).value)} placeholder="main" />
                  <input value={importSubdir} onInput={(event) => setImportSubdir((event.currentTarget as HTMLInputElement).value)} placeholder="." />
                  <button class="packages-button packages-button--primary" type="button" disabled={pendingAction === "import-package"} onClick={handleImportPackage}>Import</button>
                </div>
              </div>
            </section>

            <section class="packages-section">
              <header class="packages-section-head">
                <div>
                  <h2>{selectedSource ? selectedSource.repo : "No source selected"}</h2>
                  <p>{selectedSource ? `${selectedSource.packageCount} installed package${selectedSource.packageCount === 1 ? "" : "s"} from this source.` : "Select an installed source to inspect it."}</p>
                </div>
                {selectedSource ? (
                  <div class="packages-inline-actions">
                    <button
                      class="packages-button"
                      type="button"
                      title={selectedSource.isBuiltin ? "Builtin packages are refreshed through Sync sources." : sourceRefreshBlockedReason || undefined}
                      disabled={!selectedSource.refreshable || pendingAction === `refresh-source:${selectedSource.repo}`}
                      onClick={() => handleRefreshSource(selectedSource.repo)}
                    >
                      Pull upstream
                    </button>
                    {!selectedSource.isBuiltin ? (
                      <button
                        class="packages-button"
                        type="button"
                        title={sourceVisibilityBlockedReason || undefined}
                        disabled={!selectedSource.canChangeVisibility || pendingAction === `public:${selectedSource.repo}`}
                        onClick={() => handleSetPublic({ repo: selectedSource.repo, public: !selectedSource.public })}
                      >
                        {selectedSource.public ? "Hide source" : "Publish source"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </header>
              {selectedSource ? (
                <>
                  <div class="packages-info-grid">
                    <article><span>Kind</span><strong>{selectedSource.isBuiltin ? "Builtin" : "Imported"}</strong></article>
                    <article><span>Visibility</span><strong>{selectedSource.public ? "Public" : "Private"}</strong></article>
                    <article><span>Pending review</span><strong>{selectedSource.reviewPendingCount}</strong></article>
                    <article><span>Updates</span><strong>{selectedSource.updateCount}</strong></article>
                  </div>
                  <div class="packages-table">
                    <div class="packages-table-head">
                      <span>Package</span>
                      <span>Status</span>
                      <span>Ref</span>
                    </div>
                    {state?.packages.filter((pkg) => pkg.source.repo === selectedSource.repo).map((pkg) => (
                      <button
                        key={pkg.packageId}
                        class="packages-table-row packages-table-row--button"
                        onClick={() => updateRoute({ view: pkg.reviewPending ? "review" : pkg.updateAvailable ? "updates" : "installed", packageId: pkg.packageId, sourceRepo: pkg.source.repo })}
                      >
                        <div>
                          <strong>{pkg.name}</strong>
                          <span>{pkg.description || pkg.source.subdir}</span>
                        </div>
                        <div class="packages-row-status">
                          {pkg.reviewPending ? <span class="packages-badge is-review">Review required</span> : null}
                          {pkg.updateAvailable ? <span class="packages-badge is-update">Update available</span> : pkg.enabled ? <span class="packages-badge is-enabled">Enabled</span> : <span class="packages-badge is-disabled">Disabled</span>}
                        </div>
                        <span class="packages-mono">{pkg.source.ref}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : <div class="packages-empty-state">No source matches the current selection.</div>}
            </section>

            <section class="packages-sources-grid">
              <section class="packages-section">
                <header class="packages-section-head">
                  <div>
                    <h2>Catalogs</h2>
                    <p>Browse local and remote public package catalogs.</p>
                  </div>
                  <div class="packages-catalog-tabs">
                    {(state?.catalogs ?? []).map((catalog) => (
                      <button
                        key={catalog.name}
                        class={`packages-mini-tab${selectedCatalog?.name === catalog.name ? " is-active" : ""}`}
                        onClick={() => updateRoute({ catalog: catalog.name })}
                      >
                        {catalog.kind === "local" ? "Local" : catalog.name}
                      </button>
                    ))}
                  </div>
                </header>
                {selectedCatalog ? (
                  <>
                    <div class="packages-catalog-meta">
                      <span>{selectedCatalog.kind === "local" ? "Local catalog" : selectedCatalog.baseUrl}</span>
                      {selectedCatalog.error ? <span class="packages-badge is-disabled">Unavailable</span> : <span class="packages-badge is-catalog">{selectedCatalog.packages.length} package{selectedCatalog.packages.length === 1 ? "" : "s"}</span>}
                    </div>
                    {selectedCatalog.error ? <div class="packages-empty-state">{selectedCatalog.error}</div> : (
                      <div class="packages-table">
                        <div class="packages-table-head packages-table-head--catalog">
                          <span>Package</span>
                          <span>Source</span>
                          <span></span>
                        </div>
                        {selectedCatalog.packages.map((entry) => {
                          const installed = matchInstalledPackage(entry, state?.packages ?? []);
                          return (
                            <div key={`${entry.source.repo}:${entry.source.subdir}:${entry.name}`} class="packages-table-row packages-table-row--catalog">
                              <div>
                                <strong>{entry.name}</strong>
                                <span>{entry.description || entry.source.repo}</span>
                              </div>
                              <span class="packages-mono">{entry.source.repo}</span>
                              <div class="packages-inline-actions">
                                {installed ? (
                                  <button class="packages-button" type="button" onClick={() => updateRoute({ view: installed.reviewPending ? "review" : installed.updateAvailable ? "updates" : "installed", packageId: installed.packageId, sourceRepo: installed.source.repo })}>
                                    Inspect
                                  </button>
                                ) : null}
                                <button
                                  class="packages-button packages-button--primary"
                                  type="button"
                                  disabled={pendingAction === `catalog-import:${entry.source.repo}:${entry.source.subdir}`}
                                  onClick={() => {
                                    setImportSource(catalogImportSource(selectedCatalog, entry));
                                    setImportRef(entry.source.ref || "main");
                                    setImportSubdir(entry.source.subdir || ".");
                                    void runAction(`catalog-import:${entry.source.repo}:${entry.source.subdir}`, async () => {
                                      const result = await backend.importPackage({
                                        source: catalogImportSource(selectedCatalog, entry),
                                        ref: entry.source.ref || "main",
                                        subdir: entry.source.subdir || ".",
                                      });
                                      updateRoute({ view: "installed", packageId: result.package.packageId, sourceRepo: result.package.source.repo });
                                      await refresh(result.package.packageId);
                                      setNotice(`Imported ${result.package.name}.`);
                                    });
                                  }}
                                >
                                  {installed ? "Re-import" : "Import"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : <div class="packages-empty-state">No catalogs configured.</div>}
              </section>

              <section class="packages-section">
                <header class="packages-section-head">
                  <div>
                    <h2>Remotes</h2>
                    <p>Public catalogs from other GSV instances.</p>
                  </div>
                </header>
                <div class="packages-inline-grid packages-inline-grid--remote">
                  <input value={remoteName} onInput={(event) => setRemoteName((event.currentTarget as HTMLInputElement).value)} placeholder="name" />
                  <input value={remoteUrl} onInput={(event) => setRemoteUrl((event.currentTarget as HTMLInputElement).value)} placeholder="https://gsv.example.com" />
                  <button class="packages-button" type="button" disabled={pendingAction === "add-remote"} onClick={handleAddRemote}>Add remote</button>
                </div>
                <div class="packages-table">
                  <div class="packages-table-head packages-table-head--remotes">
                    <span>Remote</span>
                    <span>Base URL</span>
                    <span></span>
                  </div>
                  {(state?.catalogs ?? []).filter((catalog) => catalog.kind === "remote").map((catalog) => (
                    <div key={catalog.name} class="packages-table-row packages-table-row--catalog">
                      <div>
                        <strong>{catalog.name}</strong>
                        <span>{catalog.packages.length} package{catalog.packages.length === 1 ? "" : "s"}</span>
                      </div>
                      <span class="packages-mono">{catalog.baseUrl}</span>
                      <div class="packages-inline-actions">
                        <button class="packages-button" type="button" onClick={() => updateRoute({ catalog: catalog.name })}>Open catalog</button>
                        <button class="packages-button" type="button" disabled={pendingAction === `remove-remote:${catalog.name}`} onClick={() => handleRemoveRemote(catalog.name)}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </section>
          </main>
        </div>
      ) : (
        <div class="packages-layout">
          <aside class="packages-sidebar">
            <header class="packages-sidebar-head">
              <strong>{view === "installed" ? "Installed" : view === "updates" ? "Updates" : "Review queue"}</strong>
              <div class="packages-sidebar-filters">
                {(["all", "mine", "system"] as PackageScopeFilter[]).map((filter) => (
                  <button
                    key={filter}
                    class={`packages-filter-chip${scopeFilter === filter ? " is-active" : ""}`}
                    onClick={() => updateRoute({ scope: filter, packageId: null })}
                  >
                    {filter === "all" ? "All" : filter === "mine" ? "Mine" : "System"}
                  </button>
                ))}
              </div>
            </header>
            <div class="packages-sidebar-list">
              {visiblePackages.map((pkg) => (
                <button
                  key={pkg.packageId}
                  class={`packages-list-row${selectedPackage?.packageId === pkg.packageId ? " is-active" : ""}`}
                  onClick={() => updateRoute({ packageId: pkg.packageId, sourceRepo: pkg.source.repo })}
                >
                  <div>
                    <strong>{pkg.name}</strong>
                    <span>{pkg.source.repo}</span>
                  </div>
                  <div class="packages-list-meta">
                    {pkg.reviewPending ? <span class="packages-badge is-review">Review</span> : null}
                    {pkg.updateAvailable ? <span class="packages-badge is-update">Update</span> : pkg.enabled ? <span class="packages-badge is-enabled">Enabled</span> : <span class="packages-badge is-disabled">Disabled</span>}
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <main class="packages-main-pane">
            {selectedPackage ? (
              <>
                <header class="packages-detail-head">
                  <div>
                    <div class="packages-title-line">
                      <h2>{selectedPackage.name}</h2>
                      <span class={`packages-badge ${selectedPackage.scope.kind === "user" ? "is-user" : selectedPackage.scope.kind === "workspace" ? "is-workspace" : "is-system"}`}>{formatScope(selectedPackage)}</span>
                      {selectedPackage.reviewPending ? <span class="packages-badge is-review">Review required</span> : null}
                      {selectedPackage.updateAvailable ? <span class="packages-badge is-update">Update available</span> : null}
                      {!selectedPackage.reviewPending && selectedPackage.enabled ? <span class="packages-badge is-enabled">Enabled</span> : null}
                      {!selectedPackage.enabled ? <span class="packages-badge is-disabled">Disabled</span> : null}
                    </div>
                    <p>{selectedPackage.description || "No description provided."}</p>
                  </div>
                  <div class="packages-inline-actions packages-inline-actions--wrap">
                    {selectedPackageActions}
                    <button class="packages-button" type="button" disabled={pendingAction === `review:${selectedPackage.packageId}`} onClick={() => handleStartReview(selectedPackage.packageId)}>Review</button>
                    {selectedPackage.reviewPending ? (
                      <button
                        class="packages-button packages-button--primary"
                        type="button"
                        title={packageMutationBlockedReason || undefined}
                        disabled={!selectedPackage.canMutate || pendingAction === `approve:${selectedPackage.packageId}`}
                        onClick={() => handleApproveReview(selectedPackage.packageId)}
                      >
                        Approve
                      </button>
                    ) : null}
                    {selectedPackage.enabled ? (
                      <button
                        class="packages-button"
                        type="button"
                        title={packageMutationBlockedReason || undefined}
                        disabled={!selectedPackage.canMutate || pendingAction === `disable:${selectedPackage.packageId}`}
                        onClick={() => handleDisablePackage(selectedPackage.packageId)}
                      >
                        Disable
                      </button>
                    ) : !selectedPackage.reviewPending ? (
                      <button
                        class="packages-button packages-button--primary"
                        type="button"
                        title={packageMutationBlockedReason || undefined}
                        disabled={!selectedPackage.canMutate || pendingAction === `enable:${selectedPackage.packageId}`}
                        onClick={() => handleEnablePackage(selectedPackage.packageId)}
                      >
                        Enable
                      </button>
                    ) : null}
                    <button
                      class="packages-button"
                      type="button"
                      title={selectedPackage.isBuiltin ? "Builtin packages are refreshed through Sync sources." : packageMutationBlockedReason || undefined}
                      disabled={selectedPackage.isBuiltin || !selectedPackage.canMutate || pendingAction === `refresh:${selectedPackage.packageId}`}
                      onClick={() => handleRefreshPackage(selectedPackage.packageId)}
                    >
                      Pull upstream
                    </button>
                    {!selectedPackage.isBuiltin ? (
                      <button
                        class="packages-button"
                        type="button"
                        title={packageVisibilityBlockedReason || undefined}
                        disabled={!selectedPackage.canChangeVisibility || pendingAction === `public:${selectedPackage.packageId}`}
                        onClick={() => handleSetPublic({ packageId: selectedPackage.packageId, public: !selectedPackage.source.public })}
                      >
                        {selectedPackage.source.public ? "Hide" : "Publish"}
                      </button>
                    ) : null}
                  </div>
                </header>

                <nav class="packages-detail-tabs">
                  {([
                    ["overview", "Overview"],
                    ["permissions", "Permissions"],
                    ["code", "Code"],
                    ["commits", "Commits"],
                    ["changes", "Changes"],
                    ["review", "Review"],
                  ] as Array<[PackageDetailTab, string]>).map(([tabId, label]) => (
                    <button key={tabId} class={`packages-detail-tab${detailTab === tabId ? " is-active" : ""}`} onClick={() => updateRoute({ tab: tabId })}>{label}</button>
                  ))}
                </nav>

                <section class="packages-detail-body">
                  {detailTab === "overview" ? (
                    <>
                      <div class="packages-info-grid">
                        <article><span>Runtime</span><strong>{selectedPackage.runtime}</strong></article>
                        <article><span>Version</span><strong>{selectedPackage.version}</strong></article>
                        <article><span>Source</span><strong>{selectedPackage.source.repo}</strong></article>
                        <article><span>Ref</span><strong>{selectedPackage.source.ref}</strong></article>
                        <article><span>Commit</span><strong class="packages-mono">{shortHash(selectedPackage.source.resolvedCommit)}</strong></article>
                        <article><span>Updated</span><strong>{formatDate(selectedPackage.updatedAt)}</strong></article>
                      </div>
                      <section class="packages-subsection">
                        <header>
                          <h3>Entrypoints</h3>
                          <p>Launch surfaces and commands exposed by this package.</p>
                        </header>
                        <div class="packages-table">
                          <div class="packages-table-head">
                            <span>Name</span>
                            <span>Kind</span>
                            <span>Details</span>
                          </div>
                          {selectedPackage.entrypoints.length === 0 ? <div class="packages-empty-state">No entrypoints declared.</div> : selectedPackage.entrypoints.map((entry) => (
                            <div key={`${entry.name}:${entry.kind}`} class="packages-table-row packages-table-row--catalog">
                              <div>
                                <strong>{entry.name}</strong>
                                <span>{entry.description || "No description"}</span>
                              </div>
                              <span>{entry.kind}</span>
                              <span class="packages-mono">{entry.route || (entry.syscalls?.join(", ") || "—")}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    </>
                  ) : null}

                  {detailTab === "permissions" ? (
                    <>
                      <section class="packages-subsection">
                        <header>
                          <h3>Impact summary</h3>
                          <p>What this package can affect, based on declared bindings and syscall surfaces.</p>
                        </header>
                        <ul class="packages-bullet-list">
                          {packagePermissionSummary.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </section>
                      <div class="packages-columns">
                        <section class="packages-subsection">
                          <header>
                            <h3>Bindings</h3>
                            <p>Declared runtime bindings requested by the package.</p>
                          </header>
                          <div class="packages-chip-row">
                            {selectedPackage.bindingNames.length > 0 ? selectedPackage.bindingNames.map((binding) => <span key={binding} class="packages-chip">{binding}</span>) : <span class="packages-empty-inline">No declared bindings.</span>}
                          </div>
                        </section>
                        <section class="packages-subsection">
                          <header>
                            <h3>Syscalls</h3>
                            <p>Entry-point syscall exposure declared by the package.</p>
                          </header>
                          <div class="packages-chip-row">
                            {selectedPackage.declaredSyscalls.length > 0 ? selectedPackage.declaredSyscalls.map((syscall) => <span key={syscall} class="packages-chip">{syscall}</span>) : <span class="packages-empty-inline">No declared syscalls.</span>}
                          </div>
                        </section>
                      </div>
                    </>
                  ) : null}

                  {detailTab === "code" ? (
                    <>
                      <section class="packages-subsection">
                        <header>
                          <h3>Source browser</h3>
                          <p>Read-only repository inspection for trust review and update checks.</p>
                        </header>
                        <div class="packages-code-toolbar">
                          <div class="packages-chip-row">
                            <button class={`packages-mini-tab${codeRoot === "package" ? " is-active" : ""}`} type="button" onClick={() => { setCodeRoot("package"); setCodePath(""); setCodeSearchResult(null); }}>Package root</button>
                            <button class={`packages-mini-tab${codeRoot === "repo" ? " is-active" : ""}`} type="button" onClick={() => { setCodeRoot("repo"); setCodePath(""); setCodeSearchResult(null); }}>Full repo</button>
                          </div>
                          <div class="packages-inline-grid packages-inline-grid--checkout">
                            <select value={codeRef} onChange={(event) => { setCodeRef((event.currentTarget as HTMLSelectElement).value); setCodePath(""); setCodeSearchResult(null); }}>
                              {browseRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
                            </select>
                            <button class="packages-button" type="button" disabled={!codePath} onClick={() => setCodePath(parentPath(codePath))}>Up one level</button>
                          </div>
                        </div>
                        <div class="packages-inline-grid packages-inline-grid--code-search">
                          <input value={codeSearch} onInput={(event) => setCodeSearch((event.currentTarget as HTMLInputElement).value)} placeholder="Search in source" />
                          <button class="packages-button" type="button" disabled={codeSearchBusy} onClick={handleSearchRepo}>Search</button>
                        </div>
                        <div class="packages-code-layout">
                          <aside class="packages-code-sidebar">
                            <div class="packages-breadcrumbs">
                              <button class="packages-breadcrumb" type="button" onClick={() => setCodePath("")}>{codeRoot}</button>
                              {buildBreadcrumbs(codePath).map((crumb) => (
                                <button key={crumb.path} class="packages-breadcrumb" type="button" onClick={() => setCodePath(crumb.path)}>{crumb.label}</button>
                              ))}
                            </div>
                            {codeSearchResult ? (
                              <div class="packages-search-panel">
                                <div class="packages-search-panel-head">
                                  <strong>Search results</strong>
                                  <span>{codeSearchResult.matches.length} match{codeSearchResult.matches.length === 1 ? "" : "es"}</span>
                                </div>
                                {codeSearchResult.truncated ? <div class="packages-empty-inline">Search results truncated.</div> : null}
                                <div class="packages-search-results">
                                  {codeSearchResult.matches.map((match) => (
                                    <button key={`${match.path}:${match.line}:${match.content}`} class="packages-search-result" type="button" onClick={() => setCodePath(match.path)}>
                                      <strong>{match.path}</strong>
                                      <span>Line {match.line}</span>
                                      <code>{match.content}</code>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {codeRead?.kind === "tree" ? (
                              <div class="packages-tree-list">
                                {sortTreeEntries(codeRead.entries).map((entry) => (
                                  <button key={entry.path} class={`packages-tree-row${entry.type === "tree" ? " is-tree" : ""}`} type="button" onClick={() => setCodePath(entry.path)}>
                                    <span class="packages-tree-name">{entry.type === "tree" ? "▸" : "•"} {entry.name}</span>
                                    <span class="packages-mono">{entry.type}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            {codeRead?.kind === "file" ? (
                              <div class="packages-tree-list">
                                <button class="packages-tree-row is-tree" type="button" onClick={() => setCodePath(parentPath(codeRead.path))}>
                                  <span class="packages-tree-name">▸ ..</span>
                                  <span class="packages-mono">tree</span>
                                </button>
                              </div>
                            ) : null}
                          </aside>
                          <section class="packages-code-main">
                            {codeBusy ? <div class="packages-empty-state">Loading source…</div> : null}
                            {codeError ? <div class="packages-empty-state">{codeError}</div> : null}
                            {!codeBusy && !codeError && codeRead?.kind === "tree" ? (
                              <div class="packages-empty-state">Select a file from the tree or search results.</div>
                            ) : null}
                            {!codeBusy && !codeError && codeRead?.kind === "file" ? (
                              <div class="packages-file-viewer">
                                <div class="packages-file-meta">
                                  <strong>{codeRead.path || "/"}</strong>
                                  <span>{formatBytes(codeRead.size)} · {codeRead.isBinary ? "binary" : "text"}</span>
                                </div>
                                {codeRead.isBinary ? (
                                  <div class="packages-empty-state">This file is binary and cannot be previewed inline.</div>
                                ) : (
                                  <pre class="packages-code-block">{codeRead.content ?? ""}</pre>
                                )}
                              </div>
                            ) : null}
                          </section>
                        </div>
                      </section>
                    </>
                  ) : null}

                  {detailTab === "commits" ? (
                    <>
                      <section class="packages-subsection">
                        <header>
                          <h3>Ref selection</h3>
                          <p>Switch the installed package to a different branch or tag from the same source repository.</p>
                        </header>
                        <div class="packages-inline-grid packages-inline-grid--checkout">
                          <select value={checkoutRef} onChange={(event) => setCheckoutRef((event.currentTarget as HTMLSelectElement).value)}>
                            {browseRefs.map((ref) => (
                              <option key={ref} value={ref}>{ref}</option>
                            ))}
                          </select>
                          <button
                            class="packages-button"
                            type="button"
                            title={packageMutationBlockedReason || undefined}
                            disabled={!selectedPackage.canMutate || pendingAction === `checkout:${selectedPackage.packageId}` || !checkoutRef}
                            onClick={() => handleCheckout(selectedPackage.packageId)}
                          >
                            Use ref
                          </button>
                        </div>
                        <div class="packages-ref-summary">
                          <span>Active ref: <strong>{state?.packageDetail?.refs.activeRef || selectedPackage.source.ref}</strong></span>
                          <span>Resolved commit: <strong class="packages-mono">{shortHash(selectedPackage.source.resolvedCommit)}</strong></span>
                          <span>Head commit: <strong class="packages-mono">{shortHash(selectedPackage.currentHead)}</strong></span>
                        </div>
                      </section>
                      <section class="packages-subsection">
                        <header>
                          <h3>Recent commits</h3>
                          <p>Latest source commits for the selected package repository.</p>
                        </header>
                        <div class="packages-commit-list">
                          {(state?.packageDetail?.commits ?? []).map((commit) => (
                            <div key={commit.hash} class={`packages-commit-row${selectedCommit === commit.hash ? " is-active" : ""}`}>
                              <button class="packages-commit-main" type="button" onClick={() => setSelectedCommit(commit.hash)}>
                                <strong>{firstLine(commit.message)}</strong>
                                <span class="packages-mono">{shortHash(commit.hash)}</span>
                                <span>{commit.author} · {formatCommitTime(commit.commitTime)}</span>
                              </button>
                              <button class="packages-button" type="button" onClick={() => { setSelectedCommit(commit.hash); updateRoute({ tab: "changes" }); }}>View diff</button>
                            </div>
                          ))}
                        </div>
                      </section>
                    </>
                  ) : null}

                  {detailTab === "changes" ? (
                    <>
                      <section class="packages-subsection">
                        <header>
                          <h3>Commit diff</h3>
                          <p>Inspect what changed in the selected source commit.</p>
                        </header>
                        <div class="packages-chip-row">
                          {(state?.packageDetail?.commits ?? []).slice(0, 10).map((commit) => (
                            <button key={commit.hash} class={`packages-mini-tab${selectedCommit === commit.hash ? " is-active" : ""}`} type="button" onClick={() => setSelectedCommit(commit.hash)}>
                              {shortHash(commit.hash)}
                            </button>
                          ))}
                        </div>
                        {selectedCommitRecord ? (
                          <div class="packages-ref-summary">
                            <span><strong>{firstLine(selectedCommitRecord.message)}</strong></span>
                            <span>{selectedCommitRecord.author} · {formatCommitTime(selectedCommitRecord.commitTime)}</span>
                          </div>
                        ) : null}
                        {diffBusy ? <div class="packages-empty-state">Loading diff…</div> : null}
                        {diffError ? <div class="packages-empty-state">{diffError}</div> : null}
                        {!diffBusy && !diffError && diffResult ? (
                          <>
                            <div class="packages-info-grid packages-info-grid--compact">
                              <article><span>Files changed</span><strong>{diffResult.stats.filesChanged}</strong></article>
                              <article><span>Additions</span><strong>{diffResult.stats.additions}</strong></article>
                              <article><span>Deletions</span><strong>{diffResult.stats.deletions}</strong></article>
                            </div>
                            <div class="packages-diff-list">
                              {diffResult.files.map((file) => (
                                <DiffFileView key={`${diffResult.commitHash}:${file.path}`} file={file} />
                              ))}
                            </div>
                          </>
                        ) : null}
                      </section>
                    </>
                  ) : null}

                  {detailTab === "review" ? (
                    <>
                      <div class="packages-info-grid">
                        <article><span>Review required</span><strong>{selectedPackage.review.required ? "Yes" : "No"}</strong></article>
                        <article><span>Approved</span><strong>{selectedPackage.review.approvedAt ? formatDate(selectedPackage.review.approvedAt) : "Not yet"}</strong></article>
                        <article><span>Update status</span><strong>{selectedPackage.updateAvailable ? "Behind source head" : "Current"}</strong></article>
                        <article><span>Head commit</span><strong class="packages-mono">{shortHash(selectedPackage.currentHead)}</strong></article>
                      </div>
                      <section class="packages-subsection">
                        <header>
                          <h3>Review workflow</h3>
                          <p>Use the dedicated review process plus the built-in code and diff tabs before enabling or approving a package.</p>
                        </header>
                        <ul class="packages-bullet-list">
                          <li>Open a review session when the package is new, changes capabilities, or comes from an unfamiliar source.</li>
                          <li>Use Code to inspect entrypoints and sensitive files, and Changes to inspect update diffs before approving.</li>
                          <li>Approve only after checking shell, process, filesystem, host-bridge, and package-management behavior.</li>
                        </ul>
                      </section>
                    </>
                  ) : null}
                </section>
              </>
            ) : (
              <section class="packages-empty-state packages-empty-state--full">Select a package to inspect it.</section>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function DiffFileView({ file }: { file: PackageRepoDiffFile }) {
  return (
    <article class="packages-diff-file">
      <header class="packages-diff-file-head">
        <strong>{file.path}</strong>
        <span class={`packages-badge ${diffStatusClass(file.status)}`}>{file.status}</span>
      </header>
      {file.hunks && file.hunks.length > 0 ? file.hunks.map((hunk) => (
        <section key={`${file.path}:${hunk.oldStart}:${hunk.newStart}`} class="packages-diff-hunk">
          <div class="packages-diff-hunk-head">@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</div>
          <pre class="packages-diff-block">{hunk.lines.map((line, index) => (
            <div key={index} class={`packages-diff-line is-${line.tag}`}>{prefixForDiffLine(line.tag)}{line.content}</div>
          ))}</pre>
        </section>
      )) : <div class="packages-empty-state">No text hunks available for this file.</div>}
    </article>
  );
}

function readViewFromLocation(): PackagesView {
  const value = new URL(window.location.href).searchParams.get("view");
  return value === "updates" || value === "review" || value === "sources" ? value : "installed";
}

function readScopeFromLocation(): PackageScopeFilter {
  const value = new URL(window.location.href).searchParams.get("scope");
  return value === "mine" || value === "system" ? value : "all";
}

function readTabFromLocation(): PackageDetailTab {
  const value = new URL(window.location.href).searchParams.get("tab");
  return value === "permissions" || value === "code" || value === "commits" || value === "changes" || value === "review"
    ? value
    : "overview";
}

function readPackageIdFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("package");
  return value && value.trim() ? value.trim() : null;
}

function readSourceFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("source");
  return value && value.trim() ? value.trim() : null;
}

function readCatalogFromLocation(): string {
  const value = new URL(window.location.href).searchParams.get("catalog");
  return value && value.trim() ? value.trim() : "local";
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 7) : "unknown";
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleString();
}

function formatCommitTime(unixSeconds: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "unknown";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] || "No commit message";
}

function formatScope(pkg: PackageRecord): string {
  if (pkg.scope.kind === "user") return "Mine";
  if (pkg.scope.kind === "workspace") return `Workspace:${pkg.scope.workspaceId ?? "?"}`;
  return "System";
}

function buildPermissionSummary(pkg: PackageRecord): string[] {
  const notes = new Set<string>();
  if (pkg.bindingNames.includes("KERNEL")) {
    notes.add("Can call kernel-backed app RPC through the package runtime bridge.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("shell."))) {
    notes.add("Can execute shell commands on the control target or a routed device.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("fs."))) {
    notes.add("Can read or modify files exposed through the filesystem tool surface.");
  }
  if (pkg.declaredSyscalls.includes("proc.spawn")) {
    notes.add("Can spawn new processes and route work into additional runtime contexts.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("pkg."))) {
    notes.add("Can inspect or change package state, including install/enable/update flows.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.config."))) {
    notes.add("Can modify system configuration.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.token."))) {
    notes.add("Can issue or revoke access tokens.");
  }
  if (pkg.declaredSyscalls.some((syscall) => syscall.startsWith("sys.link") || syscall.startsWith("sys.unlink"))) {
    notes.add("Can modify identity links and trust relationships.");
  }
  if (notes.size === 0) {
    notes.add("No elevated bindings or syscall surfaces were declared in the package summary.");
  }
  return [...notes];
}

function renderEntryActions(pkg: PackageRecord) {
  return pkg.uiEntrypoints.flatMap((entrypoint) => {
    const route = entrypoint.route?.trim();
    if (!route) return [];
    const appId = appIdFromRoute(route) || pkg.name;
    return [
      <button key={`${entrypoint.name}:${route}`} class="packages-button" type="button" onClick={() => openCompanion(appId, route)}>
        {pkg.uiEntrypoints.length === 1 ? "Open" : `Open ${entrypoint.name}`}
      </button>,
    ];
  });
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function buildRefOptions(state: PackagesState["packageDetail"] | null | undefined, fallback?: string): string[] {
  const refs = state ? [...Object.keys(state.refs.heads), ...Object.keys(state.refs.tags)] : [];
  if (fallback) {
    refs.push(fallback);
  }
  return unique(refs).sort((left, right) => left.localeCompare(right));
}

function matchInstalledPackage(entry: CatalogEntry, packages: PackageRecord[]): PackageRecord | null {
  return packages.find((pkg) =>
    pkg.source.repo === entry.source.repo &&
    pkg.source.subdir === entry.source.subdir,
  ) ?? null;
}

function catalogImportSource(catalog: CatalogRecord, entry: CatalogEntry): string {
  if (catalog.kind === "remote" && catalog.baseUrl) {
    const [owner, repo] = entry.source.repo.split("/");
    if (owner && repo) {
      return `${catalog.baseUrl.replace(/\/+$/g, "")}/git/${owner}/${repo}.git`;
    }
  }
  return entry.source.repo;
}

function appIdFromRoute(route: string): string {
  const match = route.match(/\/apps\/([^/?#]+)/);
  return match?.[1] ?? "";
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function sortTreeEntries(entries: RepoTreeEntry[]): RepoTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "tree" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function diffStatusClass(status: PackageRepoDiffFile["status"]): string {
  if (status === "added") return "is-enabled";
  if (status === "deleted") return "is-disabled";
  return "is-update";
}

function prefixForDiffLine(tag: string): string {
  if (tag === "add") return "+";
  if (tag === "delete") return "-";
  if (tag === "binary") return "#";
  return " ";
}

function openCompanion(appId: string, route: string) {
  try {
    if (window.parent && window.parent !== window) {
      const detail = { appId, route };
      window.parent.postMessage({ type: "gsv:open-app", detail }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent("gsv:open-app", { detail }));
      return;
    }
  } catch {
  }
  window.location.href = route;
}

function openChatProcess(detail: { pid: string; workspaceId: string | null; cwd: string | null }) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "gsv:open-chat-process", detail }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent("gsv:open-chat-process", { detail }));
      return;
    }
  } catch {
  }
}
