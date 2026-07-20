import type { CronFileService } from "../kernel/crontab";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";
import type { ConversationRegistry } from "../kernel/conversations";
import type { InstalledPackageRecord } from "../kernel/packages";
import type { RequestFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import type { ArgsOf, ResultOf } from "../syscalls";
import type { ScheduleRecord, ScheduleRunHistoryEntry } from "@humansandmachines/gsv/protocol";

export type ProcessViewCall =
  | "proc.ai.config.get"
  | "proc.ai.config.set"
  | "proc.conversation.get"
  | "proc.conversation.generation.manifest"
  | "proc.conversation.generations"
  | "proc.conversation.list"
  | "proc.conversation.segment.read"
  | "proc.conversation.segments"
  | "proc.conversation.timeline"
  | "proc.history";

export type ProcessViewRequest = <S extends ProcessViewCall>(
  pid: string,
  call: S,
  args: ArgsOf<S>,
) => Promise<ResultOf<S>>;

export async function requestProcessView<S extends ProcessViewCall>(
  pid: string,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
  const response = await sendFrameToProcess(pid, frame);
  if (!response || response.type !== "res") {
    throw new Error(`${call} did not return a response`);
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data as ResultOf<S>;
}

export type ScheduleViewStore = {
  list(args: {
    ownerUid?: number;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): { records: ScheduleRecord[]; count: number };
  history(scheduleId: string, limit?: number): ScheduleRunHistoryEntry[];
};

export type KernelAuthFileKind = "passwd" | "group" | "shadow";

/**
 * Account directory access for filesystem views. Implementations resolve
 * against the Master: locally on the Master itself, by RPC from user
 * Kernels, which hold no auth state.
 */
export type KernelAuthRefs = {
  readAuthFile(kind: KernelAuthFileKind): Promise<string>;
  getAccountByUsername(username: string): Promise<{
    uid: number;
    gid: number;
    username: string;
    home: string;
  } | null>;
  getPersonalAgentUid(uid: number): Promise<number | null>;
  /** Whether /etc/passwd, /etc/shadow, and /etc/group are authoritative here. */
  authDirectoryWritable?: boolean;
  /** Root-only /etc imports; present only where the directory is writable. */
  importAuthFile?(kind: KernelAuthFileKind, content: string): void;
};

/** Master-authoritative config reads for filesystem views. */
export type KernelConfigRefs = {
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<{ key: string; value: string }[]>;
};

/** Master-authoritative group capability reads for filesystem views. */
export type KernelCapsRefs = {
  list(gid?: number): Promise<{ gid: number; capability: string }[]>;
};

/** Master-authoritative installed-package reads for filesystem views. */
export type KernelPackagesRefs = {
  listVisible(options?: { enabled?: boolean }): Promise<InstalledPackageRecord[]>;
};

export type KernelRefs = {
  auth: KernelAuthRefs;
  procs: ProcessRegistry;
  conversations?: ConversationRegistry;
  devices: DeviceRegistry;
  caps: KernelCapsRefs;
  config: KernelConfigRefs;
  /** Authoritative config write boundary; omitted for read-only projections. */
  writeConfig?: (key: string, value: string) => Promise<void>;
  packages?: KernelPackagesRefs;
  cron?: CronFileService;
  schedules?: ScheduleViewStore;
  processRequest?: ProcessViewRequest;
};
