import type { AppElementContext, GsvAppElement } from "./app-sdk";
import { renderActionIcon, renderFileIcon } from "./icons";
import type { FileIconKind } from "./icons";
import {
  getActiveThreadContext,
  subscribeActiveThreadContext,
  type ThreadContext,
} from "./thread-context";

type DeviceSummary = {
  deviceId: string;
  platform: string;
  version: string;
  online: boolean;
};

type DeviceListResult = {
  devices?: DeviceSummary[];
};

type FsImageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type FsReadDirectoryResult = {
  ok: true;
  path: string;
  files: string[];
  directories: string[];
};

type FsReadFileResult = {
  ok: true;
  path: string;
  content: string | FsImageContent[];
  lines?: number;
  size: number;
};

type FsReadResult = FsReadDirectoryResult | FsReadFileResult | { ok: false; error: string };

type FsWriteResult = { ok: true; path: string; size: number } | { ok: false; error: string };
type FsDeleteResult = { ok: true; path: string } | { ok: false; error: string };

type FsSearchMatch = {
  path: string;
  line: number;
  content: string;
};

type FsSearchResult =
  | { ok: true; matches: FsSearchMatch[]; count: number; truncated?: boolean }
  | { ok: false; error: string };

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type FilesViewState = "ready" | "working" | "error" | "offline";
type DetailKind = "empty" | "file" | "image";
type PathStyle = "absolute" | "relative";
function defineElement(tagName: string, constructor: CustomElementConstructor): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, constructor);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "gsv";
}

function detectPathStyle(path: string): PathStyle {
  return path.trim().startsWith("/") ? "absolute" : "relative";
}

function normalizePath(path: string, style: PathStyle): string {
  const normalizedInput = path.replaceAll("\\", "/");
  const parts = normalizedInput.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
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
    return `/${normalized.join("/")}`;
  }
  return normalized.length > 0 ? normalized.join("/") : ".";
}

function resolvePath(input: string, cwd: string, style: PathStyle): string {
  const raw = input.trim();
  if (!raw) {
    return cwd;
  }
  if (raw.startsWith("/")) {
    return normalizePath(raw, "absolute");
  }

  const cwdNormalized = normalizePath(cwd, style);
  if (style === "absolute") {
    const base = cwdNormalized === "/" ? "/" : `${cwdNormalized}/`;
    return normalizePath(`${base}${raw}`, "absolute");
  }
  const base = cwdNormalized === "." ? "" : `${cwdNormalized}/`;
  return normalizePath(`${base}${raw}`, "relative");
}

function parentPath(path: string, style: PathStyle): string {
  const normalized = normalizePath(path, style);
  if (style === "absolute") {
    if (normalized === "/") {
      return "/";
    }
    const segments = normalized.split("/").filter(Boolean);
    segments.pop();
    if (segments.length === 0) {
      return "/";
    }
    return `/${segments.join("/")}`;
  }

  if (normalized === ".") {
    return ".";
  }

  const segments = normalized.split("/").filter(Boolean);
  segments.pop();
  if (segments.length === 0) {
    return ".";
  }
  return segments.join("/");
}

