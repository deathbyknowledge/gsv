import { isTextContentType } from "@humansandmachines/gsv/protocol";
import {
  acquireDebugger,
  releaseDebugger,
  sendDebuggerCommand,
} from "../shared/debugger";
import { abortable, throwIfAborted } from "./abort";

export type TabResourceDirectoryListing = {
  files: string[];
  directories: string[];
};

export type TabResourceFile = {
  contentType: string;
  size: number;
  read: () => Promise<Uint8Array>;
};

export type TabResourceSearchMatch = {
  path: string;
  line: number;
  content: string;
};

type CdpFrame = {
  id: string;
  loaderId?: string;
  url: string;
  mimeType?: string;
  name?: string;
  parentId?: string;
  securityOrigin?: string;
};

type CdpFrameResource = {
  url: string;
  type: string;
  mimeType: string;
  lastModified?: number;
  contentSize?: number;
  failed?: boolean;
  canceled?: boolean;
};

type CdpFrameResourceTree = {
  frame: CdpFrame;
  resources?: CdpFrameResource[];
  childFrames?: CdpFrameResourceTree[];
};

type CdpResourceTreeResult = {
  frameTree?: CdpFrameResourceTree;
};

type CdpResourceContentResult = {
  content?: string;
  base64Encoded?: boolean;
};

type CdpSearchResult = {
  result?: Array<{
    lineNumber: number;
    lineContent: string;
  }>;
};

type FrameSummary = {
  id: string;
  parentId: string | null;
  loaderId: string | null;
  name: string | null;
  url: string;
  securityOrigin: string | null;
};

type ResourceDescriptor = {
  path: string;
  url: string;
  frameId: string;
  frameUrl: string;
  type: string;
  mimeType: string;
  contentSize: number | null;
  lastModified: number | null;
  failed: boolean;
  canceled: boolean;
};

type ResourceInventory = {
  tabId: number;
  mainFrameId: string;
  loaderId: string | null;
  frames: FrameSummary[];
  resources: ResourceDescriptor[];
  byPath: Map<string, ResourceDescriptor>;
  directories: Set<string>;
};

type CachedInventory = {
  expiresAt: number;
  promise: Promise<ResourceInventory>;
};

type RawResource = Omit<ResourceDescriptor, "path">;

const INDEX_FILE = "index.json";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const INVENTORY_CACHE_MS = 1_000;
const MAX_MANIFEST_URL_CHARS = 2_048;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_LINE_CHARS = 1_000;

