import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { canReadConfigKey } from "../../kernel/config-access";
import type { KernelRefs, ProcessViewCall } from "../refs";
import type { ArgsOf, ResultOf } from "../../syscalls";
import type {
  ProcConversation,
  ProcConversationGenerationManifest,
  ProcConversationSegment,
} from "../../syscalls/proc";
import type { ScheduleRecord } from "../../syscalls/scheduler";
import {
  packageArtifactPublicBase,
  visiblePackageScopesForActor,
  type InstalledPackageRecord,
  type PackageEntrypoint,
  type PackageInstallScope,
} from "../../kernel/packages";
import { packageSourcePathNameForRecord } from "./process-sources";
import type { MountBackend, ExtendedMountStat } from "../mount";
import { normalizePath } from "../utils";

const TEXT_ENCODER = new TextEncoder();
const PROC_HISTORY_PAGE_SIZE = 500;
const SCHEDULER_VIEW_PAGE_SIZE = 500;
const SCHEDULER_LOG_HISTORY_LIMIT = 50;

export class KernelMountBackend implements MountBackend {
  constructor(
    private readonly identity: ProcessIdentity,
    private readonly kernel: KernelRefs | null,
    private readonly selfPid: string | null,
  ) {}

  handles(path: string): boolean {
    const p = normalizePath(path);
    return (
      p.startsWith("/proc/") ||
      p === "/proc" ||
      p.startsWith("/dev/") ||
      p === "/dev" ||
      p.startsWith("/sys/") ||
      p === "/sys" ||
      p === "/etc" ||
      isEtcAuth(p) ||
      isEtcCronPath(p) ||
      isVarViewPath(p)
    );
  }