function baseName(path: string): string {
  const style = detectPathStyle(path);
  const normalized = normalizePath(path, style);
  if (normalized === "/" || normalized === ".") {
    return normalized;
  }
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function isDirectoryReadResult(value: FsReadResult): value is FsReadDirectoryResult {
  const record = asRecord(value);
  if (!record || record.ok !== true) {
    return false;
  }
  return Array.isArray(record.files) && Array.isArray(record.directories);
}

function isFileReadResult(value: FsReadResult): value is FsReadFileResult {
  const record = asRecord(value);
  if (!record || record.ok !== true) {
    return false;
  }
  return "content" in record;
}

function decodeNumberedText(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
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

function fileIconVariant(name: string, isDirectory: boolean): FileIconKind {
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

class GsvFilesAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private suspended = false;
  private statusKind: "idle" | "error" = "idle";
  private statusText = "";

  private target = "gsv";
  private devices: DeviceSummary[] = [];
  private pathStyle: PathStyle = "absolute";
  private currentPath = "/";
  private pathInput = "/";
  private entries: FileEntry[] = [];
  private selectedPath: string | null = null;
  private selectedKind: DetailKind = "empty";
  private selectedSize: number | null = null;
  private editorContent = "";
  private imageData: { mimeType: string; base64: string } | null = null;
  private isDirty = false;
  private currentView: "explorer" | "editor" = "explorer";
  private explorerPane: "entries" | "search" = "entries";
  private searchPattern = "";
  private searchMatches: FsSearchMatch[] = [];
  private searchTruncated = false;

  private isLoadingDir = false;
  private isLoadingFile = false;
  private isSaving = false;
  private isDeleting = false;
  private isSearching = false;
  private isRefreshingDevices = false;

  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeThreadContext: (() => void) | null = null;
  private activeThreadContext: ThreadContext | null = getActiveThreadContext();

  private confirmDiscardChanges(): boolean {
    if (!this.isDirty || this.selectedKind !== "file") {
      return true;
    }
    return window.confirm("Discard unsaved changes to the current file?");
  }

  private readonly onClick = (event: MouseEvent): void => {
    const targetNode = event.target;
    if (!(targetNode instanceof Element)) {
      return;
    }

    const actionNode = targetNode.closest<HTMLElement>("[data-action]");
    if (!actionNode) {
      return;
    }

    const action = actionNode.dataset.action;
    if (!action) {
      return;
    }

    if (action === "refresh") {
      void this.loadDirectory(this.currentPath);
      return;
    }
    if (action === "up") {
      if (!this.confirmDiscardChanges()) {
        return;
      }
      void this.loadDirectory(parentPath(this.currentPath, this.pathStyle));
      return;
    }
    if (action === "open-path") {
      const path = actionNode.dataset.path;
      if (!path) {
        return;
      }
      if (!this.confirmDiscardChanges()) {
        return;
      }
      void this.loadDirectory(path);
      return;
    }
    if (action === "open-entry") {
      const path = actionNode.dataset.path;
      const kind = actionNode.dataset.kind;
      if (!path || !kind) {
        return;
      }
      if (kind === "directory") {
        if (!this.confirmDiscardChanges()) {
          return;
        }
        void this.loadDirectory(path);
      } else {
        if (!this.confirmDiscardChanges()) {
          return;
        }
        void this.openFile(path);
      }
      return;
    }
    if (action === "save-file") {
      void this.saveFile();
      return;
    }
    if (action === "back-to-explorer") {
      this.currentView = "explorer";
      this.render();
      return;
    }
    if (action === "delete-selected") {
      void this.deleteSelected();
      return;
    }
    if (action === "create-file") {
      const name = window.prompt("New file name", "untitled.txt");
      if (name && name.trim()) {
        void this.createFile(name.trim());
      }
      return;
    }
    if (action === "search") {
      void this.runSearch();
      return;
    }
    if (action === "clear-search") {
      this.explorerPane = "entries";
      this.searchPattern = "";
      this.searchMatches = [];
      this.searchTruncated = false;
      this.render();
      return;
    }
  };

  private readonly onInput = (event: Event): void => {
    const targetNode = event.target;
    if (
      !(targetNode instanceof HTMLInputElement) &&
      !(targetNode instanceof HTMLTextAreaElement) &&
      !(targetNode instanceof HTMLSelectElement)
    ) {
      return;
    }

    const field = targetNode.dataset.field;
    if (!field) {
      return;
    }

    switch (field) {
      case "target-select":
        if (targetNode instanceof HTMLSelectElement) {
          if (!this.confirmDiscardChanges()) {
            targetNode.value = this.target;
            return;
          }
          this.target = targetNode.value;
          this.searchMatches = [];
          this.searchTruncated = false;
          this.pathStyle = this.target === "gsv" ? "absolute" : "relative";
          this.currentPath = this.pathStyle === "absolute"
            ? this.preferredGsvPath(this.activeThreadContext)
            : ".";
          this.pathInput = this.currentPath;
          this.entries = [];
          this.currentView = "explorer";
          this.explorerPane = "entries";
          this.selectedPath = null;
          this.selectedKind = "empty";
          this.selectedSize = null;
          this.editorContent = "";
          this.imageData = null;
          this.isDirty = false;
          this.render();
          void this.loadDirectory(this.currentPath);
        }
        break;
      case "path":
        if (targetNode instanceof HTMLInputElement) {
          this.pathInput = targetNode.value;
        }
        break;
      case "editor":
        if (targetNode instanceof HTMLTextAreaElement) {
          this.editorContent = targetNode.value;
          this.isDirty = this.selectedKind === "file";
        }
        break;
      case "search-pattern":
        if (targetNode instanceof HTMLInputElement) {
          this.searchPattern = targetNode.value;
        }
        break;
      default:
        break;
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const targetNode = event.target;
    if (!(targetNode instanceof HTMLElement)) {
      return;
    }

    if (
      targetNode instanceof HTMLInputElement &&
      targetNode.dataset.field === "path" &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      if (!this.confirmDiscardChanges()) {
        return;
      }
      void this.loadDirectory(resolvePath(this.pathInput, this.currentPath, this.pathStyle));
      return;
    }

    if (
      targetNode instanceof HTMLInputElement &&
      targetNode.dataset.field === "search-pattern" &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      void this.runSearch();
      return;
    }

    if (
      targetNode instanceof HTMLTextAreaElement &&
      targetNode.dataset.field === "editor" &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void this.saveFile();
    }
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.kernelState = context.kernel.getStatus().state;
    this.suspended = false;
    this.applyThreadContext(this.activeThreadContext, { reload: false, confirm: false });

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      const prev = this.kernelState;
      this.kernelState = status.state;
      if (prev !== "connected" && status.state === "connected" && !this.suspended) {
        void this.loadDeviceSuggestions();
        void this.loadDirectory(this.currentPath);
      }
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("input", this.onInput);
    this.addEventListener("keydown", this.onKeyDown);
    this.unsubscribeThreadContext?.();
    this.unsubscribeThreadContext = subscribeActiveThreadContext((threadContext) => {
      this.applyThreadContext(threadContext, { reload: true, confirm: true });
    });

    this.render();
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      await this.loadDirectory(this.currentPath);
    }
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      await this.loadDirectory(this.currentPath);
    }
    this.render();
  }

  async gsvOnSignal(signal: string): Promise<void> {
    if (signal !== "device.status") {
      return;
    }
    if (this.suspended || this.kernelState !== "connected") {
      return;
    }
    await this.loadDeviceSuggestions();
  }

  async gsvUnmount(): Promise<void> {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("input", this.onInput);
    this.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeThreadContext?.();
    this.unsubscribeThreadContext = null;
    this.context = null;
    this.kernelState = "disconnected";
    this.suspended = false;
    this.devices = [];
    this.pathStyle = "absolute";
    this.currentPath = "/";
    this.pathInput = "/";
    this.entries = [];
    this.searchMatches = [];
    this.searchTruncated = false;
    this.selectedPath = null;
    this.selectedKind = "empty";
    this.selectedSize = null;
    this.editorContent = "";
    this.imageData = null;
    this.isDirty = false;
    this.currentView = "explorer";
    this.explorerPane = "entries";
    this.searchPattern = "";
    this.isLoadingDir = false;
    this.isLoadingFile = false;
    this.isSaving = false;
    this.isDeleting = false;
    this.isSearching = false;
    this.isRefreshingDevices = false;
    this.statusKind = "idle";
    this.statusText = "";
  }

  private preferredGsvPath(threadContext: ThreadContext | null): string {
    if (threadContext?.workspaceId) {
      return `/workspaces/${threadContext.workspaceId}`;
    }
    if (threadContext?.cwd) {
      return normalizePath(threadContext.cwd, "absolute");
    }
    return "/";
  }

  private applyThreadContext(
    threadContext: ThreadContext | null,
    options?: { reload: boolean; confirm: boolean },
  ): void {
    this.activeThreadContext = threadContext;
    if (normalizeTarget(this.target) !== "gsv") {
      return;
    }

    const nextPath = this.preferredGsvPath(threadContext);
    const normalizedCurrent = normalizePath(this.currentPath, "absolute");
    const normalizedNext = normalizePath(nextPath, "absolute");
    if (normalizedCurrent === normalizedNext) {
      return;
    }

    if (options?.confirm !== false && !this.confirmDiscardChanges()) {
      return;
    }

    this.pathStyle = "absolute";
    this.currentPath = normalizedNext;
    this.pathInput = normalizedNext;
    this.entries = [];
    this.currentView = "explorer";
    this.explorerPane = "entries";
    this.selectedPath = null;
    this.selectedKind = "empty";
    this.selectedSize = null;
    this.editorContent = "";
    this.imageData = null;
    this.isDirty = false;
    this.searchMatches = [];
    this.searchTruncated = false;
    this.setStatus("idle", "");

    if (options?.reload && this.context && this.kernelState === "connected" && !this.suspended) {
      void this.loadDirectory(this.currentPath);
      return;
    }

    this.render();
  }

  private setStatus(kind: "idle" | "error", text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private describeViewState(): { kind: FilesViewState; label: string; detail: string } {
    if (this.kernelState !== "connected") {
      return { kind: "offline", label: "offline", detail: "Kernel is not connected." };
    }
    if (this.statusKind === "error" && this.statusText.length > 0) {
      return { kind: "error", label: "error", detail: this.statusText };
    }
    if (
      this.isLoadingDir ||
      this.isLoadingFile ||
      this.isSaving ||
      this.isDeleting ||
      this.isSearching ||
      this.isRefreshingDevices
    ) {
      return { kind: "working", label: "working", detail: "File operations in progress." };
    }
    return { kind: "ready", label: "ready", detail: "Explorer is ready." };
  }

  private withTarget(args: Record<string, unknown>): Record<string, unknown> {
    const target = normalizeTarget(this.target);
    if (target === "gsv") {
      return args;
    }
    return { ...args, target };
  }

  private async loadDeviceSuggestions(): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    this.isRefreshingDevices = true;
    this.render();
    try {
      const payload = await context.kernel.request<DeviceListResult>("sys.device.list", {});
      const next = Array.isArray(payload.devices) ? payload.devices : [];
      next.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      this.devices = next;
      const normalizedTarget = normalizeTarget(this.target);
      if (normalizedTarget !== "gsv" && !next.some((device) => device.deviceId === normalizedTarget)) {
        this.target = "gsv";
      }
    } catch {
      this.devices = [];
    } finally {
      if (!this.context) {
        return;
      }
      this.isRefreshingDevices = false;
      this.render();
    }
  }

  private async loadDirectory(path: string): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    const resolvedPath = normalizePath(
      path,
      path.trim().startsWith("/") ? "absolute" : this.pathStyle,
    );
    this.isLoadingDir = true;
    this.setStatus("idle", "");
    this.render();

    try {
      let result = await context.kernel.request<FsReadResult>(
        "fs.read",
        this.withTarget({ path: resolvedPath }),
      );
      if (!result.ok && this.target !== "gsv") {
        const fallbackPath = resolvedPath.startsWith("/") ? "." : "/";
        const fallback = await context.kernel.request<FsReadResult>(
          "fs.read",
          this.withTarget({ path: fallbackPath }),
        );
        if (fallback.ok) {
          result = fallback;
        }
      }
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }

      if (!isDirectoryReadResult(result)) {
        await this.openFile(resolvedPath);
        return;
      }

      const style = detectPathStyle(result.path);
      const directories = [...result.directories].sort((left, right) => left.localeCompare(right));
      const files = [...result.files].sort((left, right) => left.localeCompare(right));
      const nextEntries: FileEntry[] = [
        ...directories.map((name) => ({
          name,
          path: resolvePath(name, result.path, style),
          isDirectory: true,
        })),
        ...files.map((name) => ({
          name,
          path: resolvePath(name, result.path, style),
          isDirectory: false,
        })),
      ];

      this.entries = nextEntries;
      this.pathStyle = style;
      this.currentPath = normalizePath(result.path, style);
      this.pathInput = this.currentPath;
      this.currentView = "explorer";
      this.explorerPane = "entries";
      this.searchMatches = [];
      this.searchTruncated = false;

      if (this.selectedPath && !nextEntries.some((entry) => entry.path === this.selectedPath)) {
        this.selectedPath = null;
        this.selectedKind = "empty";
        this.selectedSize = null;
        this.editorContent = "";
        this.imageData = null;
        this.isDirty = false;
      }
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoadingDir = false;
      this.render();
    }
  }

  private async openFile(path: string): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    this.isLoadingFile = true;
    this.setStatus("idle", "");
    this.render();

    try {
      let readPath = path;
      let result = await context.kernel.request<FsReadResult>(
        "fs.read",
        this.withTarget({ path: readPath }),
      );
      if (!result.ok && this.target !== "gsv") {
        const fallbackPath = readPath.startsWith("/")
          ? readPath.replace(/^\/+/, "")
          : `/${readPath}`;
        if (fallbackPath && fallbackPath !== readPath) {
          readPath = fallbackPath;
          const fallback = await context.kernel.request<FsReadResult>(
            "fs.read",
            this.withTarget({ path: readPath }),
          );
          if (fallback.ok) {
            result = fallback;
          }
        }
      }
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }

      if (!isFileReadResult(result)) {
        await this.loadDirectory(result.path);
        return;
      }

      const style = detectPathStyle(result.path);
      this.pathStyle = style;
      this.selectedPath = normalizePath(result.path, style);
      this.selectedSize = typeof result.size === "number" ? result.size : null;
      this.isDirty = false;
      this.currentView = "editor";
      this.imageData = null;
      this.editorContent = "";

      if (typeof result.content === "string") {
        this.selectedKind = "file";
        this.editorContent = decodeNumberedText(result.content);
      } else {
        const imageBlock = result.content.find(
          (entry): entry is { type: "image"; data: string; mimeType: string } =>
            entry.type === "image",
        );
        if (imageBlock) {
          this.selectedKind = "image";
          this.imageData = {
            mimeType: imageBlock.mimeType,
            base64: imageBlock.data,
          };
        } else {
          this.selectedKind = "file";
          const textBlock = result.content.find(
            (entry): entry is { type: "text"; text: string } => entry.type === "text",
          );
          this.editorContent = textBlock?.text ?? "";
        }
      }
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoadingFile = false;
      this.render();
    }
  }

  private async saveFile(): Promise<void> {
    const context = this.context;
    if (
      !context ||
      this.kernelState !== "connected" ||
      this.suspended ||
      this.selectedKind !== "file" ||
      !this.selectedPath ||
      !this.isDirty ||
      this.isSaving
    ) {
      return;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const result = await context.kernel.request<FsWriteResult>(
        "fs.write",
        this.withTarget({ path: this.selectedPath, content: this.editorContent }),
      );
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }
      this.isDirty = false;
      this.selectedSize = result.size;
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async deleteSelected(): Promise<void> {
    const context = this.context;
    if (
      !context ||
      this.kernelState !== "connected" ||
      this.suspended ||
      !this.selectedPath ||
      this.isDeleting
    ) {
      return;
    }

    if (!window.confirm(`Delete ${this.selectedPath}?`)) {
      return;
    }

    this.isDeleting = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const result = await context.kernel.request<FsDeleteResult>(
        "fs.delete",
        this.withTarget({ path: this.selectedPath }),
      );
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }

      const deletedPath = this.selectedPath;
      this.selectedPath = null;
      this.selectedKind = "empty";
      this.selectedSize = null;
      this.editorContent = "";
      this.imageData = null;
      this.isDirty = false;
      this.currentView = "explorer";

      const nextDir =
        normalizePath(deletedPath, this.pathStyle) === normalizePath(this.currentPath, this.pathStyle)
          ? parentPath(this.currentPath, this.pathStyle)
          : this.currentPath;
      await this.loadDirectory(nextDir);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isDeleting = false;
      this.render();
    }
  }

  private async createFile(fileName: string): Promise<void> {
    const context = this.context;
    if (
      !context ||
      this.kernelState !== "connected" ||
      this.suspended ||
      this.isSaving ||
      this.isDeleting
    ) {
      return;
    }

    const raw = fileName.trim();
    if (!raw) {
      this.setStatus("error", "New file name is required.");
      this.render();
      return;
    }

    const path = resolvePath(raw, this.currentPath, this.pathStyle);
    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const result = await context.kernel.request<FsWriteResult>(
        "fs.write",
        this.withTarget({ path, content: "" }),
      );
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }

      await this.loadDirectory(this.currentPath);
      await this.openFile(path);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async runSearch(): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended || this.isSearching) {
      return;
    }

    const pattern = this.searchPattern.trim();
    if (!pattern) {
      this.setStatus("error", "Search pattern is required.");
      this.render();
      return;
    }

    this.isSearching = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const result = await context.kernel.request<FsSearchResult>(
        "fs.search",
        this.withTarget({
          pattern,
          path: this.currentPath,
        }),
      );
      if (!result.ok) {
        this.setStatus("error", result.error);
        return;
      }
      this.explorerPane = "search";
      this.searchMatches = result.matches;
      this.searchTruncated = result.truncated === true;
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.context) {
        return;
      }
      this.isSearching = false;
      this.render();
    }
  }

  private renderBreadcrumbs(): string {
    const normalized = normalizePath(this.currentPath, this.pathStyle);

    if (this.pathStyle === "absolute") {
      if (normalized === "/") {
        return `<button type="button" class="files-crumb is-current" data-action="open-path" data-path="/">/</button>`;
      }

      const segments = normalized.split("/").filter(Boolean);
      const crumbs: string[] = [
        `<button type="button" class="files-crumb" data-action="open-path" data-path="/">/</button>`,
      ];

      let current = "";
      for (let index = 0; index < segments.length; index += 1) {
        current += `/${segments[index]}`;
        const isLast = index === segments.length - 1;
        crumbs.push(`
          <button
            type="button"
            class="files-crumb${isLast ? " is-current" : ""}"
            data-action="open-path"
            data-path="${escapeHtml(current)}"
          >
            ${escapeHtml(segments[index])}
          </button>
        `);
      }

      return crumbs.join(`<span class="files-crumb-sep">/</span>`);
    }

    if (normalized === ".") {
      return `<button type="button" class="files-crumb is-current" data-action="open-path" data-path=".">workspace</button>`;
    }

    const segments = normalized.split("/").filter(Boolean);
    const crumbs: string[] = [
      `<button type="button" class="files-crumb" data-action="open-path" data-path=".">workspace</button>`,
    ];
    let current = "";
    for (let index = 0; index < segments.length; index += 1) {
      current = current ? `${current}/${segments[index]}` : segments[index];
      const isLast = index === segments.length - 1;
      crumbs.push(`
        <button
          type="button"
          class="files-crumb${isLast ? " is-current" : ""}"
          data-action="open-path"
          data-path="${escapeHtml(current)}"
        >
          ${escapeHtml(segments[index])}
        </button>
      `);
    }
    return crumbs.join(`<span class="files-crumb-sep">/</span>`);
  }

  private renderEntryRows(): string {
    if (this.entries.length === 0) {
      return `<p class="config-empty muted">This directory is empty.</p>`;
    }

    return this.entries
      .map((entry) => {
        const isSelected = this.selectedPath === entry.path;
        const typeLabel = entry.isDirectory ? "directory" : "file";
        const iconVariant = fileIconVariant(entry.name, entry.isDirectory);
        return `
          <button
            type="button"
            class="files-entry-tile${isSelected ? " is-selected" : ""}"
            data-action="open-entry"
            data-kind="${typeLabel}"
            data-path="${escapeHtml(entry.path)}"
            title="${escapeHtml(entry.path)}"
          >
            ${renderFileIcon(iconVariant)}
            <span class="files-entry-name">${escapeHtml(entry.name)}</span>
          </button>
        `;
      })
      .join("");
  }

  private renderEditorView(): string {
    if (this.isLoadingFile) {
      return `<p class="config-empty muted">Loading file…</p>`;
    }

    if (!this.selectedPath || this.selectedKind === "empty") {
      return `<p class="config-empty muted">No file is open.</p>`;
    }

    if (this.selectedKind === "image" && this.imageData) {
      return `
        <header class="files-editor-header">
          <div class="files-detail-title">
            <button type="button" class="runtime-btn" data-action="back-to-explorer">Back</button>
            <h3>${escapeHtml(baseName(this.selectedPath))}</h3>
            <p class="muted">${escapeHtml(this.selectedPath)}</p>
          </div>
          <div class="files-detail-actions">
            <span class="muted">${escapeHtml(this.imageData.mimeType)} · ${escapeHtml(formatBytes(this.selectedSize ?? 0))}</span>
            <button
              type="button"
              class="runtime-btn"
              data-action="delete-selected"
              ${!this.isDeleting && !this.suspended ? "" : "disabled"}
            >
              ${this.isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </header>
        <div class="files-image-wrap">
          <img
            class="files-image-preview"
            alt="${escapeHtml(this.selectedPath)}"
            src="data:${escapeHtml(this.imageData.mimeType)};base64,${this.imageData.base64}"
          />
        </div>
      `;
    }

    return `
      <header class="files-editor-header">
        <div class="files-detail-title">
          <button type="button" class="runtime-btn" data-action="back-to-explorer">Back</button>
          <h3>${escapeHtml(baseName(this.selectedPath))}</h3>
          <p class="muted">${escapeHtml(this.selectedPath)}</p>
        </div>
        <div class="files-detail-actions">
          <span class="muted">${escapeHtml(formatBytes(this.selectedSize ?? 0))}</span>
          <button
            type="button"
            class="runtime-btn"
            data-action="save-file"
            ${this.isDirty && !this.isSaving && !this.suspended ? "" : "disabled"}
          >
            ${this.isSaving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            class="runtime-btn"
            data-action="delete-selected"
            ${!this.isDeleting && !this.suspended ? "" : "disabled"}
          >
            ${this.isDeleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </header>
      <textarea
        class="files-editor"
        data-field="editor"
        spellcheck="false"
        ${this.suspended ? "disabled" : ""}
      >${escapeHtml(this.editorContent)}</textarea>
    `;
  }

  private renderExplorerPane(): string {
    if (this.explorerPane === "search") {
      return `
        <section class="files-search-view">
          <header class="files-search-header">
            <h3>Search Results</h3>
            <p class="muted">${this.searchMatches.length} match${this.searchMatches.length === 1 ? "" : "es"}</p>
          </header>
          <div class="files-search-results">
            ${this.renderSearchRows()}
          </div>
        </section>
      `;
    }

    return `
      <section class="files-grid-view">
        ${this.isLoadingDir ? `<p class="config-empty muted">Loading directory…</p>` : this.renderEntryRows()}
      </section>
    `;
  }

  private renderSearchRows(): string {
    if (this.searchMatches.length === 0) {
      return `<p class="config-empty muted">No search results yet.</p>`;
    }

    const rows = this.searchMatches
      .map((match) => {
        return `
          <button
            type="button"
            class="files-search-row"
            data-action="open-entry"
            data-kind="file"
            data-path="${escapeHtml(match.path)}"
          >
            <strong>${escapeHtml(match.path)}:${match.line}</strong>
            <code>${escapeHtml(match.content)}</code>
          </button>
        `;
      })
      .join("");

    return `
      ${rows}
      ${this.searchTruncated ? `<p class="muted">Results truncated.</p>` : ""}
    `;
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const state = this.describeViewState();
    const target = normalizeTarget(this.target);
    const targetSelectValue =
      target === "gsv" || this.devices.some((device) => device.deviceId === target)
        ? target
        : "gsv";
    const canRefresh =
      this.kernelState === "connected" &&
      !this.suspended &&
      !this.isLoadingDir &&
      !this.isLoadingFile &&
      !this.isSearching;
    const explorerCountLabel =
      this.explorerPane === "search"
        ? `${this.searchMatches.length} result${this.searchMatches.length === 1 ? "" : "s"}`
        : `${this.entries.length} item${this.entries.length === 1 ? "" : "s"}`;
    const atRoot =
      this.pathStyle === "absolute"
        ? this.currentPath === "/"
        : this.currentPath === ".";

    const targetOptions = [
      `<option value="gsv"${targetSelectValue === "gsv" ? " selected" : ""}>Kernel (gsv)</option>`,
      ...this.devices.map((device) => {
        const suffix = device.online ? " · online" : " · offline";
        const selected = targetSelectValue === device.deviceId ? " selected" : "";
        return `<option value="${escapeHtml(device.deviceId)}"${selected}>${escapeHtml(device.deviceId + suffix)}</option>`;
      }),
    ].join("");

    this.innerHTML = `
      <section class="app-grid files-app">
        <section class="files-toolbar">
          <div class="files-toolbar-left">
            <label class="files-target-field">
              <span class="visually-hidden">Target</span>
              <select data-field="target-select" ${this.suspended ? "disabled" : ""}>
                ${targetOptions}
              </select>
            </label>
            <button
              type="button"
              class="runtime-btn"
              data-action="up"
              title="Go to parent directory"
              ${atRoot || this.suspended ? "disabled" : ""}
            >
              Up
            </button>
            <input
              data-field="path"
              type="text"
              value="${escapeHtml(this.pathInput)}"
              ${this.suspended ? "disabled" : ""}
            />
            <button
              type="button"
              class="runtime-btn config-icon-btn"
              data-action="create-file"
              title="Create file"
              aria-label="Create file"
              ${this.isSaving || this.suspended ? "disabled" : ""}
            >
              ${renderActionIcon("new-file")}
            </button>
          </div>
          <div class="files-toolbar-right">
            <span class="config-state-icon is-${escapeHtml(state.kind)}" title="${escapeHtml(state.detail)}" aria-label="${escapeHtml(state.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isLoadingDir || this.isRefreshingDevices ? " is-busy" : ""}"
              data-action="refresh"
              title="Refresh directory"
              aria-label="Refresh directory"
              ${canRefresh ? "" : "disabled"}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </section>

        <section class="files-searchbar">
          <input
            data-field="search-pattern"
            type="text"
            value="${escapeHtml(this.searchPattern)}"
            placeholder="Search current folder (regex)"
            ${this.suspended ? "disabled" : ""}
          />
          <button
            type="button"
            class="runtime-btn"
            data-action="search"
            ${this.isSearching || this.suspended ? "disabled" : ""}
          >
            ${this.isSearching ? "Searching..." : "Search"}
          </button>
          <button
            type="button"
            class="runtime-btn"
            data-action="clear-search"
            ${this.searchMatches.length > 0 && !this.suspended ? "" : "disabled"}
          >
            Clear
          </button>
        </section>

        <section class="files-breadcrumbs">
          ${this.renderBreadcrumbs()}
        </section>

        <section class="files-main">
          <div class="files-main-meta">
            <p class="muted">${explorerCountLabel}</p>
          </div>
          ${this.currentView === "editor"
            ? `<section class="files-editor-view">${this.renderEditorView()}</section>`
            : this.renderExplorerPane()}
        </section>

        ${this.statusKind === "error" && this.statusText
          ? `<p class="control-error-text">${escapeHtml(this.statusText)}</p>`
          : ""}
      </section>
    `;
  }
}

export function ensureFilesAppRegistered(): void {
  defineElement("gsv-files-app", GsvFilesAppElement);
}
