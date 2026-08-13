export function approvalTargetFromValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "any") {
    return undefined;
  }
  if (trimmed === "device" || trimmed === "devices/*") {
    return "targets/*";
  }
  if (trimmed === "gateway" || trimmed === "local") {
    return "gsv";
  }
  return trimmed;
}

export type ApprovalPolicyAction = "auto" | "ask" | "deny";

export type ApprovalPolicyRule = {
  match: string;
  target?: string;
  action: ApprovalPolicyAction;
};

export type ApprovalPolicyValue = {
  default: ApprovalPolicyAction;
  rules: ApprovalPolicyRule[];
};

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

function approvalTargetIncludesGsv(target: string | undefined): boolean {
  const normalized = approvalTargetFromValue(target);
  return normalized === undefined || normalized === "gsv";
}
