import type { ConsoleConfigEntry } from "./consoleModels";
import { z } from "zod";
import {
  approvalTargetFromValue,
  protectManagedMailApproval,
  type ApprovalPolicyAction,
  type ApprovalPolicyRule,
  type ApprovalPolicyValue,
} from "../../../domain/agentApproval";
import {
  defaultModelLabelForConfig,
  modelEntryOptionValue,
  modelProfilesForConfig,
  modelOptionForValue,
  type ConsoleModelOption,
} from "./consoleAi";

export type AgentApprovalAction = ApprovalPolicyAction;

export type ApprovalRule = ApprovalPolicyRule;

export type ApprovalPolicy = ApprovalPolicyValue;

export type ConsoleAgentBehavior = {
  approval: string;
  approvalInherited: boolean;
  approvalOverride: string;
  model: string;
  modelLabel: string;
  modelId: string;
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
    { match: "mail.send", action: "ask" },
  ],
};
const ownerUidSchema = z.number().finite().nullable().catch(null);
const approvalActionSchema = z.enum(["auto", "ask", "deny"]);
const approvalValueSchema = z.unknown();
type ApprovalWireValue = z.input<typeof approvalValueSchema>;
const legacyApprovalTargetSchema = z.object({ target: z.string().optional() });
const approvalRuleWireSchema = z.object({
  match: z.string().catch(""),
  target: z.string().optional().catch(undefined),
  when: approvalValueSchema.optional(),
  action: approvalValueSchema,
});
const approvalPolicyWireSchema = z.object({
  default: approvalValueSchema.optional(),
  rules: z.array(approvalValueSchema).optional(),
});

export function behaviorForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): ConsoleAgentBehavior {
  const modelId = preferredModelOverrideForAccount(config, uid);
  const model = modelId ? modelEntryOptionValue(modelId) : "";
  const modelLabel = modelId
    ? modelProfileLabelForAccount(config, uid, ownerUid, modelId)
    : "";
  const reasoning = reasoningOverrideForAccount(config, uid);
  const approvalOverride = approvalOverrideForAccount(config, uid);
  const approval = approvalOverride || defaultApprovalPolicyForConfig(config, ownerUid);

  return {
    approval,
    approvalInherited: !approvalOverride,
    approvalOverride,
    model,
    modelLabel,
    modelId,
    permission: parseApprovalPolicy(approval).default,
    reasoning,
  };
}

export function defaultApprovalPolicyForConfig(
  config: readonly ConsoleConfigEntry[],
  ownerUid?: number | null,
): string {
  const parsedOwnerUid = ownerUidSchema.parse(ownerUid);
  const ownerApproval = parsedOwnerUid !== null
    ? approvalOverrideForAccount(config, parsedOwnerUid)
    : "";
  const configured = configValue(config, GLOBAL_APPROVAL_CONFIG_KEY);
  return ownerApproval || configured || serializeApprovalPolicy(DEFAULT_APPROVAL_POLICY);
}

export function approvalOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/tools/approval`);
}

export function preferredModelOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/preferred_model`);
}

export function inheritedModelLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const parsedOwnerUid = ownerUidSchema.parse(ownerUid);
  const modelOwnerUid = parsedOwnerUid ?? uid;
  return modelProfilesForConfig(config, modelOwnerUid)[0]?.name
    || defaultModelLabelForConfig(config, modelOwnerUid);
}

export function reasoningOverrideForAccount(config: readonly ConsoleConfigEntry[], uid: number): string {
  return configValue(config, `users/${uid}/ai/reasoning`);
}

export function inheritedReasoningForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid?: number | null,
): string {
  const parsedOwnerUid = ownerUidSchema.parse(ownerUid);
  const ownerReasoning = parsedOwnerUid !== null && parsedOwnerUid !== uid
    ? reasoningOverrideForAccount(config, parsedOwnerUid)
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
  return [primaryLabel ?? "NOT CONFIGURED", trimmedModel, ...rest];
}

export function modelOptionsForAccount(
  options: readonly ConsoleModelOption[],
  model: string,
  inheritedLabel?: string,
): ConsoleModelOption[] {
  const baseOptions = [inheritedModelOption(inheritedLabel?.trim() || "NOT CONFIGURED"), ...options];
  const trimmedModel = model.trim();
  if (!trimmedModel || baseOptions.some((option) => option.value.trim() === trimmedModel)) {
    return baseOptions;
  }
  return [...baseOptions, modelOptionForValue(trimmedModel)];
}

function inheritedModelOption(label: string): ConsoleModelOption {
  return {
    value: "",
    label: `Inherit: ${label}`,
  };
}

function modelProfileLabelForAccount(
  config: readonly ConsoleConfigEntry[],
  uid: number,
  ownerUid: number | null | undefined,
  selector: string,
): string {
  const parsedOwnerUid = ownerUidSchema.parse(ownerUid);
  const modelOwnerUid = parsedOwnerUid ?? uid;
  const normalized = selector.trim().toLowerCase();
  return modelProfilesForConfig(config, modelOwnerUid)
    .find((candidate) => candidate.id.toLowerCase() === normalized)?.name
    ?? selector;
}

export function approvalActionFromValue(value: ApprovalWireValue): AgentApprovalAction {
  if (value === "allow") {
    return "auto";
  }
  const parsed = approvalActionSchema.safeParse(value);
  return parsed.success ? parsed.data : "ask";
}

function legacyApprovalTarget(value: ApprovalWireValue): string | undefined {
  const parsed = legacyApprovalTargetSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return approvalTargetFromValue(parsed.data.target === "device" ? "targets/*" : parsed.data.target);
}

export function parseApprovalPolicy(raw: string): ApprovalPolicy {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_APPROVAL_POLICY;
  }
  try {
    const parsed = approvalPolicyWireSchema.parse(JSON.parse(trimmed));
    const rules = parsed.rules
      ? parsed.rules
          .map((entry) => {
            const record = approvalRuleWireSchema.safeParse(entry);
            if (!record.success) return null;
            const match = record.data.match.trim();
            const target = approvalTargetFromValue(record.data.target) ?? legacyApprovalTarget(record.data.when);
            return match
              ? {
                  match,
                  ...(target ? { target } : undefined),
                  action: approvalActionFromValue(record.data.action),
                }
              : null;
          })
          .filter((rule): rule is ApprovalRule => rule !== null)
      : [];
    return protectManagedMailApproval({
      default: parsed.default === undefined ? DEFAULT_APPROVAL_POLICY.default : approvalActionFromValue(parsed.default),
      rules: parsed.rules === undefined ? DEFAULT_APPROVAL_POLICY.rules : rules,
    });
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

function configValue(config: readonly ConsoleConfigEntry[], key: string): string {
  const entry = config.find((candidate) => candidate.key === key && !candidate.redacted);
  return entry?.value.trim() ?? "";
}
