import { useDraftGuard } from "../shared/useDraftGuard";
import { LoadingState, Spinner } from "../../../components/ui/Spinner";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { listLibraryCollections, saveLibraryPage } from "../../../services/memory/libraryService";
import { libraryPathInDb } from "../../../services/memory/libraryModel";
import type { MemoryPageRef } from "../shared/navigation";
import type { LibrarySavePageInput, LibraryEntry } from "../../../services/memory/libraryTypes";
import { INSTRUMENT_MEMORY_KEY as MEMORY_KEY } from "../wire/queryKeys";
import { listMemoryPages, readMemoryPage, searchMemory, newMemoryPagePath } from "./memoryService";
import { refreshSavedMemoryPage } from "./memoryQueries";
import { MemoryArticle } from "./MemoryArticle";
import { memoryLinkFromUrl, type MemoryLink } from "./memoryLinks";
import { MemoryPageTree } from "./MemoryPageTree";
import { buildMemoryTree, memoryPageTitle } from "./memoryTree";
import { rich, useT } from "../../../i18n/locale";
import "./memory.css";

export type MemoryProps = {
  onDirtyChange?: (dirty: boolean) => void;
  initialPage?: MemoryPageRef | null;
  onAsk: (text: string) => void;
};

/**
 * Memory: what the ship knows, as pages a person can read, search and
 * correct. The Personal wiki comes first; other collections sit beside it.
 * Prose on the void with one mono rail, the way Zen is, because the same two
 * voices write here. Each read is one ask: the list from the tree, a page
 * when opened, a search in the gateway.
 */
