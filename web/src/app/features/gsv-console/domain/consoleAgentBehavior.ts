import type { ConsoleConfigEntry } from "./consoleModels";
import {
  defaultModelLabelForConfig,
  modelOptionForValue,
  type ConsoleModelOption,
} from "./consoleAi";

export type AgentApprovalAction = "auto" | "ask" | "deny";

export type ApprovalRule = {
  match: string;
  when?: ApprovalRuleCondition;
  action: AgentApprovalAction;
};

export type ApprovalPolicy = {
  default: AgentApprovalAction;
  rules: ApprovalRule[];
};

export type ApprovalRuleCondition = {
  anyTag?: string[];
  allTags?: string[];
  argEquals?: Record<string, string | number | boolean>;
  argPrefix?: Record<string, string>;
  target?: "gsv" | "device";
};

export type ConsoleAgentBehavior = {
  approval: string;
  approvalInherited: boolean;
  approvalOverride: string;
  model: string;
  permission: AgentApprovalAction;
  reasoning: string;
};

export const APPROVAL_ACTIONS: AgentApprovalAction[] = ["auto", "ask", "deny"];
export const DEFAULT_REASONING_EFFORT = "medium";
export const GLOBAL_APPROVAL_CONFIG_KEY = "config/ai/tools/approval";

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", when: { anyTag: ["destructive", "privileged", "network", "mutating", "unclassified"] }, action: "ask" },
    { match: "net.fetch", when: { anyTag: ["network", "mutating"] }, action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
  ],
};

export function behaviorForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): ConsoleAgentBehavior {
  const model = modelOverrideForAccount(config, uid);
  const reasoning = reasoningOverrideForAccount(config, uid);
  const approvalOverride = approvalOverrideForAccount(config, uid);
  const approval = approvalOverride || defaultApprovalPolicyForConfig(config, ownerUid);

  return {
    approval,
    approvalInherited: !approvalOverride,
    approvalOverride,
    model,
    permission: parseApprovalPolicy(approval).default,
    reasoning,
  };
}

export function defaultApprovalPolicyForConfig(
  config: readonly ConsoleConfigEntry[],
  ownerUid?: number | null,
): string {
  const ownerApproval = typeof ownerUid === "number" && Number.isFinite(ownerUid)
    ? approvalOverrideForAccount(config, ownerUid)
    : "";
  const configured = configValue(config, GLOBAL_APPROVAL_CONFIG_KEY);
  return ownerApproval || configured || serializeApprovalPolicy(DEFAULT_APPROVAL_POLICY);
}

export function approvalOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/tools/approval`);
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

export function modelOptionsForAccount(
  options: readonly ConsoleModelOption[],
  model: string,
  inheritedLabel?: string,
): ConsoleModelOption[] {
  const defaultValue = inheritedLabel?.trim();
  const baseOptions = defaultValue
    ? [
        inheritedModelOption(defaultValue, options.find((option) => option.value.trim().toLowerCase() === defaultValue.toLowerCase())),
        ...options.filter((option) => option.value.trim().toLowerCase() !== defaultValue.toLowerCase()),
      ]
    : [...options];
  const trimmedModel = model.trim();
  if (!trimmedModel || baseOptions.some((option) => option.value.trim() === trimmedModel)) {
    return baseOptions;
  }
  const [primaryOption, ...rest] = baseOptions;
  return [
    primaryOption ?? inheritedModelOption("GATEWAY DEFAULT"),
    modelOptionForValue(trimmedModel),
    ...rest,
  ];
}

function inheritedModelOption(value: string, option?: ConsoleModelOption): ConsoleModelOption {
  const base = option ?? modelOptionForValue(value);
  return {
    ...base,
    label: `Inherit: ${base.label}`,
  };
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
    return DEFAULT_APPROVAL_POLICY;
  }
  try {
    const parsed = JSON.parse(trimmed) as { default?: unknown; rules?: unknown };
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules
          .map((entry) => {
            const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            const match = typeof record.match === "string" ? record.match.trim() : "";
            const when = normalizeApprovalRuleCondition(record.when);
            return match
              ? {
                  match,
                  ...(when ? { when } : {}),
                  action: approvalActionFromValue(record.action),
                }
              : null;
          })
          .filter((rule): rule is ApprovalRule => rule !== null)
      : [];
    return {
      default: parsed.default === undefined ? DEFAULT_APPROVAL_POLICY.default : approvalActionFromValue(parsed.default),
      rules: Array.isArray(parsed.rules) ? rules : DEFAULT_APPROVAL_POLICY.rules,
    };
  } catch {
    return DEFAULT_APPROVAL_POLICY;
  }
}

function normalizeApprovalRuleCondition(value: unknown): ApprovalRuleCondition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const anyTag = normalizeStringArray(record.anyTag);
  const allTags = normalizeStringArray(record.allTags);
  const argEquals = normalizePrimitiveRecord(record.argEquals);
  const argPrefix = normalizeStringRecord(record.argPrefix);
  const target = record.target === "gsv" || record.target === "device" ? record.target : undefined;
  if (!anyTag && !allTags && !argEquals && !argPrefix && !target) {
    return undefined;
  }
  return {
    ...(anyTag ? { anyTag } : {}),
    ...(allTags ? { allTags } : {}),
    ...(argEquals ? { argEquals } : {}),
    ...(argPrefix ? { argPrefix } : {}),
    ...(target ? { target } : {}),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizePrimitiveRecord(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([, entry]) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string" && entry.trim().length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  return JSON.stringify({ default: policy.default, rules: policy.rules });
}

function configValue(config: readonly ConsoleConfigEntry[], key: string): string {
  const entry = config.find((candidate) => candidate.key === key && !candidate.redacted);
  return entry?.value.trim() ?? "";
}
