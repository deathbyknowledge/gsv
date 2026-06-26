import type { ConsoleConfigEntry } from "./consoleModels";
import { defaultModelLabelForConfig } from "./consoleAi";

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
  reasoning: string;
};

export const APPROVAL_ACTIONS: AgentApprovalAction[] = ["auto", "ask", "deny"];
export const DEFAULT_REASONING_EFFORT = "medium";

export function behaviorForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
): ConsoleAgentBehavior {
  const model = modelOverrideForAccount(config, uid);
  const reasoning = reasoningOverrideForAccount(config, uid);
  const approval = configValue(config, `users/${uid}/ai/tools/approval`);

  return {
    approval,
    model,
    permission: parseApprovalPolicy(approval).default,
    reasoning,
  };
}

export function modelOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/model`);
}

export function inheritedModelLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const ownerModel = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? modelOverrideForAccount(config, ownerUid)
    : "";
  return ownerModel || defaultModelLabelForConfig(config);
}

export function reasoningOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/reasoning`);
}

export function inheritedReasoningForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const ownerReasoning = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? reasoningOverrideForAccount(config, ownerUid)
    : "";
  return ownerReasoning || configValue(config, "config/ai/reasoning") || DEFAULT_REASONING_EFFORT;
}

export function modelLabelsForAccount(
  labels: readonly string[],
  model: string,
  inheritedLabel?: string,
): string[] {
  const defaultLabel = inheritedLabel?.trim();
  const baseLabels = defaultLabel
    ? [
        defaultLabel,
        ...labels.filter((label) => label.trim().toLowerCase() !== defaultLabel.toLowerCase()),
      ]
    : [...labels];
  const trimmedModel = model.trim();
  if (!trimmedModel || baseLabels.some((label) => label.trim() === trimmedModel)) {
    return baseLabels;
  }
  const [primaryLabel, ...rest] = baseLabels;
  return [primaryLabel ?? "GATEWAY DEFAULT", trimmedModel, ...rest];
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
