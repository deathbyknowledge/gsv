import type {
  FilesCreateArgs,
  FilesDeleteArgs,
  FilesDevice,
  FilesDirectoryResult,
  FilesFileResult,
  FilesMutationResult,
  FilesRoute,
  FilesSearchResult,
  FilesSaveArgs,
  FilesState,
} from "../app/types";

type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

function detectPathStyle(path: string) {
  return String(path ?? "").trim().startsWith("/") ? "absolute" : "relative";
}

function normalizeTarget(target: string) {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

function defaultPathForTarget(target: string) {
  return normalizeTarget(target) === "gsv" ? "/" : ".";
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

async function listDevices(kernel: KernelClient) {
  try {
    const payload = await kernel.request("sys.device.list", { includeOffline: true });
    const devices = Array.isArray(payload?.devices) ? payload.devices as FilesDevice[] : [];
    devices.sort((left, right) => String(left?.deviceId ?? "").localeCompare(String(right?.deviceId ?? "")));
    return { ok: true, devices } as const;
  } catch {
    return { ok: false, devices: [] as FilesDevice[] } as const;
  }
}

export async function loadState(kernel: KernelClient, input: FilesRoute): Promise<FilesState> {
  let target = normalizeTarget(input.target ?? "gsv");
  let currentPath = normalizePath(input.path ?? defaultPathForTarget(target), detectPathStyle(input.path ?? defaultPathForTarget(target)));
  let pathStyle = detectPathStyle(currentPath);
  const searchQuery = String(input.q ?? "").trim();
  let filePath = String(input.open ?? "").trim() ? normalizePath(input.open, detectPathStyle(input.open)) : "";
  let errorText = "";
  const deviceListing = await listDevices(kernel);
  const devices = deviceListing.devices;
  console.debug("[files] backend loadState input", {
    input,
    resolvedTarget: target,
    currentPath,
    devices: devices.map((device) => device.deviceId),
  });

  if (target !== "gsv" && deviceListing.ok && !devices.some((device) => String(device?.deviceId ?? "") === target)) {
    console.warn("[files] requested target missing from current device list; attempting route anyway", {
      requestedTarget: target,
      devices: devices.map((device) => device.deviceId),
    });
  }

  let directoryResult: FilesDirectoryResult | null = null;
  let fileResult: FilesFileResult | null = null;
  let searchResult: FilesSearchResult = { ok: true, matches: [], truncated: false };

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
      }
    } else {
      errorText = directoryRead.result?.error || `Unable to open ${currentPath}`;
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }

  if (searchQuery) {
    try {
      const result = await kernel.request("fs.search", withTarget(target, {
        path: currentPath,
        query: searchQuery,
      }));
      if (result?.ok) {
        searchResult = result;
      } else if (!errorText) {
        errorText = result?.error || "Search failed";
      }
    } catch (error) {
      if (!errorText) {
        errorText = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (filePath) {
    try {
      const fileRead = await readPathWithFallback(kernel, target, filePath);
      if (isFileResult(fileRead.result)) {
        filePath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
        fileResult = normalizeFileResult(fileRead.result);
      } else if (isDirectoryResult(fileRead.result)) {
        currentPath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
        pathStyle = detectPathStyle(currentPath);
        directoryResult = fileRead.result;
        filePath = "";
      } else {
        if (!errorText) {
          errorText = fileRead.result?.error || `Unable to open ${filePath}`;
        }
        filePath = "";
      }
    } catch (error) {
      if (!errorText) {
        errorText = error instanceof Error ? error.message : String(error);
      }
      filePath = "";
    }
  }

  if (!directoryResult) {
    directoryResult = { ok: true, path: currentPath, files: [], directories: [] };
  }

  return {
    target,
    devices,
    currentPath,
    pathStyle,
    searchQuery,
    directoryResult,
    filePath,
    fileResult,
    searchResult,
    errorText,
  };
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
      errorText: error instanceof Error ? error.message : String(error),
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
      errorText: error instanceof Error ? error.message : String(error),
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
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}
