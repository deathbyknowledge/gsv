import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { InfoTip } from "./InfoTip";
import { Segmented } from "./Segmented";
import { Select, type SelectOption } from "./Select";
import { Tag } from "./Tag";
import "./AgentToolsPanel.css";

export type AgentToolApprovalAction = "auto" | "ask" | "deny";

export type AgentToolApprovalRule = {
  match: string;
  target?: string;
  action: AgentToolApprovalAction;
};

export type AgentToolApprovalPolicy = {
  default: AgentToolApprovalAction;
  rules: AgentToolApprovalRule[];
};

export type AgentToolTarget = {
  id: string;
  label?: string;
  online?: boolean;
  implements?: readonly string[];
};

export interface AgentToolsPanelProps {
  policy: AgentToolApprovalPolicy;
  sourceLabel?: string;
  sourceDescription?: string;
  capabilities?: readonly string[];
  targets?: readonly AgentToolTarget[];
  disabled?: boolean;
  onChange: (policy: AgentToolApprovalPolicy) => void;
}

type CapabilityFamily = {
  label: string;
  options: ApprovalMatchOption[];
};

type ApprovalMatchOption = {
  match: string;
  label: string;
  description?: string;
};

const APPROVAL_ACTIONS: AgentToolApprovalAction[] = ["auto", "ask", "deny"];
const CAPABILITY_FAMILIES: CapabilityFamily[] = [
  {
    label: "Filesystem",
    options: [
      { match: "fs.*", label: "All file tools", description: "Read, write, edit, search, copy, and delete files." },
      { match: "fs.read", label: "Read files" },
      { match: "fs.write", label: "Write files" },
      { match: "fs.edit", label: "Edit files" },
      { match: "fs.search", label: "Search files" },
      { match: "fs.copy", label: "Copy files" },
      { match: "fs.delete", label: "Delete files" },
    ],
  },
  {
    label: "Shell",
    options: [
      { match: "shell.*", label: "All shell tools", description: "Every shell operation." },
      { match: "shell.exec", label: "Run shell commands" },
    ],
  },
  {
    label: "Network",
    options: [
      { match: "net.*", label: "All network tools", description: "Every network operation." },
      { match: "net.fetch", label: "Fetch URLs" },
    ],
  },
  {
    label: "Repositories",
    options: [
      { match: "repo.*", label: "All repository tools", description: "Every ripgit repository operation." },
      { match: "repo.list", label: "List repositories" },
      { match: "repo.read", label: "Read repository content" },
      { match: "repo.search", label: "Search repositories" },
      { match: "repo.compare", label: "Compare refs" },
      { match: "repo.diff", label: "Read diffs" },
      { match: "repo.apply", label: "Apply repository changes" },
      { match: "repo.import", label: "Pull upstream" },
      { match: "repo.delete", label: "Delete repositories" },
      { match: "repo.visibility.set", label: "Change repository visibility" },
    ],
  },
  {
    label: "Packages",
    options: [
      { match: "pkg.*", label: "All package tools", description: "Every package operation." },
      { match: "pkg.list", label: "List packages" },
      { match: "pkg.install", label: "Install packages" },
      { match: "pkg.review.approve", label: "Approve package reviews" },
      { match: "pkg.public.set", label: "Publish or unpublish packages" },
      { match: "pkg.remove", label: "Remove packages" },
    ],
  },
  {
    label: "Processes",
    options: [
      { match: "proc.*", label: "All process tools", description: "Every process and conversation operation." },
      { match: "proc.spawn", label: "Start processes" },
      { match: "proc.send", label: "Send process messages" },
      { match: "proc.history", label: "Read process history" },
      { match: "proc.abort", label: "Abort runs" },
      { match: "proc.reset", label: "Reset processes" },
      { match: "proc.kill", label: "Kill processes" },
    ],
  },
  {
    label: "MCP",
    options: [
      { match: "sys.mcp.*", label: "All MCP tools", description: "Every MCP server operation." },
      { match: "sys.mcp.call", label: "Call MCP tools" },
      { match: "sys.mcp.list", label: "List MCP servers" },
      { match: "sys.mcp.add", label: "Add MCP servers" },
      { match: "sys.mcp.refresh", label: "Refresh MCP servers" },
      { match: "sys.mcp.remove", label: "Remove MCP servers" },
    ],
  },
  {
    label: "System Config",
    options: [
      { match: "sys.config.*", label: "All system config tools", description: "Read and write gateway config." },
      { match: "sys.config.get", label: "Read system config" },
      { match: "sys.config.set", label: "Write system config" },
    ],
  },
];
const APPROVAL_MATCH_OPTIONS: SelectOption[] = CAPABILITY_FAMILIES.flatMap((family) =>
  family.options.map((option) => ({
    group: family.label,
    label: option.label,
    value: option.match,
    description: option.description ?? "",
  })),
);
const APPROVAL_MATCH_VALUES = CAPABILITY_FAMILIES.flatMap((family) => family.options.map((option) => option.match));
const BUILTIN_TARGET_OPTIONS: SelectOption[] = [
  {
    label: "All",
    value: "",
  },
  {
    label: "GSV computer",
    value: "gsv",
  },
];
const LEGACY_EXTERNAL_TARGET_OPTION: SelectOption = {
  group: "Stored target",
  label: "All external targets",
  value: "targets/*",
};

