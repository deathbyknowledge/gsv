/**
 * GsvFs — unified IFileSystem implementation for gateway-os.
 *
 * Routes paths internally:
 *   /proc/*  → ProcessRegistry (kernel SQLite)
 *   /dev/*   → inline device nodes (null, zero, random, urandom)
 *   /sys/*   → ConfigStore + DeviceRegistry + CapabilityStore (kernel SQLite)
 *   /*       → R2 bucket (with uid/gid/mode permission checks)
 *
 * Used by both the bash shell driver (as IFileSystem) and the fs.* syscall
 * handlers (which add formatting on top of the raw IFileSystem methods).
 *
 * When kernel registries are not provided (no KernelRefs), virtual paths
 * return ENOENT — this allows bare R2-only usage during early bootstrap.
 */

import type {
  IFileSystem,
  FsStat,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
} from "just-bash";
import type { ProcessIdentity } from "../syscalls/system";
import type { AuthStore } from "../kernel/auth-store";
import type { CapabilityStore } from "../kernel/capabilities";
import type { ConfigStore } from "../kernel/config";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";

export type KernelRefs = {
  auth: AuthStore;
  procs: ProcessRegistry;
  devices: DeviceRegistry;
  caps: CapabilityStore;
  config: ConfigStore;
};

export type ExtendedStat = FsStat & { uid: number; gid: number };

const READ_BIT = 4;
const WRITE_BIT = 2;

export class GsvFs implements IFileSystem {
  private bucket: R2Bucket;
  private identity: ProcessIdentity;
  private kernel: KernelRefs | null;
  private selfPid: string | null;

  constructor(
    bucket: R2Bucket,
    identity: ProcessIdentity,
    kernel?: KernelRefs,
    selfPid?: string,
  ) {
    this.bucket = bucket;
    this.identity = identity;
    this.kernel = kernel ?? null;
    this.selfPid = selfPid ?? null;
  }

