import type { ConsoleConfigEntry } from "./consoleModels";

export type AgentApprovalAction = "auto" | "ask" | "deny";

export type ApprovalRule = {
  match: string;
  action: AgentApprovalAction;
};

export type ApprovalPolicy = {
  default: AgentApprovalAction;
  rules: ApprovalRule[];
};

export type ConsoleAgentBehavior = {
  approval: string;
  model: string;
  permission: AgentApprovalAction;
};

export const APPROVAL_ACTIONS: AgentApprovalAction[] = ["auto", "ask", "deny"];

export function behaviorForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
): ConsoleAgentBehavior {
  const model = configValue(config, `users/${uid}/ai/model`);
  const approval = configValue(config, `users/${uid}/ai/tools/approval`);

  return {
    approval,
    model,
    permission: parseApprovalPolicy(approval).default,
  };
}

export function modelLabelsForAccount(labels: readonly string[], model: string): string[] {
  const trimmedModel = model.trim();
  if (!trimmedModel || labels.some((label) => label.trim() === trimmedModel)) {
    return [...labels];
  }
  const [defaultLabel, ...rest] = labels;
  return [defaultLabel ?? "GATEWAY DEFAULT", trimmedModel, ...rest];
}

export function approvalActionFromValue(value: unknown): AgentApprovalAction {
  if (value === "allow") {
    return "auto";
  }
  return APPROVAL_ACTIONS.includes(value as AgentApprovalAction) ? value as AgentApprovalAction : "ask";
}

export function parseApprovalPolicy(raw: string): ApprovalPolicy {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { default: "ask", rules: [] };
  }
  try {
    const parsed = JSON.parse(trimmed) as { default?: unknown; rules?: unknown };
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules
          .map((entry) => {
            const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            const match = typeof record.match === "string" ? record.match.trim() : "";
            return match ? { match, action: approvalActionFromValue(record.action) } : null;
          })
          .filter((rule): rule is ApprovalRule => rule !== null)
      : [];
    return { default: approvalActionFromValue(parsed.default), rules };
  } catch {
    return { default: "ask", rules: [] };
  }
}

export function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  if (policy.default === "ask" && policy.rules.length === 0) {
    return "";
  }
  return JSON.stringify({ default: policy.default, rules: policy.rules });
}

function configValue(config: readonly ConsoleConfigEntry[], key: string): string {
  const entry = config.find((candidate) => candidate.key === key && !candidate.redacted);
  return entry?.value.trim() ?? "";
}
