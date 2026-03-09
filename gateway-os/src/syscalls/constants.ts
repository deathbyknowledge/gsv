// Filesystem
export const FS_READ = "fs.read";
export const FS_WRITE = "fs.write";
export const FS_EDIT = "fs.edit";
export const FS_DELETE = "fs.delete";
export const FS_SEARCH = "fs.search";

// Shell (device commands)
export const SHELL_EXEC = "shell.exec";
export const SHELL_SIGNAL = "shell.signal";
export const SHELL_LIST = "shell.list";

// Process management (OS-level agent processes)
export const PROC_SPAWN = "proc.spawn";
export const PROC_KILL = "proc.kill";
export const PROC_LIST = "proc.list";
export const PROC_SEND = "proc.send";
export const PROC_HISTORY = "proc.history";
export const PROC_RESET = "proc.reset";

// System
export const SYS_CONNECT = "sys.connect";
export const SYS_CONFIG_GET = "sys.config.get";
export const SYS_CONFIG_SET = "sys.config.set";

// Scheduler (cron)
export const SCHED_LIST = "sched.list";
export const SCHED_ADD = "sched.add";
export const SCHED_UPDATE = "sched.update";
export const SCHED_REMOVE = "sched.remove";
export const SCHED_RUN = "sched.run";

// IPC (channels)
export const IPC_SEND = "ipc.send";
export const IPC_STATUS = "ipc.status";

// syscall → LLM tool name map (only for syscalls exposed as tools)
export const SYSCALL_TOOL_NAMES: Record<string, string> = {
  [FS_READ]: "Read",
  [FS_WRITE]: "Write",
  [FS_EDIT]: "Edit",
  [FS_DELETE]: "Delete",
  [FS_SEARCH]: "Search",
  [SHELL_EXEC]: "Shell",
};
