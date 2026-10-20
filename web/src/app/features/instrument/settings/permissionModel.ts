import {
  humanToolCapabilityLabel,
  isCustomMatch,
  matchOptionsForRule,
  targetOptionsForRule,
  type AgentToolApprovalRule,
  type AgentToolTarget,
} from "../../../components/ui/agentToolApprovalOptions";

export function permissionOptionsForRule(rule: AgentToolApprovalRule, targets: readonly AgentToolTarget[]) {
  return {
    tools: matchOptionsForRule(rule.match),
    targets: targetOptionsForRule(rule.target, targets),
    customToolLabel: isCustomMatch(rule.match)
      ? `${humanToolCapabilityLabel(rule.match)} · ${rule.match}`
      : null,
  };
}