function actionLabel(action: AgentToolApprovalAction): string {
  if (action === "auto") return "Allow";
  if (action === "deny") return "Deny";
  return "Ask";
}

function defaultOverrideAction(defaultAction: AgentToolApprovalAction): AgentToolApprovalAction {
  if (defaultAction === "auto") return "ask";
  if (defaultAction === "deny") return "ask";
  return "deny";
}

function updateRule(
  policy: AgentToolApprovalPolicy,
  index: number,
  patch: Partial<AgentToolApprovalRule>,
): AgentToolApprovalPolicy {
  return {
    ...policy,
    rules: policy.rules.map((rule, candidate) => candidate === index ? { ...rule, ...patch } : rule),
  };
}

function removeRule(policy: AgentToolApprovalPolicy, index: number): AgentToolApprovalPolicy {
  return {
    ...policy,
    rules: policy.rules.filter((_, candidate) => candidate !== index),
  };
}

function addRule(policy: AgentToolApprovalPolicy): AgentToolApprovalPolicy {
  return {
    ...policy,
    rules: [...policy.rules, { match: "fs.*", action: defaultOverrideAction(policy.default) }],
  };
}

function matchOptionsForRule(match: string): SelectOption[] {
  if (!match || APPROVAL_MATCH_VALUES.includes(match)) {
    return APPROVAL_MATCH_OPTIONS;
  }
  return [
    ...APPROVAL_MATCH_OPTIONS,
    {
      group: "Custom",
      label: "Custom match",
      value: match,
      description: "Stored custom approval match.",
    },
  ];
}

function matchIndexForRule(match: string): number {
  const options = matchOptionsForRule(match);
  const index = options.findIndex((option) => typeof option !== "string" && option.value === match);
  return index >= 0 ? index : 0;
}

function optionValue(option: SelectOption): string {
  return typeof option === "string" ? option : option.value ?? option.label;
}

function targetOptionsForRule(target: string | undefined, targets: readonly AgentToolTarget[]): SelectOption[] {
  const targetOptions = targets
    .filter((candidate) => candidate.id.trim().length > 0)
    .map((candidate) => {
      const label = candidate.label?.trim() || candidate.id;
      return {
        group: "Targets",
        label,
        value: candidate.id,
      };
    });
  const knownValues = new Set([
    ...BUILTIN_TARGET_OPTIONS.map((option) => typeof option === "string" ? option : option.value ?? option.label),
    ...targetOptions.map((option) => option.value ?? option.label),
  ]);
  const baseOptions = target === "targets/*"
    ? [...BUILTIN_TARGET_OPTIONS, LEGACY_EXTERNAL_TARGET_OPTION, ...targetOptions]
    : [...BUILTIN_TARGET_OPTIONS, ...targetOptions];
  if (!target || knownValues.has(target) || target === "targets/*") {
    return baseOptions;
  }
  return [
    ...baseOptions,
    {
      group: "Stored target",
      label: target,
      value: target,
    },
  ];
}

function targetIndexForRule(target: string | undefined, targets: readonly AgentToolTarget[]): number {
  const options = targetOptionsForRule(target, targets);
  const value = target ?? "";
  const index = options.findIndex((option) => typeof option !== "string" && (option.value ?? option.label) === value);
  return index >= 0 ? index : 0;
}

