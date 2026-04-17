import type { FilesContentItem, FilesDirectoryResult, FilesFileResult, FilesSearchResult } from "./types";

type Props = {
  currentPath: string;
  searchQuery: string;
  directoryResult: FilesDirectoryResult;
  filePath: string;
  fileResult: FilesFileResult | null;
  searchResult: FilesSearchResult;
  editorContent: string;
  onEditorChange(value: string): void;
  onOpenDirectory(path: string): void;
  onOpenFile(path: string): void;
  onSave(): void;
  onDelete(path: string): void;
};

function resolveChildPath(base: string, name: string) {
  if (base === "/") {
    return `/${name}`;
  }
  if (base === ".") {
    return name;
  }
  return `${base}/${name}`;
}

function formatBytes(size: number | undefined) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function fileIconVariant(name: string, isDirectory: boolean) {
  if (isDirectory) {
    return "folder";
  }
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return "image";
  }
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) {
    return "archive";
  }
  if (["md", "txt", "json", "yaml", "yml", "toml", "xml", "html", "css", "js", "ts", "tsx", "rs", "py", "sh"].includes(ext)) {
    return "text";
  }
  return "file";
}

function iconSvg(kind: string) {
  if (kind === "folder") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.75C3 5.784 3.784 5 4.75 5H9.2c.47 0 .92.184 1.25.512l1.037 1.038c.141.14.332.22.531.22h7.232C20.216 6.77 21 7.554 21 8.52v8.73A1.75 1.75 0 0 1 19.25 19H4.75A1.75 1.75 0 0 1 3 17.25z" fill="currentColor"/></svg>`;
  }
  if (kind === "image") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.75 4h9.5A2.75 2.75 0 0 1 18 6.75v10.5A2.75 2.75 0 0 1 15.25 20h-9.5A2.75 2.75 0 0 1 3 17.25V6.75A2.75 2.75 0 0 1 5.75 4m.25 11.5 2.75-3.25 2.5 2.75 1.75-2 3 3.5zM9 9a1.25 1.25 0 1 0 0-.001z" fill="currentColor"/></svg>`;
  }
  if (kind === "archive") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3M9 8h5v1.5H9zm0 3h5v1.5H9zm0 3h4v1.5H9z" fill="currentColor"/></svg>`;
  }
  if (kind === "text") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3M8.5 9.25h7v1.5h-7zm0 3.5h7v1.5h-7z" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3" fill="currentColor"/></svg>`;
}

function renderIcon(kind: string) {
  return <span class="files-entry-icon" dangerouslySetInnerHTML={{ __html: iconSvg(kind) }} />;
}

function renderImageContent(contentItems: FilesContentItem[]) {
  for (const item of contentItems) {
    if (item && item.type === "image") {
      return <img class="files-image-preview" alt="File preview" src={`data:${item.mimeType || "image/png"};base64,${item.data || ""}`} />;
    }
  }
  for (const item of contentItems) {
    if (item && item.type === "text") {
      return <pre class="files-code-preview">{item.text || ""}</pre>;
    }
  }
  return (
    <div class="files-empty">
      <h3>Preview unavailable</h3>
      <p>This file could not be rendered.</p>
    </div>
  );
}

function DirectoryStage(props: Pick<Props, "currentPath" | "searchQuery" | "directoryResult" | "onOpenDirectory" | "onOpenFile">) {
  const directories = [...props.directoryResult.directories].sort((a, b) => a.localeCompare(b));
  const files = [...props.directoryResult.files].sort((a, b) => a.localeCompare(b));

  if (directories.length === 0 && files.length === 0) {
    return (
      <div class="files-empty">
        <h3>Directory is empty</h3>
        <p>Create a file or open a different folder.</p>
      </div>
    );
  }

  return (
    <section class="files-directory-stage">
      <div class="files-entry-grid">
        {directories.map((name) => (
          <button type="button" class="files-entry-row is-directory" onClick={() => props.onOpenDirectory(resolveChildPath(props.currentPath, name))}>
            {renderIcon("folder")}
            <span class="files-entry-name">{name}</span>
          </button>
        ))}
        {files.map((name) => (
          <button type="button" class="files-entry-row" onClick={() => props.onOpenFile(resolveChildPath(props.currentPath, name))}>
            {renderIcon(fileIconVariant(name, false))}
            <span class="files-entry-name">{name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SearchStage(props: Pick<Props, "searchResult" | "onOpenFile">) {
  if (props.searchResult.matches.length === 0) {
    return (
      <div class="files-empty">
        <h3>No matches</h3>
        <p>Try a different query inside this folder.</p>
      </div>
    );
  }

  return (
    <section class="files-search-view">
      <div class="files-content-toolbar">
        <div class="files-inline-meta">
          <strong>{props.searchResult.matches.length} match{props.searchResult.matches.length === 1 ? "" : "es"}</strong>
        </div>
        {props.searchResult.truncated ? <span class="files-pill">Truncated</span> : null}
      </div>
      <div class="files-search-list">
        {props.searchResult.matches.map((match) => (
          <button type="button" class="files-search-row" onClick={() => props.onOpenFile(match.path)}>
            <strong>{match.path}:{Number(match.line ?? 0)}</strong>
            <code>{String(match.content ?? "")}</code>
          </button>
        ))}
      </div>
    </section>
  );
}

function FileStage(props: Pick<Props, "currentPath" | "searchQuery" | "filePath" | "fileResult" | "editorContent" | "onEditorChange" | "onOpenDirectory" | "onSave" | "onDelete">) {
  if (!props.fileResult) {
    return null;
  }
  const sizeLabel = formatBytes(props.fileResult.size);
  const isBinaryPreview = Array.isArray(props.fileResult.content);

  return (
    <section class="files-file-stage">
      <header class="files-content-toolbar">
        <button type="button" class="files-back-link" aria-label="Back to folder" title="Back to folder" onClick={() => props.onOpenDirectory(props.currentPath)}>
          ←
        </button>
        <div class="files-inline-meta">
          <span>{sizeLabel}</span>
        </div>
        {isBinaryPreview ? (
          <div class="files-file-actions">
            <button type="button" class="files-icon-btn files-btn-danger" aria-label="Delete file" title="Delete file" onClick={() => props.onDelete(props.filePath)}>
              ⌫
            </button>
          </div>
        ) : (
          <div class="files-file-actions">
            <button type="button" class="files-icon-btn" aria-label="Save file" title="Save file" onClick={props.onSave}>
              ↓
            </button>
            <button type="button" class="files-icon-btn files-btn-danger" aria-label="Delete file" title="Delete file" onClick={() => props.onDelete(props.filePath)}>
              ⌫
            </button>
          </div>
        )}
      </header>
      {isBinaryPreview ? (
        <section class="files-file-body is-image">{renderImageContent(props.fileResult.content as FilesContentItem[])}</section>
      ) : (
        <form class="files-editor-form" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
          <textarea class="files-editor" spellcheck={false} value={props.editorContent} onInput={(event) => props.onEditorChange((event.currentTarget as HTMLTextAreaElement).value)} />
        </form>
      )}
    </section>
  );
}

export function Stage(props: Props) {
  if (props.fileResult) {
    return <FileStage {...props} />;
  }
  if (props.searchQuery) {
    return <SearchStage {...props} />;
  }
  return <DirectoryStage {...props} />;
}
