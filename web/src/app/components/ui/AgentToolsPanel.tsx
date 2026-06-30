import { Button } from "./Button";
import { InfoTip } from "./InfoTip";
import { Segmented } from "./Segmented";
import { Select, type SelectOption } from "./Select";
import { Surface } from "./Surface";
import { Tag } from "./Tag";
import "./AgentToolsPanel.css";

export type AgentToolApprovalAction = "auto" | "ask" | "deny";

export type AgentToolApprovalCondition = {
  anyTag?: string[];
  allTags?: string[];
  argEquals?: Record<string, string | number | boolean>;
  argPrefix?: Record<string, string>;
  target?: "gsv" | "device";
};

export type AgentToolApprovalRule = {
  match: string;
  when?: AgentToolApprovalCondition;
  action: AgentToolApprovalAction;
};

export type AgentToolApprovalPolicy = {
  default: AgentToolApprovalAction;
  rules: AgentToolApprovalRule[];
};

export interface AgentToolsPanelProps {
  policy: AgentToolApprovalPolicy;
  sourceLabel?: string;
  sourceDescription?: string;
  capabilities?: readonly string[];
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
const TAG_LABELS: Record<string, string> = {
  destructive: "Destructive",
  privileged: "Privileged",
  network: "Network",
  mutating: "Changes state",
  unclassified: "Unclassified",
};

function actionLabel(action: AgentToolApprovalAction): string {
  if (action === "auto") return "Allow automatically";
  if (action === "deny") return "Deny";
  return "Ask first";
}

function actionDescription(action: AgentToolApprovalAction): string {
  if (action === "auto") return "No confirmation prompt.";
  if (action === "deny") return "Never run matching tools.";
  return "Request confirmation before running.";
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

function conditionLabels(when: AgentToolApprovalCondition | undefined): string[] {
  if (!when) {
    return [];
  }
  const labels: string[] = [];
  if (when.target) labels.push(when.target === "gsv" ? "GSV target" : "Device target");
  if (when.anyTag?.length) labels.push(`${when.anyTag.map(tagLabel).join(" or ")}`);
  if (when.allTags?.length) labels.push(`${when.allTags.map(tagLabel).join(" + ")}`);
  for (const [key, value] of Object.entries(when.argEquals ?? {})) {
    labels.push(`${argumentLabel(key)} is ${String(value)}`);
  }
  for (const [key, value] of Object.entries(when.argPrefix ?? {})) {
    labels.push(`${argumentLabel(key)} starts with ${value}`);
  }
  return labels;
}

function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

function argumentLabel(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionIndex(action: AgentToolApprovalAction): number {
  return Math.max(0, APPROVAL_ACTIONS.indexOf(action));
}

export function AgentToolsPanel({
  policy,
  sourceLabel,
  sourceDescription,
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
        <Surface level={1} class="gsv-tools-rules">
          <div class="gsv-tools-rule-list">
            {policy.rules.map((rule, index) => {
              const conditions = conditionLabels(rule.when);
              const matchOptions = matchOptionsForRule(rule.match);
              return (
                <div class="gsv-tools-rule" key={index}>
                  <Select
                    label={index === 0 ? "TOOL" : ""}
                    options={matchOptions}
                    value={matchIndexForRule(rule.match)}
                    width={280}
                    size="small"
                    disabled={disabled}
                    onChange={(selected) => onChange(updateRule(policy, index, { match: optionValue(matchOptions[selected] ?? matchOptions[0] ?? "fs.*") }))}
                  />
                  <Select
                    label={index === 0 ? "ACTION" : ""}
                    options={APPROVAL_ACTIONS.map((action) => ({
                      label: actionLabel(action),
                      value: action,
                      description: actionDescription(action),
                    }))}
                    value={actionIndex(rule.action)}
                    width={190}
                    size="small"
                    disabled={disabled}
                    onChange={(selected) => onChange(updateRule(policy, index, { action: APPROVAL_ACTIONS[selected] ?? "ask" }))}
                  />
                  <Button
                    variant="dangerGhost"
                    label="REMOVE"
                    disabled={disabled}
                    onClick={() => onChange(removeRule(policy, index))}
                  />
                  {conditions.length > 0 ? (
                    <div class="gsv-tools-rule-conditions">
                      {conditions.map((condition) => (
                        <Tag key={condition} tone="accent" label={condition.toUpperCase()} boxed />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Surface>
      ) : null}
    </section>
  );
}
