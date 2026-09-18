export type ToolApprovalAction = "auto" | "ask" | "deny";

export type ToolApprovalRule = {
  match: string;
  target?: string;
  action: ToolApprovalAction;
};

export type ToolApprovalPolicy = {
  default: ToolApprovalAction;
  rules: ToolApprovalRule[];
};

/** Approval defaults shared by the runtime and editors; account grants still apply. */
export const DEFAULT_TOOL_APPROVAL_POLICY: ToolApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", target: "targets/*", action: "ask" },
    { match: "net.fetch", target: "targets/*", action: "ask" },
    { match: "fs.*", target: "targets/*", action: "ask" },
    { match: "fs.read", target: "targets/*", action: "auto" },
    { match: "fs.search", target: "targets/*", action: "auto" },
    { match: "fs.transfer.stat", target: "targets/*", action: "auto" },
    { match: "fs.transfer.send", target: "targets/*", action: "auto" },
    { match: "sys.mcp.call", action: "ask" },
    { match: "mail.send", action: "ask" },
  ],
};
