import type { KernelClientLike } from "@gsv/package/backend";

export type ConfigFileEntry = {
  key: string;
  value: string;
};

type FsReadPayload = {
  ok?: boolean;
  path?: string;
  files?: unknown;
  directories?: unknown;
  content?: unknown;
  error?: string;
};

type FsWritePayload = {
  ok?: boolean;
  error?: string;
};

export async function loadConfigEntries(kernel: KernelClientLike): Promise<ConfigFileEntry[]> {
  const [system, users] = await Promise.all([
    readConfigTree(kernel, "/sys/config"),
    readConfigTree(kernel, "/sys/users"),
  ]);
  return [...system, ...users].sort((left, right) => left.key.localeCompare(right.key));
}

export async function readConfigValue(
  kernel: KernelClientLike,
  key: string,
): Promise<string | undefined> {
  const payload = await readPath(kernel, configKeyToPath(key));
  if (payload.ok === false || typeof payload.content !== "string") {
    return undefined;
  }
  return stripReadText(payload.content);
}

export async function writeConfigValue(
  kernel: KernelClientLike,
  key: string,
  value: string,
): Promise<void> {
  const payload = await kernel.request("fs.write", {
    path: configKeyToPath(key),
    content: value,
  }) as FsWritePayload;
  if (payload.ok === false) {
    throw new Error(payload.error ?? "write failed");
  }
}

function configKeyToPath(key: string): string {
  const normalized = key.trim().replace(/^\/+/, "");
  if (normalized.startsWith("config/")) {
    return `/sys/config/${normalized.slice("config/".length)}`;
  }
  if (normalized.startsWith("users/")) {
    return `/sys/users/${normalized.slice("users/".length)}`;
  }
  throw new Error(`Unsupported config key: ${key}`);
}

async function readConfigTree(
  kernel: KernelClientLike,
  path: string,
): Promise<ConfigFileEntry[]> {
  const payload = await readPath(kernel, path);
  if (payload.ok === false) return [];

  if (typeof payload.content === "string") {
    const key = pathToConfigKey(path);
    return key ? [{ key, value: stripReadText(payload.content) }] : [];
  }

  const files = Array.isArray(payload.files)
    ? payload.files.filter((item): item is string => typeof item === "string")
    : [];
  const directories = Array.isArray(payload.directories)
    ? payload.directories.filter((item): item is string => typeof item === "string")
    : [];

  const childResults = await Promise.all([
    ...files.map((name) => readConfigTree(kernel, joinPath(path, name))),
    ...directories.map((name) => readConfigTree(kernel, joinPath(path, name))),
  ]);
  return childResults.flat();
}

async function readPath(kernel: KernelClientLike, path: string): Promise<FsReadPayload> {
  try {
    return await kernel.request("fs.read", { path }) as FsReadPayload;
  } catch {
    return { ok: false };
  }
}

function pathToConfigKey(path: string): string | null {
  if (path.startsWith("/sys/config/")) {
    return `config/${path.slice("/sys/config/".length)}`;
  }
  if (path.startsWith("/sys/users/")) {
    return `users/${path.slice("/sys/users/".length)}`;
  }
  return null;
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, "")}/${child}`;
}

function stripReadText(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}
