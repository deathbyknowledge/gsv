import type { ComponentChildren } from "preact";
import type { FilesDevice } from "./types";

type Props = {
  targetDraft: string;
  pathDraft: string;
  searchDraft: string;
  devices: FilesDevice[];
  currentPath: string;
  pathStyle: "absolute" | "relative";
  canGoUp: boolean;
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

function normalizeTarget(target: string) {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

function normalizePath(input: string, style: "absolute" | "relative") {
  const raw = String(input ?? "").replaceAll("\\", "/").trim();
  const normalized: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  if (style === "absolute") {
    return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
  }
  return normalized.length > 0 ? normalized.join("/") : ".";
}

function renderTargetLabel(device: FilesDevice) {
  const suffix = device.online === false ? " · offline" : " · online";
  return `${device.deviceId}${suffix}`;
}

function renderBreadcrumbButtons(currentPath: string, pathStyle: "absolute" | "relative", onNavigate: (path: string) => void) {
  const normalized = normalizePath(currentPath, pathStyle);
  const nodes: ComponentChildren[] = [];

  if (pathStyle === "absolute") {
    if (normalized === "/") {
      return <button type="button" class="files-crumb is-current">/</button>;
    }

    nodes.push(
      <button type="button" class="files-crumb" onClick={() => onNavigate("/")}>/</button>,
    );

    let current = "";
    for (const [index, segment] of normalized.split("/").filter(Boolean).entries()) {
      current += `/${segment}`;
      const isLast = current === normalized;
      nodes.push(<span class="files-crumb-sep">›</span>);
      nodes.push(
        <button type="button" class={`files-crumb${isLast ? " is-current" : ""}`} onClick={() => onNavigate(current)}>
          {segment}
        </button>,
      );
    }
    return nodes;
  }

  if (normalized === ".") {
    return <button type="button" class="files-crumb is-current">workspace</button>;
  }

  nodes.push(
    <button type="button" class="files-crumb" onClick={() => onNavigate(".")}>workspace</button>,
  );
  let current = "";
  for (const segment of normalized.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment;
    const isLast = current === normalized;
    nodes.push(<span class="files-crumb-sep">›</span>);
    nodes.push(
      <button type="button" class={`files-crumb${isLast ? " is-current" : ""}`} onClick={() => onNavigate(current)}>
        {segment}
      </button>,
    );
  }
  return nodes;
}

export function Toolbar(props: Props) {
  const normalizedTarget = normalizeTarget(props.targetDraft);

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
            <select value={normalizedTarget} onInput={(event) => props.onTargetDraftChange((event.currentTarget as HTMLSelectElement).value)}>
              <option value="gsv">Kernel (gsv)</option>
              {props.devices.map((device) => (
                <option value={device.deviceId}>{renderTargetLabel(device)}</option>
              ))}
            </select>
          </label>
          <label class="files-field">
            <span>Path</span>
            <input
              type="text"
              value={props.pathDraft}
              spellcheck={false}
              onInput={(event) => props.onPathDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-icon-btn" aria-label="Open path" title="Open path">↩</button>
            <button type="button" class={`files-icon-btn${props.canGoUp ? "" : " is-disabled"}`} aria-label="Go up" title="Go up" onClick={() => props.canGoUp && props.onGoUp()}>
              ↑
            </button>
          </div>
          <button type="button" class="files-icon-btn" aria-label="Create file" title="Create file" onClick={props.onCreateFile}>＋</button>
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
              value={props.searchDraft}
              placeholder="Search this folder"
              spellcheck={false}
              onInput={(event) => props.onSearchDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-icon-btn" aria-label="Search" title="Search">⌕</button>
            <button type="button" class="files-icon-btn" aria-label="Clear search" title="Clear search" onClick={props.onClearSearch}>✕</button>
          </div>
        </div>
      </form>
      <nav class="files-breadcrumbs">{renderBreadcrumbButtons(props.currentPath, props.pathStyle, props.onNavigate)}</nav>
    </section>
  );
}
