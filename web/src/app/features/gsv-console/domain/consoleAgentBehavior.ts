import type { ConsoleConfigEntry } from "./consoleModels";
import {
  defaultModelLabelForConfig,
  modelProfileOptionValue,
  modelProfilesForConfig,
  modelOptionForValue,
  type ConsoleModelOption,
} from "./consoleAi";

export type AgentApprovalAction = "auto" | "ask" | "deny";

export type ApprovalRule = {
  match: string;
  target?: string;
  action: AgentApprovalAction;
};

export type ApprovalPolicy = {
  default: AgentApprovalAction;
  rules: ApprovalRule[];
};

export type ConsoleAgentBehavior = {
  approval: string;
  approvalInherited: boolean;
  approvalOverride: string;
  model: string;
  modelLabel: string;
  modelProfile: string;
  permission: AgentApprovalAction;
  reasoning: string;
};

export const APPROVAL_ACTIONS: AgentApprovalAction[] = ["auto", "ask", "deny"];
export const DEFAULT_REASONING_EFFORT = "medium";
export const GLOBAL_APPROVAL_CONFIG_KEY = "config/ai/tools/approval";

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", action: "ask" },
    { match: "net.fetch", action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
  ],
};

export function behaviorForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): ConsoleAgentBehavior {
  const modelProfile = modelProfileOverrideForAccount(config, uid);
  const modelOverride = modelOverrideForAccount(config, uid);
  const model = modelProfile ? modelProfileOptionValue(modelProfile) : modelOverride;
  const modelLabel = modelProfile ? modelProfileLabelForAccount(config, uid, ownerUid, modelProfile) : modelOverride;
  const reasoning = reasoningOverrideForAccount(config, uid);
  const approvalOverride = approvalOverrideForAccount(config, uid);
  const approval = approvalOverride || defaultApprovalPolicyForConfig(config, ownerUid);

  return {
    approval,
    approvalInherited: !approvalOverride,
    approvalOverride,
    model,
    modelLabel,
    modelProfile,
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

export function modelProfileOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/model_profile`);
}

export function inheritedModelLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const ownerModel = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? modelLabelOverrideForAccount(config, ownerUid)
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

function modelLabelOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  const profile = modelProfileOverrideForAccount(config, uid);
  if (profile) {
    return modelProfileLabelForAccount(config, uid, null, profile);
  }
  return modelOverrideForAccount(config, uid);
}

function modelProfileLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  selector: string,
): string {
  const accountProfiles = modelProfilesForConfig(config, uid);
  const ownerProfiles = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? modelProfilesForConfig(config, ownerUid)
    : [];
  return profileLabelForSelector(accountProfiles, ownerProfiles, selector) || selector;
}

function profileLabelForSelector(
  primaryProfiles: ReturnType<typeof modelProfilesForConfig>,
  fallbackProfiles: ReturnType<typeof modelProfilesForConfig>,
  selector: string,
): string {
  const normalized = selector.trim().toLowerCase();
  const profile = [...primaryProfiles, ...fallbackProfiles].find((candidate) =>
    candidate.id.toLowerCase() === normalized ||
    candidate.name.toLowerCase() === normalized
  );
  return profile?.name ?? "";
}

export function approvalActionFromValue(value: unknown): AgentApprovalAction {
  if (value === "allow") {
    return "auto";
  }
  return APPROVAL_ACTIONS.includes(value as AgentApprovalAction) ? value as AgentApprovalAction : "ask";
}

function approvalTargetFromValue(value: unknown): string | undefined {
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

function legacyApprovalTarget(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const target = (value as { target?: unknown }).target;
  return approvalTargetFromValue(target === "device" ? "targets/*" : target);
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
            const target = approvalTargetFromValue(record.target) ?? legacyApprovalTarget(record.when);
            return match
              ? {
                  match,
                  ...(target ? { target } : {}),
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

export function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  return JSON.stringify({ default: policy.default, rules: policy.rules });
}

function configValue(config: readonly ConsoleConfigEntry[], key: string): string {
  const entry = config.find((candidate) => candidate.key === key && !candidate.redacted);
  return entry?.value.trim() ?? "";
}
