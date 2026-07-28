import type { ConsoleConfigEntry } from "./consoleModels";
import { approvalTargetFromValue } from "../../../domain/agentApproval";
import {
  defaultModelLabelForConfig,
  modelProfileOptionValue,
  modelProfileSummary,
  modelProfilesForConfig,
  modelOptionForValue,
  type ConsoleModelProfile,
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
  fallbackModel: string;
  fallbackModelInherited: boolean;
  fallbackModelLabel: string;
  fallbackModelProfile: string;
  modelLabel: string;
  modelProfile: string;
  permission: AgentApprovalAction;
  reasoning: string;
};

export const APPROVAL_ACTIONS: AgentApprovalAction[] = ["auto", "ask", "deny"];
export const DEFAULT_REASONING_EFFORT = "medium";
export const GLOBAL_APPROVAL_CONFIG_KEY = "config/ai/tools/approval";
const MODEL_PROFILE_INFERENCE_BLOCKING_KEYS = [
  "provider",
  "base_url",
  "provider_style",
  "transport_target",
  "api_key",
] as const;

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
  const explicitModelProfile = modelProfileOverrideForAccount(config, uid);
  const modelOverride = modelOverrideForAccount(config, uid);
  const inferredModelProfile = explicitModelProfile
    ? null
    : modelProfileForRawModelOverride(config, uid, ownerUid, modelOverride);
  const modelProfile = explicitModelProfile || inferredModelProfile?.id || "";
  const model = modelProfile ? modelProfileOptionValue(modelProfile) : modelOverride;
  const modelLabel = explicitModelProfile
    ? modelProfileLabelForAccount(config, uid, ownerUid, explicitModelProfile)
    : inferredModelProfile?.name ?? modelOverride;
  const fallbackModelProfile = fallbackModelProfileOverrideForAccount(config, uid);
  const fallbackModel = fallbackModelProfile ? modelProfileOptionValue(fallbackModelProfile) : "";
  const fallbackModelLabel = fallbackModelProfile
    ? modelProfileLabelForAccount(config, uid, ownerUid, fallbackModelProfile)
    : "";
  const reasoning = reasoningOverrideForAccount(config, uid);
  const approvalOverride = approvalOverrideForAccount(config, uid);
  const approval = approvalOverride || defaultApprovalPolicyForConfig(config, ownerUid);

  return {
    approval,
    approvalInherited: !approvalOverride,
    approvalOverride,
    model,
    fallbackModel,
    fallbackModelInherited: !fallbackModelProfile,
    fallbackModelLabel,
    fallbackModelProfile,
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

export function fallbackModelProfileOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/fallback_model_profile`);
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

export function inheritedFallbackModelLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const ownerFallback = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? fallbackModelLabelOverrideForAccount(config, ownerUid, null)
    : "";
  const systemFallback = fallbackModelLabelForSelector(config, uid, ownerUid, configValue(config, "config/ai/fallback_model_profile"));
  return ownerFallback || systemFallback;
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

function fallbackModelLabelOverrideForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
): string {
  return fallbackModelLabelForSelector(config, uid, ownerUid, fallbackModelProfileOverrideForAccount(config, uid));
}

function fallbackModelLabelForSelector(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  selector: string,
): string {
  return selector.trim() ? modelProfileLabelForAccount(config, uid, ownerUid, selector) : "";
}

function modelProfileLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  selector: string,
): string {
  return modelProfileForSelector(config, uid, ownerUid, selector)?.name || selector;
}

function modelProfileForRawModelOverride(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  rawModel: string,
): ConsoleModelProfile | null {
  const model = rawModel.trim();
  if (!model || hasAccountProviderStackOverride(config, uid)) {
    return null;
  }
  return modelProfileForSelector(config, uid, ownerUid, model, { matchModel: true });
}

function modelProfileForSelector(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  selector: string,
  options: { matchModel?: boolean } = {},
): ConsoleModelProfile | null {
  const accountProfiles = modelProfilesForConfig(config, uid);
  const ownerProfiles = typeof ownerUid === "number" && Number.isFinite(ownerUid) && ownerUid !== uid
    ? modelProfilesForConfig(config, ownerUid)
    : [];
  const normalized = selector.trim().toLowerCase();
  return [...accountProfiles, ...ownerProfiles].find((candidate) =>
    candidate.id.toLowerCase() === normalized ||
    candidate.name.toLowerCase() === normalized ||
    (
      options.matchModel === true &&
      candidate.values["config/ai/model"]?.trim().toLowerCase() === normalized
    )
  ) ?? null;
}

function hasAccountProviderStackOverride(config: readonly ConsoleConfigEntry[], uid: number): boolean {
  return MODEL_PROFILE_INFERENCE_BLOCKING_KEYS.some((key) =>
    config.some((entry) =>
      entry.key === `users/${uid}/ai/${key}` &&
      (entry.redacted || entry.value.trim().length > 0)
    )
  );
}

export function approvalActionFromValue(value: unknown): AgentApprovalAction {
  if (value === "allow") {
    return "auto";
  }
  return APPROVAL_ACTIONS.includes(value as AgentApprovalAction) ? value as AgentApprovalAction : "ask";
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

export function normalizedApprovalPolicy(raw: string): string {
  return serializeApprovalPolicy(parseApprovalPolicy(raw));
}

/** Empty string when the draft equals the inherited policy — writing "" keeps
 *  the account on inheritance instead of materializing an identical override. */
export function approvalOverrideForInheritedPolicy(draftApproval: string, inheritedApproval: string): string {
  const normalizedDraft = normalizedApprovalPolicy(draftApproval);
  const normalizedInherited = normalizedApprovalPolicy(inheritedApproval);
  return normalizedDraft === normalizedInherited ? "" : normalizedDraft;
}

export function approvalForAgentSave(
  draftApproval: string,
  behavior: ConsoleAgentBehavior,
): string {
  return behavior.approvalInherited
    ? approvalOverrideForInheritedPolicy(draftApproval, behavior.approval)
    : normalizedApprovalPolicy(draftApproval);
}

/** Fallback-model Select options for an account: "Inherit" first, then the
 *  account's + owner's model profiles, then a stored-but-unknown selection. */
export function fallbackModelOptionsForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number | null,
  ownerUid: number | null,
  selectedValue: string,
  inheritedLabel: string,
): ConsoleModelOption[] {
  const inherited = inheritedLabel.trim();
  const options: ConsoleModelOption[] = [{
    value: "",
    label: inherited ? `Inherit: ${inherited}` : "Inherit fallback",
    description: inherited ? "Uses the inherited fallback model." : "No fallback override.",
  }];
  const seen = new Set([""]);

  const addProfileOptions = (profileUid: number | null) => {
    if (profileUid === null || !Number.isFinite(profileUid)) {
      return;
    }
    for (const profile of modelProfilesForConfig(config, profileUid)) {
      const value = modelProfileOptionValue(profile.id);
      const key = value.trim().toLowerCase();
      if (!value || seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push({
        value,
        label: profile.name,
        description: modelProfileSummary(profile),
      });
    }
  };

  addProfileOptions(uid);
  if (ownerUid !== uid) {
    addProfileOptions(ownerUid);
  }

  const selected = selectedValue.trim();
  if (selected && !seen.has(selected.toLowerCase())) {
    options.push({
      value: selected,
      label: selected.replace(/^model-profile:/i, ""),
      description: "Stored fallback model is not currently available.",
    });
  }

  return options;
}

function configValue(config: readonly ConsoleConfigEntry[], key: string): string {
  const entry = config.find((candidate) => candidate.key === key && !candidate.redacted);
  return entry?.value.trim() ?? "";
}
