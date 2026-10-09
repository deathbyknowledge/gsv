import { z } from "zod";

export type ToolApprovalAction = "auto" | "ask" | "deny";

export const toolApprovalTargetSelectorSchema = z.strictObject({
  route: z.enum(["machine", "adapter", "instance"]),
  platform: z.string().trim().min(1).optional(),
});
export const toolApprovalTargetSchema = z.union([z.string(), toolApprovalTargetSelectorSchema]);
export type ToolApprovalTargetSelector = z.infer<typeof toolApprovalTargetSelectorSchema>;
export type ToolApprovalTarget = z.infer<typeof toolApprovalTargetSchema>;

export function isToolApprovalTargetSelector(target: ToolApprovalTarget): target is ToolApprovalTargetSelector {
  return toolApprovalTargetSelectorSchema.safeParse(target).success;
}

export function normalizeToolApprovalTarget(target: ToolApprovalTarget | undefined): ToolApprovalTarget | undefined {
  const parsed = z.string().safeParse(target);
  if (!parsed.success) return target;
  const trimmed = parsed.data.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || trimmed === "*" || lower === "any") return undefined;
  if (lower === "gateway" || lower === "local") return "gsv";
  if (trimmed === "device" || trimmed === "devices/*") return "targets/*";
  return trimmed;
}

export type ToolApprovalRule = {
  match: string;
  target?: ToolApprovalTarget;
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
    { match: "fs.*", target: "gsv", action: "auto" },
    { match: "shell.exec", target: "gsv", action: "auto" },
    { match: "net.fetch", target: "gsv", action: "auto" },
    { match: "fs.*", target: { route: "instance", platform: "browser" }, action: "auto" },
    { match: "shell.exec", target: { route: "instance", platform: "browser" }, action: "auto" },
    { match: "net.fetch", target: { route: "instance", platform: "browser" }, action: "auto" },
    { match: "shell.exec", target: "targets/*", action: "ask" },
    { match: "net.fetch", target: "targets/*", action: "ask" },
    { match: "fs.*", target: "targets/*", action: "ask" },
    { match: "fs.read", target: "targets/*", action: "auto" },
    { match: "fs.search", target: "targets/*", action: "auto" },
    { match: "fs.transfer.stat", target: "targets/*", action: "auto" },
    { match: "fs.transfer.send", target: "targets/*", action: "auto" },
    { match: "web.search", action: "auto" },
    { match: "sys.mcp.call", action: "ask" },
    { match: "mail.send", action: "ask" },
  ],
};
