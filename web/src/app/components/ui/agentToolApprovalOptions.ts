import {
  isToolApprovalTargetSelector, toolApprovalTargetSchema, type ToolApprovalTarget,
} from "@humansandmachines/gsv/protocol";
import type {
  ApprovalPolicyAction,
  ApprovalPolicyRule,
  ApprovalPolicyValue,
} from "../../domain/agentApproval";
import { t, type TextKey } from "../../i18n/locale";

/** Shared model + option builders for tool-approval editing. Extracted from
 *  AgentToolsPanel so other approval editors (e.g. the CREW overrides drawer)
 *  can reuse the same capability families, machine scopes and labels. */

export type AgentToolApprovalAction = ApprovalPolicyAction;

export type AgentToolApprovalRule = ApprovalPolicyRule;

export type AgentToolApprovalPolicy = ApprovalPolicyValue;

export type AgentToolTarget = {
  id: string;
  label?: string;
  online?: boolean;
  implements?: readonly string[];
};

/** A choice in a rule's select: the stored value and the text shown for it. */
export type ApprovalOption = { value: string; label: string };

export const APPROVAL_ACTIONS: AgentToolApprovalAction[] = ["auto", "ask", "deny"];

const ACTION_LABELS = {
  auto: "approval.action.allow",
  ask: "approval.action.ask",
  deny: "approval.action.block",
} satisfies Record<AgentToolApprovalAction, TextKey>;

/** The capabilities a rule can name, by family, with the message that labels each. */
const CAPABILITY_LABELS = new Map(Object.entries({
  // Filesystem
  "fs.*": "approval.match.fsAll",
  "fs.read": "approval.match.fsRead",
  "fs.write": "approval.match.fsWrite",
  "fs.edit": "approval.match.fsEdit",
  "fs.search": "approval.match.fsSearch",
  "fs.copy": "approval.match.fsCopy",
  "fs.delete": "approval.match.fsDelete",
  // Shell
  "shell.*": "approval.match.shellAll",
  "shell.exec": "approval.match.shellExec",
  // Network
  "net.*": "approval.match.netAll",
  "net.fetch": "approval.match.netFetch",
  // Mail
  "mail.send": "approval.match.mailSend",
  // Web search
  "web.search": "approval.match.webSearch",
  // Repositories
  "repo.*": "approval.match.repoAll",
  "repo.list": "approval.match.repoList",
  "repo.read": "approval.match.repoRead",
  "repo.search": "approval.match.repoSearch",
  "repo.compare": "approval.match.repoCompare",
  "repo.diff": "approval.match.repoDiff",
  "repo.apply": "approval.match.repoApply",
  "repo.import": "approval.match.repoImport",
  "repo.delete": "approval.match.repoDelete",
  "repo.visibility.set": "approval.match.repoVisibility",
  // Processes
  "proc.*": "approval.match.procAll",
  "proc.spawn": "approval.match.procSpawn",
  "proc.send": "approval.match.procSend",
  "proc.history": "approval.match.procHistory",
  "proc.abort": "approval.match.procAbort",
  "proc.reset": "approval.match.procReset",
  "proc.kill": "approval.match.procKill",
  // MCP
  "sys.mcp.*": "approval.match.mcpAll",
  "sys.mcp.call": "approval.match.mcpCall",
  "sys.mcp.list": "approval.match.mcpList",
  "sys.mcp.add": "approval.match.mcpAdd",
  "sys.mcp.refresh": "approval.match.mcpRefresh",
  "sys.mcp.remove": "approval.match.mcpRemove",
  // System config
  "sys.config.*": "approval.match.configAll",
  "sys.config.get": "approval.match.configGet",
  "sys.config.set": "approval.match.configSet",
} satisfies Record<string, TextKey>));

export function targetOptionValue(target: ToolApprovalTarget | undefined): string {
  return target === undefined ? "" : JSON.stringify(target);
}

export function targetFromOptionValue(value: string): ToolApprovalTarget | undefined {
  return value ? toolApprovalTargetSchema.parse(JSON.parse(value)) : undefined;
}

