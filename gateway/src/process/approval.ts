import type { ProcessIdentity } from "../syscalls/system";

export type ToolApprovalAction = "auto" | "ask" | "deny";

export type ToolApprovalRule = {
  match: string;
  when?: {
    anyTag?: string[];
    allTags?: string[];
    argEquals?: Record<string, string | number | boolean>;
    argPrefix?: Record<string, string>;
    target?: "gsv" | "device";
  };
  action: ToolApprovalAction;
};

export type ToolApprovalPolicy = {
  default: ToolApprovalAction;
  rules: ToolApprovalRule[];
};

export type ToolApprovalFacts = {
  syscall: string;
  domain: string;
  target: "gsv" | "device";
  tags: string[];
  path?: string;
  command?: string;
};

export type ToolApprovalResolution = {
  action: ToolApprovalAction;
  facts: ToolApprovalFacts;
  matchedRule?: string;
};

export const DEFAULT_TOOL_APPROVAL_POLICY: ToolApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", action: "ask" },
    { match: "fs.delete", action: "ask" },
  ],
};

export function parseToolApprovalPolicy(raw: string | null | undefined): ToolApprovalPolicy {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_TOOL_APPROVAL_POLICY;
    }

    const record = parsed as {
      default?: unknown;
      rules?: unknown;
    };

    const defaultAction = normalizeAction(record.default) ?? DEFAULT_TOOL_APPROVAL_POLICY.default;
    const rules = Array.isArray(record.rules)
      ? record.rules
          .map(parseRule)
          .filter((rule): rule is ToolApprovalRule => rule !== null)
      : DEFAULT_TOOL_APPROVAL_POLICY.rules;

    return {
      default: defaultAction,
      rules,
    };
  } catch {
    return DEFAULT_TOOL_APPROVAL_POLICY;
  }
}

export function resolveToolApproval(
  policy: ToolApprovalPolicy,
  syscall: string,
  args: unknown,
  identity: ProcessIdentity,
): ToolApprovalResolution {
  const facts = buildToolApprovalFacts(syscall, args, identity);
  const rules = [
    ...policy.rules.filter((rule) => rule.match === syscall),
    ...policy.rules.filter((rule) => isWildcardMatch(rule.match, syscall)),
  ];

  for (const rule of rules) {
    if (rule.when && !matchesWhen(rule.when, facts, args)) {
      continue;
    }
    return {
      action: rule.action,
      facts,
      matchedRule: rule.match,
    };
  }

  return {
    action: policy.default,
    facts,
  };
}

export function buildToolApprovalFacts(
  syscall: string,
  args: unknown,
  identity: ProcessIdentity,
): ToolApprovalFacts {
  const record = asRecord(args);
  const domain = syscall.split(".")[0] ?? syscall;
  const rawTarget = typeof record?.target === "string" ? record.target.trim() : "";
  const target: "gsv" | "device" =
    rawTarget && rawTarget !== "gsv" && rawTarget !== "gateway" && rawTarget !== "local"
      ? "device"
      : "gsv";

  const path = typeof record?.path === "string"
    ? resolvePath(identity.cwd, record.path)
    : undefined;
  const command = typeof record?.command === "string"
    ? record.command
    : undefined;

  const tags = new Set<string>();

  if (target === "device") {
    tags.add("remote");
  }

  if (syscall === "fs.write" || syscall === "fs.edit") {
    tags.add("mutating");
  }
  if (syscall === "fs.delete") {
    tags.add("destructive");
    tags.add("mutating");
  }

  if (path) {
    if (isHiddenPath(path)) tags.add("hidden-path");
    if (!isWithin(path, identity.cwd)) tags.add("outside-cwd");
    if (!isWithin(path, identity.home)) tags.add("outside-home");
  }

  if (command) {
    const normalized = command.toLowerCase();
    if (includesAny(normalized, ["curl ", "wget ", "ssh ", "scp ", "nc ", "telnet ", "ftp "])) {
      tags.add("network");
    }
    if (includesAny(normalized, ["sudo ", "su ", "passwd", "useradd", "userdel", "systemctl ", "service ", "mount ", "umount "])) {
      tags.add("privileged");
    }
    if (includesAny(normalized, ["rm ", "dd ", "mkfs", "chmod ", "chown ", "mv ", "rmdir ", "truncate ", "reboot", "shutdown"])) {
      tags.add("destructive");
    }
  }

  return {
    syscall,
    domain,
    target,
    tags: Array.from(tags).sort(),
    ...(path ? { path } : {}),
    ...(command ? { command } : {}),
  };
}

