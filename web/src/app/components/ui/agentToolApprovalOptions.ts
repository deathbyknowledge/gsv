import type { SelectOption } from "./Select";

/** Shared model + option builders for tool-approval editing. Extracted from
 *  AgentToolsPanel so other approval editors (e.g. the CREW overrides drawer)
 *  can reuse the same capability families, machine scopes and labels. */

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

type CapabilityFamily = {
  label: string;
  options: ApprovalMatchOption[];
};

type ApprovalMatchOption = {
  match: string;
  label: string;
  description?: string;
};

export const APPROVAL_ACTIONS: AgentToolApprovalAction[] = ["auto", "ask", "deny"];

export const CAPABILITY_FAMILIES: CapabilityFamily[] = [
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

export const APPROVAL_MATCH_OPTIONS: SelectOption[] = CAPABILITY_FAMILIES.flatMap((family) =>
  family.options.map((option) => ({
    group: family.label,
    label: option.label,
    value: option.match,
    description: option.description ?? "",
  })),
);
const APPROVAL_MATCH_VALUES = CAPABILITY_FAMILIES.flatMap((family) => family.options.map((option) => option.match));
const APPROVAL_MATCH_LABELS = new Map(
  CAPABILITY_FAMILIES.flatMap((family) =>
    family.options.map((option) => [option.match, option.label] as const)
  ),
);
export const BUILTIN_TARGET_OPTIONS: SelectOption[] = [
  {
    label: "All machines",
    value: "",
  },
  {
    label: "GSV computer",
    value: "gsv",
  },
];
const LEGACY_EXTERNAL_TARGET_OPTION: SelectOption = {
  group: "Stored machine",
  label: "All machines",
  value: "targets/*",
};

export function humanToolCapabilityLabel(capability: string): string {
  const normalized = capability.trim();
  if (!normalized) {
    return "Capability";
  }
  const known = APPROVAL_MATCH_LABELS.get(normalized);
  if (known) {
    return known;
  }
  return normalized
    .replace(/\.\*/g, "")
    .split(/[._:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function actionLabel(action: AgentToolApprovalAction): string {
  if (action === "auto") return "Allow";
  if (action === "deny") return "Block";
  return "Ask";
}

export function defaultOverrideAction(defaultAction: AgentToolApprovalAction): AgentToolApprovalAction {
  if (defaultAction === "auto") return "ask";
  if (defaultAction === "deny") return "ask";
  return "deny";
}

export function matchOptionsForRule(match: string): SelectOption[] {
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

export function matchIndexForRule(match: string): number {
  const options = matchOptionsForRule(match);
  const index = options.findIndex((option) => typeof option !== "string" && option.value === match);
  return index >= 0 ? index : 0;
}

export function approvalOptionValue(option: SelectOption): string {
  return typeof option === "string" ? option : option.value ?? option.label;
}

export function targetOptionsForRule(target: string | undefined, targets: readonly AgentToolTarget[]): SelectOption[] {
  const targetOptions = targets
    .filter((candidate) => candidate.id.trim().length > 0)
    .map((candidate) => {
      const label = candidate.label?.trim() || candidate.id;
      return {
        group: "Machines",
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
      group: "Stored machine",
      label: target,
      value: target,
    },
  ];
}

export function targetIndexForRule(target: string | undefined, targets: readonly AgentToolTarget[]): number {
  const options = targetOptionsForRule(target, targets);
  const value = target ?? "";
  const index = options.findIndex((option) => typeof option !== "string" && (option.value ?? option.label) === value);
  return index >= 0 ? index : 0;
}

/** Human label for a rule's machine scope (mirrors the target Select options). */
export function targetLabelForRule(target: string | undefined, targets: readonly AgentToolTarget[]): string {
  if (!target || target === "targets/*") {
    return "All machines";
  }
  if (target === "gsv") {
    return "GSV computer";
  }
  const known = targets.find((candidate) => candidate.id === target);
  return known?.label?.trim() || target;
}

export function actionIndex(action: AgentToolApprovalAction): number {
  return Math.max(0, APPROVAL_ACTIONS.indexOf(action));
}
