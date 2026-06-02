import type {
  AgentRelation,
  ApprovalAction,
  ApprovalPolicy,
  ApprovalRule,
} from "./types";

const APPROVAL_ACTIONS: ApprovalAction[] = ["auto", "ask", "deny"];

export function relationLabel(relation: AgentRelation): string {
  switch (relation) {
    case "self": return "You";
    case "personal-agent": return "Personal agent";
    case "agent": return "Custom agent";
    case "human": return "Human user";
  }
}

export function relationTone(relation: AgentRelation): "accent" | "good" | "neutral" {
  switch (relation) {
    case "personal-agent": return "accent";
    case "agent": return "good";
    default: return "neutral";
  }
}

function asApprovalAction(value: unknown): ApprovalAction {
  return APPROVAL_ACTIONS.includes(value as ApprovalAction) ? value as ApprovalAction : "ask";
}

// Parse a stored approval policy JSON string into a structured policy. Falls
// back to an "ask" default so the editor always has something coherent to show.
export function parseApprovalPolicy(raw: string): ApprovalPolicy {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { default: "ask", rules: [] };
  }
  try {
    const parsed = JSON.parse(trimmed) as { default?: unknown; rules?: unknown };
    const rules: ApprovalRule[] = Array.isArray(parsed.rules)
      ? (parsed.rules as unknown[])
          .map((entry) => {
            const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            const match = typeof record.match === "string" ? record.match.trim() : "";
            return match ? { match, action: asApprovalAction(record.action) } : null;
          })
          .filter((rule): rule is ApprovalRule => rule !== null)
      : [];
    return { default: asApprovalAction(parsed.default), rules };
  } catch {
    return { default: "ask", rules: [] };
  }
}

// Serialize a structured policy back to the stored JSON string. An empty,
// all-default policy serializes to "" so the agent inherits the global default.
export function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  if (policy.default === "ask" && policy.rules.length === 0) {
    return "";
  }
  return JSON.stringify({ default: policy.default, rules: policy.rules });
}

export function approvalSummary(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Inherits default";
  }
  const policy = parseApprovalPolicy(trimmed);
  const ruleCount = policy.rules.length;
  return `${policy.default}${ruleCount > 0 ? ` + ${ruleCount} rule${ruleCount === 1 ? "" : "s"}` : ""}`;
}

export const APPROVAL_ACTION_OPTIONS = APPROVAL_ACTIONS;