function parseRule(value: unknown): ToolApprovalRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    match?: unknown;
    action?: unknown;
    when?: unknown;
  };

  const match = typeof record.match === "string" ? record.match.trim() : "";
  const action = normalizeAction(record.action);
  if (!match || !action) {
    return null;
  }

  const when = parseWhen(record.when);
  return {
    match,
    action,
    ...(when ? { when } : {}),
  };
}

function parseWhen(value: unknown): ToolApprovalRule["when"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    anyTag?: unknown;
    allTags?: unknown;
    argEquals?: unknown;
    argPrefix?: unknown;
    target?: unknown;
  };

  const anyTag = normalizeStringArray(record.anyTag);
  const allTags = normalizeStringArray(record.allTags);
  const argEquals = normalizePrimitiveRecord(record.argEquals);
  const argPrefix = normalizeStringRecord(record.argPrefix);
  const target =
    record.target === "gsv" || record.target === "device"
      ? record.target
      : undefined;

  if (!anyTag && !allTags && !argEquals && !argPrefix && !target) {
    return undefined;
  }

  return {
    ...(anyTag ? { anyTag } : {}),
    ...(allTags ? { allTags } : {}),
    ...(argEquals ? { argEquals } : {}),
    ...(argPrefix ? { argPrefix } : {}),
    ...(target ? { target } : {}),
  };
}

function matchesWhen(
  when: NonNullable<ToolApprovalRule["when"]>,
  facts: ToolApprovalFacts,
  args: unknown,
): boolean {
  const tags = new Set(facts.tags);
  if (when.target && when.target !== facts.target) {
    return false;
  }
  if (when.anyTag && !when.anyTag.some((tag) => tags.has(tag))) {
    return false;
  }
  if (when.allTags && !when.allTags.every((tag) => tags.has(tag))) {
    return false;
  }

  const record = asRecord(args);
  if (when.argEquals) {
    for (const [key, expected] of Object.entries(when.argEquals)) {
      if (record?.[key] !== expected) {
        return false;
      }
    }
  }
  if (when.argPrefix) {
    for (const [key, prefix] of Object.entries(when.argPrefix)) {
      if (typeof record?.[key] !== "string" || !record[key].startsWith(prefix)) {
        return false;
      }
    }
  }

  return true;
}

function normalizeAction(value: unknown): ToolApprovalAction | null {
  return value === "auto" || value === "ask" || value === "deny"
    ? value
    : null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizePrimitiveRecord(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([, entry]) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([, entry]) =>
    typeof entry === "string" && entry.length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isWildcardMatch(ruleMatch: string, syscall: string): boolean {
  if (!ruleMatch.endsWith(".*")) {
    return false;
  }
  const domain = ruleMatch.slice(0, -2);
  return syscall === domain || syscall.startsWith(domain + ".");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolvePath(cwd: string, value: string): string {
  const source = value.startsWith("/") ? value : `${cwd.replace(/\/+$/g, "")}/${value}`;
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function isWithin(path: string, root: string): boolean {
  const normalizedRoot = resolvePath("/", root);
  return path === normalizedRoot || path.startsWith(normalizedRoot + "/");
}

function isHiddenPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments.some((segment) => segment.startsWith("."));
}

function includesAny(source: string, needles: string[]): boolean {
  return needles.some((needle) => source.includes(needle));
}
