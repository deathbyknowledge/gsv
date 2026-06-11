import type { ComponentChildren } from "preact";
import { normalizePath, normalizeTarget } from "./domain/paths";
import type { FilesDevice, FilesMutationPending, FilesPendingNavigation } from "./types";

type Props = {
  targetDraft: string;
  pathDraft: string;
  searchDraft: string;
  devices: FilesDevice[];
  currentPath: string;
  pathStyle: "absolute" | "relative";
  canGoUp: boolean;
  pendingNavigation: FilesPendingNavigation | null;
  pendingMutation: FilesMutationPending | null;
  openPathDisabled: boolean;
  searchDisabled: boolean;
  onTargetDraftChange(value: string): void;
  onPathDraftChange(value: string): void;
  onSearchDraftChange(value: string): void;
  onSubmitNav(): void;
  onSubmitSearch(): void;
  onClearSearch(): void;
  onGoUp(): void;
  onCreateFile(): void;
  onNavigate(path: string): void;
};

function renderTargetLabel(device: FilesDevice) {
  const suffix = device.online === false ? " · offline" : " · online";
  return `${device.deviceId}${suffix}`;
}

function renderSpinner() {
  return <span class="files-spinner is-small" aria-hidden="true" />;
}

function isPendingBreadcrumb(path: string, pendingNavigation: FilesPendingNavigation | null) {
  return pendingNavigation?.kind === "directory" && pendingNavigation.entryKind === "directory" && pendingNavigation.path === path;
}

function renderCrumb(path: string, label: string, title: string, isCurrent: boolean, pendingNavigation: FilesPendingNavigation | null, onNavigate: (path: string) => void) {
  const isPending = isPendingBreadcrumb(path, pendingNavigation);
  return (
    <button type="button" class={`files-crumb${isCurrent ? " is-current" : ""}${isPending ? " is-pending" : ""}`} title={title} disabled={isPending} onClick={() => onNavigate(path)}>
      {isPending ? renderSpinner() : null}
      <span class="files-crumb-label">{label}</span>
    </button>
  );
}

function renderBreadcrumbButtons(currentPath: string, pathStyle: "absolute" | "relative", pendingNavigation: FilesPendingNavigation | null, onNavigate: (path: string) => void) {
  const normalized = normalizePath(currentPath, pathStyle);
  const nodes: ComponentChildren[] = [];

  if (pathStyle === "absolute") {
    if (normalized === "/") {
      return renderCrumb("/", "/", "/", true, pendingNavigation, onNavigate);
    }

    nodes.push(renderCrumb("/", "/", "/", false, pendingNavigation, onNavigate));

    let current = "";
    for (const [index, segment] of normalized.split("/").filter(Boolean).entries()) {
      current += `/${segment}`;
      const nextPath = current;
      const isLast = nextPath === normalized;
      nodes.push(<span class="files-crumb-sep">›</span>);
      nodes.push(renderCrumb(nextPath, segment, segment, isLast, pendingNavigation, onNavigate));
    }
    return nodes;
  }

  if (normalized === ".") {
    return renderCrumb(".", "cwd", "cwd", true, pendingNavigation, onNavigate);
  }

  nodes.push(renderCrumb(".", "cwd", "cwd", false, pendingNavigation, onNavigate));
  let current = "";
  for (const segment of normalized.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    const nextPath = current;
    const isLast = nextPath === normalized;
    nodes.push(<span class="files-crumb-sep">›</span>);
    nodes.push(renderCrumb(nextPath, segment, segment, isLast, pendingNavigation, onNavigate));
  }
  return nodes;
}

export function Toolbar(props: Props) {
  const normalizedTarget = normalizeTarget(props.targetDraft);
  const hasSelectedTarget = normalizedTarget === "gsv" || props.devices.some((device) => device.deviceId === normalizedTarget);
  const isOpeningPath = props.pendingNavigation?.kind === "path" || props.pendingNavigation?.kind === "target";
  const isSearching = props.pendingNavigation?.kind === "search";
  const isCreating = props.pendingMutation?.kind === "create";
  const hasPendingNavigation = Boolean(props.pendingNavigation);
  const openPathDisabled = props.openPathDisabled || hasPendingNavigation;
  const searchDisabled = props.searchDisabled || hasPendingNavigation;

  return (
    <section class="files-toolbar">
      <form
        class="files-toolbar-form files-toolbar-form-nav"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmitNav();
        }}
      >
        <div class="files-toolbar-group">
          <label class="files-field">
            <span>Target</span>
            <select aria-label="Target" value={normalizedTarget} onInput={(event) => props.onTargetDraftChange((event.currentTarget as HTMLSelectElement).value)}>
              <option value="gsv">Kernel (gsv)</option>
              {!hasSelectedTarget ? (
                <option value={normalizedTarget}>{`${normalizedTarget} · requested target`}</option>
              ) : null}
              {props.devices.map((device) => (
                <option value={device.deviceId}>{renderTargetLabel(device)}</option>
              ))}
            </select>
          </label>
          <label class="files-field">
            <span>Path</span>
            <input
              type="text"
              aria-label="Path"
              value={props.pathDraft}
              spellcheck={false}
              onInput={(event) => props.onPathDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-icon-btn" aria-label={isOpeningPath ? "Opening path" : "Open path"} title={isOpeningPath ? "Opening path" : "Open path"} disabled={openPathDisabled}>
              {isOpeningPath ? renderSpinner() : "↩"}
            </button>
            <button type="button" class={`files-icon-btn${props.canGoUp ? "" : " is-disabled"}`} aria-label="Go up" title="Go up" onClick={() => props.canGoUp && props.onGoUp()}>
              ↑
            </button>
          </div>
          <button type="button" class="files-icon-btn" aria-label={isCreating ? "Creating file" : "Create file"} title={isCreating ? "Creating file" : "Create file"} disabled={Boolean(props.pendingMutation)} onClick={props.onCreateFile}>
            {isCreating ? renderSpinner() : "＋"}
          </button>
        </div>
      </form>
      <form
        class="files-toolbar-form files-toolbar-form-search"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmitSearch();
        }}
      >
        <div class="files-toolbar-group">
          <label class="files-field">
            <span>Search</span>
            <input
              type="text"
              aria-label="Search"
              value={props.searchDraft}
              placeholder="Search this folder"
              spellcheck={false}
              onInput={(event) => props.onSearchDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-icon-btn" aria-label={isSearching ? "Searching" : "Search"} title={isSearching ? "Searching" : "Search"} disabled={searchDisabled}>
              {isSearching ? renderSpinner() : "⌕"}
            </button>
            <button type="button" class="files-icon-btn" aria-label="Clear search" title="Clear search" onClick={props.onClearSearch}>✕</button>
          </div>
        </div>
      </form>
      <nav class="files-breadcrumbs">{renderBreadcrumbButtons(props.currentPath, props.pathStyle, props.pendingNavigation, props.onNavigate)}</nav>
    </section>
  );
}
