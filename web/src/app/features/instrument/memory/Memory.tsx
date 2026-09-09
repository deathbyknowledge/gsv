import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { listLibraryCollections, saveLibraryPage } from "../../gsv-console/library/libraryService";
import { libraryPathInDb } from "../../gsv-console/library/libraryModel";
import type { MemoryPageRef } from "../shared/navigation";
import type { LibrarySavePageInput, LibraryEntry } from "../../gsv-console/library/libraryTypes";
import { renderMarkdownHtml } from "../shared/markdown";
import { InstrumentHeader } from "../shared/InstrumentHeader";
import { INSTRUMENT_MEMORY_KEY as MEMORY_KEY } from "../wire/queryKeys";
import { listMemoryPages, readMemoryPage, searchMemory } from "./memoryService";
import { refreshSavedMemoryPage } from "./memoryQueries";
import "./memory.css";

export type MemoryProps = {
  initialPage?: MemoryPageRef | null;
  onAsk: (page: MemoryPageRef, prompt: string) => void;
  onZen: () => void;
  onFleet: () => void;
};

/**
 * Memory: what the ship knows, as pages a person can read, search and
 * correct. The Personal wiki comes first; other collections sit beside it.
 * Prose on the void with one mono rail, the way Zen is, because the same two
 * voices write here. Each read is one ask: the list from the tree, a page
 * when opened, a search in the gateway.
 */
