import type { AuthStore } from "../kernel/auth-store";
import type { CapabilityStore } from "../kernel/capabilities";
import type { ConfigStore } from "../kernel/config";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";
import type { ArgsOf, ResultOf } from "../syscalls";
import type { ScheduleRecord, ScheduleRunHistoryEntry } from "../syscalls/scheduler";

export type ProcessViewCall =
  | "proc.conversation.get"
  | "proc.conversation.list"
  | "proc.conversation.segment.read"
  | "proc.conversation.segments"
  | "proc.history";

export type ProcessViewRequest = <S extends ProcessViewCall>(
  pid: string,
  call: S,
  args: ArgsOf<S>,
) => Promise<ResultOf<S>>;

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
  procs: ProcessRegistry;
  devices: DeviceRegistry;
  caps: CapabilityStore;
  config: ConfigStore;
  schedules?: ScheduleViewStore;
  processRequest?: ProcessViewRequest;
};
