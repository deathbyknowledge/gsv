import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";

function stringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

export type TextApprovalCopy = {
  action: string;
  detail: string;
};

/** Curate approval copy from an explicit syscall allowlist. Unknown arguments stay private. */
export function textApprovalCopy(request: ProcHilRequest): TextApprovalCopy {
  const args = request.args;
  if (request.syscall === "shell.exec") {
    return {
      action: "Run a command",
      detail: stringArg(args, "input", "command", "cmd", "script"),
    };
  }
  if (request.syscall === "fs.delete") {
    return { action: "Delete a file", detail: stringArg(args, "path") };
  }
  if (request.syscall === "net.fetch") {
    const method = stringArg(args, "method");
    const url = stringArg(args, "url");
    return { action: method ? `${method.toUpperCase()} a URL` : "Contact a URL", detail: url };
  }
  if (request.syscall === "sys.mcp.call") {
    return { action: "Use an MCP tool", detail: stringArg(args, "tool", "name") };
  }
  return { action: request.toolName || "Use a protected capability", detail: "" };
}