export class TabResourceStore {
  private readonly inventories = new Map<number, CachedInventory>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly cacheMs = INVENTORY_CACHE_MS,
  ) {
    this.observeTabLifecycle();
  }

  invalidate(tabId: number): void {
    this.inventories.delete(tabId);
  }

  private observeTabLifecycle(): void {
    if (typeof chrome === "undefined" || !chrome.tabs) {
      return;
    }
    chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
        this.invalidate(tabId);
      }
    });
    chrome.tabs.onRemoved?.addListener((tabId) => this.invalidate(tabId));
  }

  async list(tabId: number, relativePath: string): Promise<TabResourceDirectoryListing | null> {
    const inventory = await this.getInventory(tabId);
    const directory = normalizeRelativePath(relativePath);
    if (!inventory.directories.has(directory)) {
      return null;
    }

    const files = new Set<string>();
    const directories = new Set<string>();
    if (!directory) {
      files.add(INDEX_FILE);
    }
    for (const resource of inventory.resources) {
      addDirectChild(resource.path, directory, files, directories);
    }
    return {
      files: [...files].sort(),
      directories: [...directories].sort(),
    };
  }

  async file(tabId: number, relativePath: string): Promise<TabResourceFile | null> {
    const path = normalizeRelativePath(relativePath);
    const inventory = await this.getInventory(tabId);
    if (path === INDEX_FILE) {
      const bytes = inventoryBytes(inventory);
      return {
        contentType: JSON_CONTENT_TYPE,
        size: bytes.byteLength,
        read: async () => inventoryBytes(await this.getInventory(tabId)),
      };
    }

    const resource = inventory.byPath.get(path);
    if (!resource) {
      return null;
    }
    return {
      contentType: resource.mimeType || DEFAULT_CONTENT_TYPE,
      size: resource.contentSize ?? 0,
      read: async () => await this.readResource(tabId, path),
    };
  }

  async search(
    tabId: number,
    relativePath: string,
    query: string,
    include?: string,
    signal?: AbortSignal,
  ): Promise<TabResourceSearchMatch[]> {
    throwIfAborted(signal);
    const root = normalizeRelativePath(relativePath);
    let inventory = await abortable(this.getInventory(tabId), signal);
    const matches = searchIndex(inventory, root, query, include);
    if (matches.length >= MAX_SEARCH_MATCHES || root === INDEX_FILE) {
      return matches.slice(0, MAX_SEARCH_MATCHES);
    }

    let candidates = matchingResources(inventory, root, include);
    if (candidates.length === 0) {
      return matches;
    }

    let searched = 0;
    const errors: string[] = [];
    await withDebugger(tabId, async (target) => {
      await sendDebuggerCommand(target, "Page.enable");
      for (const resource of candidates) {
        throwIfAborted(signal);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          break;
        }
        try {
          const response = await abortable(
            sendDebuggerCommand<CdpSearchResult>(target, "Page.searchInResource", {
              frameId: resource.frameId,
              url: resource.url,
              query,
              caseSensitive: true,
              isRegex: false,
            }),
            signal,
          );
          searched += 1;
          for (const result of response?.result ?? []) {
            matches.push({
              path: resource.path,
              line: result.lineNumber + 1,
              content: compactSearchLine(result.lineContent, query),
            });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              break;
            }
          }
        } catch (error) {
          throwIfAborted(signal);
          errors.push(errorMessage(error));
        }
      }
    });

    if (searched === 0 && errors.length > 0) {
      this.invalidate(tabId);
      inventory = await abortable(this.getInventory(tabId), signal);
      candidates = matchingResources(inventory, root, include);
      if (candidates.length > 0) {
        throw new Error(`Unable to search tab resources: ${errors[0]}`);
      }
    }
    return matches.slice(0, MAX_SEARCH_MATCHES);
  }

  private async readResource(tabId: number, path: string): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inventory = await this.getInventory(tabId, attempt > 0);
      const resource = inventory.byPath.get(path);
      if (!resource) {
        throw new Error(`Tab resource no longer exists: ${path}`);
      }

      try {
        return await withDebugger(tabId, async (target) => {
          await sendDebuggerCommand(target, "Page.enable");
          const response = await sendDebuggerCommand<CdpResourceContentResult>(target, "Page.getResourceContent", {
            frameId: resource.frameId,
            url: resource.url,
          });
          if (typeof response?.content !== "string") {
            throw new Error(`Page.getResourceContent returned no content for ${resource.url}`);
          }
          return response.base64Encoded
            ? base64ToBytes(response.content)
            : new TextEncoder().encode(response.content);
        });
      } catch (error) {
        if (attempt === 0) {
          this.invalidate(tabId);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Unable to read tab resource: ${path}`);
  }

  private async getInventory(tabId: number, force = false): Promise<ResourceInventory> {
    const cached = this.inventories.get(tabId);
    if (!force && cached && cached.expiresAt >= this.now()) {
      return await cached.promise;
    }

    const promise = loadInventory(tabId);
    this.inventories.set(tabId, {
      expiresAt: this.now() + this.cacheMs,
      promise,
    });
    try {
      return await promise;
    } catch (error) {
      if (this.inventories.get(tabId)?.promise === promise) {
        this.inventories.delete(tabId);
      }
      throw error;
    }
  }
}

async function loadInventory(tabId: number): Promise<ResourceInventory> {
  return await withDebugger(tabId, async (target) => {
    await sendDebuggerCommand(target, "Page.enable");
    const result = await sendDebuggerCommand<CdpResourceTreeResult>(target, "Page.getResourceTree");
    if (!result?.frameTree) {
      throw new Error("Page.getResourceTree returned no frame tree");
    }

    const frames: FrameSummary[] = [];
    const rawResources: RawResource[] = [];
    collectFrameResources(result.frameTree, frames, rawResources);
    const resources = assignResourcePaths(rawResources);
    const directories = new Set<string>([""]);
    for (const resource of resources) {
      addParentDirectories(resource.path, directories);
    }
    return {
      tabId,
      mainFrameId: result.frameTree.frame.id,
      loaderId: result.frameTree.frame.loaderId ?? null,
      frames,
      resources,
      byPath: new Map(resources.map((resource) => [resource.path, resource])),
      directories,
    };
  });
}

function collectFrameResources(
  tree: CdpFrameResourceTree,
  frames: FrameSummary[],
  resources: RawResource[],
): void {
  const frame = tree.frame;
  frames.push({
    id: frame.id,
    parentId: frame.parentId ?? null,
    loaderId: frame.loaderId ?? null,
    name: frame.name ?? null,
    url: manifestUrl(frame.url).value,
    securityOrigin: frame.securityOrigin ?? null,
  });

  if (frame.url) {
    resources.push({
      url: frame.url,
      frameId: frame.id,
      frameUrl: frame.url,
      type: "Document",
      mimeType: frame.mimeType || "text/html",
      contentSize: null,
      lastModified: null,
      failed: false,
      canceled: false,
    });
  }
  for (const resource of tree.resources ?? []) {
    if (!resource.url || (resource.url === frame.url && resource.type === "Document")) {
      continue;
    }
    resources.push({
      url: resource.url,
      frameId: frame.id,
      frameUrl: frame.url,
      type: resource.type,
      mimeType: resource.mimeType || DEFAULT_CONTENT_TYPE,
      contentSize: finiteSize(resource.contentSize),
      lastModified: finiteNumber(resource.lastModified),
      failed: resource.failed === true,
      canceled: resource.canceled === true,
    });
  }
  for (const child of tree.childFrames ?? []) {
    collectFrameResources(child, frames, resources);
  }
}

function assignResourcePaths(resources: RawResource[]): ResourceDescriptor[] {
  const sorted = [...resources].sort((left, right) => (
    left.url.localeCompare(right.url)
    || left.frameId.localeCompare(right.frameId)
    || left.type.localeCompare(right.type)
  ));
  const used = new Set<string>();
  return sorted.map((resource) => {
    const base = resourcePath(resource);
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = addFilenameSuffix(base, `~${suffix}`);
      suffix += 1;
    }
    used.add(path);
    return { ...resource, path };
  });
}

function resourcePath(resource: RawResource): string {
  const parsed = safeUrl(resource.url);
  const scheme = sanitizeSegment(parsed?.protocol.replace(/:$/, "") || "other");
  const host = sanitizeSegment(parsed?.host || "local");
  const rawName = parsed ? lastPathSegment(parsed.pathname) : "resource";
  const withExtension = ensureResourceExtension(sanitizeSegment(rawName || "index"), resource);
  const fingerprint = shortHash(resource.url);
  return `${scheme}/${host}/${addFilenameSuffix(withExtension, `~${fingerprint}`)}`;
}

function inventoryBytes(inventory: ResourceInventory): Uint8Array {
  const resources = inventory.resources.map((resource) => {
    const url = manifestUrl(resource.url);
    return {
      path: resource.path,
      url: url.value,
      ...(url.truncated ? { urlTruncated: true, urlLength: resource.url.length } : {}),
      frameId: resource.frameId,
      frameUrl: manifestUrl(resource.frameUrl).value,
      type: resource.type,
      mimeType: resource.mimeType,
      contentSize: resource.contentSize,
      lastModified: resource.lastModified,
      failed: resource.failed,
      canceled: resource.canceled,
    };
  });
  return new TextEncoder().encode(`${JSON.stringify({
    tabId: inventory.tabId,
    mainFrameId: inventory.mainFrameId,
    loaderId: inventory.loaderId,
    frames: inventory.frames,
    resources,
    count: resources.length,
  }, null, 2)}\n`);
}

function matchingResources(
  inventory: ResourceInventory,
  root: string,
  include?: string,
): ResourceDescriptor[] {
  const file = inventory.byPath.get(root);
  const resources = file ? [file] : inventory.resources.filter((resource) => isWithin(resource.path, root));
  return resources.filter((resource) => (
    !resource.failed
    && !resource.canceled
    && isTextContentType(resource.mimeType || DEFAULT_CONTENT_TYPE)
    && matchesInclude(resource.path, root, include)
  ));
}

function searchIndex(
  inventory: ResourceInventory,
  root: string,
  query: string,
  include?: string,
): TabResourceSearchMatch[] {
  if (root && root !== INDEX_FILE) {
    return [];
  }
  if (!matchesInclude(INDEX_FILE, root, include)) {
    return [];
  }
  const text = new TextDecoder().decode(inventoryBytes(inventory));
  const matches: TabResourceSearchMatch[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.includes(query)) {
      matches.push({ path: INDEX_FILE, line: index + 1, content: line });
    }
  }
  return matches;
}

function addDirectChild(
  filePath: string,
  directory: string,
  files: Set<string>,
  directories: Set<string>,
): void {
  if (!isWithin(filePath, directory)) {
    return;
  }
  const relative = directory ? filePath.slice(directory.length + 1) : filePath;
  const slash = relative.indexOf("/");
  if (slash < 0) {
    files.add(relative);
  } else {
    directories.add(relative.slice(0, slash));
  }
}

function addParentDirectories(path: string, directories: Set<string>): void {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    directories.add(parts.slice(0, index).join("/"));
  }
}

function normalizeRelativePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function isWithin(path: string, root: string): boolean {
  return !root || path === root || path.startsWith(`${root}/`);
}

function matchesInclude(path: string, root: string, include?: string): boolean {
  const pattern = include?.trim();
  if (!pattern) {
    return true;
  }
  const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const regex = globToRegExp(pattern);
  return regex.test(relative) || regex.test(path) || regex.test(lastPathSegment(path));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    source += char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function ensureResourceExtension(name: string, resource: RawResource): string {
  if (/\.[a-z0-9]{1,12}$/i.test(name)) {
    return name;
  }
  const extension = extensionFor(resource.mimeType, resource.type);
  return extension ? `${name}.${extension}` : name;
}

function extensionFor(mimeType: string, type: string): string | null {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  const byMime: Record<string, string> = {
    "application/javascript": "js",
    "application/json": "json",
    "application/manifest+json": "json",
    "application/pdf": "pdf",
    "application/wasm": "wasm",
    "application/x-javascript": "js",
    "application/xml": "xml",
    "font/otf": "otf",
    "font/ttf": "ttf",
    "font/woff": "woff",
    "font/woff2": "woff2",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/css": "css",
    "text/html": "html",
    "text/javascript": "js",
    "text/plain": "txt",
  };
  const match = byMime[mime];
  if (match) {
    return match;
  }
  const byType: Record<string, string> = {
    Document: "html",
    Script: "js",
    Stylesheet: "css",
  };
  return byType[type] ?? null;
}

function addFilenameSuffix(path: string, suffix: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return `${directory}${name}${suffix}`;
  }
  return `${directory}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

function sanitizeSegment(value: string): string {
  const decoded = decodeUrlComponent(value).normalize("NFKC");
  const compact = decoded
    .replace(/[^a-zA-Z0-9._@+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 120);
  return compact || "_";
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "index";
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function manifestUrl(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_MANIFEST_URL_CHARS) {
    return { value, truncated: false };
  }
  return {
    value: `${value.slice(0, MAX_MANIFEST_URL_CHARS - 1)}…`,
    truncated: true,
  };
}

function finiteSize(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function finiteNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function compactSearchLine(line: string, query: string): string {
  if (line.length <= MAX_SEARCH_LINE_CHARS) {
    return line;
  }
  const match = Math.max(0, line.indexOf(query));
  const start = Math.max(0, match - Math.floor(MAX_SEARCH_LINE_CHARS / 3));
  const end = Math.min(line.length, start + MAX_SEARCH_LINE_CHARS);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

async function withDebugger<T>(
  tabId: number,
  use: (target: chrome.debugger.DebuggerSession) => Promise<T>,
): Promise<T> {
  const target = await acquireDebugger(tabId);
  try {
    return await use(target);
  } finally {
    await releaseDebugger(tabId).catch((error: unknown) => {
      console.warn("GSV browser target failed to detach debugger", error);
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