export function Memory({ initialPage, onAsk, onZen, onFleet }: MemoryProps) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [db, setDb] = useState<string | null>(initialPage?.db ?? null);
  const [path, setPath] = useState<string | null>(initialPage?.path ?? null);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [editor, setEditor] = useState<LibrarySavePageInput | null>(null);
  const [status, setStatus] = useState<{ db: string; path: string; text: string; error: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!initialPage) return;
    setDb(initialPage.db);
    setPath(initialPage.path);
    setEditor(null);
    setStatus(null);
  }, [initialPage?.db, initialPage?.path]);

  const collectionsQuery = useQuery({
    queryKey: [...MEMORY_KEY, "collections"],
    queryFn: () => listLibraryCollections(client),
    enabled: connected,
  });
  const collections = useMemo(() => collectionsQuery.data ?? [], [collectionsQuery.data]);
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
  /* the first page of a collection opens by itself; a page the person picked stays */
  const currentPath = path ?? pagesQuery.data?.[0]?.path ?? null;
  const pageQuery = useQuery({
    queryKey: [...MEMORY_KEY, "page", selectedDb, currentPath ?? ""],
    queryFn: () => (collection && currentPath ? readMemoryPage(client, collection, currentPath) : Promise.resolve(null)),
    enabled: connected && collection !== null && currentPath !== null,
  });
  const note = pageQuery.data ?? null;
  const editing = editor !== null && editor.db === selectedDb && editor.path === note?.path;
  const pageStatus = status?.db === selectedDb && status.path === currentPath ? status : null;

  const save = useMutation({
    mutationFn: (input: LibrarySavePageInput) => saveLibraryPage(client, input),
    onSuccess: async (result, input) => {
      setEditor((current) => current?.db === input.db && current.path === input.path && current.markdown === input.markdown ? null : current);
      setStatus({ db: input.db, path: input.path, text: result.statusText || "saved", error: false });
      await refreshSavedMemoryPage(queryClient, input);
    },
    onError: (error: Error, input) => setStatus({ db: input.db, path: input.path, text: error.message, error: true }),
  });
  const saveEdit = () => {
    if (editor && editing && connected && writable && !save.isPending) save.mutate(editor);
  };

  const open = useCallback((entry: LibraryEntry) => {
    setPath(entry.path);
    setEditor(null);
    setStatus(null);
  }, []);
  const beginEdit = useCallback(() => {
    if (!note || !writable) return;
    setEditor({ db: selectedDb, path: note.path, markdown: note.markdown });
    setStatus(null);
  }, [note, selectedDb, writable]);
  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  /* keys: j k walk the pages, enter opens, / searches, e edits, esc leaves the editor or the search */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (event.key === "Escape") {
        if (editing) {
          event.preventDefault();
          setEditor(null);
          return;
        }
        if (typing && target instanceof HTMLElement) {
          event.preventDefault();
          target.blur();
        }
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const at = pages.findIndex((entry) => entry.path === note?.path);
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = pages[Math.min(pages.length - 1, at + 1)];
        if (next) open(next);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = pages[Math.max(0, at - 1)];
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
  }, [beginEdit, editing, note?.path, open, pages]);

  const onEditorKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveEdit();
    }
  };

  const empty = connected && collectionsQuery.isSuccess && collections.length === 0;

  return (
    <main class="memory" aria-label="Memory">
      <InstrumentHeader status={<>
          memory ·{" "}
          <span style={connected ? "color: var(--online)" : "color: var(--error)"}>
            {connected ? (collections.length === 1 ? "1 collection" : `${collections.length} collections`) : "offline"}
          </span>
      </>}>
        <button type="button" onClick={onZen}>
          <kbd>m</kbd>zen
        </button>
        <button type="button" onClick={onFleet}>
          <kbd>z</kbd>fleet
        </button>
        <span aria-current="page">memory</span>
        <span>
          <kbd>?</kbd>keys
        </span>
      </InstrumentHeader>

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
                        setDb(entry.id);
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
            <div class="pages" role="listbox" aria-label={asked ? "Matches" : "Pages"}>
              {!asked && pagesQuery.isError ? <div class="ph" role="alert">{pagesQuery.error.message}</div> : null}
              {asked ? (
                <div class="ph">
                  {searchQuery.isLoading ? <LoadingState>searching</LoadingState> : searchQuery.isError ? "Search failed" : pages.length === 0 ? "nothing matches" : `${pages.length} ${pages.length === 1 ? "match" : "matches"}`}
                </div>
              ) : null}
              {asked && searchQuery.isError ? <div class="ph" role="alert">{searchQuery.error.message}</div> : null}
              {asked && searchQuery.data?.truncated ? <div class="ph">More matches exist. Narrow your search.</div> : null}
              {pages.map((entry) => (
                <button
                  type="button"
                  role="option"
                  key={entry.path}
                  aria-selected={entry.path === note?.path}
                  class={`page${entry.path === note?.path ? " is-sel" : ""}`}
                  onClick={() => open(entry)}
                >
                  <span class="title">{entry.title || entry.path}</span>
                  {entry.snippet ? <span class="snippet">{entry.snippet}</span> : null}
                </button>
              ))}
            </div>
          </aside>

          <section class={`memory-page${editing ? " is-editing" : ""}`}>
            {note ? (
              <>
                <div class="page-head">
                  <span class="path">{note.path}</span>
                  <span class="actions">
                    {pageStatus ? <span class={`status${pageStatus.error ? " is-error" : ""}`} role={pageStatus.error ? "alert" : "status"}>{pageStatus.text}</span> : null}
                    {!editing && collection ? <button type="button" class="ibtn" onClick={() => onAsk(
                      { db: selectedDb, path: note.path },
                      `Tell me about the memory page “${note.title}” (gsv:/src/repos/${collection.repo}/${libraryPathInDb(note.path, selectedDb)}). `,
                    )}>ask about this</button> : null}
                    {editing ? (
                      <>
                        <button type="button" class="ibtn is-primary" disabled={save.isPending || !connected || !writable} onClick={() => saveEdit()}>
                          {save.isPending ? <LoadingState>saving</LoadingState> : "save"}
                        </button>
                        <button type="button" class="ibtn" onClick={() => setEditor(null)}>
                          cancel
                        </button>
                      </>
                    ) : writable ? (
                      <button type="button" class="ibtn" onClick={beginEdit}>
                        <kbd>e</kbd>correct this
                      </button>
                    ) : null}
                  </span>
                </div>
                {pageQuery.isError ? <div class="memory-none" role="alert">Could not refresh this page: {pageQuery.error.message}</div> : null}
                {editing ? (
                  <textarea
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
                  <article class="prose" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(note.markdown) }} />
                )}
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