const BUILTIN_TARGETS = [
  { value: "", label: "approval.target.allMachines" },
  { value: targetOptionValue("gsv"), label: "approval.target.shipComputer" },
  { value: targetOptionValue({ route: "instance", platform: "browser" }), label: "approval.target.cloudBrowsers" },
  { value: targetOptionValue({ route: "instance", platform: "linux" }), label: "approval.target.cloudComputers" },
] satisfies { value: string; label: TextKey }[];
const LEGACY_EXTERNAL_TARGET = { value: targetOptionValue("targets/*"), label: "approval.target.allMachines" } satisfies { value: string; label: TextKey };

export function humanToolCapabilityLabel(capability: string): string {
  const normalized = capability.trim();
  if (!normalized) {
    return t("approval.capability");
  }
  const known = CAPABILITY_LABELS.get(normalized);
  if (known) {
    return t(known);
  }
  return normalized
    .replace(/\.\*/g, "")
    .split(/[._:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function actionLabel(action: AgentToolApprovalAction): string {
  return t(ACTION_LABELS[action]);
}

export function defaultOverrideAction(defaultAction: AgentToolApprovalAction): AgentToolApprovalAction {
  if (defaultAction === "auto") return "ask";
  if (defaultAction === "deny") return "ask";
  return "deny";
}

/** Whether a rule names a capability this editor does not list; it stays selectable as a custom match. */
export function isCustomMatch(match: string): boolean {
  return match !== "" && !CAPABILITY_LABELS.has(match);
}

export function matchOptionsForRule(match: string): ApprovalOption[] {
  const options = [...CAPABILITY_LABELS].map(([value, label]) => ({ value, label: t(label) }));
  return isCustomMatch(match) ? [...options, { value: match, label: t("approval.customMatch") }] : options;
}

export function matchIndexForRule(match: string): number {
  const index = matchOptionsForRule(match).findIndex((option) => option.value === match);
  return index >= 0 ? index : 0;
}

function translated(option: { value: string; label: TextKey }): ApprovalOption {
  return { value: option.value, label: t(option.label) };
}

export function targetOptionsForRule(target: ToolApprovalTarget | undefined, targets: readonly AgentToolTarget[]): ApprovalOption[] {
  const builtinOptions = BUILTIN_TARGETS.map(translated);
  const targetOptions = targets
    .filter((candidate) => candidate.id.trim().length > 0)
    .map((candidate) => ({
      value: targetOptionValue(candidate.id),
      label: candidate.label?.trim() || candidate.id,
    }));
  const knownValues = new Set([...builtinOptions, ...targetOptions].map((option) => option.value));
  const baseOptions = target === "targets/*"
    ? [...builtinOptions, translated(LEGACY_EXTERNAL_TARGET), ...targetOptions]
    : [...builtinOptions, ...targetOptions];
  if (!target || knownValues.has(targetOptionValue(target)) || target === "targets/*") {
    return baseOptions;
  }
  return [
    ...baseOptions,
    {
      value: targetOptionValue(target),
      label: targetLabelForRule(target, targets),
    },
  ];
}

export function targetIndexForRule(target: ToolApprovalTarget | undefined, targets: readonly AgentToolTarget[]): number {
  const value = targetOptionValue(target);
  const index = targetOptionsForRule(target, targets).findIndex((option) => option.value === value);
  return index >= 0 ? index : 0;
}

/** Human label for a rule's machine scope (mirrors the target Select options). */
export function targetLabelForRule(target: ToolApprovalTarget | undefined, targets: readonly AgentToolTarget[]): string {
  if (!target || target === "targets/*") {
    return t("approval.target.allMachines");
  }
  if (target === "gsv") {
    return t("approval.target.shipComputer");
  }
  if (isToolApprovalTargetSelector(target)) {
    if (target.route === "instance" && target.platform === "browser") return t("approval.target.cloudBrowsers");
    if (target.route === "instance" && target.platform === "linux") return t("approval.target.cloudComputers");
    return target.platform ? `${target.route} · ${target.platform}` : target.route;
  }
  const known = targets.find((candidate) => candidate.id === target);
  return known?.label?.trim() || target;
}

export function actionIndex(action: AgentToolApprovalAction): number {
  return Math.max(0, APPROVAL_ACTIONS.indexOf(action));
}