  async readFile(path: string, _options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const p = normalize(path);
    const virt = this.readVirtual(p);
    if (virt !== undefined) return virt;

    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    if (isDirectoryMarker(obj)) throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    this.assertMode(obj, READ_BIT, p);
    return obj.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalize(path);

    if (p === "/dev/random" || p === "/dev/urandom") {
      const buf = new Uint8Array(256);
      crypto.getRandomValues(buf);
      return buf;
    }

    const virt = this.readVirtual(p);
    if (virt !== undefined) return new TextEncoder().encode(virt);

    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    this.assertMode(obj, READ_BIT, p);
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const p = normalize(path);

    if (p.startsWith("/dev/")) {
      if (p === "/dev/null") return;
      throw new Error(`EPERM: cannot write to virtual device '${p}'`);
    }

    if (p.startsWith("/proc/")) {
      throw new Error(`EPERM: /proc is read-only`);
    }

    if (p.startsWith("/sys/")) {
      this.writeSys(p, typeof content === "string" ? content : new TextDecoder().decode(content));
      return;
    }

    if (this.isEtcAuth(p)) {
      this.writeEtcAuth(p, typeof content === "string" ? content : new TextDecoder().decode(content));
      return;
    }

    const key = toKey(p);
    const existing = await this.bucket.head(key);
    if (existing) this.assertMode(existing, WRITE_BIT, p);

    await this.bucket.put(key, content, {
      httpMetadata: { contentType: inferContentType(p) },
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: existing?.customMetadata?.mode ?? "644",
      },
    });
  }

  async appendFile(path: string, content: FileContent, _options?: { encoding?: BufferEncoding } | BufferEncoding): Promise<void> {
    const p = normalize(path);

    if (p === "/dev/null") return;
    if (p.startsWith("/dev/") || p.startsWith("/proc/") || p.startsWith("/sys/")) {
      throw new Error(`EPERM: cannot append to virtual path '${p}'`);
    }

    if (this.isEtcAuth(p)) {
      const existing = this.readEtcAuth(p) ?? "";
      const appended = typeof content === "string" ? existing + content : existing + new TextDecoder().decode(content);
      this.writeEtcAuth(p, appended);
      return;
    }

    const key = toKey(p);
    const existing = await this.bucket.get(key);

    if (existing) {
      this.assertMode(existing, WRITE_BIT, p);
      const old = await existing.text();
      const appended = typeof content === "string" ? old + content : old + new TextDecoder().decode(content);
      await this.bucket.put(key, appended, {
        httpMetadata: existing.httpMetadata,
        customMetadata: existing.customMetadata,
      });
    } else {
      await this.writeFile(path, content);
    }
  }

  async exists(path: string): Promise<boolean> {
    const p = normalize(path);

    if (this.isVirtualDir(p)) return true;
    if (p === "/etc") return true;
    if (this.isEtcAuth(p)) return true;
    if (this.readVirtual(p) !== undefined) return true;

    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) return true;

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const listed = await this.bucket.list({ prefix: dirPrefix, limit: 1 });
    return listed.objects.length > 0 || listed.delimitedPrefixes.length > 0;
  }

  async stat(path: string): Promise<FsStat> {
    const ext = await this.statExtended(path);
    return { isFile: ext.isFile, isDirectory: ext.isDirectory, isSymbolicLink: ext.isSymbolicLink, mode: ext.mode, size: ext.size, mtime: ext.mtime };
  }

  async statExtended(path: string): Promise<ExtendedStat> {
    const p = normalize(path);

    if (this.isVirtualDir(p)) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (p === "/etc") {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (this.isEtcAuth(p)) {
      const mode = p === "/etc/shadow" ? 0o640 : 0o644;
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (this.readVirtual(p) !== undefined) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o444, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) {
      const uid = parseInt(head.customMetadata?.uid ?? "0", 10);
      const gid = parseInt(head.customMetadata?.gid ?? "0", 10);
      if (isDirectoryMarker(head)) {
        return {
          isFile: false, isDirectory: true, isSymbolicLink: false,
          mode: parseOctalMode(head.customMetadata?.mode ?? "755"),
          size: 0, mtime: head.uploaded, uid, gid,
        };
      }
      return {
        isFile: true, isDirectory: false, isSymbolicLink: false,
        mode: parseOctalMode(head.customMetadata?.mode ?? "644"),
        size: head.size, mtime: head.uploaded, uid, gid,
      };
    }

    const dirPrefix = key.endsWith("/") ? key : key + "/";
    const listed = await this.bucket.list({ prefix: dirPrefix, limit: 1 });
    if (listed.objects.length > 0 || listed.delimitedPrefixes.length > 0) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const p = normalize(path);

    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/")) {
      throw new Error(`EPERM: cannot mkdir in virtual filesystem '${p}'`);
    }

    const key = toKey(p);
    if (!options?.recursive) {
      const parentKey = key.split("/").slice(0, -1).join("/");
      if (parentKey) {
        const parentExists = await this.exists("/" + parentKey);
        if (!parentExists) throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
      }
    }

    const dirKey = key.endsWith("/") ? key : key + "/";
    const markerKey = dirKey + ".dir";
    const existing = await this.bucket.head(markerKey);
    if (existing && !options?.recursive) throw new Error(`EEXIST: file already exists, mkdir '${p}'`);

    await this.bucket.put(markerKey, "", {
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: "755",
        dirmarker: "1",
      },
    });
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalize(path);

    const virtEntries = this.readdirVirtual(p);
    if (virtEntries !== undefined) return virtEntries;

    const key = toKey(p);
    const prefix = key ? key + "/" : "";
    const listed = await this.bucket.list({ prefix, delimiter: "/" });

    const entries: string[] = [];
    for (const obj of listed.objects) {
      const name = obj.key.slice(prefix.length);
      if (name && !name.endsWith("/.dir") && name !== ".dir") entries.push(name);
    }
    for (const dp of listed.delimitedPrefixes) {
      const name = dp.slice(prefix.length).replace(/\/+$/, "");
      if (name) entries.push(name);
    }

    // Merge virtual top-level entries for root listing
    if (p === "/" && this.kernel) {
      for (const vdir of ["proc", "dev", "sys"]) {
        if (!entries.includes(vdir)) entries.push(vdir);
      }
      if (!entries.includes("etc")) entries.push("etc");
    }

    // Merge auth virtual files into /etc listing
    if (p === "/etc" && this.kernel) {
      for (const name of ["passwd", "shadow", "group"]) {
        if (!entries.includes(name)) entries.push(name);
      }
    }

    if (entries.length === 0) {
      const dirExists = await this.exists(path);
      if (!dirExists) throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    }

    return [...new Set(entries)].sort();
  }

  async readdirWithFileTypes(path: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const names = await this.readdir(path);
    const results: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[] = [];
    for (const name of names) {
      const childPath = path.endsWith("/") ? path + name : path + "/" + name;
      try {
        const s = await this.stat(childPath);
        results.push({ name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: s.isSymbolicLink });
      } catch {
        results.push({ name, isFile: true, isDirectory: false, isSymbolicLink: false });
      }
    }
    return results;
  }


  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalize(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/")) {
      throw new Error(`EPERM: cannot remove virtual path '${p}'`);
    }
    if (this.isEtcAuth(p)) {
      throw new Error(`EPERM: cannot remove '${p}'`);
    }

    const key = toKey(p);
    const head = await this.bucket.head(key);
    if (head) {
      this.assertMode(head, WRITE_BIT, p);
      await this.bucket.delete(key);
      return;
    }

    if (options?.recursive) {
      const prefix = key + "/";
      let cursor: string | undefined;
      do {
        const listed = await this.bucket.list({ prefix, cursor, limit: 100 });
        if (listed.objects.length > 0) {
          await this.bucket.delete(listed.objects.map((o) => o.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return;
    }

    if (!options?.force) throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const sp = normalize(src);
    const dp = normalize(dest);

    if (sp.startsWith("/proc/") || sp.startsWith("/dev/") || sp.startsWith("/sys/")) {
      const content = this.readVirtual(sp);
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, cp '${sp}'`);
      await this.writeFile(dp, content);
      return;
    }

    const srcKey = toKey(sp);
    const obj = await this.bucket.get(srcKey);
    if (!obj) throw new Error(`ENOENT: no such file or directory, cp '${sp}'`);
    this.assertMode(obj, READ_BIT, sp);

    const destKey = toKey(dp);
    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(destKey, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: {
        uid: String(this.identity.uid),
        gid: String(this.identity.gid),
        mode: obj.customMetadata?.mode ?? "644",
      },
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest);
    await this.rm(src, { force: true });
  }

  // ---------------------------------------------------------------------------
  // IFileSystem — permissions
  // ---------------------------------------------------------------------------

  async chmod(path: string, mode: number): Promise<void> {
    const p = normalize(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/")) {
      throw new Error(`EPERM: cannot chmod virtual path '${p}'`);
    }

    const key = toKey(p);
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chmod '${p}'`);

    const fileUid = parseInt(obj.customMetadata?.uid ?? "-1", 10);
    if (this.identity.uid !== 0 && this.identity.uid !== fileUid) {
      throw new Error(`EPERM: operation not permitted, chmod '${p}'`);
    }

    const octal = mode.toString(8).padStart(3, "0");
    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(key, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { ...obj.customMetadata, mode: octal },
    });
  }

  /**
   * chown — not part of IFileSystem but used by custom bash commands.
   */
  async chown(path: string, newUid?: number, newGid?: number): Promise<void> {
    const key = toKey(normalize(path));
    const obj = await this.bucket.get(key);
    if (!obj) throw new Error(`ENOENT: no such file or directory, chown '${path}'`);

    if (this.identity.uid !== 0) {
      throw new Error(`EPERM: operation not permitted, chown '${path}'`);
    }

    const meta = { ...obj.customMetadata };
    if (newUid !== undefined) meta.uid = String(newUid);
    if (newGid !== undefined) meta.gid = String(newGid);

    const stream = new FixedLengthStream(obj.size);
    obj.body.pipeTo(stream.writable);

    await this.bucket.put(key, stream.readable, {
      httpMetadata: obj.httpMetadata,
      customMetadata: meta,
    });
  }


  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlinks not supported");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: hard links not supported");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("ENOSYS: symlinks not supported");
  }

  async realpath(path: string): Promise<string> {
    return normalize(path);
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    const p = normalize(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/")) return;
    const key = toKey(p);
    const exists = await this.bucket.head(key);
    if (!exists) throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalize(path);
    const combined = base.endsWith("/") ? base + path : base + "/" + path;
    return normalize(combined);
  }

  getAllPaths(): string[] {
    return [];
  }

  private readProc(path: string): string | undefined {
    if (!this.kernel) return undefined;
    const parts = path.slice("/proc/".length).split("/");
    if (parts.length === 0 || !parts[0]) return undefined;

    let pid = parts[0];
    if (pid === "self") {
      pid = this.selfPid ?? `init:${this.identity.uid}`;
    }

    const attr = parts.slice(1).join("/");

    if (pid === "version") return `GSV ${this.identity.username} 1.0.0\n`;
    if (pid === "uptime") return "0\n";

    const proc = this.kernel.procs.get(pid);

    if (!attr) {
      // /proc/{pid} with no sub-path — check if process exists
      if (!proc) return undefined;
      return `${proc.processId}\n`;
    }

    if (!proc) return undefined;

    // Permission check: only own processes or root
    if (this.identity.uid !== 0 && proc.uid !== this.identity.uid) {
      return undefined;
    }

    switch (attr) {
      case "status":
        return [
          `Name:\t${proc.label ?? proc.processId}`,
          `Pid:\t${proc.processId}`,
          `PPid:\t${proc.parentPid ?? "0"}`,
          `State:\t${proc.state}`,
          `Uid:\t${proc.uid}`,
          `Gid:\t${proc.gid}`,
          `Groups:\t${proc.gids.join(" ")}`,
        ].join("\n") + "\n";
      case "identity":
        return JSON.stringify({
          uid: proc.uid, gid: proc.gid, gids: proc.gids,
          username: proc.username, home: proc.home,
        }, null, 2) + "\n";
      default:
        return undefined;
    }
  }

  private readDev(path: string): string | undefined {
    switch (path) {
      case "/dev/null": return "";
      case "/dev/zero": return "\0".repeat(256);
      case "/dev/random":
      case "/dev/urandom": {
        const buf = new Uint8Array(256);
        crypto.getRandomValues(buf);
        return Array.from(buf, (b) => String.fromCharCode(b)).join("");
      }
      default: return undefined;
    }
  }

  private readSys(path: string): string | undefined {
    if (!this.kernel) return undefined;
    const rel = path.slice("/sys/".length);

    // /sys/config/{key} — system-wide config
    if (rel.startsWith("config/")) {
      const configKey = rel;  // "config/ai/provider" etc.
      const value = this.kernel.config.get(configKey);
      if (value !== null) return value + "\n";
      return undefined;
    }

    // /sys/users/{uid}/{key} — per-user config
    if (rel.startsWith("users/")) {
      const userKey = rel; // "users/0/ai/model" etc.
      const uidStr = rel.split("/")[1];
      const uid = parseInt(uidStr, 10);
      if (isNaN(uid)) return undefined;

      // Permission check: own uid or root
      if (this.identity.uid !== 0 && this.identity.uid !== uid) return undefined;

      const value = this.kernel.config.get(userKey);
      if (value !== null) return value + "\n";
      return undefined;
    }

    // /sys/devices/{deviceId}/{attr}
    if (rel.startsWith("devices/")) {
      return this.readSysDevice(rel.slice("devices/".length));
    }

    // /sys/capabilities/{gid}
    if (rel.startsWith("capabilities/")) {
      return this.readSysCaps(rel.slice("capabilities/".length));
    }

    return undefined;
  }

  private readSysDevice(rel: string): string | undefined {
    if (!this.kernel) return undefined;
    const parts = rel.split("/");
    const deviceId = parts[0];
    const attr = parts.slice(1).join("/");

    if (!deviceId) return undefined;

    const device = this.kernel.devices.get(deviceId);
    if (!device) return undefined;

    if (!this.kernel.devices.canAccess(deviceId, this.identity.uid, this.identity.gids)) {
      return undefined;
    }

    if (!attr) {
      return [
        `device_id=${device.device_id}`,
        `owner_uid=${device.owner_uid}`,
        `platform=${device.platform}`,
        `version=${device.version}`,
        `online=${device.online ? "1" : "0"}`,
        `implements=${device.implements.join(",")}`,
      ].join("\n") + "\n";
    }

    switch (attr) {
      case "status": return device.online ? "online\n" : "offline\n";
      case "platform": return device.platform + "\n";
      case "version": return device.version + "\n";
      case "implements": return device.implements.join("\n") + "\n";
      case "owner": return String(device.owner_uid) + "\n";
      default: return undefined;
    }
  }

  private readSysCaps(rel: string): string | undefined {
    if (!this.kernel) return undefined;
    if (!rel) return undefined;

    const gid = parseInt(rel, 10);
    if (isNaN(gid)) return undefined;

    const caps = this.kernel.caps.list(gid);
    if (caps.length === 0) return undefined;
    return caps.map((c) => c.capability).join("\n") + "\n";
  }

  private writeSys(path: string, content: string): void {
    if (!this.kernel) throw new Error(`EPERM: /sys is not available`);
    const rel = path.slice("/sys/".length);

    if (rel.startsWith("config/")) {
      if (this.identity.uid !== 0) throw new Error(`EPERM: only root can write to /sys/config/`);
      this.kernel.config.set(rel, content.trim());
      return;
    }

    if (rel.startsWith("users/")) {
      const uidStr = rel.split("/")[1];
      const uid = parseInt(uidStr, 10);
      if (isNaN(uid)) throw new Error(`EINVAL: invalid uid in path '${path}'`);
      if (this.identity.uid !== 0 && this.identity.uid !== uid) {
        throw new Error(`EPERM: permission denied, '${path}'`);
      }
      this.kernel.config.set(rel, content.trim());
      return;
    }

    throw new Error(`EPERM: read-only region of /sys/`);
  }


  /**
   * Try to read a virtual path. Returns undefined if not a virtual path
   * or the virtual path doesn't exist.
   */
  private readEtcAuth(path: string): string | undefined {
    if (!this.kernel) return undefined;
    if (path === "/etc/passwd") return this.kernel.auth.serializePasswd();
    if (path === "/etc/shadow") {
      if (this.identity.uid !== 0) throw new Error("EACCES: permission denied, open '/etc/shadow'");
      return this.kernel.auth.serializeShadow();
    }
    if (path === "/etc/group") return this.kernel.auth.serializeGroup();
    return undefined;
  }

  private writeEtcAuth(path: string, content: string): boolean {
    if (!this.kernel) return false;
    if (path === "/etc/passwd") {
      if (this.identity.uid !== 0) throw new Error("EACCES: permission denied, open '/etc/passwd'");
      this.kernel.auth.importPasswd(content);
      return true;
    }
    if (path === "/etc/shadow") {
      if (this.identity.uid !== 0) throw new Error("EACCES: permission denied, open '/etc/shadow'");
      this.kernel.auth.importShadow(content);
      return true;
    }
    if (path === "/etc/group") {
      if (this.identity.uid !== 0) throw new Error("EACCES: permission denied, open '/etc/group'");
      this.kernel.auth.importGroup(content);
      return true;
    }
    return false;
  }

  private isEtcAuth(path: string): boolean {
    return path === "/etc/passwd" || path === "/etc/shadow" || path === "/etc/group";
  }

  private readVirtual(path: string): string | undefined {
    if (path.startsWith("/proc/")) return this.readProc(path);
    if (path.startsWith("/dev/")) return this.readDev(path);
    if (path.startsWith("/sys/")) return this.readSys(path);
    if (this.isEtcAuth(path)) return this.readEtcAuth(path);
    return undefined;
  }

  private isVirtualDir(path: string): boolean {
    const virtualDirs = [
      "/proc", "/dev", "/sys",
      "/sys/config", "/sys/users", "/sys/devices", "/sys/capabilities",
    ];
    if (virtualDirs.includes(path)) return true;

    if (!this.kernel) return false;

    // /proc/{pid} is a directory if that process exists
    if (path.startsWith("/proc/") && !path.slice("/proc/".length).includes("/")) {
      const pid = path.slice("/proc/".length);
      if (pid === "self") return true;
      return this.kernel.procs.get(pid) !== null;
    }

    // /sys/devices/{deviceId} is a directory
    if (path.startsWith("/sys/devices/") && !path.slice("/sys/devices/".length).includes("/")) {
      const deviceId = path.slice("/sys/devices/".length);
      return this.kernel.devices.get(deviceId) !== null;
    }

    // /sys/users/{uid} is a directory
    if (path.startsWith("/sys/users/") && !path.slice("/sys/users/".length).includes("/")) {
      return true;
    }

    return false;
  }

  private readdirVirtual(path: string): string[] | undefined {
    if (!this.kernel) return undefined;

    if (path === "/proc") {
      const procs = this.identity.uid === 0
        ? this.kernel.procs.list()
        : this.kernel.procs.list(this.identity.uid);
      const entries = procs.map((p) => p.processId);
      entries.push("self", "version", "uptime");
      return entries.sort();
    }

    if (path === "/dev") {
      return ["null", "zero", "random", "urandom"];
    }

    if (path === "/sys") {
      return ["capabilities", "config", "devices", "users"];
    }

    if (path === "/sys/config") {
      return uniquePrefixes(this.kernel.config.list("config/"), "config/");
    }

    if (path === "/sys/users") {
      return uniquePrefixes(this.kernel.config.list("users/"), "users/");
    }

    if (path === "/sys/devices") {
      const devices = this.kernel.devices.listForUser(this.identity.uid, this.identity.gids);
      return devices.map((d) => d.device_id).sort();
    }

    if (path === "/sys/capabilities") {
      const caps = this.kernel.caps.list();
      return [...new Set(caps.map((c) => String(c.gid)))].sort();
    }

    // /proc/{pid} directory
    if (path.startsWith("/proc/")) {
      const parts = path.slice("/proc/".length).split("/");
      if (parts.length === 1) {
        let pid = parts[0];
        if (pid === "self") pid = this.selfPid ?? `init:${this.identity.uid}`;
        const proc = this.kernel.procs.get(pid);
        if (proc) return ["identity", "status"];
      }
    }

    // /sys/devices/{deviceId} directory
    if (path.startsWith("/sys/devices/")) {
      const parts = path.slice("/sys/devices/".length).split("/");
      if (parts.length === 1 && parts[0]) {
        const device = this.kernel.devices.get(parts[0]);
        if (device) return ["implements", "owner", "platform", "status", "version"];
      }
    }

    return undefined;
  }


  private assertMode(obj: R2Object | R2ObjectBody, bit: number, path: string): void {
    if (this.identity.uid === 0) return;

    const meta = obj.customMetadata;
    const mode = meta?.mode ?? "644";
    const fileUid = parseInt(meta?.uid ?? "-1", 10);
    const fileGid = parseInt(meta?.gid ?? "-1", 10);

    const digits = mode.padStart(3, "0").slice(-3);
    const owner = parseInt(digits[0], 10);
    const group = parseInt(digits[1], 10);
    const other = parseInt(digits[2], 10);

    if (this.identity.uid === fileUid) {
      if ((owner & bit) !== 0) return;
    } else if (this.identity.gids.includes(fileGid)) {
      if ((group & bit) !== 0) return;
    } else {
      if ((other & bit) !== 0) return;
    }

    throw new Error(`EACCES: permission denied, '${path}'`);
  }
}


