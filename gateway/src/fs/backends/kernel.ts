import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "../../syscalls/system";
import { canReadConfigKey } from "../../kernel/config-access";
import type { KernelRefs } from "../refs";
import type { MountBackend, ExtendedMountStat } from "../mount";
import { normalizePath } from "../utils";

const TEXT_ENCODER = new TextEncoder();

export class KernelMountBackend implements MountBackend {
  constructor(
    private readonly identity: ProcessIdentity,
    private readonly kernel: KernelRefs | null,
    private readonly selfPid: string | null,
  ) {}

  handles(path: string): boolean {
    return (
      path.startsWith("/proc/") ||
      path === "/proc" ||
      path.startsWith("/dev/") ||
      path === "/dev" ||
      path.startsWith("/sys/") ||
      path === "/sys" ||
      isEtcAuth(path)
    );
  }

  async readFile(path: string): Promise<string> {
    const p = normalizePath(path);
    const virt = this.readVirtual(p);
    if (virt !== undefined) return virt;
    if (this.isVirtualDir(p) || p === "/etc") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    }
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (p === "/dev/random" || p === "/dev/urandom") {
      const buf = new Uint8Array(256);
      crypto.getRandomValues(buf);
      return buf;
    }

    const virt = this.readVirtual(p);
    if (virt !== undefined) return TEXT_ENCODER.encode(virt);
    if (this.isVirtualDir(p) || p === "/etc") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
    }
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
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
    if (isEtcAuth(p)) {
      this.writeEtcAuth(p, typeof content === "string" ? content : new TextDecoder().decode(content));
      return;
    }
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
    if (p === "/dev/null") return;
    if (p.startsWith("/dev/") || p.startsWith("/proc/") || p.startsWith("/sys/")) {
      throw new Error(`EPERM: cannot append to virtual path '${p}'`);
    }
    if (isEtcAuth(p)) {
      const existing = this.readEtcAuth(p) ?? "";
      const appended = typeof content === "string" ? existing + content : existing + new TextDecoder().decode(content);
      this.writeEtcAuth(p, appended);
      return;
    }
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (p === "/etc") return true;
    if (this.isVirtualDir(p)) return true;
    if (isEtcAuth(p)) return true;
    if (this.readVirtual(p) !== undefined) return true;
    return false;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const p = normalizePath(path);

    if (this.isVirtualDir(p) || p === "/etc") {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (isEtcAuth(p)) {
      const mode = p === "/etc/shadow" ? 0o640 : 0o644;
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (this.readVirtual(p) !== undefined) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o444, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    const p = normalizePath(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/") || p === "/etc" || isEtcAuth(p)) {
      throw new Error(`EPERM: cannot mkdir in virtual filesystem '${p}'`);
    }
    throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);
    const entries = this.readdirVirtual(p);
    if (entries !== undefined) return entries;
    if (p === "/etc") return ["group", "passwd", "shadow"];
    throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/") || p === "/etc" || isEtcAuth(p)) {
      throw new Error(`EPERM: cannot remove virtual path '${p}'`);
    }
    throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
  }

  async chmod(path: string): Promise<void> {
    throw new Error(`EPERM: cannot chmod virtual path '${normalizePath(path)}'`);
  }

  async chown(path: string): Promise<void> {
    throw new Error(`EPERM: cannot chown virtual path '${normalizePath(path)}'`);
  }

  async utimes(path: string): Promise<void> {
    const p = normalizePath(path);
    if (await this.exists(p)) {
      return;
    }
    throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
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
      if (!proc) return undefined;
      return `${proc.processId}\n`;
    }

    if (!proc) return undefined;

    if (this.identity.uid !== 0 && proc.uid !== this.identity.uid) {
      return undefined;
    }

    switch (attr) {
      case "status":
        return [
          `Name:\t${proc.label ?? proc.processId}`,
          `Pid:\t${proc.processId}`,
          `PPid:\t${proc.parentPid ?? "0"}`,
          `Profile:\t${proc.profile}`,
          `State:\t${proc.state}`,
          `Uid:\t${proc.uid}`,
          `Gid:\t${proc.gid}`,
          `Groups:\t${proc.gids.join(" ")}`,
        ].join("\n") + "\n";
      case "identity":
        return JSON.stringify({
          uid: proc.uid,
          gid: proc.gid,
          gids: proc.gids,
          username: proc.username,
          profile: proc.profile,
          home: proc.home,
          cwd: proc.cwd,
          workspaceId: proc.workspaceId,
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

  private listReadableConfig(prefix: string): { key: string; value: string }[] {
    if (!this.kernel) return [];

    const entries = this.kernel.config.list(prefix);
    if (this.identity.uid === 0) return entries;

    return entries.filter((entry) => canReadConfigKey(this.identity.uid, entry.key));
  }

  private readSys(path: string): string | undefined {
    if (!this.kernel) return undefined;
    const rel = path.slice("/sys/".length);

    if (rel.startsWith("config/")) {
      const configKey = rel;
      if (!canReadConfigKey(this.identity.uid, configKey)) return undefined;
      const value = this.kernel.config.get(configKey);
      if (value !== null) return value + "\n";
      return undefined;
    }

    if (rel.startsWith("users/")) {
      const userKey = rel;
      const uidStr = rel.split("/")[1];
      const uid = parseInt(uidStr, 10);
      if (isNaN(uid)) return undefined;

      if (!canReadConfigKey(this.identity.uid, userKey)) return undefined;

      const value = this.kernel.config.get(userKey);
      if (value !== null) return value + "\n";
      return undefined;
    }

    if (rel.startsWith("devices/")) {
      return this.readSysDevice(rel.slice("devices/".length));
    }

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
    if (!this.kernel) throw new Error("EPERM: /sys is not available");
    const rel = path.slice("/sys/".length);

    if (rel.startsWith("config/")) {
      if (this.identity.uid !== 0) throw new Error("EPERM: only root can write to /sys/config/");
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

    throw new Error("EPERM: read-only region of /sys/");
  }

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

  private readVirtual(path: string): string | undefined {
    if (path.startsWith("/proc/")) return this.readProc(path);
    if (path.startsWith("/dev/")) return this.readDev(path);
    if (path.startsWith("/sys/")) return this.readSys(path);
    if (isEtcAuth(path)) return this.readEtcAuth(path);
    return undefined;
  }

  private isVirtualDir(path: string): boolean {
    const virtualDirs = [
      "/proc", "/dev", "/sys",
      "/sys/config", "/sys/users", "/sys/devices", "/sys/capabilities",
    ];
    if (virtualDirs.includes(path)) return true;

    if (!this.kernel) return false;

    if (path.startsWith("/proc/") && !path.slice("/proc/".length).includes("/")) {
      const pid = path.slice("/proc/".length);
      if (pid === "self") return true;
      return this.kernel.procs.get(pid) !== null;
    }

    if (path.startsWith("/sys/devices/") && !path.slice("/sys/devices/".length).includes("/")) {
      const deviceId = path.slice("/sys/devices/".length);
      return this.kernel.devices.get(deviceId) !== null;
    }

    if (path.startsWith("/sys/users/") && !path.slice("/sys/users/".length).includes("/")) {
      const uid = parseInt(path.slice("/sys/users/".length), 10);
      if (isNaN(uid)) return false;
      if (this.identity.uid !== 0 && this.identity.uid !== uid) return false;
      return true;
    }

    if (path.startsWith("/sys/config/")) {
      const rel = path.slice("/sys/config/".length);
      if (rel) {
        const nested = this.listReadableConfig(`config/${rel}`);
        if (nested.length > 0) return true;
      }
    }

    if (path.startsWith("/sys/users/")) {
      const rel = path.slice("/sys/users/".length);
      const parts = rel.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const uid = parseInt(parts[0], 10);
        if (!isNaN(uid)) {
          if (this.identity.uid !== 0 && this.identity.uid !== uid) return false;
          const suffix = parts.slice(1).join("/");
          const nested = this.listReadableConfig(`users/${uid}/${suffix}`);
          if (nested.length > 0) return true;
        }
      }
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
      return ["null", "random", "urandom", "zero"];
    }

    if (path === "/sys") {
      return ["capabilities", "config", "devices", "users"];
    }

    if (path === "/sys/config") {
      return uniquePrefixes(this.listReadableConfig("config/"), "config/");
    }

    if (path.startsWith("/sys/config/")) {
      const rel = path.slice("/sys/config/".length);
      if (!rel) return undefined;
      const prefix = `config/${rel}`;
      const entries = this.listReadableConfig(prefix);
      if (entries.length === 0) return undefined;
      return uniquePrefixes(entries, `${prefix}/`);
    }

    if (path === "/sys/users") {
      if (this.identity.uid === 0) {
        return uniquePrefixes(this.listReadableConfig("users/"), "users/");
      }
      return [String(this.identity.uid)];
    }

    if (path.startsWith("/sys/users/")) {
      const rel = path.slice("/sys/users/".length);
      const parts = rel.split("/").filter(Boolean);
      if (parts.length >= 1) {
        const uid = parseInt(parts[0], 10);
        if (isNaN(uid)) return undefined;
        if (this.identity.uid !== 0 && this.identity.uid !== uid) return undefined;

        if (parts.length === 1) {
          const entries = this.listReadableConfig(`users/${uid}`);
          if (entries.length === 0) return [];
          return uniquePrefixes(entries, `users/${uid}/`);
        }

        const suffix = parts.slice(1).join("/");
        const prefix = `users/${uid}/${suffix}`;
        const entries = this.listReadableConfig(prefix);
        if (entries.length === 0) return undefined;
        return uniquePrefixes(entries, `${prefix}/`);
      }
    }

    if (path === "/sys/devices") {
      const devices = this.kernel.devices.listForUser(this.identity.uid, this.identity.gids);
      return devices.map((d) => d.device_id).sort();
    }

    if (path === "/sys/capabilities") {
      const caps = this.kernel.caps.list();
      return [...new Set(caps.map((c) => String(c.gid)))].sort();
    }

    if (path.startsWith("/proc/")) {
      const parts = path.slice("/proc/".length).split("/");
      if (parts.length === 1) {
        let pid = parts[0];
        if (pid === "self") pid = this.selfPid ?? `init:${this.identity.uid}`;
        const proc = this.kernel.procs.get(pid);
        if (proc) return ["identity", "status"];
      }
    }

    if (path.startsWith("/sys/devices/")) {
      const parts = path.slice("/sys/devices/".length).split("/");
      if (parts.length === 1 && parts[0]) {
        const device = this.kernel.devices.get(parts[0]);
        if (device) return ["implements", "owner", "platform", "status", "version"];
      }
    }

    return undefined;
  }
}

function isEtcAuth(path: string): boolean {
  return path === "/etc/passwd" || path === "/etc/shadow" || path === "/etc/group";
}

function uniquePrefixes(entries: { key: string }[], strip: string): string[] {
  const seen = new Set<string>();
  for (const { key } of entries) {
    const rel = key.startsWith(strip) ? key.slice(strip.length) : key;
    const first = rel.split("/")[0];
    if (first) seen.add(first);
  }
  return [...seen].sort();
}
