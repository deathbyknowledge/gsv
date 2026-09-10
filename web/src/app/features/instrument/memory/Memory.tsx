import { useDraftGuard } from "../shared/useDraftGuard";
import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { listLibraryCollections, saveLibraryPage } from "../../gsv-console/library/libraryService";
import { libraryPathInDb } from "../../gsv-console/library/libraryModel";
import type { MemoryPageRef } from "../shared/navigation";
import type { LibrarySavePageInput, LibraryEntry } from "../../gsv-console/library/libraryTypes";
import { INSTRUMENT_MEMORY_KEY as MEMORY_KEY } from "../wire/queryKeys";
import { listMemoryPages, readMemoryPage, searchMemory, newMemoryPagePath } from "./memoryService";
import { refreshSavedMemoryPage } from "./memoryQueries";
import { MemoryArticle } from "./MemoryArticle";
import { memoryLinkFromUrl, type MemoryLink } from "./memoryLinks";
import { MemoryPageTree } from "./MemoryPageTree";
import { buildMemoryTree, memoryTreePages } from "./memoryTree";
import "./memory.css";

export type MemoryProps = {
  onDirtyChange?: (dirty: boolean) => void;
  initialPage?: MemoryPageRef | null;
  onAsk: (page: MemoryPageRef, prompt: string) => void;
};

/**
 * Memory: what the ship knows, as pages a person can read, search and
 * correct. The Personal wiki comes first; other collections sit beside it.
 * Prose on the void with one mono rail, the way Zen is, because the same two
 * voices write here. Each read is one ask: the list from the tree, a page
 * when opened, a search in the gateway.
 */
