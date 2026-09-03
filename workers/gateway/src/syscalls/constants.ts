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

export const MAIL_SEND = "mail.send";
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
export const SYSCALL_TOOL_NAMES = {
  [FS_READ]: "Read",
  [FS_WRITE]: "Write",
  [FS_EDIT]: "Edit",
  [FS_DELETE]: "Delete",
  [FS_SEARCH]: "Search",
  [SHELL_EXEC]: "Shell",
  [CODEMODE_EXEC]: "CodeMode",
} satisfies Record<string, string>;

export type ToolSyscallName = keyof typeof SYSCALL_TOOL_NAMES;

const SYSCALL_TOOL_NAME_BY_SYSCALL = new Map<string, string>(
  Object.entries(SYSCALL_TOOL_NAMES),
);

export function isToolSyscallName(call: string): call is ToolSyscallName {
  return SYSCALL_TOOL_NAME_BY_SYSCALL.has(call);
}

export function syscallToolName(call: string): string | undefined {
  return SYSCALL_TOOL_NAME_BY_SYSCALL.get(call);
}

// LLM tool name -> syscall. Reverse mapping of the above
type ToolToSyscallMap = { readonly [key: string]: ToolSyscallName | undefined };
function defineToolToSyscallMap<T extends ToolToSyscallMap>(value: T): ToolToSyscallMap & T {
  return value;
}
export const TOOL_TO_SYSCALL = defineToolToSyscallMap({
  [SYSCALL_TOOL_NAMES[FS_READ]]: FS_READ,
  [SYSCALL_TOOL_NAMES[FS_WRITE]]: FS_WRITE,
  [SYSCALL_TOOL_NAMES[FS_EDIT]]: FS_EDIT,
  [SYSCALL_TOOL_NAMES[FS_DELETE]]: FS_DELETE,
  [SYSCALL_TOOL_NAMES[FS_SEARCH]]: FS_SEARCH,
  [SYSCALL_TOOL_NAMES[SHELL_EXEC]]: SHELL_EXEC,
  [SYSCALL_TOOL_NAMES[CODEMODE_EXEC]]: CODEMODE_EXEC,
});
