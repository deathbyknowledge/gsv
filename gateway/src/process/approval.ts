import { NET_FETCH } from "../syscalls/constants";

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
  ],
};

export function parseToolApprovalPolicy(raw: string | null | undefined): ToolApprovalPolicy {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_TOOL_APPROVAL_POLICY;
    }

    const record = parsed as {
      default?: unknown;
      rules?: unknown;
    };

    const defaultAction = normalizeAction(record.default) ?? DEFAULT_TOOL_APPROVAL_POLICY.default;
    const rules = Array.isArray(record.rules)
      ? record.rules
          .map(parseRule)
          .filter((rule): rule is ToolApprovalRule => rule !== null)
      : DEFAULT_TOOL_APPROVAL_POLICY.rules;

    return {
      default: defaultAction,
      rules,
    };
  } catch {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }
}

export function resolveToolApproval(
  policy: ToolApprovalPolicy,
  syscall: string,
  args?: unknown,
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

  return {
    action: policy.default,
    target,
  };
}

export function resolveToolApprovalTarget(syscall: string, args?: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  const target = normalizeExplicitTarget(record?.target);
  if (target) {
    return target;
  }
  if (syscall === "shell.exec" && typeof record?.sessionId === "string" && record.sessionId.trim().length > 0) {
    return "targets/*";
  }
  return "gsv";
}

function parseRule(value: unknown): ToolApprovalRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    match?: unknown;
    target?: unknown;
    action?: unknown;
    when?: unknown;
  };

  const match = typeof record.match === "string" ? record.match.trim() : "";
  const action = normalizeAction(record.action);
  if (!match || !action) {
    return null;
  }

  return {
    match,
    ...normalizeTargetPatch(record.target, record.when),
    action,
  };
}

function normalizeAction(value: unknown): ToolApprovalAction | null {
  return value === "auto" || value === "ask" || value === "deny"
    ? value
    : null;
}

function isWildcardMatch(ruleMatch: string, syscall: string): boolean {
  if (!ruleMatch.endsWith(".*")) {
    return false;
  }
  const domain = ruleMatch.slice(0, -2);
  return syscall === domain || syscall.startsWith(domain + ".");
}

function normalizeTargetPatch(
  targetValue: unknown,
  legacyWhen: unknown,
): Pick<ToolApprovalRule, "target"> {
  const target = normalizeTargetScope(targetValue)
    ?? normalizeTargetScope(legacyWhenTarget(legacyWhen));
  return target ? { target } : {};
}

function normalizeTargetScope(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeTargetAlias(value);
  if (!normalized || normalized === "*" || normalized === "any") {
    return undefined;
  }
  if (normalized === "device" || normalized === "devices/*") {
    return "targets/*";
  }
  return normalized;
}

function legacyWhenTarget(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const target = (value as { target?: unknown }).target;
  return target === "device" ? "targets/*" : target;
}

function normalizeExplicitTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeTargetAlias(value);
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
