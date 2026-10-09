import {
  normalizeToolApprovalTarget,
  type ToolApprovalPolicy as ApprovalPolicyValue,
  type ToolApprovalTarget,
} from "@humansandmachines/gsv/protocol";

export { normalizeToolApprovalTarget as approvalTargetFromValue } from "@humansandmachines/gsv/protocol";
export type {
  ToolApprovalAction as ApprovalPolicyAction,
  ToolApprovalRule as ApprovalPolicyRule,
  ToolApprovalPolicy as ApprovalPolicyValue,
} from "@humansandmachines/gsv/protocol";

export function protectManagedMailApproval(policy: ApprovalPolicyValue): ApprovalPolicyValue {
  if (
    policy.default !== "auto"
    || policy.rules.some((rule) =>
      approvalMatchIncludes(rule.match, "mail.send")
      && approvalTargetIncludesGsv(rule.target)
    )
  ) {
    return policy;
  }
  return {
    ...policy,
    rules: [...policy.rules, { match: "mail.send", action: "ask" }],
  };
}

function approvalMatchIncludes(match: string, syscall: string): boolean {
  const normalized = match.trim();
  if (normalized === syscall) {
    return true;
  }
  if (!normalized.endsWith(".*")) {
    return false;
  }
  const domain = normalized.slice(0, -2);
  return syscall === domain || syscall.startsWith(`${domain}.`);
}

function approvalTargetIncludesGsv(target: ToolApprovalTarget | undefined): boolean {
  const normalized = normalizeToolApprovalTarget(target);
  return normalized === undefined || normalized === "gsv";
}
