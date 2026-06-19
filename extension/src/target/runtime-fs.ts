import type { FileStat, TargetFileSystem } from "./types";
import { basename, normalizePath } from "../shared/paths";
import {
  activeTab,
  executeInTab,
  getTab,
  listTabs,
  listWindows,
  type TabSummary,
  type WindowSummary,
} from "../shared/chrome";
import {
  networkEventsJsonl,
  networkRequestsSnapshot,
  networkStatusSnapshot,
} from "./network-recorder";

type DirectoryListing = { files: string[]; directories: string[] };

type RuntimeFile = {
  contentType: string;
  read: () => Promise<Uint8Array>;
};

type RuntimeManifest = {
  name?: string;
  version?: string;
  manifest_version?: number;
  permissions?: string[];
  host_permissions?: string[];
};

const READONLY_MESSAGE = "Runtime filesystem is read-only";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_TEXT_CHARS = 120_000;
const MAX_SEARCH_MATCHES = 200;

const README = [
  "GSV browser target",
  "",
  "This target exposes the current browser profile to GSV through shell.exec",
  "and fs.*. Run `help` in shell.exec for browser-specific commands, and run",
  "`<command> --help` for command-specific usage.",
  "",
  "Browser commands:",
  "  tabs list",
  "  tabs active",
  "  tabs get <tabId>",
  "  tabs open [--mime type] <url|path|->",
  "  tabs focus <tabId>",
  "  tabs close <tabId>",
  "  tabs reload <tabId>",
  "",
  "  windows list",
  "  windows focus <windowId>",
  "",
  "  page snapshot [--tab <tabId>] [selector]",
  "  page text [--tab <tabId>] [selector]",
  "  page screenshot [--tab <tabId>]",
  "  page click [--tab <tabId>] <selector> [index]",
  "  page type [--tab <tabId>] <selector> <text>",
  "  page key [--tab <tabId>] <key>",
  "  page scroll [--tab <tabId>] <up|down|top|bottom|x,y>",
  "  page wait [--tab <tabId>] <selector> [--timeout ms]",
  "  page js [--tab <tabId>] <source>",
  "",
  "  clipboard read",
  "  clipboard write <text>",
  "  echo text | clipboard write",
  "",
  "  cookies list <url-or-domain>",
  "  cookies get <url-or-domain> <name>",
  "  cookies set <url> <name> <value>",
  "  cookies delete <url> <name>",
  "",
  "  storage local get [key]",
  "  storage local set <key> <json-or-string>",
  "  storage local delete <key>",
  "",
  "  downloads list [--limit n] [query...]",
  "  downloads get <downloadId>",
  "  downloads start <url> [--filename path] [--save-as] [--conflict uniquify|overwrite|prompt] [--method GET|POST] [--body text] [--header Name:Value]",
  "  downloads pause <downloadId>",
  "  downloads resume <downloadId>",
  "  downloads cancel <downloadId>",
  "  downloads erase <downloadId>",
  "  downloads remove-file <downloadId>",
  "  downloads show <downloadId>",
  "  downloads show-folder",
  "  downloads open <downloadId>",
  "",
  "  history search [--text query] [--limit n] [--start ms-or-iso] [--end ms-or-iso] [query...]",
  "  history visits <url>",
  "  history add <url>",
  "  history delete <url>",
  "  history delete-range <start ms-or-iso> <end ms-or-iso>",
  "  history delete-all --yes",
  "",
  "  bookmarks tree [bookmarkId]",
  "  bookmarks children <folderId>",
  "  bookmarks recent [limit]",
  "  bookmarks search <query>",
  "  bookmarks get <bookmarkId>",
  "  bookmarks create <parentId> <url> <title...>",
  "  bookmarks folder <parentId> <title...>",
  "  bookmarks update <bookmarkId> [--title title] [--url url]",
  "  bookmarks move <bookmarkId> [--parent parentId] [--index index]",
  "  bookmarks delete <bookmarkId>",
  "  bookmarks delete-tree <folderId>",
  "",
  "  network start [--tab <tabId>] [--bodies] [--persist] [--body-limit bytes]",
  "  network stop [--tab <tabId>]",
  "  network status [--tab <tabId>]",
  "  network events [--tab <tabId>] [--limit n] [--url text]",
  "  network get <requestId> [--body]",
  "  network clear [--tab <tabId>]",
  "  network export har [--tab <tabId>] [--path path]",
  "",
  "  media record start [--tab <tabId>] [--path path] [--mode audio|video] [--video] [--max-duration 10m] [--max-bytes bytes] [--monitor on|off]",
  "  media record stop [recordingId]",
  "  media record status [recordingId]",
  "  media record list",
  "",
  "just-bash commands:",
  "  echo, cat, printf, ls, mkdir, rmdir, touch, rm, cp, mv, ln, chmod, pwd,",
  "  readlink, head, tail, wc, stat, grep, fgrep, egrep, rg, sed, awk, sort,",
  "  uniq, comm, cut, paste, tr, rev, nl, fold, expand, unexpand, strings,",
  "  split, column, join, tee, find, basename, dirname, tree, du, env,",
  "  printenv, alias, unalias, xargs, true, false, clear, bash, sh, jq,",
  "  base64, diff, date, sleep, timeout, time, seq, expr, md5sum, sha1sum,",
  "  sha256sum, file, html-to-markdown, help, which, tac, hostname, whoami,",
  "  od, gzip, gunzip, zcat, curl",
  "",
  "Notes:",
  "  curl is enabled with full browser fetch access.",
  "  tabs open can open URLs, browser target files, or stdin in a viewer tab.",
  "  page js uses chrome.debugger and briefly attaches to the target tab.",
  "  network start uses chrome.debugger and stays attached until network stop.",
  "  media record uses tabCapture and may require clicking Grant Recording in the GSV extension UI first.",
  "  each Grant Recording click allows one media record start.",
  "  media record captures audio by default; use --video or --mode video for tab video with audio.",
  "  captured tab audio remains audible by default; use --monitor off to disable playback.",
  "  The browser history command shadows just-bash shell history.",
  "  clipboard read/write currently need an offscreen document bridge.",
  "  downloads open may fail if the browser requires a user gesture.",
  "  gzip, gunzip, and zcat depend on node:zlib and may fail in the browser.",
  "  Shell sessions are not supported yet; files persist across shell.exec calls.",
  "",
  "Writable paths:",
  "  /tmp",
  "  /tmp/render",
  "  /home/browser",
  "  /home/browser/recordings",
  "  /home/browser/screenshots",
  "  /home/browser/network",
  "",
  "Runtime files:",
  "  /README.txt",
  "  /proc/browser.json",
  "  /proc/tabs.json",
  "  /proc/tabs/<tabId>/meta.json",
  "  /proc/tabs/<tabId>/text.txt",
  "  /proc/network/status.json",
  "  /proc/network/events.jsonl",
  "  /proc/network/requests.json",
  "  /proc/windows.json",
  "  /proc/windows/<windowId>/meta.json",
  "  /dev/active-tab",
  "",
  "Directories:",
  "  /tmp",
  "  /home",
  "  /home/browser",
  "  /home/browser/recordings",
  "  /home/browser/screenshots",
  "  /proc/network",
  "  /proc/tabs",
  "  /proc/windows",
  "",
  "Read-only paths:",
  "  /",
  "  /dev",
  "  /proc",
  "",
  "GSV capabilities:",
  "  shell.exec",
  "  fs.read",
  "  fs.write",
  "  fs.edit",
  "  fs.delete",
  "  fs.search",
  "  fs.copy",
  "  fs.transfer.stat",
  "  fs.transfer.send",
  "  fs.transfer.receive",
  "",
].join("\n");

