import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadLibraryWorkspace, saveLibraryPage } from "../../gsv-console/library/libraryService";
import type { LibraryEntry } from "../../gsv-console/library/libraryTypes";
import { renderMarkdownHtml } from "../shared/markdown";
import { Wordmark } from "../shared/Wordmark";
import "./memory.css";

export type MemoryProps = {
  onZen: () => void;
  onFleet: () => void;
};

const MEMORY_KEY = ["instrument", "memory"] as const;

/** The pages a collection holds, or the search's matches while there is a query. */
function shownPages(pages: readonly LibraryEntry[], matches: readonly LibraryEntry[] | null): LibraryEntry[] {
  return (matches ?? pages).filter((entry) => entry.kind === "file");
}

/**
 * Memory: what the ship knows, as pages a person can read, search and
 * correct. The Personal wiki comes first; other collections sit beside it.
 * Prose on the void with one mono rail, the way Zen is, because the same two
 * voices write here.
 */
export function Memory({ onZen, onFleet }: MemoryProps) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [db, setDb] = useState<string | undefined>(undefined);
  const [path, setPath] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const workspace = useQuery({
    queryKey: [...MEMORY_KEY, db ?? "", path ?? "", asked],
    queryFn: () => loadLibraryWorkspace(client, { db, path, q: asked || undefined }),
    enabled: connected,
    placeholderData: (previous) => previous,
  });
  const state = workspace.data;
  const pages = useMemo(() => shownPages(state?.pages ?? [], state?.searchMatches ?? null), [state]);
  const note = state?.selectedNote ?? null;
  const collections = state?.dbs ?? [];
  const selectedDb = state?.selectedDb ?? db ?? "";
  const writable = collections.find((entry) => entry.id === selectedDb)?.writable ?? false;

  const save = useMutation({
    mutationFn: (markdown: string) => saveLibraryPage(client, { db: selectedDb, path: note?.path ?? "", markdown }),
    onSuccess: (result) => {
      setEditing(false);
      setStatus(result.statusText || "saved");
      void queryClient.invalidateQueries({ queryKey: MEMORY_KEY });
    },
    onError: (error: Error) => setStatus(error.message),
  });

  const open = useCallback((entry: LibraryEntry) => {
    setPath(entry.path);
    setEditing(false);
    setStatus(null);
  }, []);
  const beginEdit = useCallback(() => {
    if (!note || !writable) return;
    setDraft(note.markdown);
    setEditing(true);
    setStatus(null);
  }, [note, writable]);
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
          setEditing(false);
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
      save.mutate(draft);
    }
  };

  const empty = connected && !workspace.isPending && collections.length === 0;

  return (
    <main class="memory" aria-label="Memory">
      <div class="instrument-top">
        <Wordmark />
        <span>
          memory ·{" "}
          <span style={connected ? "color: var(--online)" : "color: var(--error)"}>
            {connected ? (collections.length === 1 ? "1 collection" : `${collections.length} collections`) : "offline"}
          </span>
        </span>
        <span class="keys">
          <button type="button" onClick={onZen}>
            <kbd>m</kbd>zen
          </button>
          <button type="button" onClick={onFleet}>
            <kbd>z</kbd>fleet
          </button>
          <span>
            <kbd>?</kbd>keys
          </span>
        </span>
      </div>

      {empty ? (
        <div class="memory-empty">
          <p>
            Nothing here yet. Your ship writes what it learns about you into its <span class="place">personal</span> wiki as you
            work together, and this is where you read it and put it right.
          </p>
        </div>
      ) : (
        <div class="memory-body">
          <aside class="memory-rail">
            {collections.length > 1 ? (
              <div class="collections" role="tablist" aria-label="Collections">
                {collections.map((collection) => (
                  <button
                    type="button"
                    role="tab"
                    key={collection.id}
                    aria-selected={collection.id === selectedDb}
                    class={collection.id === selectedDb ? "is-sel" : ""}
                    onClick={() => {
                      setDb(collection.id);
                      setPath(undefined);
                      setEditing(false);
                    }}
                  >
                    {collection.title || collection.id}
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
            <div class="pages" role="listbox" aria-label={asked ? "Matches" : "Pages"}>
              {asked ? <div class="ph">{pages.length === 0 ? "nothing matches" : `${pages.length} ${pages.length === 1 ? "match" : "matches"}`}</div> : null}
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

          <section class="memory-page">
            {note ? (
              <>
                <div class="page-head">
                  <span class="path">{note.path}</span>
                  <span class="actions">
                    {status ? <span class="status">{status}</span> : null}
                    {editing ? (
                      <>
                        <button type="button" class="ibtn is-primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                          {save.isPending ? "saving" : "save"}
                        </button>
                        <button type="button" class="ibtn" onClick={() => setEditing(false)}>
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
                {editing ? (
                  <textarea
                    ref={editorRef}
                    class="editor"
                    value={draft}
                    spellcheck={true}
                    aria-label="Page text"
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={onEditorKey}
                  />
                ) : (
                  <article class="prose" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(note.markdown) }} />
                )}
              </>
            ) : workspace.isPending ? null : (
              <div class="memory-none">{state?.errorText || "Pick a page, or search."}</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
