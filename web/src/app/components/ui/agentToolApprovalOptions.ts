import {
  isToolApprovalTargetSelector, normalizeToolApprovalTarget, toolApprovalTargetSchema, type ToolApprovalTarget,
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
const RULE_MATCH_LABELS = new Map(Object.entries({
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
  // The open network
  "atproto.write": "approval.match.atprotoWrite",
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

/** Other capabilities an account can hold, labelled for display but not offered as rule choices. */
const GRANT_LABELS = new Map(Object.entries({
  // Mail
  "mail.status": "approval.match.mailStatus",
  "mail.list": "approval.match.mailList",
  "mail.search": "approval.match.mailSearch",
  "mail.read": "approval.match.mailRead",
  // Repositories
  "repo.create": "approval.match.repoCreate",
  "repo.log": "approval.match.repoLog",
  "repo.refs": "approval.match.repoRefs",
  // AI
  "ai.models": "approval.match.aiModels",
  "ai.text.generate": "approval.match.aiTextGenerate",
  "ai.image.generate": "approval.match.aiImageGenerate",
  "ai.image.read": "approval.match.aiImageRead",
  "ai.transcription.create": "approval.match.aiTranscriptionCreate",
  "ai.speech.create": "approval.match.aiSpeechCreate",
  // Messengers
  "adapter.connect": "approval.match.adapterConnect",
  "adapter.disconnect": "approval.match.adapterDisconnect",
  "adapter.list": "approval.match.adapterList",
  "adapter.route": "approval.match.adapterRoute",
  "adapter.send": "approval.match.adapterSend",
  "adapter.status": "approval.match.adapterStatus",
  "sys.link.list": "approval.match.sysLinkList",
  // Connections
  "sys.target.get": "approval.match.sysTargetGet",
  "sys.target.list": "approval.match.sysTargetList",
  "sys.target.update": "approval.match.sysTargetUpdate",
  "sys.target.delete": "approval.match.sysTargetDelete",
  "sys.pair.create": "approval.match.sysPairCreate",
  "sys.pair.list": "approval.match.sysPairList",
  "sys.pair.cancel": "approval.match.sysPairCancel",
  // Service sign-ins
  "sys.oauth.start": "approval.match.sysOauthStart",
  "sys.oauth.device.start": "approval.match.sysOauthDeviceStart",
  "sys.oauth.device.poll": "approval.match.sysOauthDevicePoll",
  "sys.oauth.list": "approval.match.sysOauthList",
  "sys.oauth.forget": "approval.match.sysOauthForget",
  // Access keys
  "sys.token.create": "approval.match.sysTokenCreate",
  "sys.token.list": "approval.match.sysTokenList",
  "sys.token.revoke": "approval.match.sysTokenRevoke",
  // Accounts and system
  "account.create": "approval.match.accountCreate",
  "account.list": "approval.match.accountList",
  "sys.ledger.list": "approval.match.sysLedgerList",
  "sys.feedback": "approval.match.sysFeedback",
  "sys.bootstrap": "approval.match.sysBootstrap",
  "contact.list": "approval.match.contactList",
  "contact.send": "approval.match.contactSend",
  "contact.preferences.update": "approval.match.contactPreferencesUpdate",
  "conversation.history": "approval.match.conversationHistory",
  "conversation.inbox": "approval.match.conversationInbox",
  "conversation.send": "approval.match.conversationSend",
  "conversation.view.update": "approval.match.conversationViewUpdate",
  "profile.get": "approval.match.profileGet",
  "profile.update": "approval.match.profileUpdate",
  "profile.publish": "approval.match.profilePublish",
  "profile.unpublish": "approval.match.profileUnpublish",
  "profile.resolve": "approval.match.profileResolve",
  "approach.create": "approval.match.approachCreate",
  "approach.list": "approval.match.approachList",
  "adapter.pair.info": "approval.match.adapterPairInfo",
  "adapter.pair.inspect": "approval.match.adapterPairInspect",
  "adapter.pair.confirm": "approval.match.adapterPairConfirm",
  "adapter.pair.disconnect": "approval.match.adapterPairDisconnect",
  "proc.list": "approval.match.procList",
  "r12y.list": "approval.match.r12yList",
  "r12y.get": "approval.match.r12yGet",
  "r12y.update": "approval.match.r12yUpdate",
  "r12y.source.list": "approval.match.r12ySourceList",
  "sched.list": "approval.match.schedList",
  "sched.add": "approval.match.schedAdd",
  "sched.update": "approval.match.schedUpdate",
} satisfies Record<string, TextKey>));

/** What each family of capabilities is about, keyed by the id prefix it covers. A wildcard grant such as
 *  `contact.*`, or a single syscall no other label names, is described by its longest family. */
const FAMILY_LABELS = new Map(Object.entries({
  "fs": "approval.family.fs",
  "shell": "approval.family.shell",
  "net": "approval.family.net",
  "web": "approval.family.web",
  "mail": "approval.family.mail",
  "atproto": "approval.family.atproto",
  "repo": "approval.family.repo",
  "proc": "approval.family.proc",
  "codemode": "approval.family.codemode",
  "conversation": "approval.family.conversation",
  "contact": "approval.family.contact",
  "profile": "approval.family.profile",
  "approach": "approval.family.approach",
  "signal": "approval.family.signal",
  "sched": "approval.family.sched",
  "r12y": "approval.family.r12y",
  "ai": "approval.family.ai",
  "adapter": "approval.family.adapter",
  "adapter.pair": "approval.family.adapterPair",
  "account": "approval.family.account",
  "sys.config": "approval.family.sysConfig",
  "sys.mcp": "approval.family.sysMcp",
  "sys.instance": "approval.family.sysInstance",
  "sys.browser": "approval.family.sysBrowser",
  "sys.target": "approval.family.sysTarget",
  "sys.pair": "approval.family.sysPair",
  "sys.oauth": "approval.family.sysOauth",
  "sys.token": "approval.family.sysToken",
  "sys.ledger": "approval.family.sysLedger",
} satisfies Record<string, TextKey>));

/** The message naming a capability: its own label, else its longest labelled family, else none. */
export function capabilityLabelKey(capability: string): TextKey | undefined {
  const known = RULE_MATCH_LABELS.get(capability) ?? GRANT_LABELS.get(capability);
  if (known) {
    return known;
  }
  const parts = capability.replace(/\.\*$/, "").split(".");
  for (let length = parts.length; length > 0; length -= 1) {
    const family = FAMILY_LABELS.get(parts.slice(0, length).join("."));
    if (family) {
      return family;
    }
  }
  return undefined;
}

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
const LEGACY_EXTERNAL_TARGET = { value: targetOptionValue("targets/*"), label: "approval.target.allExternal" } satisfies { value: string; label: TextKey };

/** Naming the rule "Always allow" saves: one exact syscall. A syscall without a verb of its own shows its
 *  family and its id, so the hint never reads wider than the rule it adds. */
export function ruleCapabilityLabel(capability: string): string {
  const label = humanToolCapabilityLabel(capability);
  const exact = RULE_MATCH_LABELS.has(capability) || GRANT_LABELS.has(capability) || capability.endsWith(".*") || !capabilityLabelKey(capability);
  return exact ? label : `${label} · ${capability}`;
}

export function humanToolCapabilityLabel(capability: string): string {
  const normalized = capability.trim();
  if (!normalized) {
    return t("approval.capability");
  }
  const known = capabilityLabelKey(normalized);
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
  return match !== "" && !RULE_MATCH_LABELS.has(match);
}

export function matchOptionsForRule(match: string): ApprovalOption[] {
  const options = [...RULE_MATCH_LABELS].map(([value, label]) => ({ value, label: t(label) }));
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
  const named = targets.filter((candidate) => candidate.id.trim().length > 0);
  const connections = named.map((candidate) => ({
    value: targetOptionValue(candidate.id),
    label: candidate.label?.trim() || candidate.id,
    id: candidate.id,
  }));
  const options: { value: string; label: string; id?: string }[] = target === "targets/*"
    ? [...builtinOptions, translated(LEGACY_EXTERNAL_TARGET), ...connections]
    : [...builtinOptions, ...connections];
  const value = targetOptionValue(target);
  if (target !== undefined && !options.some((option) => option.value === value)) {
    // The rule's own target, kept under its stored value: a supported alias reads as what it means, a selector
    // as its scope, and a machine no listed connection matches as forgotten, apart from a live one of that name.
    const canonical = normalizeToolApprovalTarget(target);
    const alias = canonical !== target;
    const label = alias
      ? canonical === "targets/*" ? t(LEGACY_EXTERNAL_TARGET.label) : targetLabelForRule(canonical, targets)
      : isToolApprovalTargetSelector(target) ? targetLabelForRule(target, targets) : t("approval.target.notConnected", { id: target });
    options.push(isToolApprovalTargetSelector(target) || alias ? { value, label } : { value, label, id: target });
  }
  // Connection names are not unique and may echo a built-in choice or another connection's derived label; any
  // label still shared after a pass gains that connection's id until every option reads differently.
  for (let pass = 0; pass < 3; pass += 1) {
    const counts = new Map<string, number>();
    for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    const colliding = options.filter((option) => (counts.get(option.label) ?? 0) > 1 && option.id !== undefined && !option.label.endsWith(` · ${option.id}`));
    if (colliding.length === 0) break;
    for (const option of colliding) option.label = `${option.label} · ${option.id}`;
  }
  return options.map(({ value: optionValue, label }) => ({ value: optionValue, label }));
}

export function targetIndexForRule(target: ToolApprovalTarget | undefined, targets: readonly AgentToolTarget[]): number {
  const value = targetOptionValue(target);
  const index = targetOptionsForRule(target, targets).findIndex((option) => option.value === value);
  return index >= 0 ? index : 0;
}

/** Human label for a rule's machine scope (mirrors the target Select options). */
export function targetLabelForRule(target: ToolApprovalTarget | undefined, targets: readonly AgentToolTarget[]): string {
  if (!target) {
    return t("approval.target.allMachines");
  }
  if (target === "targets/*") {
    return t("approval.target.allExternal");
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
