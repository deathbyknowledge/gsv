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

// Packages
export const PKG_REPO_REFS = "pkg.repo.refs";
export const PKG_REPO_READ = "pkg.repo.read";
export const PKG_REPO_LOG = "pkg.repo.log";
export const PKG_REPO_SEARCH = "pkg.repo.search";
export const PKG_REPO_DIFF = "pkg.repo.diff";

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

// Knowledge substrate (home durable knowledge)
export const KNOWLEDGE_DB_LIST = "knowledge.db.list";
export const KNOWLEDGE_DB_INIT = "knowledge.db.init";
export const KNOWLEDGE_DB_DELETE = "knowledge.db.delete";
export const KNOWLEDGE_LIST = "knowledge.list";
export const KNOWLEDGE_READ = "knowledge.read";
export const KNOWLEDGE_WRITE = "knowledge.write";
export const KNOWLEDGE_SEARCH = "knowledge.search";
export const KNOWLEDGE_MERGE = "knowledge.merge";
export const KNOWLEDGE_PROMOTE = "knowledge.promote";
export const KNOWLEDGE_QUERY = "knowledge.query";
export const KNOWLEDGE_INGEST = "knowledge.ingest";
export const KNOWLEDGE_COMPILE = "knowledge.compile";

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