export function Memory({ initialPage, onAsk, onDirtyChange }: MemoryProps) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [locationPage] = useState(() => memoryLinkFromUrl(new URL(window.location.href)));
  const [db, setDb] = useState<string | null>(initialPage?.db ?? locationPage?.db ?? null);
  const [path, setPath] = useState<string | null>(initialPage?.path ?? locationPage?.path ?? null);
  const [fragment, setFragment] = useState(initialPage ? "" : locationPage?.fragment ?? "");
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [editor, setEditor] = useState<LibrarySavePageInput | null>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ db: string; path: string; text: string; error: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!initialPage) return;
    setDb(initialPage.db);
    setPath(initialPage.path);
    setFragment("");
    setEditor(null);
    setStatus(null);
  }, [initialPage?.db, initialPage?.path]);

  const collectionsQuery = useQuery({
    queryKey: [...MEMORY_KEY, "collections"],
    queryFn: () => listLibraryCollections(client),
    enabled: connected,
  });
  const collections = useMemo(() => [...(collectionsQuery.data ?? [])]
    .sort((left, right) => Number(right.id === "personal") - Number(left.id === "personal")), [collectionsQuery.data]);
  const collection = useMemo(
    () => db !== null
      ? collections.find((entry) => entry.id === db) ?? null
      : collections.find((entry) => entry.id === "personal") ?? collections[0] ?? null,
    [collections, db],
  );
  const selectedDb = collection?.id ?? "";
  const writable = collection?.writable ?? false;

  const pagesQuery = useQuery({
    queryKey: [...MEMORY_KEY, "pages", selectedDb],
    queryFn: () => (collection ? listMemoryPages(client, collection) : Promise.resolve([])),
    enabled: connected && collection !== null,
  });
  const searchQuery = useQuery({
    queryKey: [...MEMORY_KEY, "search", selectedDb, asked],
    queryFn: () => (collection ? searchMemory(client, collection, asked) : Promise.resolve({ entries: [], truncated: false })),
    enabled: connected && collection !== null && asked !== "",
  });
  const pages = useMemo(() => (asked ? (searchQuery.data?.entries ?? []) : (pagesQuery.data ?? [])), [asked, pagesQuery.data, searchQuery.data]);
  const pageTree = useMemo(() => buildMemoryTree(pagesQuery.data ?? [], selectedDb), [pagesQuery.data, selectedDb]);
  const orderedPages = useMemo(() => asked ? pages : memoryTreePages(pageTree), [asked, pages, pageTree]);
  /* the first page of a collection opens by itself; a page the person picked stays */
  const currentPath = path ?? pagesQuery.data?.[0]?.path ?? null;
  const pageQuery = useQuery({
    queryKey: [...MEMORY_KEY, "page", selectedDb, currentPath ?? ""],
    queryFn: () => (collection && currentPath ? readMemoryPage(client, collection, currentPath) : Promise.resolve(null)),
    enabled: connected && collection !== null && currentPath !== null,
  });
  const note = pageQuery.data ?? null;
  const creating = editor?.createOnly === true;
  const editing = editor !== null && editor.db === selectedDb && (creating || editor.path === note?.path);
  const dirty = editing && (creating ? Boolean(newName || editor.markdown) : editor.markdown !== editor.expectedMarkdown);
  const pageStatus = status?.db === selectedDb && status.path === currentPath ? status : null;

  const save = useMutation({
    mutationFn: (input: LibrarySavePageInput) => saveLibraryPage(client, input),
    onSuccess: async (result, input) => {
      setEditor((current) => current?.db === input.db && (current.createOnly || current.path === input.path) && current.markdown === input.markdown ? null : current);
      setPath(result.openPath);
      setAsked("");
      setQuery("");
      setNewName("");
      setStatus({ db: input.db, path: input.path, text: result.statusText || "saved", error: false });
      await refreshSavedMemoryPage(queryClient, input);
    },
    onError: (error: Error, input) => {
      if (input.createOnly) setCreateError(error.message);
      else setStatus({ db: input.db, path: input.path, text: error.message, error: true });
    },
  });
  useDraftGuard(dirty || save.isPending, onDirtyChange);
  const canLeaveEditor = () => !save.isPending && (!dirty || window.confirm("Discard your unsaved page changes?"));
  const closeEditor = () => { if (canLeaveEditor()) { setEditor(null); setCreateError(null); save.reset(); } };
  const saveEdit = () => {
    if (!editor || !editing || !connected || !writable || save.isPending) return;
    try {
      const input = creating ? { ...editor, path: newMemoryPagePath(selectedDb, newName) } : editor;
      setCreateError(null);
      save.mutate(input);
    } catch (error) { setCreateError(error instanceof Error ? error.message : String(error)); }
  };
  const newPage = () => {
    if (!writable || !connected || !canLeaveEditor()) return;
    setNewName(""); setCreateError(null); save.reset(); setStatus(null);
    setEditor({ db: selectedDb, path: "", markdown: "", createOnly: true });
  };

  const open = useCallback((entry: LibraryEntry) => {
    if (!canLeaveEditor()) return;
    setPath(entry.path);
    setFragment("");
    setEditor(null);
    setStatus(null);
  }, [dirty, save.isPending]);
  const openLink = useCallback((link: MemoryLink) => {
    if (!canLeaveEditor()) return;
    setDb(link.db);
    setPath(link.path);
    setFragment(link.fragment);
    setEditor(null);
    setStatus(null);
  }, [dirty, save.isPending]);
  const beginEdit = useCallback(() => {
    if (!note || !writable) return;
    setEditor({ db: selectedDb, path: note.path, markdown: note.markdown, expectedMarkdown: note.markdown });
    setStatus(null);
  }, [note, selectedDb, writable]);
  useEffect(() => {
    if (editing && !creating) editorRef.current?.focus();
  }, [editing]);

  /* keys: j k walk the pages, enter opens, / searches, e edits, esc leaves the editor or the search */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (event.key === "Escape") {
        if (editing) {
          event.preventDefault();
          closeEditor();
          return;
        }
        if (typing && target instanceof HTMLElement) {
          event.preventDefault();
          target.blur();
        }
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const at = orderedPages.findIndex((entry) => entry.path === note?.path);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = orderedPages[Math.min(orderedPages.length - 1, at + 1)];
        if (next) open(next);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = orderedPages[Math.max(0, at - 1)];
        if (next) open(next);
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "e") {
        event.preventDefault();
        beginEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [beginEdit, editing, note?.path, open, orderedPages, dirty, save.isPending]);

  const onEditorKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveEdit();
    }
  };

  const empty = connected && collectionsQuery.isSuccess && collections.length === 0;

  return (
    <main class="memory" aria-label="Memory">
      {collectionsQuery.isError ? (
        <div class="memory-empty" role="alert">{collectionsQuery.error.message}</div>
      ) : empty ? (
        <div class="memory-empty">
          <p>
            Nothing here yet. Your ship writes what it learns about you into its <span class="place">personal</span> wiki as you
            work together, and this is where you read it and put it right.
          </p>
        </div>
      ) : (
        <div class="memory-body">
          <aside class="memory-rail">
            <div class="memory-tools">
              {collections.length > 1 || (collections.length > 0 && !collection) ? (
                <div class="collections" role="tablist" aria-label="Collections">
                  {collections.map((entry) => (
                    <button
                      type="button"
                      role="tab"
                      key={entry.id}
                      aria-selected={entry.id === selectedDb}
                      class={entry.id === selectedDb ? "is-sel" : ""}
                      onClick={() => {
                        if (!canLeaveEditor()) return;
                        setDb(entry.id);
                        setFragment("");
                        setPath(null);
                        setEditor(null);
                        setStatus(null);
                      }}
                    >
                      {entry.title || entry.id}
                    </button>
                  ))}
                </div>
              ) : null}
              <form
                class="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setAsked(query.trim());
                }}
              >
                <span class="sigil">/</span>
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  placeholder="search what is known"
                  aria-label="Search memory"
                  spellcheck={false}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
                {asked ? (
                  <button
                    type="button"
                    class="clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery("");
                      setAsked("");
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </form>
            </div>
            {writable && <button type="button" class="memory-new-page" disabled={!connected || save.isPending} onClick={newPage}>new page</button>}
            <nav class="pages" aria-label={asked ? "Matches" : "Pages"}>
              {!asked && pagesQuery.isError ? <div class="ph" role="alert">{pagesQuery.error.message}</div> : null}
              {asked ? (
                <div class="ph">
                  {searchQuery.isLoading ? <LoadingState>searching</LoadingState> : searchQuery.isError ? "Search failed" : pages.length === 0 ? "nothing matches" : `${pages.length} ${pages.length === 1 ? "match" : "matches"}`}
                </div>
              ) : null}
              {asked && searchQuery.isError ? <div class="ph" role="alert">{searchQuery.error.message}</div> : null}
              {asked && searchQuery.data?.truncated ? <div class="ph">More matches exist. Narrow your search.</div> : null}
              <MemoryPageTree nodes={pageTree} db={selectedDb} selectedPath={note?.path ?? null} hidden={Boolean(asked)} onOpen={open} />
              {asked ? pages.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  aria-current={entry.path === note?.path ? "page" : undefined}
                  class={`page${entry.path === note?.path ? " is-sel" : ""}`}
                  onClick={() => open(entry)}
                >
                  <span class="title">{entry.title || entry.path}</span>
                  <span class="page-path">{libraryPathInDb(entry.path, selectedDb)}</span>
                  {entry.snippet ? <span class="snippet">{entry.snippet}</span> : null}
                </button>
              )) : null}
            </nav>
          </aside>

          <section class={`memory-page${editing ? " is-editing" : ""}`}>
            {note || creating ? (
              <>
                <div class="page-head">
                  {creating ? <input autoFocus class="memory-page-name" value={newName} aria-label="New page name" placeholder="Page name" disabled={save.isPending} onInput={(event) => setNewName(event.currentTarget.value)} /> : <span class="path">{note?.path}</span>}
                  <span class="actions">
                    {pageStatus ? <span class={`status${pageStatus.error ? " is-error" : ""}`} role={pageStatus.error ? "alert" : "status"}>{pageStatus.text}</span> : null}
                    {!editing && collection && note ? <button type="button" class="page-action" onClick={() => onAsk(
                      { db: selectedDb, path: note.path },
                      `Tell me about the memory page “${note.title}” (gsv:/src/repos/${collection.repo}/${libraryPathInDb(note.path, selectedDb)}). `,
                    )}>ask about this</button> : null}
                    {editing ? (
                      <>
                        <button type="button" class="ibtn is-primary" disabled={save.isPending || !connected || !writable} onClick={() => saveEdit()}>
                          {save.isPending ? <LoadingState>saving</LoadingState> : "save"}
                        </button>
                        <button type="button" class="ibtn" disabled={save.isPending} onClick={closeEditor}>
                          cancel
                        </button>
                      </>
                    ) : writable ? (
                      <button type="button" class="page-action" onClick={beginEdit}>
                        <kbd>e</kbd>correct this
                      </button>
                    ) : null}
                  </span>
                </div>
                {createError || (creating && save.error) ? <p class="memory-editor-error" role="alert">{createError ?? save.error?.message}</p> : null}
                <div class="page-content">
                  {pageQuery.isError ? <div class="memory-none" role="alert">Could not refresh this page: {pageQuery.error.message}</div> : null}
                  {editing ? (
                    <textarea
                      disabled={save.isPending}
                      ref={editorRef}
                      class="editor"
                      value={editor?.markdown ?? ""}
                      spellcheck={true}
                      aria-label="Page text"
                      onInput={(event) => {
                        const markdown = event.currentTarget.value;
                        setEditor((current) => current ? { ...current, markdown } : current);
                      }}
                      onKeyDown={onEditorKey}
                    />
                  ) : (
                    note && <MemoryArticle note={note} db={selectedDb} fragment={fragment} onOpen={openLink} />
                  )}
                </div>
              </>
            ) : collectionsQuery.isLoading || pageQuery.isLoading || pagesQuery.isLoading ? (
              <div class="memory-none memory-loading"><LoadingState variant="panel">Loading memory…</LoadingState></div>
            ) : (
              <div class="memory-none" role={pageQuery.isError || pagesQuery.isError || (db !== null && !collection) ? "alert" : undefined}>
                {pageQuery.error?.message || pagesQuery.error?.message ||
                  (db !== null && !collection ? `Collection “${db}” is unavailable.` : currentPath ? "This page is unavailable." : "No pages here yet.")}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