  async readFile(path: string): Promise<string> {
    const p = normalizePath(path);
    const virt = await this.readVirtual(p);
    if (virt !== undefined) return virt;
    if (await this.isVirtualDir(p) || p === "/etc") {
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

    const virt = await this.readVirtual(p);
    if (virt !== undefined) return TEXT_ENCODER.encode(virt);
    if (await this.isVirtualDir(p) || p === "/etc") {
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
    if (isCronWritablePath(p)) {
      await this.writeCronFile(p, typeof content === "string" ? content : new TextDecoder().decode(content));
      return;
    }
    if (isVarViewPath(p)) {
      throw new Error(`EPERM: /var runtime views are read-only`);
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
    if (isCronWritablePath(p)) {
      const existing = await this.readVirtual(p) ?? "";
      await this.writeCronFile(p, existing + (typeof content === "string" ? content : new TextDecoder().decode(content)));
      return;
    }
    if (p.startsWith("/dev/") || p.startsWith("/proc/") || p.startsWith("/sys/") || isVarViewPath(p) || isEtcCronPath(p)) {
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
    if (await this.isVirtualDir(p)) return true;
    if (isEtcAuth(p)) return true;
    if (isEtcCronPath(p) && await this.readEtcCron(p) !== undefined) return true;
    if (await this.readVirtual(p) !== undefined) return true;
    return false;
  }

  async stat(path: string): Promise<ExtendedMountStat> {
    const p = normalizePath(path);

    if (await this.isVirtualDir(p) || p === "/etc") {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (isEtcAuth(p)) {
      const mode = p === "/etc/shadow" ? 0o640 : 0o644;
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    if (isCronWritablePath(p)) {
      const stat = this.statCronFile(p);
      if (stat) return stat;
    }

    if (await this.readVirtual(p) !== undefined) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o444, size: 0, mtime: new Date(), uid: 0, gid: 0 };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    const p = normalizePath(path);
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/") || isVarViewPath(p) || p === "/etc" || isEtcAuth(p) || isEtcCronPath(p)) {
      throw new Error(`EPERM: cannot mkdir in virtual filesystem '${p}'`);
    }
    throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);
    const entries = await this.readdirVirtual(p);
    if (entries !== undefined) return entries;
    if (p === "/etc") return ["cron.d", "group", "passwd", "shadow"];
    throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    const p = normalizePath(path);
    if (isCronWritablePath(p)) {
      const removed = await this.removeCronFile(p);
      if (removed) return;
      throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
    }
    if (p.startsWith("/proc/") || p.startsWith("/dev/") || p.startsWith("/sys/") || isVarViewPath(p) || p === "/etc" || isEtcAuth(p) || isEtcCronPath(p)) {
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

  private async readProc(path: string): Promise<string | undefined> {
    if (!this.kernel) return undefined;
    const parts = path.slice("/proc/".length).split("/");
    if (parts.length === 0 || !parts[0]) return undefined;

    let pid = parts[0];
    if (pid === "self") {
      pid = this.selfProcessPid();
    }

    const attrParts = parts.slice(1);
    const attr = attrParts.join("/");

    if (pid === "version") return `GSV ${this.identity.username} 1.0.0\n`;
    if (pid === "uptime") return "0\n";

    const proc = this.kernel.procs.get(pid);

    if (!attr) {
      if (!proc || !this.canViewProcess(proc)) return undefined;
      return `${proc.processId}\n`;
    }

    if (!proc) return undefined;

    if (!this.canViewProcess(proc)) {
      return undefined;
    }

    if (attrParts[0] === "conversations") {
      return this.readProcConversation(pid, attrParts.slice(1));
    }

    switch (attr) {
      case "status":
        return [
          `Name:\t${proc.label ?? proc.processId}`,
          `Pid:\t${proc.processId}`,
          `PPid:\t${proc.parentPid ?? "0"}`,
          `RunAs:\t${proc.username}`,
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
          home: proc.home,
          cwd: proc.cwd,
        }, null, 2) + "\n";
      case "context.d":
        return undefined;
      default:
        if (attr.startsWith("context.d/")) {
          const name = attr.slice("context.d/".length);
          const file = proc.contextFiles.find((entry) => entry.name === name);
          if (!file) {
            return undefined;
          }
          return file.text.endsWith("\n") ? file.text : `${file.text}\n`;
        }
        return undefined;
    }
  }

  private async readProcConversation(
    pid: string,
    parts: string[],
  ): Promise<string | undefined> {
    if (parts.length === 0) return undefined;

    const conversationId = decodePathSegment(parts[0]);
    if (!conversationId) return undefined;

    if (parts.length === 1) return undefined;

    const attr = parts[1];
    if (attr === "status" && parts.length === 2) {
      const conversation = await this.getProcessConversation(pid, conversationId);
      return conversation ? jsonText(conversation) : undefined;
    }

    if (attr === "history" && parts.length === 2) {
      return this.readProcessConversationHistory(pid, conversationId);
    }

    if (attr === "timeline" && parts.length === 2) {
      return this.readProcessConversationTimeline(pid, conversationId);
    }

    if (attr === "segments") {
      if (parts.length === 2) return undefined;
      const segmentId = decodePathSegment(parts[2]);
      if (!segmentId || parts.length !== 3) return undefined;
      return this.readProcessConversationSegment(pid, conversationId, segmentId);
    }

    if (attr === "generations") {
      if (parts.length === 2) return undefined;
      const generation = parsePositiveIntegerSegment(parts[2]);
      if (generation === null) return undefined;
      if (parts.length === 3) return undefined;
      if (parts.length === 4 && parts[3] === "manifest") {
        return this.readProcessConversationGenerationManifest(pid, conversationId, generation);
      }
    }

    return undefined;
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
        `description=${device.description}`,
        `platform=${device.platform}`,
        `version=${device.version}`,
        `online=${device.online ? "1" : "0"}`,
        `implements=${device.implements.join(",")}`,
      ].join("\n") + "\n";
    }

    switch (attr) {
      case "status": return device.online ? "online\n" : "offline\n";
      case "description": return device.description + "\n";
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

  /**
   * The pid `/proc/self` refers to: the current process when inside one,
   * otherwise the caller's live default ("inbox") conversation executor (their
   * personal agent). Returns "" when no executor is live, yielding ENOENT.
   */
  private selfProcessPid(): string {
    if (this.selfPid) return this.selfPid;
    if (!this.kernel) return "";
    const agentUid = this.kernel.auth.getPersonalAgentUid(this.identity.uid) ?? this.identity.uid;
    return this.kernel.conversations?.getDefault(this.identity.uid, agentUid)?.activePid ?? "";
  }

  private resolveVisibleProcess(pidSegment: string) {
    if (!this.kernel) return null;
    const pid = pidSegment === "self"
      ? this.selfProcessPid()
      : pidSegment;
    const proc = this.kernel.procs.get(pid);
    if (!proc) return null;
    if (!this.canViewProcess(proc)) return null;
    return proc;
  }

  private canViewProcess(proc: { processId?: string; uid: number; ownerUid?: number | null }): boolean {
    if (this.identity.uid === 0) return true;
    if (this.selfPid && proc.processId === this.selfPid) return true;
    return (proc.ownerUid ?? proc.uid) === this.viewerOwnerUid();
  }

  private viewerOwnerUid(): number {
    if (!this.kernel || !this.selfPid) return this.identity.uid;
    if (typeof this.kernel.procs.getOwnerUid === "function") {
      const ownerUid = this.kernel.procs.getOwnerUid(this.selfPid);
      if (ownerUid !== null) return ownerUid;
    }
    const proc = this.kernel.procs.get(this.selfPid);
    return proc ? proc.ownerUid ?? proc.uid : this.identity.uid;
  }

  private async processRequest<S extends ProcessViewCall>(
    pid: string,
    call: S,
    args: ArgsOf<S>,
  ): Promise<ResultOf<S> | null> {
    if (!this.kernel?.processRequest) return null;
    try {
      const result = await this.kernel.processRequest(pid, call, args);
      if (!result || typeof result !== "object") return null;
      if ((result as { ok?: unknown }).ok === false) return null;
      return result;
    } catch {
      return null;
    }
  }

  private async listProcessConversations(pid: string): Promise<ProcConversation[] | null> {
    const result = await this.processRequest(
      pid,
      "proc.conversation.list",
      { includeClosed: true },
    );
    return result?.ok ? result.conversations : null;
  }

  private async getProcessConversation(
    pid: string,
    conversationId: string,
  ): Promise<ProcConversation | null> {
    if (!conversationId) return null;
    const result = await this.processRequest(
      pid,
      "proc.conversation.get",
      { conversationId },
    );
    return result?.ok ? result.conversation : null;
  }

  private async readProcessConversationHistory(
    pid: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const messages: unknown[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const page = await this.processRequest(
        pid,
        "proc.history",
        { conversationId, limit: PROC_HISTORY_PAGE_SIZE, offset },
      );
      if (!page?.ok) return undefined;
      total = page.messageCount;
      messages.push(...page.messages);
      if (page.messages.length === 0) break;
      offset += page.messages.length;
    }

    return jsonLines(messages);
  }

  private async listProcessConversationSegments(
    pid: string,
    conversationId: string,
  ): Promise<ProcConversationSegment[] | null> {
    const result = await this.processRequest(
      pid,
      "proc.conversation.segments",
      { conversationId },
    );
    return result?.ok ? result.segments : null;
  }

  private async readProcessConversationTimeline(
    pid: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const result = await this.processRequest(
      pid,
      "proc.conversation.timeline",
      { conversationId },
    );
    return result?.ok ? jsonLines(result.timeline) : undefined;
  }

  private async listProcessConversationGenerations(
    pid: string,
    conversationId: string,
  ): Promise<number[] | null> {
    const result = await this.processRequest(
      pid,
      "proc.conversation.generations",
      { conversationId },
    );
    return result?.ok ? result.generations : null;
  }

  private async readProcessConversationGenerationManifest(
    pid: string,
    conversationId: string,
    generation: number,
  ): Promise<string | undefined> {
    const manifest = await this.getProcessConversationGenerationManifest(pid, conversationId, generation);
    return manifest ? jsonText(manifest) : undefined;
  }

  private async getProcessConversationGenerationManifest(
    pid: string,
    conversationId: string,
    generation: number,
  ): Promise<ProcConversationGenerationManifest | null> {
    const result = await this.processRequest(
      pid,
      "proc.conversation.generation.manifest",
      { conversationId, generation },
    );
    return result?.ok ? result.manifest : null;
  }

  private async readProcessConversationSegment(
    pid: string,
    conversationId: string,
    segmentId: string,
  ): Promise<string | undefined> {
    const messages: unknown[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const page = await this.processRequest(
        pid,
        "proc.conversation.segment.read",
        {
          conversationId,
          segmentId,
          limit: PROC_HISTORY_PAGE_SIZE,
          offset,
        },
      );
      if (!page?.ok) return undefined;
      total = page.messageCount;
      messages.push(...page.messages);
      if (page.messages.length === 0) break;
      offset += page.messages.length;
    }

    return jsonLines(messages);
  }

  private readVarView(path: string): string | undefined {
    if (path.startsWith("/var/spool/cron/")) {
      const username = decodePathSegment(path.slice("/var/spool/cron/".length));
      if (!username) return undefined;
      return this.kernel?.cron?.readUserCrontab(username);
    }

    if (path === "/var/lib/gsv/packages/status") {
      return renderPackageStatus(this.listVisiblePackages());
    }

    if (path.startsWith("/var/lib/gsv/packages/info/")) {
      const file = path.slice("/var/lib/gsv/packages/info/".length);
      return this.readPackageInfoFile(file);
    }

    if (path === "/var/log/gsv/scheduler") {
      const entries = this.listVisibleSchedules()
        .flatMap((schedule) =>
          this.kernel?.schedules?.history(schedule.id, SCHEDULER_LOG_HISTORY_LIMIT)
            .map((entry) => ({
              ...entry,
              scheduleName: schedule.name,
              ownerUid: schedule.ownerUid,
            })) ?? []
        )
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      return jsonLines(entries);
    }

    return undefined;
  }

  private readEtcCron(path: string): string | undefined {
    if (path.startsWith("/etc/cron.d/")) {
      const name = decodePathSegment(path.slice("/etc/cron.d/".length));
      if (!name) return undefined;
      return this.kernel?.cron?.readSystemCrontab(name);
    }
    return undefined;
  }

  private statCronFile(path: string): ExtendedMountStat | undefined {
    if (!this.kernel?.cron) return undefined;
    if (path.startsWith("/var/spool/cron/")) {
      const username = decodePathSegment(path.slice("/var/spool/cron/".length));
      if (!username) return undefined;
      const content = this.kernel.cron.readUserCrontab(username);
      if (content === undefined) return undefined;
      const user = this.kernel.auth?.getPasswdByUsername(username);
      const uid = user?.uid ?? (this.identity.username === username ? this.identity.uid : 0);
      const gid = user?.gid ?? (this.identity.username === username ? this.identity.gid : 0);
      return cronFileStat(content, 0o600, uid, gid);
    }

    if (path.startsWith("/etc/cron.d/")) {
      const content = this.readEtcCron(path);
      if (content === undefined) return undefined;
      return cronFileStat(content, 0o644, 0, 0);
    }

    return undefined;
  }

  private async writeCronFile(path: string, content: string): Promise<void> {
    if (!this.kernel?.cron) {
      throw new Error("scheduler store is not configured");
    }
    if (path.startsWith("/var/spool/cron/")) {
      const username = decodePathSegment(path.slice("/var/spool/cron/".length));
      if (!username) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      await this.kernel.cron.installUserCrontab(username, content);
      return;
    }
    if (path.startsWith("/etc/cron.d/")) {
      const name = decodePathSegment(path.slice("/etc/cron.d/".length));
      if (!name) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      await this.kernel.cron.installSystemCrontab(name, content);
      return;
    }
    throw new Error(`EPERM: cannot write to virtual path '${path}'`);
  }

  private async removeCronFile(path: string): Promise<boolean> {
    if (!this.kernel?.cron) return false;
    if (path.startsWith("/var/spool/cron/")) {
      const username = decodePathSegment(path.slice("/var/spool/cron/".length));
      return username ? this.kernel.cron.removeUserCrontab(username) : false;
    }
    if (path.startsWith("/etc/cron.d/")) {
      const name = decodePathSegment(path.slice("/etc/cron.d/".length));
      return name ? this.kernel.cron.removeSystemCrontab(name) : false;
    }
    return false;
  }

  private readPackageInfoFile(file: string): string | undefined {
    const parsed = parsePackageInfoFile(file);
    if (!parsed) return undefined;

    const packages = this.listVisiblePackages();
    const record = packages.find((candidate) => candidate.packageId === parsed.packageId);
    if (!record) return undefined;

    switch (parsed.kind) {
      case "manifest":
        return jsonText(record.manifest);
      case "refs":
        return jsonText(buildPackageRefs(record, packages));
      case "list":
        return renderPackagePathList(record, packages);
    }
  }

  private listVisibleSchedules(): ScheduleRecord[] {
    const schedules = this.kernel?.schedules;
    if (!schedules) return [];

    const records: ScheduleRecord[] = [];
    let offset = 0;
    let count = 0;
    do {
      const listed = schedules.list({
        ownerUid: this.identity.uid === 0 ? undefined : this.identity.uid,
        includeDisabled: true,
        limit: SCHEDULER_VIEW_PAGE_SIZE,
        offset,
      });
      records.push(...listed.records);
      count = listed.count;
      offset += listed.records.length;
    } while (records.length < count && offset > 0);

    return records;
  }

  private listVisiblePackages(): InstalledPackageRecord[] {
    const packages = this.kernel?.packages;
    if (!packages) return [];
    return packages.list({
      scopes: visiblePackageScopesForActor(this.identity),
    });
  }

  private async readVirtual(path: string): Promise<string | undefined> {
    if (path.startsWith("/proc/")) return this.readProc(path);
    if (path.startsWith("/dev/")) return this.readDev(path);
    if (path.startsWith("/sys/")) return this.readSys(path);
    if (isVarViewPath(path)) return this.readVarView(path);
    if (isEtcCronPath(path)) return this.readEtcCron(path);
    if (isEtcAuth(path)) return this.readEtcAuth(path);
    return undefined;
  }

  private async isVirtualDir(path: string): Promise<boolean> {
    const virtualDirs = [
      "/proc", "/dev", "/sys",
      "/sys/config", "/sys/users", "/sys/devices", "/sys/capabilities",
      "/var", "/var/spool", "/var/spool/cron", "/var/log", "/var/log/gsv",
      "/var/lib", "/var/lib/gsv", "/var/lib/gsv/packages", "/var/lib/gsv/packages/info",
      "/etc/cron.d",
    ];
    if (virtualDirs.includes(path)) return true;

    if (!this.kernel) return false;

    if (path.startsWith("/proc/") && !path.slice("/proc/".length).includes("/")) {
      const pid = path.slice("/proc/".length);
      if (pid === "version" || pid === "uptime") return false;
      return this.resolveVisibleProcess(pid) !== null;
    }

    if (path.startsWith("/proc/")) {
      const parts = path.slice("/proc/".length).split("/");
      if (parts.length === 2 && parts[1] === "context.d") {
        return this.resolveVisibleProcess(parts[0]) !== null;
      }
      if (parts.length === 2 && parts[1] === "conversations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        return proc !== null;
      }
      if (parts.length === 3 && parts[1] === "conversations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return false;
        const conversation = await this.getProcessConversation(proc.processId, decodePathSegment(parts[2]));
        return conversation !== null;
      }
      if (parts.length === 4 && parts[1] === "conversations" && parts[3] === "segments") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return false;
        const conversation = await this.getProcessConversation(proc.processId, decodePathSegment(parts[2]));
        return conversation !== null;
      }
      if (parts.length === 4 && parts[1] === "conversations" && parts[3] === "generations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return false;
        const conversation = await this.getProcessConversation(proc.processId, decodePathSegment(parts[2]));
        return conversation !== null;
      }
      if (parts.length === 5 && parts[1] === "conversations" && parts[3] === "generations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        const generation = parsePositiveIntegerSegment(parts[4]);
        if (!proc || generation === null) return false;
        const manifest = await this.getProcessConversationGenerationManifest(
          proc.processId,
          decodePathSegment(parts[2]),
          generation,
        );
        return manifest !== null;
      }
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

  private async readdirVirtual(path: string): Promise<string[] | undefined> {
    if (!this.kernel) return undefined;

    if (path === "/proc") {
      const procs = this.identity.uid === 0
        ? this.kernel.procs.list()
        : this.kernel.procs.list(this.viewerOwnerUid());
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
        const proc = this.resolveVisibleProcess(parts[0]);
        if (proc) return ["context.d", "conversations", "identity", "status"];
      }
      if (parts.length === 2 && parts[1] === "context.d") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (proc) return proc.contextFiles.map((entry) => entry.name).sort();
      }
      if (parts.length === 2 && parts[1] === "conversations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const conversations = await this.listProcessConversations(proc.processId);
        return conversations?.map((conversation) => encodePathSegment(conversation.id)).sort();
      }
      if (parts.length === 3 && parts[1] === "conversations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const conversation = await this.getProcessConversation(proc.processId, decodePathSegment(parts[2]));
        if (conversation) return ["generations", "history", "segments", "status", "timeline"];
      }
      if (parts.length === 4 && parts[1] === "conversations" && parts[3] === "segments") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const segments = await this.listProcessConversationSegments(proc.processId, decodePathSegment(parts[2]));
        return segments?.map((segment) => encodePathSegment(segment.id)).sort();
      }
      if (parts.length === 4 && parts[1] === "conversations" && parts[3] === "generations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const generations = await this.listProcessConversationGenerations(proc.processId, decodePathSegment(parts[2]));
        return generations?.map((generation) => String(generation));
      }
      if (parts.length === 5 && parts[1] === "conversations" && parts[3] === "generations") {
        const proc = this.resolveVisibleProcess(parts[0]);
        const generation = parsePositiveIntegerSegment(parts[4]);
        if (!proc || generation === null) return undefined;
        const manifest = await this.getProcessConversationGenerationManifest(
          proc.processId,
          decodePathSegment(parts[2]),
          generation,
        );
        if (manifest) return ["manifest"];
      }
    }

    if (path === "/var") {
      return ["lib", "log", "spool"];
    }
    if (path === "/var/lib") {
      return ["gsv"];
    }
    if (path === "/var/lib/gsv") {
      return ["packages"];
    }
    if (path === "/var/lib/gsv/packages") {
      return ["info", "status"];
    }
    if (path === "/var/lib/gsv/packages/info") {
      return this.listVisiblePackages().flatMap(packageInfoFileNames).sort();
    }
    if (path === "/var/spool") {
      return ["cron"];
    }
    if (path === "/var/spool/cron") {
      return this.kernel?.cron?.listUserCrontabs().map(encodePathSegment).sort() ?? [];
    }
    if (path === "/var/log") {
      return ["gsv"];
    }
    if (path === "/var/log/gsv") {
      return ["scheduler"];
    }
    if (path === "/etc/cron.d") {
      return this.kernel?.cron?.listSystemCrontabs().map(encodePathSegment).sort() ?? [];
    }

    if (path.startsWith("/sys/devices/")) {
      const parts = path.slice("/sys/devices/".length).split("/");
      if (parts.length === 1 && parts[0]) {
        const device = this.kernel.devices.get(parts[0]);
        if (device) return ["description", "implements", "owner", "platform", "status", "version"];
      }
    }

    return undefined;
  }
}

function isEtcAuth(path: string): boolean {
  return path === "/etc/passwd" || path === "/etc/shadow" || path === "/etc/group";
}

function isEtcCronPath(path: string): boolean {
  return path === "/etc/cron.d" || path.startsWith("/etc/cron.d/");
}

function isCronWritablePath(path: string): boolean {
  return path.startsWith("/var/spool/cron/") || path.startsWith("/etc/cron.d/");
}

function isVarViewPath(path: string): boolean {
  return path === "/var" ||
    path === "/var/lib" ||
    path.startsWith("/var/lib/") ||
    path === "/var/spool" ||
    path.startsWith("/var/spool/") ||
    path === "/var/log" ||
    path.startsWith("/var/log/");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function cronFileStat(content: string, mode: number, uid: number, gid: number): ExtendedMountStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode,
    size: TEXT_ENCODER.encode(content).byteLength,
    mtime: new Date(),
    uid,
    gid,
  };
}

function parsePositiveIntegerSegment(segment: string): number | null {
  if (!/^[1-9]\d*$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLines(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
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

type PackageInfoFileKind = "list" | "manifest" | "refs";

function parsePackageInfoFile(file: string): { packageId: string; kind: PackageInfoFileKind } | null {
  for (const kind of ["manifest", "refs", "list"] as const) {
    const suffix = `.${kind}`;
    if (!file.endsWith(suffix)) continue;
    const packageId = decodePathSegment(file.slice(0, -suffix.length));
    return packageId ? { packageId, kind } : null;
  }
  return null;
}

function packageInfoFileBase(record: InstalledPackageRecord): string {
  return encodePathSegment(record.packageId);
}

function packageInfoFileNames(record: InstalledPackageRecord): string[] {
  const base = packageInfoFileBase(record);
  return [`${base}.list`, `${base}.manifest`, `${base}.refs`];
}

function renderPackageStatus(records: InstalledPackageRecord[]): string {
  return records.map(renderPackageStatusStanza).join("\n\n") + (records.length > 0 ? "\n" : "");
}

function renderPackageStatusStanza(record: InstalledPackageRecord): string {
  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ["Package", record.packageId],
    ["Name", record.manifest.name],
    ["Version", record.manifest.version],
    ["Status", "install ok installed"],
    ["Enabled", record.enabled],
    ["Scope", renderPackageScope(record.scope)],
    ["Runtime", record.manifest.runtime],
    ["Source", record.manifest.source.repo],
    ["Source-Ref", record.manifest.source.ref],
    ["Source-Subdir", record.manifest.source.subdir],
    ["Resolved-Commit", record.manifest.source.resolvedCommit ?? null],
    ["Artifact", record.artifact.hash],
    ["Review-Required", record.reviewRequired],
    ["Review-Approved-At", record.reviewedAt ?? null],
    ["Installed-At", record.installedAt],
    ["Updated-At", record.updatedAt],
    ["Description", record.manifest.description],
  ];

  return fields.flatMap(([name, value]) => renderStanzaField(name, value) ?? []).join("\n");
}

function renderStanzaField(
  name: string,
  value: string | number | boolean | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
  const [first, ...rest] = text.split("\n");
  return [
    `${name}: ${first}`,
    ...rest.map((line) => ` ${line.length > 0 ? line : "."}`),
  ].join("\n");
}

function buildPackageRefs(record: InstalledPackageRecord, records: InstalledPackageRecord[]): unknown {
  return {
    packageId: record.packageId,
    scope: record.scope,
    enabled: record.enabled,
    source: record.manifest.source,
    artifact: record.artifact,
    grants: record.grants ?? null,
    review: {
      required: record.reviewRequired,
      approvedAt: record.reviewedAt ?? null,
    },
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    paths: packagePaths(record, records),
  };
}

function renderPackagePathList(record: InstalledPackageRecord, records: InstalledPackageRecord[]): string {
  const paths = packagePaths(record, records);
  return [
    ...paths.info,
    paths.source,
    ...paths.commands,
    ...paths.publicFiles,
  ].filter(Boolean).join("\n") + "\n";
}

function packagePaths(record: InstalledPackageRecord, records: InstalledPackageRecord[]): {
  info: string[];
  source: string;
  commands: string[];
  publicFiles: string[];
} {
  const infoBase = `/var/lib/gsv/packages/info/${packageInfoFileBase(record)}`;
  const sourceName = packageSourcePathNameForRecord(record, records);
  return {
    info: [`${infoBase}.list`, `${infoBase}.manifest`, `${infoBase}.refs`],
    source: `/src/packages/${sourceName}`,
    commands: packageCommandPaths(record, records),
    publicFiles: packagePublicFilePaths(record),
  };
}

function packageCommandPaths(record: InstalledPackageRecord, records: InstalledPackageRecord[]): string[] {
  if (!record.enabled) return [];
  const owners = packageCommandOwners(records);
  const key = packageRecordKey(record);
  return record.manifest.entrypoints
    .filter(isPackageCommandEntrypoint)
    .map((entrypoint) => entrypoint.command.trim())
    .filter((command) => owners.get(command) === key)
    .map((command) => `/usr/local/bin/${command}`)
    .sort();
}

function packageCommandOwners(records: InstalledPackageRecord[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const record of records) {
    if (!record.enabled) continue;
    for (const entrypoint of record.manifest.entrypoints) {
      if (!isPackageCommandEntrypoint(entrypoint)) continue;
      const command = entrypoint.command.trim();
      if (!owners.has(command)) {
        owners.set(command, packageRecordKey(record));
      }
    }
  }
  return owners;
}

function packagePublicFilePaths(record: InstalledPackageRecord): string[] {
  const publicFiles = record.artifact.publicFilePaths ?? [];
  if (publicFiles.length === 0) return [];
  const base = packageArtifactPublicBase(record.artifact.hash);
  return publicFiles.map((path) => `${base}/${path.replace(/^\/+/, "")}`).sort();
}

function isPackageCommandEntrypoint(entrypoint: PackageEntrypoint): entrypoint is PackageEntrypoint & { command: string } {
  return entrypoint.kind === "command" && typeof entrypoint.command === "string" && entrypoint.command.trim().length > 0;
}

function packageRecordKey(record: InstalledPackageRecord): string {
  return `${record.packageId}\0${renderPackageScope(record.scope)}`;
}

function renderPackageScope(scope: PackageInstallScope): string {
  return scope.kind === "user" ? `user:${scope.uid}` : "global";
}
