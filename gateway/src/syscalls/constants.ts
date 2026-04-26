// Filesystem
export const FS_READ = "fs.read";
export const FS_WRITE = "fs.write";
export const FS_EDIT = "fs.edit";
export const FS_DELETE = "fs.delete";
export const FS_SEARCH = "fs.search";

// Shell (device commands)
export const SHELL_EXEC = "shell.exec";

// Process management (OS-level agent processes)
export const PROC_SPAWN = "proc.spawn";
export const PROC_KILL = "proc.kill";
export const PROC_LIST = "proc.list";
export const PROC_SEND = "proc.send";
export const PROC_ABORT = "proc.abort";
export const PROC_HIL = "proc.hil";
export const PROC_HISTORY = "proc.history";
export const PROC_RESET = "proc.reset";
export const PROC_SETIDENTITY = "proc.setidentity";

// Repositories
export const REPO_LIST = "repo.list";
export const REPO_CREATE = "repo.create";
export const REPO_REFS = "repo.refs";
export const REPO_READ = "repo.read";
export const REPO_SEARCH = "repo.search";
export const REPO_LOG = "repo.log";
export const REPO_DIFF = "repo.diff";
export const REPO_COMPARE = "repo.compare";
export const REPO_APPLY = "repo.apply";
export const REPO_IMPORT = "repo.import";

// System
export const SYS_CONNECT = "sys.connect";
export const SYS_SETUP = "sys.setup";
export const SYS_BOOTSTRAP = "sys.bootstrap";
export const SYS_CONFIG_GET = "sys.config.get";
export const SYS_CONFIG_SET = "sys.config.set";
export const SYS_DEVICE_LIST = "sys.device.list";
export const SYS_DEVICE_GET = "sys.device.get";
export const SYS_TOKEN_CREATE = "sys.token.create";
export const SYS_TOKEN_LIST = "sys.token.list";
export const SYS_TOKEN_REVOKE = "sys.token.revoke";
export const SYS_LINK_CONSUME = "sys.link.consume";
export const SYS_LINK = "sys.link";
export const SYS_UNLINK = "sys.unlink";
export const SYS_LINK_LIST = "sys.link.list";

// Scheduler (cron)
export const SCHED_LIST = "sched.list";
export const SCHED_ADD = "sched.add";
export const SCHED_UPDATE = "sched.update";
export const SCHED_REMOVE = "sched.remove";
export const SCHED_RUN = "sched.run";

// AI (process bootstrap)
export const AI_TOOLS = "ai.tools";
export const AI_CONFIG = "ai.config";

// Adapter transport (external connectors)
export const ADAPTER_INBOUND = "adapter.inbound";
export const ADAPTER_STATE_UPDATE = "adapter.state.update";
export const ADAPTER_CONNECT = "adapter.connect";
export const ADAPTER_DISCONNECT = "adapter.disconnect";
export const ADAPTER_SEND = "adapter.send";
export const ADAPTER_STATUS = "adapter.status";

// Notifications
export const NOTIFICATION_CREATE = "notification.create";
export const NOTIFICATION_LIST = "notification.list";
export const NOTIFICATION_MARK_READ = "notification.mark_read";
export const NOTIFICATION_DISMISS = "notification.dismiss";

// Durable signal watches
export const SIGNAL_WATCH = "signal.watch";
export const SIGNAL_UNWATCH = "signal.unwatch";

// syscall → LLM tool name map (only for syscalls exposed as tools)
export const SYSCALL_TOOL_NAMES: Record<string, string> = {
  [FS_READ]: "Read",
  [FS_WRITE]: "Write",
  [FS_EDIT]: "Edit",
  [FS_DELETE]: "Delete",
  [FS_SEARCH]: "Search",
  [SHELL_EXEC]: "Shell",
};

// LLM tool name -> syscall. Reverse mapping of the above
export const TOOL_TO_SYSCALL: Record<string, string> = Object.fromEntries(
  Object.entries(SYSCALL_TOOL_NAMES).map(([syscall, tool]) => [tool, syscall]),
);
