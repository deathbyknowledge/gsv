import type {
  FileContent,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { canReadConfigKey } from "../../kernel/config-access";
import type { KernelRefs, ProcessViewCall } from "../refs";
import type { ArgsOf, ResultOf } from "../../syscalls";
import type {
  AiModelEntry,
  ProcessIdentity,
  ProcAiConfig,
  ProcHistorySegment,
  ScheduleRecord,
} from "@humansandmachines/gsv/protocol";
import type { ProcessRecord } from "../../kernel/processes";
import {
  processAiConfigDirEntries,
} from "../../process/ai-config";
import {
  parseAiModelStack,
  SYSTEM_AI_MODELS_CONFIG_KEY,
  userAiModelsConfigKey,
} from "../../kernel/ai-model-stack";
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
      await this.writeProc(p, fileContentText(content));
      return;
    }
    if (p.startsWith("/sys/")) {
      this.writeSys(p, fileContentText(content));
      return;
    }
    if (isCronWritablePath(p)) {
      await this.writeCronFile(p, fileContentText(content));
      return;
    }
    if (isVarViewPath(p)) {
      throw new Error(`EPERM: /var runtime views are read-only`);
    }
    if (isEtcAuth(p)) {
      this.writeEtcAuth(p, fileContentText(content));
      return;
    }
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const p = normalizePath(path);
    if (p === "/dev/null") return;
    if (isCronWritablePath(p)) {
      const existing = await this.readVirtual(p) ?? "";
      await this.writeCronFile(p, existing + fileContentText(content));
      return;
    }
    if (p.startsWith("/dev/") || p.startsWith("/proc/") || p.startsWith("/sys/") || isVarViewPath(p) || isEtcCronPath(p)) {
      throw new Error(`EPERM: cannot append to virtual path '${p}'`);
    }
    if (isEtcAuth(p)) {
      const existing = this.readEtcAuth(p) ?? "";
      const appended = existing + fileContentText(content);
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

    if (attrParts[0] === "ai") {
      return this.readProcAi(proc.processId, proc, attrParts.slice(1));
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
      case "history":
        return this.readProcessHistory(pid);
      default:
        if (attrParts[0] === "segments" && attrParts.length === 2) {
          const segmentId = decodePathSegment(attrParts[1]);
          return segmentId
            ? this.readProcessHistorySegment(pid, segmentId)
            : undefined;
        }
        return undefined;
    }
  }

  private async readProcAi(
    pid: string,
    proc: ProcessRecord,
    parts: string[],
  ): Promise<string | undefined> {
    if (parts.length === 0) return undefined;

    const attr = parts.join("/");
    const local = await this.getProcessAiConfig(pid);

    if (attr === "model") {
      return `${local?.modelId ?? ""}\n`;
    }

    if (attr === "models") {
      return jsonText(this.listProcAiModels(proc.ownerUid));
    }

    if (attr === "local.json") {
      return jsonText(local);
    }

    if (attr === "effective.json") {
      return jsonText({
        modelId: this.effectiveProcAiModelId(proc, local),
        reasoning: this.effectiveProcAiReasoning(proc, local),
      });
    }

    if (attr === "reasoning") {
      return `${this.effectiveProcAiReasoning(proc, local) ?? ""}\n`;
    }
    return undefined;
  }

  private async writeProc(path: string, content: string): Promise<void> {
    if (!this.kernel) {
      throw new Error("EPERM: /proc is not available");
    }

    const parts = path.slice("/proc/".length).split("/");
    if (parts.length < 3 || parts[1] !== "ai") {
      throw new Error(`EPERM: /proc is read-only`);
    }

    const proc = this.resolveVisibleProcess(parts[0]);
    if (!proc || !this.canWriteProcess(proc)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const aiParts = parts.slice(2);
    if (aiParts.length === 1 && aiParts[0] === "model") {
      const modelId = content.trim().toLowerCase();
      if (modelId && !this.listProcAiModels(proc.ownerUid).some((model) => model.id === modelId)) {
        throw new Error(`ENOENT: AI model not found: ${modelId}`);
      }
      const result = await this.processRequest(
        proc.processId,
        "proc.ai.config.set",
        { modelId: modelId || null },
      );
      if (!result?.ok) {
        throw new Error(`EIO: failed to update process AI model`);
      }
      return;
    }

    if (aiParts.length === 1 && aiParts[0] === "reasoning") {
      const result = await this.processRequest(
        proc.processId,
        "proc.ai.config.set",
        { reasoning: content.trim() || null },
      );
      if (!result?.ok) {
        throw new Error(`EIO: failed to update process AI reasoning`);
      }
      return;
    }

    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }

  private async getProcessAiConfig(
    pid: string,
  ): Promise<ProcAiConfig | null> {
    const result = await this.processRequest(
      pid,
      "proc.ai.config.get",
      {},
    );
    return result?.ok ? result.config : null;
  }

  private effectiveProcAiModelId(
    proc: ProcessRecord,
    local: ProcAiConfig | null,
  ): string | null {
    return local?.modelId
      ?? this.kernel?.config?.get(`users/${proc.uid}/ai/preferred_model`)
      ?? this.listProcAiModels(proc.ownerUid)[0]?.id
      ?? null;
  }

  private effectiveProcAiReasoning(proc: ProcessRecord, local: ProcAiConfig | null): string | null {
    return local?.reasoning
      ?? this.kernel?.config?.get(`users/${proc.uid}/ai/reasoning`)
      ?? this.kernel?.config?.get(`users/${proc.ownerUid}/ai/reasoning`)
      ?? this.kernel?.config?.get("config/ai/reasoning")
      ?? null;
  }

  private listProcAiModels(ownerUid: number): AiModelEntry[] {
    const ownerKey = userAiModelsConfigKey(ownerUid);
    const key = this.kernel?.config?.getExplicit(ownerKey) != null
      ? ownerKey
      : SYSTEM_AI_MODELS_CONFIG_KEY;
    const stack = parseAiModelStack(this.kernel?.config?.get(key));
    return stack?.models ?? [];
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

    if (rel.startsWith("targets/")) {
      return this.readSysTarget(rel.slice("targets/".length));
    }

    if (rel.startsWith("capabilities/")) {
      return this.readSysCaps(rel.slice("capabilities/".length));
    }

    return undefined;
  }

  private readSysTarget(rel: string): string | undefined {
    if (!this.kernel) return undefined;
    const parts = rel.split("/");
    const targetId = parts[0];
    const attr = parts.slice(1).join("/");

    if (!targetId) return undefined;

    const device = this.kernel.targets.get(targetId);
    if (!device) return undefined;

    if (!this.kernel.targets.canAccess(targetId, this.identity.uid, this.identity.gids)) {
      return undefined;
    }

    if (!attr) {
      return [
        `target_id=${device.target_id}`,
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

  /** The current process pid for `/proc/self`, or ENOENT outside a process. */
  private selfProcessPid(): string {
    return this.selfPid ?? "";
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

  private canWriteProcess(proc: { processId?: string; uid: number; ownerUid?: number | null }): boolean {
    return this.canViewProcess(proc);
  }

  private viewerOwnerUid(): number {
    if (!this.kernel || !this.selfPid) return this.identity.uid;
    return this.kernel.procs.getOwnerUid(this.selfPid) ?? this.identity.uid;
  }

  private async processRequest<S extends ProcessViewCall>(
    pid: string,
    call: S,
    args: ArgsOf<S>,
  ): Promise<ResultOf<S> | null> {
    if (!this.kernel?.processRequest) return null;
    try {
      return await this.kernel.processRequest(pid, call, args);
    } catch {
      return null;
    }
  }

  private async readProcessHistory(pid: string): Promise<string | undefined> {
    const messages: unknown[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const page = await this.processRequest(
        pid,
        "proc.history",
        { limit: PROC_HISTORY_PAGE_SIZE, offset },
      );
      if (!page?.ok) return undefined;
      total = page.messageCount;
      messages.push(...page.messages);
      if (page.messages.length === 0) break;
      offset += page.messages.length;
    }

    return jsonLines(messages);
  }

  private async listProcessHistorySegments(pid: string): Promise<ProcHistorySegment[] | null> {
    const result = await this.processRequest(
      pid,
      "proc.history.segments",
      {},
    );
    return result?.ok ? result.segments : null;
  }

  private async readProcessHistorySegment(
    pid: string,
    segmentId: string,
  ): Promise<string | undefined> {
    const messages: unknown[] = [];
    let offset = 0;
    let total: number | null = null;

    while (total === null || offset < total) {
      const page = await this.processRequest(
        pid,
        "proc.history.segment.read",
        {
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
      "/sys/config", "/sys/users", "/sys/targets", "/sys/capabilities",
      "/var", "/var/spool", "/var/spool/cron", "/var/log", "/var/log/gsv",
      "/var/lib", "/var/lib/gsv",
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
      if (parts.length >= 2 && parts[1] === "ai") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return false;
        if (parts.length === 2) return true;
        return processAiConfigDirEntries(parts.slice(2)).length > 0;
      }
      if (parts.length === 2 && parts[1] === "segments") {
        const proc = this.resolveVisibleProcess(parts[0]);
        return proc !== null;
      }
    }

    if (path.startsWith("/sys/targets/") && !path.slice("/sys/targets/".length).includes("/")) {
      const targetId = path.slice("/sys/targets/".length);
      return this.kernel.targets.get(targetId) !== null;
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
      if (this.selfPid) {
        entries.push("self");
      }
      entries.push("version", "uptime");
      return entries.sort();
    }

    if (path === "/dev") {
      return ["null", "random", "urandom", "zero"];
    }

    if (path === "/sys") {
      return ["capabilities", "config", "targets", "users"];
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

    if (path === "/sys/targets") {
      const targets = this.kernel.targets.listForUser(this.identity.uid, this.identity.gids);
      return targets.map((target) => target.target_id).sort();
    }

    if (path === "/sys/capabilities") {
      const caps = this.kernel.caps.list();
      return [...new Set(caps.map((c) => String(c.gid)))].sort();
    }

    if (path.startsWith("/proc/")) {
      const parts = path.slice("/proc/".length).split("/");
      if (parts.length === 1) {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (proc) return ["ai", "history", "identity", "segments", "status"];
      }
      if (parts.length >= 2 && parts[1] === "ai") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const entries = processAiConfigDirEntries(parts.slice(2));
        return entries.length > 0 ? entries : undefined;
      }
      if (parts.length === 2 && parts[1] === "segments") {
        const proc = this.resolveVisibleProcess(parts[0]);
        if (!proc) return undefined;
        const segments = await this.listProcessHistorySegments(proc.processId);
        return segments?.map((segment) => encodePathSegment(segment.id)).sort();
      }
    }

    if (path === "/var") {
      return ["lib", "log", "spool"];
    }
    if (path === "/var/lib") {
      return ["gsv"];
    }
    if (path === "/var/lib/gsv") return [];
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

    if (path.startsWith("/sys/targets/")) {
      const parts = path.slice("/sys/targets/".length).split("/");
      if (parts.length === 1 && parts[0]) {
        const device = this.kernel.targets.get(parts[0]);
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

function fileContentText(content: FileContent): string {
  return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
}

type JsonTextValue = Parameters<typeof JSON.stringify>[0];

function jsonText(value: JsonTextValue): string {
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
