import { MAIL_SEND, NET_FETCH } from "../syscalls/constants";
import { isRoutableSyscall, type SyscallName } from "../syscalls";
import { z } from "zod";

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

export type ToolApprovalResolution = {
  action: ToolApprovalAction;
  target: string;
  matchedRule?: string;
};

export const DEFAULT_TOOL_APPROVAL_POLICY: ToolApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", action: "ask" },
    { match: NET_FETCH, action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
    { match: MAIL_SEND, action: "ask" },
  ],
};
const approvalActionSchema = z.enum(["auto", "ask", "deny"]);
const approvalValueSchema = z.unknown();
type ApprovalWireValue = z.input<typeof approvalValueSchema>;
const approvalRuleSchema = z.object({
  match: z.string().trim().min(1),
  target: z.string().optional(),
  action: approvalActionSchema,
  when: approvalValueSchema.optional(),
});
const approvalPolicySchema = z.object({
  default: approvalActionSchema.optional(),
  rules: z.array(approvalValueSchema).optional(),
});
const approvalArgsSchema = z.object({ target: z.string().optional(), sessionId: z.string().optional() });

export function parseToolApprovalPolicy(raw: string | null | undefined): ToolApprovalPolicy {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }

  try {
    const record = approvalPolicySchema.parse(JSON.parse(raw));
    const defaultAction = record.default ?? DEFAULT_TOOL_APPROVAL_POLICY.default;
    const rules = record.rules
      ? record.rules
          .map(parseRule)
          .filter((rule): rule is ToolApprovalRule => rule !== null)
      : DEFAULT_TOOL_APPROVAL_POLICY.rules;

    return protectManagedMailApproval({
      default: defaultAction,
      rules,
    });
  } catch {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }
}

export function resolveToolApproval(
  policy: ToolApprovalPolicy,
  syscall: string,
  args?: ApprovalWireValue,
): ToolApprovalResolution {
  const target = resolveToolApprovalTarget(syscall, args);
  const rules = policy.rules
    .map((rule, index) => ({
      rule,
      index,
      matchSpecificity: rule.match === syscall ? 2 : isWildcardMatch(rule.match, syscall) ? 1 : 0,
      targetSpecificity: targetScopeSpecificity(rule.target),
    }))
    .filter((entry) => entry.matchSpecificity > 0 && targetMatchesScope(entry.rule.target, target))
    .sort((left, right) =>
      right.targetSpecificity - left.targetSpecificity
      || right.matchSpecificity - left.matchSpecificity
      || left.index - right.index
    );

  const rule = rules[0]?.rule;
  if (rule) {
    return {
      action: rule.action,
      target,
      matchedRule: rule.match,
    };
  }

  if (syscall === MAIL_SEND && policy.default === "auto") {
    return {
      action: "ask",
      target,
    };
  }

  return {
    action: policy.default,
    target,
  };
}

function protectManagedMailApproval(policy: ToolApprovalPolicy): ToolApprovalPolicy {
  if (
    policy.default !== "auto"
    || policy.rules.some((rule) =>
      (rule.match === MAIL_SEND || isWildcardMatch(rule.match, MAIL_SEND))
      && targetMatchesScope(rule.target, "gsv")
    )
  ) {
    return policy;
  }
  return {
    ...policy,
    rules: [...policy.rules, { match: MAIL_SEND, action: "ask" }],
  };
}

export function resolveToolApprovalTarget(syscall: string, args?: ApprovalWireValue): string {
  const record = approvalArgsSchema.safeParse(args).success ? approvalArgsSchema.parse(args) : null;
  // SAFETY: syscall routing accepts the complete syscall-name union at this boundary.
  const target = isRoutableSyscall(syscall as SyscallName)
    ? normalizeExplicitTarget(record?.target)
    : null;
  if (target) {
    return target;
  }
  if (syscall === "shell.exec" && record?.sessionId?.trim()) {
    return "targets/*";
  }
  return "gsv";
}

function parseRule(value: ApprovalWireValue): ToolApprovalRule | null {
  const record = approvalRuleSchema.safeParse(value);
  if (!record.success) return null;

  return {
    match: record.data.match,
    ...normalizeTargetPatch(record.data.target, record.data.when),
    action: record.data.action,
  };
}

function isWildcardMatch(ruleMatch: string, syscall: string): boolean {
  if (!ruleMatch.endsWith(".*")) {
    return false;
  }
  const domain = ruleMatch.slice(0, -2);
  return syscall === domain || syscall.startsWith(domain + ".");
}

function normalizeTargetPatch(
  targetValue: ApprovalWireValue,
  legacyWhen: ApprovalWireValue,
): Pick<ToolApprovalRule, "target"> {
  const target = normalizeTargetScope(targetValue)
    ?? normalizeTargetScope(legacyWhenTarget(legacyWhen));
  return target ? { target } : {};
}

function normalizeTargetScope(value: ApprovalWireValue): string | undefined {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return undefined;
  const normalized = normalizeTargetAlias(parsed.data);
  if (!normalized || normalized === "*" || normalized === "any") {
    return undefined;
  }
  if (normalized === "device" || normalized === "devices/*") {
    return "targets/*";
  }
  return normalized;
}

function legacyWhenTarget(value: ApprovalWireValue): ApprovalWireValue {
  const parsed = z.object({ target: z.string().optional() }).safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.target === "device" ? "targets/*" : parsed.data.target;
}

function normalizeExplicitTarget(value: ApprovalWireValue): string | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const normalized = normalizeTargetAlias(parsed.data);
  return normalized || null;
}

function normalizeTargetAlias(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "gateway" || lower === "local") {
    return "gsv";
  }
  return trimmed;
}

function targetMatchesScope(scope: string | undefined, target: string): boolean {
  if (!scope || scope === "*" || scope === "any") {
    return true;
  }
  if (scope === "targets/*" || scope === "devices/*") {
    return target !== "gsv";
  }
  if (target === "targets/*") {
    return scope === "targets/*" || scope === "devices/*";
  }
  return scope === target;
}

function targetScopeSpecificity(scope: string | undefined): number {
  if (!scope || scope === "*" || scope === "any") {
    return 0;
  }
  if (scope === "targets/*" || scope === "devices/*" || scope === "gsv") {
    return 1;
  }
  return 2;
}
