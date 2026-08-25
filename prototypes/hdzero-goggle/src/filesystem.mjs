import { mkdir, realpath, stat as hostStat, writeFile as hostWriteFile } from "node:fs/promises";
import path from "node:path";

import { MountableFs, OverlayFs, ReadWriteFs } from "just-bash";
import { bodyFromBytes, bodyFromText, bodyToBytes } from "@humansandmachines/gsv/protocol";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const IMAGE_TYPES = new Map([
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
]);

function cleanPath(value, fallback = "/") {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const absolute = value.startsWith("/") ? value : `/${value}`;
  return path.posix.normalize(absolute);
}

function errorResult(error, fallback) {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return { data: { ok: false, error: message } };
}

function wildcardMatches(pattern, value) {
  if (!pattern) {
    return true;
  }
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${expression}$`).test(value);
}

function countOccurrences(text, needle) {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function contentTypeForPath(filePath) {
  return IMAGE_TYPES.get(path.posix.extname(filePath).toLowerCase())
    || "application/octet-stream";
}

export class WearableFilesystem {
  constructor({ rootPath, firmwareAppRoot, deviceId, getState = () => ({}) }) {
    this.rootPath = path.resolve(rootPath);
    this.firmwareAppRoot = firmwareAppRoot ? path.resolve(firmwareAppRoot) : null;
    this.deviceId = deviceId;
    this.getState = getState;
    this.fs = null;
  }

  async initialize() {
    await Promise.all([
      mkdir(path.join(this.rootPath, "etc"), { recursive: true }),
      mkdir(path.join(this.rootPath, "home/gsv"), { recursive: true }),
      mkdir(path.join(this.rootPath, "mnt"), { recursive: true }),
      mkdir(path.join(this.rootPath, "run/gsv"), { recursive: true }),
      mkdir(path.join(this.rootPath, "sys/gsv"), { recursive: true }),
      mkdir(path.join(this.rootPath, "tmp"), { recursive: true }),
      mkdir(path.join(this.rootPath, "var/log/gsv"), { recursive: true }),
    ]);
    await this.writeHostFileIfMissing("etc/os-release", [
      "NAME=\"GSV HDZero Emulator\"",
      "ID=gsv-hdzero",
      "PRETTY_NAME=\"GSV HDZero Goggle 2 Emulator\"",
      "",
    ].join("\n"));

    const base = new ReadWriteFs({
      root: this.rootPath,
      maxFileReadSize: MAX_FILE_BYTES,
      allowSymlinks: false,
    });
    this.fs = new MountableFs({ base });
    this.fs.mount("/sys/gsv", new OverlayFs({
      root: path.join(this.rootPath, "sys/gsv"),
      mountPoint: "/",
      readOnly: true,
      maxFileReadSize: MAX_FILE_BYTES,
      allowSymlinks: false,
    }));
    if (this.firmwareAppRoot && await this.hostDirectoryExists(this.firmwareAppRoot)) {
      this.fs.mount("/mnt/app", new OverlayFs({
        root: this.firmwareAppRoot,
        mountPoint: "/",
        readOnly: true,
        maxFileReadSize: MAX_FILE_BYTES,
        allowSymlinks: false,
      }));
    }
    await this.syncRuntimeFiles();
    return this;
  }

  async writeHostFileIfMissing(relativePath, content) {
    const destination = path.join(this.rootPath, relativePath);
    try {
      await hostWriteFile(destination, content, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  async hostDirectoryExists(candidate) {
    try {
      return (await hostStat(candidate)).isDirectory();
    } catch {
      return false;
    }
  }

  requireFs() {
    if (!this.fs) {
      throw new Error("Wearable filesystem is not initialized");
    }
    return this.fs;
  }

  async syncRuntimeFiles() {
    const state = this.getState() || {};
    const files = {
      "capabilities.json": {
        implements: [
          "fs.read",
          "fs.write",
          "fs.edit",
          "fs.delete",
          "fs.search",
          "fs.copy",
          "fs.transfer.stat",
          "fs.transfer.send",
          "fs.transfer.receive",
          "shell.exec",
        ],
        shell: "just-bash",
      },
      "device.json": {
        deviceId: this.deviceId,
        kind: "wearable",
        platform: "hdzero-emulator",
        product: "HDZero Goggle 2",
      },
      "runtime.json": {
        clientConnection: state.clientConnection || "offline",
        driverConnection: state.driverConnection || "offline",
        phase: state.phase || "idle",
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
    await Promise.all(Object.entries(files).map(([name, value]) => (
      hostWriteFile(
        path.join(this.rootPath, "sys/gsv", name),
        `${JSON.stringify(value, null, 2)}\n`,
        { mode: 0o644 },
      )
    )));
  }

  isProtectedMutation(virtualPath) {
    return virtualPath === "/"
      || virtualPath === "/mnt/app"
      || virtualPath.startsWith("/mnt/app/")
      || virtualPath === "/sys/gsv"
      || virtualPath.startsWith("/sys/gsv/");
  }

  async read(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath) {
      return { data: { ok: false, error: "path is required" } };
    }
    try {
      await this.syncRuntimeFiles();
      const fs = this.requireFs();
      const entry = await fs.stat(virtualPath);
      if (entry.isDirectory) {
        const files = [];
        const directories = [];
        for (const name of await fs.readdir(virtualPath)) {
          const child = path.posix.join(virtualPath, name);
          const childEntry = await fs.stat(child);
          if (childEntry.isDirectory) {
            directories.push(name);
          } else {
            files.push(name);
          }
        }
        return { data: { ok: true, path: virtualPath, files, directories } };
      }
      const bytes = await fs.readFileBuffer(virtualPath);
      const contentType = IMAGE_TYPES.get(path.posix.extname(virtualPath).toLowerCase());
      if (contentType) {
        return {
          data: { ok: true, path: virtualPath, kind: "image", contentType, size: entry.size },
          body: bodyFromBytes(bytes),
        };
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { data: { ok: false, error: `Binary file (${entry.size} bytes) - not a text file` } };
      }
      const offset = Number.isSafeInteger(args?.offset) && args.offset >= 0 ? args.offset : 0;
      const limit = Number.isSafeInteger(args?.limit) && args.limit >= 0
        ? args.limit
        : Number.POSITIVE_INFINITY;
      const selected = text.split("\n").slice(offset, offset + limit);
      return {
        data: {
          ok: true,
          path: virtualPath,
          kind: "text",
          contentType: "text/plain; charset=utf-8",
          lines: selected.length,
          size: entry.size,
        },
        body: bodyFromText(selected.join("\n")),
      };
    } catch (error) {
      return errorResult(error, `Unable to read ${virtualPath}`);
    }
  }

  async write(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath || typeof args?.content !== "string") {
      return { data: { ok: false, error: "path and string content are required" } };
    }
    if (this.isProtectedMutation(virtualPath)) {
      return { data: { ok: false, error: `${virtualPath} is read-only` } };
    }
    try {
      await this.requireFs().writeFile(virtualPath, args.content);
      return {
        data: {
          ok: true,
          path: virtualPath,
          size: new TextEncoder().encode(args.content).byteLength,
        },
      };
    } catch (error) {
      return errorResult(error, `Unable to write ${virtualPath}`);
    }
  }

  async edit(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath || typeof args?.oldString !== "string" || typeof args?.newString !== "string") {
      return { data: { ok: false, error: "path, oldString, and newString are required" } };
    }
    if (!args.oldString) {
      return { data: { ok: false, error: "oldString must not be empty" } };
    }
    if (this.isProtectedMutation(virtualPath)) {
      return { data: { ok: false, error: `${virtualPath} is read-only` } };
    }
    try {
      const fs = this.requireFs();
      const text = await fs.readFile(virtualPath);
      const matches = countOccurrences(text, args.oldString);
      if (matches === 0) {
        return { data: { ok: false, error: "oldString was not found" } };
      }
      if (matches > 1 && !args.replaceAll) {
        return { data: { ok: false, error: "oldString matched more than once; set replaceAll or provide more context" } };
      }
      const updated = args.replaceAll
        ? text.split(args.oldString).join(args.newString)
        : text.replace(args.oldString, args.newString);
      await fs.writeFile(virtualPath, updated);
      return { data: { ok: true, path: virtualPath, replacements: args.replaceAll ? matches : 1 } };
    } catch (error) {
      return errorResult(error, `Unable to edit ${virtualPath}`);
    }
  }

  async delete(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath) {
      return { data: { ok: false, error: "path is required" } };
    }
    if (this.isProtectedMutation(virtualPath)) {
      return { data: { ok: false, error: `${virtualPath} is read-only` } };
    }
    try {
      await this.requireFs().rm(virtualPath, { recursive: true, force: true });
      return { data: { ok: true, path: virtualPath } };
    } catch (error) {
      return errorResult(error, `Unable to delete ${virtualPath}`);
    }
  }

  async copy(args) {
    const source = cleanPath(args?.source?.path, "");
    const destination = cleanPath(args?.destination?.path, "");
    if (!source || !destination) {
      return { data: { ok: false, error: "source.path and destination.path are required" } };
    }
    if (this.isProtectedMutation(destination)) {
      return { data: { ok: false, error: `${destination} is read-only` } };
    }
    try {
      const fs = this.requireFs();
      await fs.cp(source, destination, { recursive: true });
      const destinationEntry = await fs.stat(destination);
      return {
        data: {
          ok: true,
          source: { target: this.deviceId, path: source },
          destination: { target: this.deviceId, path: destination },
          size: destinationEntry.size,
        },
      };
    } catch (error) {
      return errorResult(error, `Unable to copy ${source}`);
    }
  }

  async transferStat(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath) {
      return { data: { ok: false, error: "path is required" } };
    }
    try {
      const entry = await this.requireFs().stat(virtualPath);
      return {
        data: {
          ok: true,
          path: virtualPath,
          size: entry.size,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          ...(entry.isFile ? { contentType: contentTypeForPath(virtualPath) } : {}),
        },
      };
    } catch (error) {
      return errorResult(error, `Unable to stat ${virtualPath}`);
    }
  }

  async transferSend(args) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath) {
      return { data: { ok: false, error: "path is required" } };
    }
    try {
      const fs = this.requireFs();
      const entry = await fs.stat(virtualPath);
      if (!entry.isFile) {
        return { data: { ok: false, error: `${virtualPath} is not a file` } };
      }
      const bytes = await fs.readFileBuffer(virtualPath);
      return {
        data: {
          ok: true,
          path: virtualPath,
          size: entry.size,
          contentType: contentTypeForPath(virtualPath),
        },
        body: bodyFromBytes(bytes),
      };
    } catch (error) {
      return errorResult(error, `Unable to send ${virtualPath}`);
    }
  }

  async transferReceive(args, body, signal) {
    const virtualPath = cleanPath(args?.path, "");
    if (!virtualPath) {
      await body?.stream.cancel("path is required").catch(() => {});
      return { data: { ok: false, error: "path is required" } };
    }
    if (this.isProtectedMutation(virtualPath)) {
      await body?.stream.cancel(`${virtualPath} is read-only`).catch(() => {});
      return { data: { ok: false, error: `${virtualPath} is read-only` } };
    }
    if (!body) {
      return { data: { ok: false, error: "fs.transfer.receive requires a request body" } };
    }
    try {
      const bytes = await bodyToBytes(body, MAX_FILE_BYTES, signal);
      await this.requireFs().writeFile(virtualPath, bytes);
      return {
        data: {
          ok: true,
          path: virtualPath,
          bytesWritten: bytes.byteLength,
          ...(args?.contentType ? { contentType: args.contentType } : {}),
        },
      };
    } catch (error) {
      await body.stream.cancel("Wearable transfer failed").catch(() => {});
      return errorResult(error, `Unable to receive ${virtualPath}`);
    }
  }

  async search(args, signal) {
    const query = typeof args?.query === "string" ? args.query : "";
    if (!query) {
      return { data: { ok: false, error: "query is required" } };
    }
    const root = cleanPath(args?.path || "/");
    const matches = [];
    try {
      await this.walk(root, signal, async (filePath) => {
        if (!wildcardMatches(args?.include, path.posix.basename(filePath))) {
          return false;
        }
        let text;
        try {
          text = await this.requireFs().readFile(filePath);
        } catch {
          return false;
        }
        for (const [index, line] of text.split("\n").entries()) {
          if (line.includes(query)) {
            matches.push({ path: filePath, line: index + 1, content: line });
            if (matches.length === MAX_SEARCH_MATCHES) {
              return true;
            }
          }
        }
        return false;
      });
      return {
        data: {
          ok: true,
          matches,
          count: matches.length,
          ...(matches.length === MAX_SEARCH_MATCHES ? { truncated: true } : {}),
        },
      };
    } catch (error) {
      return errorResult(error, `Unable to search ${root}`);
    }
  }

  async walk(root, signal, visit) {
    const fs = this.requireFs();
    const queue = [root];
    while (queue.length) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Search cancelled");
      }
      const current = queue.shift();
      const entry = await fs.stat(current);
      if (entry.isDirectory) {
        for (const name of await fs.readdir(current)) {
          queue.push(path.posix.join(current, name));
        }
      } else if (entry.isFile && await visit(current)) {
        return;
      }
    }
  }

  async resolveDisplayPath(virtualPath) {
    const normalized = cleanPath(virtualPath, "");
    if (!normalized) {
      throw new Error("image path is required");
    }
    let root = this.rootPath;
    let relative = normalized;
    if (normalized === "/mnt/app" || normalized.startsWith("/mnt/app/")) {
      if (!this.firmwareAppRoot) {
        throw new Error("/mnt/app is not mounted");
      }
      root = this.firmwareAppRoot;
      relative = normalized.slice("/mnt/app".length) || "/";
    }
    const candidate = path.resolve(root, `.${relative}`);
    if (!withinRoot(candidate, root)) {
      throw new Error("image path escaped the wearable filesystem");
    }
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(candidate);
    if (!withinRoot(canonical, canonicalRoot)) {
      throw new Error("image path escaped the wearable filesystem");
    }
    const entry = await hostStat(canonical);
    const contentType = IMAGE_TYPES.get(path.extname(canonical).toLowerCase());
    if (!entry.isFile() || !contentType || !["image/bmp", "image/png"].includes(contentType)) {
      throw new Error("gsv-show image currently supports PNG and BMP files");
    }
    if (entry.size > 8 * 1024 * 1024) {
      throw new Error("image exceeds the 8 MiB presentation limit");
    }
    if (canonical.length > 240) {
      throw new Error("image path exceeds the LVGL POSIX driver limit");
    }
    return { hostPath: canonical, virtualPath: normalized, contentType, size: entry.size };
  }
}