function updateRuleTarget(
  policy: AgentToolApprovalPolicy,
  index: number,
  target: string,
): AgentToolApprovalPolicy {
  const patch: Partial<AgentToolApprovalRule> = target ? { target } : { target: undefined };
  const next = updateRule(policy, index, patch);
  return {
    ...next,
    rules: next.rules.map((rule, candidate) => candidate === index && !target
      ? { match: rule.match, action: rule.action }
      : rule),
  };
}

function actionIndex(action: AgentToolApprovalAction): number {
  return Math.max(0, APPROVAL_ACTIONS.indexOf(action));
}

export function AgentToolsPanel({
  policy,
  sourceLabel,
  sourceDescription,
  targets = [],
  disabled = false,
  onChange,
}: AgentToolsPanelProps) {
  const normalizedSource = sourceLabel?.trim();

  return (
    <section class="gsv-tools-panel" aria-label="Agent tools">
      <div class="gsv-tools-bar">
        <div class="gsv-tools-title">
          <span>TOOL APPROVAL</span>
          {normalizedSource ? <Tag tone="info" label={normalizedSource.toUpperCase()} boxed /> : null}
          {sourceDescription ? (
            <InfoTip text={sourceDescription} position="right" label="Tool approval policy source" />
          ) : null}
        </div>
        <div class="gsv-tools-bar-actions">
          <Button
            variant="secondary"
            label="ADD OVERRIDE"
            disabled={disabled}
            onClick={() => onChange(addRule(policy))}
          />
        </div>
      </div>

      <Segmented
        l0="ALLOW"
        l1="ASK"
        l2="DENY"
        value={actionIndex(policy.default)}
        onChange={disabled ? undefined : (index) => onChange({ ...policy, default: APPROVAL_ACTIONS[index] ?? "ask" })}
        width={300}
        label="DEFAULT"
        description="Used when no approval override matches."
        disabled={disabled}
      />

      {policy.rules.length > 0 ? (
        <div class="gsv-tools-overrides" role="table" aria-label="Tool approval overrides">
          <div class="gsv-tools-overrides-head" role="row">
            <span role="columnheader">TOOL</span>
            <span class="gsv-tools-column-head" role="columnheader">
              TARGET
              <InfoTip
                text="Where this override applies: all targets, the GSV computer, or one named target."
                position="top"
                label="Target scope"
              />
            </span>
            <span class="gsv-tools-column-head" role="columnheader">
              ACTION
              <InfoTip
                text="What happens when the tool and target match: allow it, ask for confirmation, or deny it."
                position="top"
                label="Approval action"
              />
            </span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          <div class="gsv-tools-rule-list" role="rowgroup">
            {policy.rules.map((rule, index) => {
              const matchOptions = matchOptionsForRule(rule.match);
              const targetOptions = targetOptionsForRule(rule.target, targets);
              return (
                <div class="gsv-tools-rule" role="row" key={index}>
                  <div class="gsv-tools-rule-tool" role="cell">
                    <Select
                      options={matchOptions}
                      value={matchIndexForRule(rule.match)}
                      width={280}
                      size="small"
                      disabled={disabled}
                      onChange={(selected) => onChange(updateRule(policy, index, { match: optionValue(matchOptions[selected] ?? matchOptions[0] ?? "fs.*") }))}
                    />
                  </div>
                  <div class="gsv-tools-rule-target" role="cell">
                    <Select
                      options={targetOptions}
                      value={targetIndexForRule(rule.target, targets)}
                      width={190}
                      size="small"
                      disabled={disabled}
                      onChange={(selected) => onChange(updateRuleTarget(policy, index, optionValue(targetOptions[selected] ?? targetOptions[0] ?? "")))}
                    />
                  </div>
                  <div class="gsv-tools-rule-action" role="cell">
                    <Select
                      options={APPROVAL_ACTIONS.map((action) => ({
                        label: actionLabel(action),
                        value: action,
                      }))}
                      value={actionIndex(rule.action)}
                      width={170}
                      size="small"
                      disabled={disabled}
                      onChange={(selected) => onChange(updateRule(policy, index, { action: APPROVAL_ACTIONS[selected] ?? "ask" }))}
                    />
                  </div>
                  <div class="gsv-tools-rule-delete" role="cell">
                    <IconButton
                      glyph="close"
                      size="small"
                      title="Delete override"
                      disabled={disabled}
                      onClick={() => onChange(removeRule(policy, index))}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