export class RuntimeFileSystem implements TargetFileSystem {
  async read(path: string): Promise<Uint8Array> {
    const normalized = runtimePath(path);
    const file = await this.getFile(normalized);
    if (!file) {
      if (await this.isDirectory(normalized)) {
        throw new Error(`Is a directory: ${normalized}`);
      }
      throw new Error(`No such file: ${normalized}`);
    }
    return await file.read();
  }

  async write(path: string, _content: Uint8Array): Promise<void> {
    throw readOnly(path);
  }

  async append(path: string, _content: Uint8Array): Promise<void> {
    throw readOnly(path);
  }

  async delete(path: string): Promise<void> {
    throw readOnly(path);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = runtimePath(path);
    if (await this.isDirectory(normalized)) {
      return;
    }
    throw readOnly(normalized);
  }

  async copy(source: string, _destination: string): Promise<string> {
    throw readOnly(source);
  }

  async move(source: string, _destination: string): Promise<void> {
    throw readOnly(source);
  }

  async list(path: string): Promise<DirectoryListing> {
    const normalized = runtimePath(path);
    const listing = await this.getDirectoryListing(normalized);
    if (!listing) {
      if (await this.fileExists(normalized)) {
        throw new Error(`Not a directory: ${normalized}`);
      }
      throw new Error(`No such directory: ${normalized}`);
    }
    return listing;
  }

