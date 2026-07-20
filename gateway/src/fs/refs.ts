import type { AuthStore } from "../kernel/auth-store";
import type { CapabilityStore } from "../kernel/capabilities";
import type { ConfigStore } from "../kernel/config";
import type { CronFileService } from "../kernel/crontab";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";
import type { ConversationRegistry } from "../kernel/conversations";
import type { PackageStore } from "../kernel/packages";
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

export type KernelRefs = {
  auth: AuthStore;
  /** Whether /etc/passwd, /etc/shadow, and /etc/group are authoritative here. */
  authDirectoryWritable?: boolean;
  procs: ProcessRegistry;
  conversations?: ConversationRegistry;
  devices: DeviceRegistry;
  caps: CapabilityStore;
  config: ConfigStore;
  /** Authoritative config write boundary; omitted for read-only projections. */
  writeConfig?: (key: string, value: string) => Promise<void>;
  packages?: PackageStore;
  cron?: CronFileService;
  schedules?: ScheduleViewStore;
  processRequest?: ProcessViewRequest;
};
