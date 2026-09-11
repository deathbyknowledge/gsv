import {
  approvalOptionValue,
  humanToolCapabilityLabel,
  matchOptionsForRule,
  targetOptionsForRule,
  type AgentToolApprovalRule,
  type AgentToolTarget,
} from "../../../components/ui/agentToolApprovalOptions";
import type { SelectOption } from "../../../components/ui/Select";
import { z } from "zod";

type PermissionOption = { value: string; label: string; group?: string };
const optionLabelSchema = z.union([
  z.string().transform((label) => ({ label, group: undefined })),
  z.object({ label: z.string(), group: z.string().optional() }),
]);

function nativeOption(option: SelectOption): PermissionOption {
  const presentation = optionLabelSchema.parse(option);
  return {
    value: approvalOptionValue(option),
    label: presentation.label,
    group: presentation.group,
  };
}

export function permissionOptionsForRule(rule: AgentToolApprovalRule, targets: readonly AgentToolTarget[]) {
  const tools = matchOptionsForRule(rule.match).map(nativeOption);
  return {
    tools,
    targets: targetOptionsForRule(rule.target, targets).map(nativeOption),
    customToolLabel: tools.some((option) => option.value === rule.match && option.group === "Custom")
      ? `${humanToolCapabilityLabel(rule.match)} · ${rule.match}`
      : null,
  };
}