  async stat(path: string): Promise<FileStat> {
    const normalized = runtimePath(path);
    const listing = await this.getDirectoryListing(normalized);
    if (listing) {
      return {
        path: normalized,
        isFile: false,
        isDirectory: true,
        size: 0,
      };
    }

    const file = await this.getFile(normalized);
    if (!file) {
      throw new Error(`No such file or directory: ${normalized}`);
    }
    const bytes = await file.read();
    return {
      path: normalized,
      isFile: true,
      isDirectory: false,
      size: bytes.byteLength,
      contentType: file.contentType,
    };
  }

  async exists(path: string): Promise<boolean> {
    const normalized = runtimePath(path);
    return (await this.isDirectory(normalized)) || (await this.fileExists(normalized));
  }

  async search(path: string, query: string, include?: string): Promise<Array<{ path: string; line: number; content: string }>> {
    const needle = query.trim();
    if (!needle) {
      return [];
    }

    const root = runtimePath(path);
    const includePattern = include?.trim() || null;
    const files = await this.collectFiles(root);
    const decoder = new TextDecoder();
    const matches: Array<{ path: string; line: number; content: string }> = [];

    for (const filePath of files) {
      if (!matchesInclude(filePath, root, includePattern)) {
        continue;
      }
      const content = decoder.decode(await this.read(filePath));
      if (content.includes("\0")) {
        continue;
      }
      const lines = content.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes(needle)) {
          continue;
        }
        matches.push({ path: filePath, line: index + 1, content: line });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          return matches;
        }
      }
    }

    return matches;
  }

  resolvePath(cwd: string, path: string): string {
    return normalizePath(path, cwd);
  }

  async getAllPaths(): Promise<string[]> {
    const tabs = await listTabs();
    const windows = await listWindows();
    const paths = new Set<string>([
      "/",
      "/README.txt",
      "/dev",
      "/dev/active-tab",
      "/proc",
      "/proc/browser.json",
      "/proc/network",
      "/proc/network/events.jsonl",
      "/proc/network/requests.json",
      "/proc/network/status.json",
      "/proc/tabs",
      "/proc/tabs.json",
      "/proc/windows",
      "/proc/windows.json",
    ]);

    for (const tab of tabs) {
      paths.add(`/proc/tabs/${tab.id}`);
      paths.add(`/proc/tabs/${tab.id}/meta.json`);
      paths.add(`/proc/tabs/${tab.id}/text.txt`);
    }
    for (const window of windows) {
      paths.add(`/proc/windows/${window.id}`);
      paths.add(`/proc/windows/${window.id}/meta.json`);
    }

    return [...paths].sort();
  }

  private async getFile(path: string): Promise<RuntimeFile | null> {
    if (path === "/README.txt") {
      return textFile(README);
    }
    if (path === "/proc/browser.json") {
      return jsonFile(browserRuntimeInfo());
    }
    if (path === "/proc/tabs.json") {
      return jsonFile({ tabs: await listTabs() });
    }
    if (path === "/proc/windows.json") {
      return jsonFile({ windows: await listWindows() });
    }
    if (path === "/proc/network/status.json") {
      return jsonFile(networkStatusSnapshot());
    }
    if (path === "/proc/network/events.jsonl") {
      return {
        contentType: "application/x-ndjson; charset=utf-8",
        read: async () => textBytes(networkEventsJsonl()),
      };
    }
    if (path === "/proc/network/requests.json") {
      return jsonFile(networkRequestsSnapshot());
    }
    if (path === "/dev/active-tab") {
      return textFile(await activeTabPath());
    }

    const tabMetaId = parseDynamicFile(path, "/proc/tabs", "meta.json");
    if (tabMetaId !== null) {
      const tab = await getTab(tabMetaId);
      return tab ? jsonFile(tab) : null;
    }

    const tabTextId = parseDynamicFile(path, "/proc/tabs", "text.txt");
    if (tabTextId !== null) {
      const tab = await getTab(tabTextId);
      return tab ? textFile(await tabText(tab)) : null;
    }

    const windowMetaId = parseDynamicFile(path, "/proc/windows", "meta.json");
    if (windowMetaId !== null) {
      const window = await getWindow(windowMetaId);
      return window ? jsonFile(window) : null;
    }

    return null;
  }

  private async fileExists(path: string): Promise<boolean> {
    if (
      path === "/README.txt"
      || path === "/proc/browser.json"
      || path === "/proc/network/events.jsonl"
      || path === "/proc/network/requests.json"
      || path === "/proc/network/status.json"
      || path === "/proc/tabs.json"
      || path === "/proc/windows.json"
      || path === "/dev/active-tab"
    ) {
      return true;
    }

    const tabFileId = parseDynamicFile(path, "/proc/tabs", "meta.json") ?? parseDynamicFile(path, "/proc/tabs", "text.txt");
    if (tabFileId !== null) {
      return await getTab(tabFileId) !== null;
    }

    const windowFileId = parseDynamicFile(path, "/proc/windows", "meta.json");
    if (windowFileId !== null) {
      return await getWindow(windowFileId) !== null;
    }

    return false;
  }

  private async getDirectoryListing(path: string): Promise<DirectoryListing | null> {
    if (path === "/") {
      return { directories: ["dev", "proc"], files: ["README.txt"] };
    }
    if (path === "/dev") {
      return { directories: [], files: ["active-tab"] };
    }
    if (path === "/proc") {
      return {
        directories: ["network", "tabs", "windows"],
        files: ["browser.json", "tabs.json", "windows.json"],
      };
    }
    if (path === "/proc/network") {
      return {
        directories: [],
        files: ["events.jsonl", "requests.json", "status.json"],
      };
    }
    if (path === "/proc/tabs") {
      const tabs = await listTabs();
      return {
        directories: tabs.map((tab) => String(tab.id)),
        files: [],
      };
    }
    if (path === "/proc/windows") {
      const windows = await listWindows();
      return {
        directories: windows.map((window) => String(window.id)),
        files: [],
      };
    }

    const tabId = parseDynamicDirectory(path, "/proc/tabs");
    if (tabId !== null) {
      return await getTab(tabId) ? { directories: [], files: ["meta.json", "text.txt"] } : null;
    }

    const windowId = parseDynamicDirectory(path, "/proc/windows");
    if (windowId !== null) {
      return await getWindow(windowId) ? { directories: [], files: ["meta.json"] } : null;
    }

    return null;
  }

  private async isDirectory(path: string): Promise<boolean> {
    return await this.getDirectoryListing(path) !== null;
  }

  private async collectFiles(root: string): Promise<string[]> {
    if (await this.fileExists(root)) {
      return [root];
    }

    const listing = await this.getDirectoryListing(root);
    if (!listing) {
      throw new Error(`No such file or directory: ${root}`);
    }

    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await this.getDirectoryListing(directory);
      if (!entries) {
        return;
      }
      for (const file of entries.files) {
        files.push(joinRuntimePath(directory, file));
      }
      for (const child of entries.directories) {
        await visit(joinRuntimePath(directory, child));
      }
    };
    await visit(root);

    return files.sort();
  }
}

