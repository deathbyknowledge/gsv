import type {
  FilesCreateArgs,
  FilesDeleteArgs,
  FilesDevice,
  FilesDeviceListResult,
  FilesDirectoryLoadArgs,
  FilesDirectoryLoadResult,
  FilesDirectoryResult,
  FilesFileLoadArgs,
  FilesFileLoadResult,
  FilesFileResult,
  FilesMutationResult,
  FilesSearchLoadArgs,
  FilesSearchLoadResult,
  FilesSearchResult,
  FilesSaveArgs,
} from "../app/types";

type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

type FilesRuntime = {
  viewer?: {
    username?: string;
  };
};

function detectPathStyle(path: string): "absolute" | "relative" {
  return String(path ?? "").trim().startsWith("/") ? "absolute" : "relative";
}

function normalizeTarget(target: string) {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

function viewerHome(runtime: FilesRuntime) {
  const username = String(runtime.viewer?.username ?? "").trim();
  if (!username || username === "root") {
    return "/root";
  }
  return `/home/${username}`;
}

function defaultPathForTarget(target: string, runtime: FilesRuntime) {
  return normalizeTarget(target) === "gsv" ? viewerHome(runtime) : ".";
}

function normalizePath(input: string, style: "absolute" | "relative" = detectPathStyle(input)) {
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

function resolvePath(input: string, cwd: string, style: "absolute" | "relative") {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return cwd;
  }
  if (raw.startsWith("/")) {
    return normalizePath(raw, "absolute");
  }

  const base = normalizePath(cwd, style);
  if (style === "absolute") {
    const prefix = base === "/" ? "/" : `${base}/`;
    return normalizePath(`${prefix}${raw}`, "absolute");
  }
  const prefix = base === "." ? "" : `${base}/`;
  return normalizePath(`${prefix}${raw}`, "relative");
}

function parentPath(path: string, style: "absolute" | "relative") {
  const normalized = normalizePath(path, style);
  if (style === "absolute") {
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  if (normalized === ".") {
    return ".";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

function withTarget(target: string, args: Record<string, unknown>) {
  const normalizedTarget = normalizeTarget(target);
  if (normalizedTarget === "gsv") {
    return args;
  }
  return { ...args, target: normalizedTarget };
}

function decodeNumberedText(content: string) {
  return String(content ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function isDirectoryResult(value: any): value is FilesDirectoryResult {
  return value && value.ok === true && Array.isArray(value.files) && Array.isArray(value.directories);
}

function isFileResult(value: any): value is FilesFileResult {
  return value && value.ok === true && "content" in value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readPathWithFallback(kernel: KernelClient, target: string, path: string) {
  const result = await kernel.request("fs.read", withTarget(target, { path }));
  if (!result?.ok && target !== "gsv") {
    const fallbackPath = path.startsWith("/") ? path.replace(/^\/+/, "") || "." : `/${path}`;
    if (fallbackPath !== path) {
      const fallback = await kernel.request("fs.read", withTarget(target, { path: fallbackPath }));
      if (fallback?.ok) {
        return { path: fallbackPath, result: fallback };
      }
    }
  }
  return { path, result };
}

function normalizeFileResult(fileResult: FilesFileResult | null) {
  if (!fileResult || typeof fileResult.content !== "string") {
    return fileResult;
  }
  return {
    ...fileResult,
    content: decodeNumberedText(fileResult.content),
  };
}

export async function listDevices(kernel: KernelClient): Promise<FilesDeviceListResult> {
  try {
    const payload = await kernel.request("sys.device.list", { includeOffline: true });
    const devices = Array.isArray(payload?.devices) ? payload.devices as FilesDevice[] : [];
    devices.sort((left, right) => String(left?.deviceId ?? "").localeCompare(String(right?.deviceId ?? "")));
    return { devices, errorText: "" };
  } catch (error) {
    return { devices: [], errorText: errorMessage(error) };
  }
}

export async function loadDirectory(
  kernel: KernelClient,
  input: FilesDirectoryLoadArgs,
  runtime: FilesRuntime = {},
): Promise<FilesDirectoryLoadResult> {
  const target = normalizeTarget(input.target ?? "gsv");
  const defaultPath = defaultPathForTarget(target, runtime);
  const requestedPath = String(input.path ?? "").trim() || defaultPath;
  let currentPath = normalizePath(requestedPath, detectPathStyle(requestedPath));
  let pathStyle = detectPathStyle(currentPath);
  let filePath = "";
  let errorText = "";
  let directoryResult: FilesDirectoryResult | null = null;

  try {
    const directoryRead = await readPathWithFallback(kernel, target, currentPath);
    currentPath = normalizePath(directoryRead.path, detectPathStyle(directoryRead.path));
    pathStyle = detectPathStyle(currentPath);

    if (isDirectoryResult(directoryRead.result)) {
      directoryResult = directoryRead.result;
    } else if (isFileResult(directoryRead.result)) {
      filePath = normalizePath(directoryRead.result.path ?? currentPath, detectPathStyle(directoryRead.result.path ?? currentPath));
      currentPath = parentPath(filePath, detectPathStyle(filePath));
      pathStyle = detectPathStyle(currentPath);
      const parentRead = await readPathWithFallback(kernel, target, currentPath);
      if (isDirectoryResult(parentRead.result)) {
        directoryResult = parentRead.result;
      } else {
        errorText = parentRead.result?.error || `Unable to open ${currentPath}`;
      }
    } else {
      errorText = directoryRead.result?.error || `Unable to open ${currentPath}`;
    }
  } catch (error) {
    errorText = errorMessage(error);
  }

  if (!directoryResult) {
    directoryResult = { ok: true, path: currentPath, files: [], directories: [] };
  }

  return {
    target,
    currentPath,
    pathStyle,
    directoryResult,
    filePath,
    errorText,
  };
}

export async function loadFile(kernel: KernelClient, input: FilesFileLoadArgs): Promise<FilesFileLoadResult> {
  const target = normalizeTarget(input.target);
  const requestedPath = String(input.path ?? "").trim();
  const normalizedPath = normalizePath(requestedPath, detectPathStyle(requestedPath));
  let filePath = normalizedPath;
  let fileResult: FilesFileResult | null = null;
  let directoryPath = parentPath(normalizedPath, detectPathStyle(normalizedPath));
  let directoryResult: FilesDirectoryResult | null = null;
  let pathStyle = detectPathStyle(directoryPath);
  let errorText = "";

  if (!requestedPath) {
    return {
      target,
      filePath: "",
      fileResult: null,
      directoryPath: "",
      directoryResult: null,
      pathStyle: "relative",
      errorText: "",
    };
  }

  try {
    const fileRead = await readPathWithFallback(kernel, target, normalizedPath);
    if (isFileResult(fileRead.result)) {
      filePath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
      directoryPath = parentPath(filePath, detectPathStyle(filePath));
      pathStyle = detectPathStyle(directoryPath);
      fileResult = normalizeFileResult(fileRead.result);
    } else if (isDirectoryResult(fileRead.result)) {
      directoryPath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
      pathStyle = detectPathStyle(directoryPath);
      directoryResult = fileRead.result;
      filePath = "";
    } else {
      errorText = fileRead.result?.error || `Unable to open ${normalizedPath}`;
      filePath = "";
    }
  } catch (error) {
    errorText = errorMessage(error);
    filePath = "";
  }

  return {
    target,
    filePath,
    fileResult,
    directoryPath,
    directoryResult,
    pathStyle,
    errorText,
  };
}

export async function searchFiles(kernel: KernelClient, input: FilesSearchLoadArgs): Promise<FilesSearchLoadResult> {
  const target = normalizeTarget(input.target);
  const path = normalizePath(input.path, detectPathStyle(input.path));
  const q = String(input.q ?? "").trim();
  let searchResult: FilesSearchResult = { ok: true, matches: [], truncated: false };
  let errorText = "";

  if (!q) {
    return { target, path, q, searchResult, errorText };
  }

  try {
    const result = await kernel.request("fs.search", withTarget(target, {
      path,
      query: q,
    }));
    if (result?.ok) {
      searchResult = result;
    } else {
      errorText = result?.error || "Search failed";
    }
  } catch (error) {
    errorText = errorMessage(error);
  }

  return { target, path, q, searchResult, errorText };
}

export async function saveFile(kernel: KernelClient, args: FilesSaveArgs): Promise<FilesMutationResult> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path, detectPathStyle(args.path));
  try {
    const result = await kernel.request("fs.write", withTarget(target, {
      path,
      content: String(args.content ?? ""),
    }));
    if (result?.ok) {
      return {
        target,
        path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
        q: String(args.q ?? "").trim(),
        open: path,
        statusText: `Saved ${path}`,
        errorText: "",
      };
    }
    return {
      target,
      path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
      q: String(args.q ?? "").trim(),
      open: path,
      statusText: "",
      errorText: result?.error ?? `Failed to save ${path}`,
    };
  } catch (error) {
    return {
      target,
      path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
      q: String(args.q ?? "").trim(),
      open: path,
      statusText: "",
      errorText: errorMessage(error),
    };
  }
}

export async function deletePath(kernel: KernelClient, args: FilesDeleteArgs): Promise<FilesMutationResult> {
  const target = normalizeTarget(args.target);
  const path = normalizePath(args.path, detectPathStyle(args.path));
  try {
    const result = await kernel.request("fs.delete", withTarget(target, { path }));
    if (result?.ok) {
      return {
        target,
        path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
        q: String(args.q ?? "").trim(),
        open: "",
        statusText: `Deleted ${path}`,
        errorText: "",
      };
    }
    return {
      target,
      path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
      q: String(args.q ?? "").trim(),
      open: path,
      statusText: "",
      errorText: result?.error ?? `Failed to delete ${path}`,
    };
  } catch (error) {
    return {
      target,
      path: normalizePath(args.currentPath, detectPathStyle(args.currentPath)),
      q: String(args.q ?? "").trim(),
      open: path,
      statusText: "",
      errorText: errorMessage(error),
    };
  }
}

export async function createFile(kernel: KernelClient, args: FilesCreateArgs): Promise<FilesMutationResult> {
  const target = normalizeTarget(args.target);
  const currentPath = normalizePath(args.currentPath, detectPathStyle(args.currentPath));
  const pathStyle = detectPathStyle(currentPath);
  const name = String(args.name ?? "").trim();
  if (!name) {
    return {
      target,
      path: currentPath,
      q: String(args.q ?? "").trim(),
      open: "",
      statusText: "",
      errorText: "New file name is required.",
    };
  }

  const path = resolvePath(name, currentPath, pathStyle);
  try {
    const result = await kernel.request("fs.write", withTarget(target, { path, content: "" }));
    if (result?.ok) {
      return {
        target,
        path: currentPath,
        q: String(args.q ?? "").trim(),
        open: path,
        statusText: `Created ${path}`,
        errorText: "",
      };
    }
    return {
      target,
      path: currentPath,
      q: String(args.q ?? "").trim(),
      open: "",
      statusText: "",
      errorText: result?.error ?? `Failed to create ${path}`,
    };
  } catch (error) {
    return {
      target,
      path: currentPath,
      q: String(args.q ?? "").trim(),
      open: "",
      statusText: "",
      errorText: errorMessage(error),
    };
  }
}