function normalize(path: string): string {
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return "/" + segments.join("/");
}

function toKey(path: string): string {
  return normalize(path).replace(/^\//, "");
}

function isDirectoryMarker(obj: R2Object | R2ObjectBody): boolean {
  return obj.customMetadata?.dirmarker === "1" || obj.key.endsWith("/.dir");
}

function parseOctalMode(mode: string): number {
  return parseInt(mode, 8);
}

function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown", json: "application/json", yaml: "application/yaml",
    yml: "application/yaml", xml: "application/xml", toml: "application/toml",
    js: "application/javascript", ts: "application/typescript",
    html: "text/html", css: "text/css", txt: "text/plain", csv: "text/csv",
    sh: "text/x-shellscript", py: "text/x-python",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };
  return (ext && map[ext]) || "text/plain";
}

/**
 * Extract unique first-level directory names under a given prefix from
 * a list of config key/value pairs.
 *
 * e.g. keys ["config/ai/provider", "config/ai/model", "config/server/name"]
 *      with strip "config/" → ["ai", "server"]
 */
function uniquePrefixes(entries: { key: string }[], strip: string): string[] {
  const seen = new Set<string>();
  for (const { key } of entries) {
    const rel = key.startsWith(strip) ? key.slice(strip.length) : key;
    const first = rel.split("/")[0];
    if (first) seen.add(first);
  }
  return [...seen].sort();
}
