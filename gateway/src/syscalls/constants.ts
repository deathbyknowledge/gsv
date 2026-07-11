// Filesystem
export const FS_READ = "fs.read";
export const FS_WRITE = "fs.write";
export const FS_EDIT = "fs.edit";
export const FS_DELETE = "fs.delete";
export const FS_SEARCH = "fs.search";

// Shell (device commands)
export const SHELL_EXEC = "shell.exec";

// CodeMode (process-local programmable tool use)
export const CODEMODE_EXEC = "codemode.exec";
export const CODEMODE_RUN = "codemode.run";

// Host-routed network operations
export const NET_FETCH = "net.fetch";

// System calls used by the native shell and CodeMode.
export const SYS_OAUTH_DEVICE_START = "sys.oauth.device.start";
export const SYS_OAUTH_DEVICE_POLL = "sys.oauth.device.poll";
export const SYS_OAUTH_LIST = "sys.oauth.list";
export const SYS_OAUTH_FORGET = "sys.oauth.forget";
export const SYS_MCP_ADD = "sys.mcp.add";
export const SYS_MCP_LIST = "sys.mcp.list";
export const SYS_MCP_REMOVE = "sys.mcp.remove";
export const SYS_MCP_REFRESH = "sys.mcp.refresh";
export const SYS_MCP_CALL = "sys.mcp.call";

// syscall → LLM tool name map (only for syscalls exposed as tools)
export const SYSCALL_TOOL_NAMES: Record<string, string> = {
  [FS_READ]: "Read",
  [FS_WRITE]: "Write",
  [FS_EDIT]: "Edit",
  [FS_DELETE]: "Delete",
  [FS_SEARCH]: "Search",
  [SHELL_EXEC]: "Shell",
  [CODEMODE_EXEC]: "CodeMode",
};

// LLM tool name -> syscall. Reverse mapping of the above
export const TOOL_TO_SYSCALL: Record<string, string> = Object.fromEntries(
  Object.entries(SYSCALL_TOOL_NAMES).map(([syscall, tool]) => [tool, syscall]),
);