export function Memory({ initialPage, onAsk, onDirtyChange }: MemoryProps) {
  const t = useT();
  const active = useViewActive();
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [locationPage] = useState(() => memoryLinkFromUrl(new URL(window.location.href)));
  const [reading, setReading] = useState(Boolean(initialPage ?? locationPage));
  const [db, setDb] = useState<string | null>(initialPage?.db ?? locationPage?.db ?? null);
  const [path, setPath] = useState<string | null>(initialPage?.path ?? locationPage?.path ?? null);
  const [fragment, setFragment] = useState(initialPage ? "" : locationPage?.fragment ?? "");
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [editor, setEditor] = useState<LibrarySavePageInput | null>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  /** The last save of a page: its failure as reported, or null once it is saved. */
  const [status, setStatus] = useState<{ db: string; path: string; error: string | null } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const pagesRef = useRef<HTMLElement>(null);
  const focusedRow = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!initialPage) return;
    setDb(initialPage.db);
    setPath(initialPage.path);
    setFragment("");
    setReading(true);
    setEditor(null);
    setStatus(null);
  }, [initialPage]);

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
      setStatus({ db: input.db, path: input.path, error: null });
      await refreshSavedMemoryPage(queryClient, input);
    },
    onError: (error: Error, input) => {
      if (input.createOnly) setCreateError(error.message);
      else setStatus({ db: input.db, path: input.path, error: error.message });
    },
  });
  useDraftGuard(dirty || save.isPending, onDirtyChange);
  const canLeaveEditor = () => !save.isPending && (!dirty || window.confirm(t("memory.discard")));
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
    setReading(true);
  };

  const open = useCallback((entry: LibraryEntry) => {
    if (!canLeaveEditor()) return;
    setPath(entry.path);
    setReading(true);
    setFragment("");
    setEditor(null);
    setStatus(null);
  }, [dirty, save.isPending, t]);
  const openLink = useCallback((link: MemoryLink) => {
    if (!canLeaveEditor()) return;
    setDb(link.db);
    setReading(true);
    setPath(link.path);
    setFragment(link.fragment);
    setEditor(null);
    setStatus(null);
  }, [dirty, save.isPending, t]);
  const beginEdit = useCallback(() => {
    if (!note || !writable) return;
    setReading(true);
    setEditor({ db: selectedDb, path: note.path, markdown: note.markdown, expectedMarkdown: note.markdown });
    setStatus(null);
  }, [note, selectedDb, writable]);
  useEffect(() => {
    if (active && editing && !creating) editorRef.current?.focus();
  }, [editing]);

  /* keys: j k walk the pages, enter opens, / searches, e edits, esc leaves the editor or the search */
  useLayoutEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (Boolean(target.closest("input, textarea, select")) || target.isContentEditable);
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
      if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
        if (!pagesRef.current?.getClientRects().length) return;
        event.preventDefault();
        // Read the visible tree structure without measuring every row or changing the open page.
        const rows = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>(".page, .memory-folder > summary") ?? []).filter((row) => {
          if (row.closest("[hidden]")) return false;
          for (let folder = row.closest("details"); folder; folder = folder.parentElement?.closest("details") ?? null) {
            if (!folder.open && folder.firstElementChild !== row) return false;
          }
          return true;
        });
        let at = rows.findIndex((row) => row === document.activeElement);
        if (at < 0) at = rows.findIndex((row) => row === focusedRow.current);
        if (at < 0) at = rows.findIndex((row) => row.getAttribute("aria-current") === "page");
        const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
        const next = rows[Math.max(0, Math.min(rows.length - 1, at + direction))];
        if (next) {
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "nearest" });
        }
        // Space and Enter activate the focused button/summary through the browser's native behavior.
      } else if (event.key === "/") {
        event.preventDefault();
        setReading(false);
        requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
      } else if (event.key === "e") {
        event.preventDefault();
        beginEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, beginEdit, editing, dirty, save.isPending, t]);

  const onEditorKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveEdit();
    }
  };

  const empty = connected && collectionsQuery.isSuccess && collections.length === 0;

  return (
    <main class={`memory${reading ? " is-reading" : ""}`} aria-label={t("memory.title")}>
      {collectionsQuery.isError ? (
        <div class="memory-empty" role="alert">{collectionsQuery.error.message}</div>
      ) : empty ? (
        <div class="memory-empty">
          <p>{rich(t("memory.empty"), { personal: <span class="place">personal</span> })}</p>
        </div>
      ) : (
        <div class="memory-body">
          <aside class="memory-rail" data-scroll-edge>
            <div class="memory-tools">
              {collections.length > 1 || (collections.length > 0 && !collection) ? (
                <div class="collections" role="tablist" aria-label={t("memory.collections")}>
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
                  placeholder={t("memory.search.placeholder")}
                  aria-label={t("memory.search.label")}
                  spellcheck={false}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
                {asked ? (
                  <button
                    type="button"
                    class="clear"
                    aria-label={t("memory.search.clear")}
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
            {writable && <button type="button" class="memory-new-page" disabled={!connected || save.isPending} onClick={newPage}>{t("memory.newPage")}</button>}
            {editing && <button type="button" class="memory-resume" onClick={() => setReading(true)}>{t("memory.resume")}</button>}
            <nav class="pages" ref={pagesRef} aria-label={asked ? t("memory.matches") : t("memory.pages")} onFocusCapture={(event) => {
              if (event.target instanceof HTMLElement && event.target.matches(".page, .memory-folder > summary")) focusedRow.current = event.target;
            }}>
              {!asked && (collectionsQuery.isLoading || pagesQuery.isLoading) ? <div class="memory-loading" role="status" aria-label={t("memory.loading")}><Spinner size={160} /></div> : null}
              {!asked && pagesQuery.isError ? <div class="ph" role="alert">{pagesQuery.error.message}</div> : null}
              {asked ? (
                <div class="ph">
                  {searchQuery.isLoading ? <LoadingState>{t("memory.search.searching")}</LoadingState> : searchQuery.isError ? t("memory.search.failed") : pages.length === 0 ? t("memory.search.none") : t("memory.search.count", { count: pages.length })}
                </div>
              ) : null}
              {asked && searchQuery.isError ? <div class="ph" role="alert">{searchQuery.error.message}</div> : null}
              {asked && searchQuery.data?.truncated ? <div class="ph">{t("memory.search.truncated")}</div> : null}
              <MemoryPageTree nodes={pageTree} db={selectedDb} selectedPath={note?.path ?? null} hidden={Boolean(asked)} onOpen={open} />
              {asked ? pages.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  aria-current={entry.path === note?.path ? "page" : undefined}
                  class={`page${entry.path === note?.path ? " is-sel" : ""}`}
                  onClick={() => open(entry)}
                >
                  <span class="title">{memoryPageTitle(t, entry, selectedDb)}</span>
                  <span class="page-path">{libraryPathInDb(entry.path, selectedDb)}</span>
                  {entry.snippet ? <span class="snippet">{entry.snippet}</span> : null}
                </button>
              )) : null}
            </nav>
          </aside>

          <section class={`memory-page${editing ? " is-editing" : ""}`}>
            <button type="button" class="memory-browse" onClick={() => setReading(false)}>{t("memory.back")}</button>
            {note || creating ? (
              <>
                <div class="page-head">
                  {creating ? <input autoFocus class="memory-page-name" value={newName} aria-label={t("memory.page.newName")} placeholder={t("memory.page.namePlaceholder")} disabled={save.isPending} onInput={(event) => setNewName(event.currentTarget.value)} /> : <span class="path">{note?.path}</span>}
                  <span class="actions">
                    {pageStatus ? <span class={`status${pageStatus.error !== null ? " is-error" : ""}`} role={pageStatus.error !== null ? "alert" : "status"}>{pageStatus.error ?? t("memory.page.saved", { path: pageStatus.path })}</span> : null}
                    {!editing && collection && note ? <button type="button" class="page-action" onClick={() => onAsk(`Use this file as context: @gsv /src/repos/${collection.repo}/${libraryPathInDb(note.path, selectedDb)}`)}>{t("memory.page.ask")}</button> : null}
                    {editing ? (
                      <>
                        <button type="button" class="ibtn is-primary" disabled={save.isPending || !connected || !writable} onClick={() => saveEdit()}>
                          {save.isPending ? <LoadingState>{t("memory.page.saving")}</LoadingState> : t("memory.page.save")}
                        </button>
                        <button type="button" class="ibtn" disabled={save.isPending} onClick={closeEditor}>
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : writable ? (
                      <button type="button" class="page-action" onClick={beginEdit}>
                        <kbd>e</kbd>{t("common.edit")}
                      </button>
                    ) : null}
                  </span>
                </div>
                {createError || (creating && save.error) ? <p class="memory-editor-error" role="alert">{createError ?? save.error?.message}</p> : null}
                <div class="page-content" data-scroll-edge>
                  {pageQuery.isError ? <div class="memory-none" role="alert">{t("memory.page.refreshFailed", { error: pageQuery.error.message })}</div> : null}
                  {editing ? (
                    <textarea
                      disabled={save.isPending}
                      ref={editorRef}
                      class="editor"
                      value={editor?.markdown ?? ""}
                      spellcheck={true}
                      aria-label={t("memory.page.text")}
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
              <div class="memory-loading" role="status" aria-label={t("memory.loading")}><Spinner size={160} /></div>
            ) : (
              <div class="memory-none" role={pageQuery.isError || pagesQuery.isError || (db !== null && !collection) ? "alert" : undefined}>
                {pageQuery.error?.message || pagesQuery.error?.message ||
                  (db !== null && !collection ? t("memory.collectionUnavailable", { db }) : currentPath ? t("memory.pageUnavailable") : t("memory.noPages"))}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
