import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getAppBoot } from "@gsv/package/browser";
import { ArticleView } from "./article-view";
import {
  buildEntryHref,
  extractHeadings,
  extractTitle
} from "./markdown";
import { PreviewCard } from "./preview-card";
import type { WikiBackend, WikiEntry, WikiMutationResult, WikiPreviewPayload, WikiPreviewRequest, WikiState } from "./types";

type Props = {
  backend: WikiBackend;
};

type RouteState = {
  db: string;
  path: string;
  q: string;
  ask: string;
};

type PreviewState = {
  key: string;
  anchorRect: DOMRect;
  request: WikiPreviewRequest;
  pinned: boolean;
  loading: boolean;
  payload: WikiPreviewPayload | null;
  error: string;
};

function readRoute(): RouteState {
  const url = new URL(window.location.href);
  return {
    db: url.searchParams.get("db")?.trim() || "",
    path: url.searchParams.get("path")?.trim() || "",
    q: url.searchParams.get("q")?.trim() || "",
    ask: url.searchParams.get("ask")?.trim() || "",
  };
}

function writeRoute(route: RouteState, replace = false) {
  const url = new URL(window.location.href);
  for (const key of ["db", "path", "q", "ask"] as const) {
    const value = route[key];
    if (value) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }
  window.history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}${url.hash}`);
}

function previewKey(request: WikiPreviewRequest): string {
  return JSON.stringify(request);
}

function pageLabel(entry: WikiEntry): string {
  return entry.title || entry.path.split("/").pop() || entry.path;
}

function defaultEditorPath(state: WikiState | null): string {
  if (!state) {
    return "product/pages/topic.md";
  }
  if (state.selectedNote?.path) {
    return state.selectedNote.path;
  }
  return state.selectedDb ? `${state.selectedDb}/pages/topic.md` : "product/pages/topic.md";
}

export function App({ backend }: Props) {
  const routeBase = getAppBoot().routeBase;
  const [route, setRoute] = useState<RouteState>(() => readRoute());
  const [state, setState] = useState<WikiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");

  const [searchDraft, setSearchDraft] = useState(route.q);
  const [queryDraft, setQueryDraft] = useState(route.ask);
  const [editorPath, setEditorPath] = useState("");
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [compileTarget, setCompileTarget] = useState("");
  const [newDbId, setNewDbId] = useState("");
  const [newDbTitle, setNewDbTitle] = useState("");
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestSummary, setIngestSummary] = useState("");
  const [ingestSources, setIngestSources] = useState("");
  const [buildTarget, setBuildTarget] = useState("gsv");
  const [buildSourcePath, setBuildSourcePath] = useState("");
  const [buildDbId, setBuildDbId] = useState("");
  const [buildDbTitle, setBuildDbTitle] = useState("");

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestId = useRef(0);
  const loadRequestId = useRef(0);

  const navigate = useCallback((nextRoute: Partial<RouteState>, replace = false) => {
    const merged: RouteState = {
      ...route,
      ...nextRoute,
    };
    console.debug("[wiki] navigate", { nextRoute, merged, replace });
    writeRoute(merged, replace);
    setRoute(merged);
  }, [route]);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setSearchDraft(route.q);
    setQueryDraft(route.ask);
  }, [route.q, route.ask]);

  useEffect(() => {
    const requestId = ++loadRequestId.current;
    console.debug("[wiki] loadState", { route, requestId });
    setLoading(true);
    void backend.loadState(route)
      .then((nextState) => {
        if (requestId !== loadRequestId.current) {
          return;
        }
        setState(nextState);
        setErrorText(nextState.errorText || "");
      })
      .catch((error) => {
        if (requestId !== loadRequestId.current) {
          return;
        }
        setErrorText(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestId === loadRequestId.current) {
          setLoading(false);
        }
      });
  }, [backend, route]);

  useEffect(() => {
    setEditorPath(defaultEditorPath(state));
    setEditorMarkdown(state?.selectedNote?.markdown || "");
    setCompileTarget("");
    setBuildDbId(state?.selectedDb || "");
  }, [state?.selectedPath, state?.selectedNote?.markdown, state?.selectedDb]);

  const articleMarkdown = state?.selectedNote?.markdown || "";
  const articleTitle = useMemo(() => {
    const fallback = state?.selectedPath?.split("/").pop() || state?.selectedDb || "Wiki";
    return extractTitle(articleMarkdown, fallback);
  }, [articleMarkdown, state?.selectedDb, state?.selectedPath]);
  const headings = useMemo(() => extractHeadings(articleMarkdown), [articleMarkdown]);
  const canCompile = Boolean(state?.selectedDb && state?.selectedPath?.startsWith(`${state.selectedDb}/inbox/`));

  const runMutation = useCallback(async (operation: Promise<WikiMutationResult>) => {
    try {
      const result = await operation;
      setStatusText(result.statusText);
      setErrorText("");
      navigate({ db: result.db, path: result.openPath, q: "", ask: "" });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [navigate]);

  const clearPreviewHide = useCallback(() => {
    if (previewTimerRef.current != null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }, []);

  const scheduleHidePreview = useCallback((force: boolean) => {
    clearPreviewHide();
    previewTimerRef.current = window.setTimeout(() => {
      setPreview((current) => {
        if (!current) {
          return null;
        }
        if (!force && current.pinned) {
          return current;
        }
        return null;
      });
    }, 120);
  }, [clearPreviewHide]);

  const openPreview = useCallback((anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean) => {
    clearPreviewHide();
    const key = previewKey(request);
    const anchorRect = anchor.getBoundingClientRect();
    let shouldFetch = true;
    setPreview((current) => {
      if (pin && current?.pinned && current.key === key) {
        shouldFetch = false;
        return null;
      }
      if (!pin && current?.pinned && current.key !== key) {
        shouldFetch = false;
        return current;
      }
      if (!pin && current?.key === key) {
        shouldFetch = false;
        return {
          ...current,
          anchorRect,
        };
      }
      return {
        key,
        anchorRect,
        request,
        pinned: pin ? true : current?.key === key ? current.pinned : false,
        loading: true,
        payload: current?.key === key ? current.payload : null,
        error: "",
      };
    });
    if (!shouldFetch) {
      return;
    }
    const requestId = ++previewRequestId.current;
    void backend.preview(request)
      .then((payload) => {
        if (requestId !== previewRequestId.current) {
          return;
        }
        setPreview((current) => {
          if (!current || current.key !== key) {
            return current;
          }
          return {
            ...current,
            loading: false,
            payload,
            error: payload.ok ? "" : payload.error,
            pinned: pin ? true : current.pinned,
          };
        });
      })
      .catch((error) => {
        if (requestId !== previewRequestId.current) {
          return;
        }
        setPreview((current) => {
          if (!current || current.key !== key) {
            return current;
          }
          return {
            ...current,
            loading: false,
            payload: null,
            error: error instanceof Error ? error.message : String(error),
            pinned: pin ? true : current.pinned,
          };
        });
      });
  }, [backend, clearPreviewHide]);

  const articleNavigate = useCallback((path: string) => {
    navigate({ db: path.split("/")[0] || state?.selectedDb || "", path, q: "", ask: "" });
  }, [navigate, state?.selectedDb]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        scheduleHidePreview(true);
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(".wiki-preview-card") || target.closest("[data-preview-kind]")) {
        return;
      }
      scheduleHidePreview(true);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [scheduleHidePreview]);

  return (
    <>
      <header class="masthead">
        <div>
          <div class="wordmark">Wiki</div>
          <div class="tagline">Compiled knowledge pages with explicit inbox review and live source references.</div>
        </div>
        <div class="tagline">{state?.selectedDb || "no database selected"}</div>
      </header>
      <main class="frame">
        <aside class="rail left">
          <section class="panel">
            <h2>Databases</h2>
            {state?.dbs?.length ? (
              <ul class="nav-list">
                {state.dbs.map((db) => (
                  <li key={db.id}>
                    <a
                      href={buildEntryHref(routeBase, db.id, "")}
                      aria-current={db.id === state.selectedDb ? "page" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate({ db: db.id, path: "", q: "", ask: "" });
                      }}
                    >
                      {db.title || db.id}
                    </a>
                    <div class="nav-meta">{db.id}</div>
                  </li>
                ))}
              </ul>
            ) : <p class="muted">No knowledge databases yet.</p>}
          </section>
          <section class="panel">
            <h3>Pages</h3>
            {state?.selectedDb ? (
              state.pages.length ? (
                <ul class="nav-list">
                  {state.pages.map((entry) => (
                    <li key={entry.path}>
                      <a
                        href={buildEntryHref(routeBase, state.selectedDb, entry.path)}
                        aria-current={entry.path === state.selectedPath ? "page" : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate({ db: state.selectedDb, path: entry.path, q: "", ask: "" });
                        }}
                      >
                        {pageLabel(entry)}
                      </a>
                      <div class="nav-meta">{entry.path}</div>
                    </li>
                  ))}
                </ul>
              ) : <p class="muted">No canonical pages yet.</p>
            ) : <p class="muted">Select a database to browse pages.</p>}
          </section>
          <section class="panel">
            <h3>Inbox</h3>
            {state?.selectedDb ? (
              state.inbox.length ? (
                <ul class="nav-list">
                  {state.inbox.map((entry) => (
                    <li key={entry.path}>
                      <a
                        href={buildEntryHref(routeBase, state.selectedDb, entry.path)}
                        aria-current={entry.path === state.selectedPath ? "page" : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate({ db: state.selectedDb, path: entry.path, q: "", ask: "" });
                        }}
                      >
                        {pageLabel(entry)}
                      </a>
                      <div class="nav-meta">{entry.path}</div>
                    </li>
                  ))}
                </ul>
              ) : <p class="muted">No staged inbox notes.</p>
            ) : <p class="muted">Select a database to browse inbox notes.</p>}
          </section>
        </aside>
        <section class="article-wrap">
          <div class="notice-stack">
            {statusText ? <div class="notice">{statusText}</div> : null}
            {errorText ? <div class="notice error">{errorText}</div> : null}
            {loading ? <div class="notice">Loading wiki…</div> : null}
          </div>
          <article class="article">
            <div class="breadcrumbs">{state?.selectedDb || "wiki"}{state?.selectedPath ? ` / ${state.selectedPath}` : ""}</div>
            <h1>{articleTitle || "Wiki"}</h1>
            <div class="page-path">{state?.selectedPath || "No page selected."}</div>
            <ArticleView
              markdown={articleMarkdown}
              articleTitle={articleTitle}
              routeBase={routeBase}
              selectedDb={state?.selectedDb || ""}
              selectedPath={state?.selectedPath || ""}
              onNavigate={articleNavigate}
              onPreviewOpen={openPreview}
              onPreviewHide={scheduleHidePreview}
            />
          </article>
        </section>
        <aside class="rail right">
          <section class="panel tools">
            <h2>Page tools</h2>
            {headings.length > 0 ? (
              <div style={{ marginBottom: "14px" }}>
                <h3>Contents</h3>
                <ol class="toc-list">
                  {headings.map((heading) => (
                    <li key={heading.id} class={`level-${heading.level}`}>
                      <a href={`#${heading.id}`}>{heading.text}</a>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <form onSubmit={(event) => {
              event.preventDefault();
              navigate({ db: state?.selectedDb || "", path: state?.selectedPath || "", q: searchDraft, ask: queryDraft });
            }}>
              <div class="field">
                <label for="wiki-search">Search</label>
                <input id="wiki-search" type="text" value={searchDraft} onInput={(event) => setSearchDraft((event.currentTarget as HTMLInputElement).value)} placeholder="Find pages or inbox notes" />
              </div>
              <div class="field">
                <label for="wiki-query">Query</label>
                <input id="wiki-query" type="text" value={queryDraft} onInput={(event) => setQueryDraft((event.currentTarget as HTMLInputElement).value)} placeholder="What does this wiki say about auth?" />
              </div>
              <button type="submit" class="primary">Refresh view</button>
            </form>
            {state?.queryText && state.queryResult ? (
              <details open>
                <summary>Query result</summary>
                <div class="detail-body">
                  <div style={{ whiteSpace: "pre-wrap", marginBottom: "12px" }}>{state.queryResult.brief || ""}</div>
                  <ul class="result-list">
                    {state.queryResult.refs.map((ref) => (
                      <li key={ref.path}>
                        <a href={buildEntryHref(routeBase, state.selectedDb, ref.path)} onClick={(event) => {
                          event.preventDefault();
                          navigate({ db: state.selectedDb, path: ref.path, q: "", ask: "" });
                        }}>{ref.title || ref.path}</a>
                        <div class="nav-meta">{ref.path}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
            {state?.searchQuery ? (
              <details open>
                <summary>Search matches</summary>
                <div class="detail-body">
                  {state.searchMatches && state.searchMatches.length > 0 ? (
                    <ul class="result-list">
                      {state.searchMatches.map((match) => (
                        <li key={match.path}>
                          <a href={buildEntryHref(routeBase, state.selectedDb, match.path)} onClick={(event) => {
                            event.preventDefault();
                            navigate({ db: state.selectedDb, path: match.path, q: "", ask: "" });
                          }}>{match.title || match.path}</a>
                          <div class="nav-meta">{match.path}</div>
                          <div>{match.snippet || ""}</div>
                        </li>
                      ))}
                    </ul>
                  ) : <p class="muted">No entries matched the current search.</p>}
                </div>
              </details>
            ) : null}
            <details>
              <summary>Write page</summary>
              <div class="detail-body">
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void runMutation(backend.writePage({ db: state?.selectedDb || "", path: editorPath, markdown: editorMarkdown }));
                }}>
                  <div class="field">
                    <label for="wiki-path">Path</label>
                    <input id="wiki-path" type="text" value={editorPath} onInput={(event) => setEditorPath((event.currentTarget as HTMLInputElement).value)} placeholder={state?.selectedDb ? "pages/topic.md" : "product/pages/topic.md"} />
                  </div>
                  <div class="field">
                    <label for="wiki-markdown">Markdown</label>
                    <textarea id="wiki-markdown" value={editorMarkdown} onInput={(event) => setEditorMarkdown((event.currentTarget as HTMLTextAreaElement).value)} placeholder="# Topic\n\n## Summary\nCompiled knowledge goes here." />
                  </div>
                  <button type="submit" class="primary">Save page</button>
                  {canCompile ? (
                    <>
                      <button
                        type="button"
                        style={{ marginLeft: "8px" }}
                        onClick={() => void runMutation(backend.compileInboxNote({
                          db: state?.selectedDb || "",
                          sourcePath: state?.selectedPath || "",
                          targetPath: compileTarget,
                        }))}
                      >
                        Compile inbox note
                      </button>
                      <div class="field" style={{ marginTop: "12px" }}>
                        <label for="compile-target">Compile target</label>
                        <input id="compile-target" type="text" value={compileTarget} onInput={(event) => setCompileTarget((event.currentTarget as HTMLInputElement).value)} placeholder="pages/compiled-page.md" />
                      </div>
                    </>
                  ) : null}
                </form>
              </div>
            </details>
            <details>
              <summary>Create from directory</summary>
              <div class="detail-body">
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void runMutation(backend.startBuildFromDirectory({
                    buildTarget,
                    buildSourcePath,
                    buildDbId,
                    buildDbTitle,
                  }));
                }}>
                  <div class="field">
                    <label for="build-target">Source target</label>
                    <input id="build-target" type="text" value={buildTarget} onInput={(event) => setBuildTarget((event.currentTarget as HTMLInputElement).value)} placeholder="gsv" />
                  </div>
                  <div class="field">
                    <label for="build-source-path">Source directory</label>
                    <input id="build-source-path" type="text" value={buildSourcePath} onInput={(event) => setBuildSourcePath((event.currentTarget as HTMLInputElement).value)} placeholder="/workspaces/project/docs" />
                  </div>
                  <div class="field">
                    <label for="build-db-id">Target database</label>
                    <input id="build-db-id" type="text" value={buildDbId} onInput={(event) => setBuildDbId((event.currentTarget as HTMLInputElement).value)} placeholder="product-alpha" />
                  </div>
                  <div class="field">
                    <label for="build-db-title">Database title</label>
                    <input id="build-db-title" type="text" value={buildDbTitle} onInput={(event) => setBuildDbTitle((event.currentTarget as HTMLInputElement).value)} placeholder="Product Alpha" />
                  </div>
                  <button type="submit">Start background build</button>
                </form>
              </div>
            </details>
            <details>
              <summary>Stage source refs</summary>
              <div class="detail-body">
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void runMutation(backend.ingestSourcesToInbox({
                    db: state?.selectedDb || "",
                    title: ingestTitle,
                    summary: ingestSummary,
                    sources: ingestSources,
                  }));
                }}>
                  <div class="field">
                    <label for="ingest-title">Title</label>
                    <input id="ingest-title" type="text" value={ingestTitle} onInput={(event) => setIngestTitle((event.currentTarget as HTMLInputElement).value)} placeholder="Adapter UX inputs" />
                  </div>
                  <div class="field">
                    <label for="ingest-summary">Summary</label>
                    <input id="ingest-summary" type="text" value={ingestSummary} onInput={(event) => setIngestSummary((event.currentTarget as HTMLInputElement).value)} placeholder="Collected notes for onboarding and approval UX" />
                  </div>
                  <div class="field">
                    <label for="ingest-sources">Sources</label>
                    <textarea id="ingest-sources" value={ingestSources} onInput={(event) => setIngestSources((event.currentTarget as HTMLTextAreaElement).value)} placeholder={"gsv:/workspaces/gsv/docs/alpha-plan.md::Alpha plan\nmacbook:/Users/hank/Downloads/adapter-notes.txt::Adapter notes"} />
                  </div>
                  <button type="submit">Stage sources</button>
                </form>
              </div>
            </details>
            <details>
              <summary>Create database</summary>
              <div class="detail-body">
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void runMutation(backend.createDatabase({ dbId: newDbId, dbTitle: newDbTitle }));
                }}>
                  <div class="field">
                    <label for="db-id">Id</label>
                    <input id="db-id" type="text" value={newDbId} onInput={(event) => setNewDbId((event.currentTarget as HTMLInputElement).value)} placeholder="product-alpha" />
                  </div>
                  <div class="field">
                    <label for="db-title">Title</label>
                    <input id="db-title" type="text" value={newDbTitle} onInput={(event) => setNewDbTitle((event.currentTarget as HTMLInputElement).value)} placeholder="Product Alpha" />
                  </div>
                  <button type="submit">Create database</button>
                </form>
              </div>
            </details>
          </section>
        </aside>
      </main>
      {preview ? (
        <PreviewCard
          anchorRect={preview.anchorRect}
          loading={preview.loading}
          payload={preview.payload}
          error={preview.error}
          pinned={preview.pinned}
          onMouseEnter={clearPreviewHide}
          onMouseLeave={() => scheduleHidePreview(false)}
        />
      ) : null}
    </>
  );
}
