import type { FsReadArgs, FsReadResult } from "./read";
import type { FsWriteArgs, FsWriteResult } from "./write";
import type { FsEditArgs, FsEditResult } from "./edit";
import type { FsDeleteArgs, FsDeleteResult } from "./delete";
import type { FsSearchArgs, FsSearchResult } from "./search";
import type { ExecArgs, ExecResult, ProcessInfo } from "./exec";
import type { SessionSendResult, ResetResult, HistoryResult } from "./session";
import type { ConnectArgs, ConnectResult } from "./system";
import type {
  SchedulerListArgs,
  SchedulerListResult,
  SchedulerAddArgs,
  SchedulerRunResult,
  CronJob,
  CronJobPatch,
} from "./scheduler";
import type { IpcSendArgs, IpcSendResult, ChannelStatus } from "./ipc";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SyscallDomains = {
  // Filesystem
  "fs.read": { args: FsReadArgs; result: FsReadResult };
  "fs.write": { args: FsWriteArgs; result: FsWriteResult };
  "fs.edit": { args: FsEditArgs; result: FsEditResult };
  "fs.delete": { args: FsDeleteArgs; result: FsDeleteResult };
  "fs.search": { args: FsSearchArgs; result: FsSearchResult };

  // Process management
  "proc.exec": { args: ExecArgs; result: ExecResult };
  "proc.signal": { args: { pid: number; signal: string }; result: { ok: true } };
  "proc.list": { args: Record<string, never>; result: { processes: ProcessInfo[] } };

  // Session (process-level agent state)
  "session.send": { args: { message: string }; result: SessionSendResult };
  "session.reset": { args: Record<string, never>; result: ResetResult };
  "session.history": { args: { limit?: number }; result: HistoryResult };

  // System
  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.config.get": { args: { path?: string }; result: unknown };
  "sys.config.set": { args: { path: string; value: unknown }; result: { ok: true } };

  // Scheduler (cron)
  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: { job: CronJob } };
  "sched.update": { args: { id: string; patch: CronJobPatch }; result: { job: CronJob } };
  "sched.remove": { args: { id: string }; result: { removed: boolean } };
  "sched.run": { args: { id?: string; mode?: "due" | "force" }; result: SchedulerRunResult };

  // IPC (channels)
  "ipc.send": { args: IpcSendArgs; result: IpcSendResult };
  "ipc.status": { args: { channel: string }; result: ChannelStatus };
};

export type SyscallName = keyof SyscallDomains;
export type ArgsOf<S extends SyscallName> = SyscallDomains[S]["args"];
export type ResultOf<S extends SyscallName> = SyscallDomains[S]["result"];

export type SyscallDomain =
  | "fs"
  | "proc"
  | "session"
  | "sys"
  | "sched"
  | "ipc";

export function domainOf(syscall: SyscallName): SyscallDomain {
  return syscall.split(".")[0] as SyscallDomain;
}

export function intoSyscallTool(
  tool: ToolDefinition,
  nodes: string[],
): ToolDefinition {
  const required = tool.inputSchema.required as string[];
  const properties = tool.inputSchema.properties as Record<string, unknown>;
  if (
    required.includes("target") ||
    Object.keys(properties).includes("target")
  ) {
    throw new Error(
      `Tool ${tool.name} already has 'target' property. Can't turn into syscall tool.`,
    );
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        target: {
          type: "string",
          description: `Target node to execute on. Use "gsv" to execute on the cloud or use one of the online nodes: ${nodes.join(", ")}`,
        },
      },
      required: [...required, "target"],
    },
  };
}