export function createRuntimeFileSystem(): RuntimeFileSystem {
  return new RuntimeFileSystem();
}

function textFile(content: string): RuntimeFile {
  return {
    contentType: TEXT_CONTENT_TYPE,
    read: async () => textBytes(content),
  };
}

function jsonFile(content: unknown): RuntimeFile {
  return {
    contentType: JSON_CONTENT_TYPE,
    read: async () => jsonBytes(content),
  };
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(ensureTrailingNewline(content));
}

function jsonBytes(content: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`);
}

function browserRuntimeInfo(): unknown {
  const manifest = getManifest();
  return {
    target: "gsv-browser-extension",
    manifest: {
      name: manifest?.name ?? null,
      version: manifest?.version ?? null,
      manifestVersion: manifest?.manifest_version ?? null,
      permissions: [...(manifest?.permissions ?? [])].sort(),
      hostPermissions: [...(manifest?.host_permissions ?? [])].sort(),
    },
    browser: {
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
      language: typeof navigator === "undefined" ? null : navigator.language,
      platform: typeof navigator === "undefined" ? null : navigator.platform,
    },
  };
}

function getManifest(): RuntimeManifest | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.getManifest) {
    return null;
  }
  return chrome.runtime.getManifest() as RuntimeManifest;
}

async function activeTabPath(): Promise<string> {
  const tab = await activeTab();
  return tab ? `/proc/tabs/${tab.id}\n` : "none\n";
}

async function tabText(tab: TabSummary): Promise<string> {
  try {
    const extracted = await executeInTab<string>(tab.id, extractVisibleText);
    return compactPageText(extracted);
  } catch (error) {
    return `[text unavailable: ${errorMessage(error)}]\n`;
  }
}

async function getWindow(windowId: number): Promise<WindowSummary | null> {
  const windows = await listWindows();
  return windows.find((window) => window.id === windowId) ?? null;
}

function extractVisibleText(): string {
  return document.body?.innerText ?? document.documentElement.textContent ?? "";
}

function compactPageText(content: string | null | undefined): string {
  const compact = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (compact.length <= MAX_TEXT_CHARS) {
    return compact ? `${compact}\n` : "";
  }

  return `${compact.slice(0, MAX_TEXT_CHARS).trimEnd()}\n\n[truncated after ${MAX_TEXT_CHARS} characters]\n`;
}

function parseDynamicDirectory(path: string, parent: "/proc/tabs" | "/proc/windows"): number | null {
  if (!path.startsWith(`${parent}/`)) {
    return null;
  }
  const id = path.slice(parent.length + 1);
  return parseIdSegment(id);
}

function parseDynamicFile(path: string, parent: "/proc/tabs" | "/proc/windows", file: string): number | null {
  if (!path.startsWith(`${parent}/`) || !path.endsWith(`/${file}`)) {
    return null;
  }
  const id = path.slice(parent.length + 1, -(file.length + 1));
  return parseIdSegment(id);
}

function parseIdSegment(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) ? id : null;
}

function matchesInclude(path: string, root: string, include: string | null): boolean {
  if (!include) {
    return true;
  }
  const relative = path.startsWith(root === "/" ? "/" : `${root}/`)
    ? path.slice(root === "/" ? 1 : root.length + 1)
    : path.replace(/^\/+/, "");
  const regex = globToRegExp(include);
  return regex.test(relative) || regex.test(path) || regex.test(basename(path));
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

function runtimePath(path: string): string {
  return normalizePath(path || "/");
}

function joinRuntimePath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOnly(path: string): Error {
  return new Error(`${READONLY_MESSAGE}: ${runtimePath(path)}`);
}
