import type {
  ToolApprovalArgCondition,
  ToolApprovalConfig,
  ToolApprovalRuleDecision,
} from "../config";

export type ToolApprovalUserDecision = "approve" | "deny";

export type ParsedToolApprovalDecision = {
  decision: ToolApprovalUserDecision;
  approvalId?: string;
};

export type ToolApprovalEvaluation = {
  decision: ToolApprovalRuleDecision;
  ruleId?: string;
  reason?: string;
};

const APPROVE_TOKENS = new Set([
  "yes",
  "y",
  "approve",
  "approved",
  "ok",
  "okay",
]);
const DENY_TOKENS = new Set([
  "no",
  "n",
  "deny",
  "denied",
  "reject",
  "rejected",
]);

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRuleDecision(
  raw: unknown,
  fallback: ToolApprovalRuleDecision = "allow",
): ToolApprovalRuleDecision {
  if (raw === "allow" || raw === "ask" || raw === "deny") {
    return raw;
  }
  return fallback;
}

function getArgValueByPath(
  args: Record<string, unknown>,
  rawPath: string,
): unknown {
  const path = rawPath.trim();
  if (!path) {
    return undefined;
  }

  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  let current: unknown = args;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function matchesArgCondition(
  args: Record<string, unknown>,
  condition: ToolApprovalArgCondition,
): boolean {
  const value = getArgValueByPath(args, condition.path);

  switch (condition.op) {
    case "equals":
      return value === condition.value;
    case "contains":
      return (
        typeof value === "string" &&
        typeof condition.value === "string" &&
        value.includes(condition.value)
      );
    case "startsWith":
      return (
        typeof value === "string" &&
        typeof condition.value === "string" &&
        value.startsWith(condition.value)
      );
    case "regex":
      if (typeof value !== "string" || typeof condition.value !== "string") {
        return false;
      }
      try {
        return new RegExp(condition.value, condition.flags ?? "").test(value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function matchesToolApprovalPattern(
  toolName: string,
  rawPattern: string,
): boolean {
  const pattern = rawPattern.trim();
  if (!pattern) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (!pattern.includes("*")) {
    return toolName === pattern;
  }

  const regexSource = `^${pattern
    .split("*")
    .map((part) => escapeRegex(part))
    .join(".*")}$`;
  return new RegExp(regexSource).test(toolName);
}

export function evaluateToolApproval(
  toolName: string,
  args: Record<string, unknown>,
  config: ToolApprovalConfig | undefined,
): ToolApprovalEvaluation {
  const defaultDecision = normalizeRuleDecision(config?.defaultDecision);
  const rules = Array.isArray(config?.rules) ? config.rules : [];

  for (const rule of rules) {
    if (!rule || typeof rule.tool !== "string") {
      continue;
    }
    if (!matchesToolApprovalPattern(toolName, rule.tool)) {
      continue;
    }
    const when = Array.isArray(rule.when) ? rule.when : [];
    if (!when.every((condition) => matchesArgCondition(args, condition))) {
      continue;
    }

    return {
      decision: normalizeRuleDecision(rule.decision, defaultDecision),
      ruleId: typeof rule.id === "string" ? rule.id : undefined,
      reason: typeof rule.reason === "string" ? rule.reason : undefined,
    };
  }

  return { decision: defaultDecision };
}

export function parseToolApprovalDecision(
  raw: string,
): ParsedToolApprovalDecision | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutEnvelopePrefix = trimmed.replace(/^\[[^\]]*\]\s*/, "");
  const tokens = withoutEnvelopePrefix.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const head = tokens[0];
  if (APPROVE_TOKENS.has(head)) {
    return {
      decision: "approve",
      approvalId: tokens[1],
    };
  }
  if (DENY_TOKENS.has(head)) {
    return {
      decision: "deny",
      approvalId: tokens[1],
    };
  }

  return null;
}
