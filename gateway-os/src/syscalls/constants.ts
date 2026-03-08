// syscall domain identifiers
export const FS_READ = "fs.read";
export const FS_WRITE = "fs.write";
export const FS_EDIT = "fs.edit";
export const FS_DELETE = "fs.delete";
export const FS_SEARCH = "fs.search";
export const PROC_EXEC = "proc.exec";
export const PROC_SIGNAL = "proc.signal";
export const PROC_LIST = "proc.list";
export const SESSION_SEND = "session.send";
export const SESSION_RESET = "session.reset";
export const SESSION_HISTORY = "session.history";
export const SYS_CONNECT = "sys.connect";
export const SYS_CONFIG_GET = "sys.config.get";
export const SYS_CONFIG_SET = "sys.config.set";
export const SCHED_LIST = "sched.list";
export const SCHED_ADD = "sched.add";
export const SCHED_UPDATE = "sched.update";
export const SCHED_REMOVE = "sched.remove";
export const SCHED_RUN = "sched.run";
export const IPC_SEND = "ipc.send";
export const IPC_STATUS = "ipc.status";

// syscall → LLM tool name map (only for syscalls exposed as tools)
export const SYSCALL_TOOL_NAMES: Record<string, string> = {
  [FS_READ]: "Read",
  [FS_WRITE]: "Write",
  [FS_EDIT]: "Edit",
  [FS_DELETE]: "Delete",
  [FS_SEARCH]: "Search",
  [PROC_EXEC]: "Exec",
};
