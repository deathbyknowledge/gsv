import {
  Bash,
  type CommandNode,
  type ScriptNode,
  type SimpleCommandNode,
  type StatementNode,
  type WordNode,
} from "just-bash";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { CODEMODE_FETCH } from "../syscalls/constants";

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
    { match: "shell.exec", when: { anyTag: ["destructive", "privileged", "network", "mutating", "unclassified"] }, action: "ask" },
    { match: CODEMODE_FETCH, when: { anyTag: ["network", "mutating"] }, action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
  ],
};

const READONLY_SHELL_COMMANDS = new Set([
  "base64",
  "basename",
  "cat",
  "clear",
  "column",
  "comm",
  "cut",
  "date",
  "dirname",
  "du",
  "echo",
  "egrep",
  "expand",
  "expr",
  "false",
  "fgrep",
  "file",
  "fold",
  "grep",
  "head",
  "help",
  "history",
  "hostname",
  "html-to-markdown",
  "join",
  "jq",
  "ls",
  "md5sum",
  "nl",
  "od",
  "paste",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "seq",
  "sha1sum",
  "sha256sum",
  "sort",
  "stat",
  "strings",
  "tac",
  "tail",
  "tr",
  "tree",
  "true",
  "uniq",
  "wc",
  "which",
  "whoami",
  "zcat",
]);

const NETWORK_SHELL_COMMANDS = new Set(["curl", "ftp", "nc", "scp", "ssh", "telnet", "wget"]);
const PRIVILEGED_SHELL_COMMANDS = new Set([
  "mount",
  "passwd",
  "service",
  "su",
  "sudo",
  "systemctl",
  "umount",
  "useradd",
  "userdel",
]);
const DESTRUCTIVE_SHELL_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "mkfs",
  "mkdir",
  "mv",
  "reboot",
  "rm",
  "rmdir",
  "shutdown",
  "tee",
  "touch",
  "truncate",
]);
const DYNAMIC_SHELL_COMMANDS = new Set([
  ".",
  "bash",
  "builtin",
  "command",
  "eval",
  "exec",
  "env",
  "sh",
  "source",
  "timeout",
  "xargs",
]);
const MUTATING_REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const SHELL_APPROVAL_BASH = new Bash();

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
  const hasShellSession = syscall === "shell.exec"
    && typeof record?.sessionId === "string"
    && record.sessionId.trim().length > 0;
  const target: "gsv" | "device" =
    hasShellSession || (rawTarget && rawTarget !== "gsv" && rawTarget !== "gateway" && rawTarget !== "local")
      ? "device"
      : "gsv";

  const path = typeof record?.path === "string"
    ? resolvePath(identity.cwd, record.path)
    : undefined;
  const command = typeof record?.input === "string"
    ? record.input
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
    addShellCommandTags(command, tags);
  }
  if (syscall === CODEMODE_FETCH) {
    tags.add("network");
    const method = typeof record?.method === "string" ? record.method.trim().toUpperCase() : "GET";
    if (method && method !== "GET" && method !== "HEAD") {
      tags.add("mutating");
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

function addShellCommandTags(command: string, tags: Set<string>): void {
  try {
    scanShellScript(SHELL_APPROVAL_BASH.transform(command).ast as ScriptNode, tags);
  } catch {
    tags.add("unclassified");
  }
}

function scanShellScript(script: ScriptNode, tags: Set<string>): void {
  for (const statement of script.statements) {
    scanShellStatement(statement, tags);
  }
}

function scanShellStatement(statement: StatementNode, tags: Set<string>): void {
  if (statement.deferredError) {
    tags.add("unclassified");
  }
  for (const pipeline of statement.pipelines) {
    for (const command of pipeline.commands) {
      scanShellCommand(command, tags);
    }
  }
}

function scanShellCommand(command: CommandNode, tags: Set<string>): void {
  switch (command.type) {
    case "SimpleCommand":
      scanSimpleShellCommand(command, tags);
      return;
    case "FunctionDef":
      tags.add("unclassified");
      scanShellCommand(command.body, tags);
      return;
    case "If":
      scanStatementLists(tags, ...command.clauses.flatMap((clause) => [clause.condition, clause.body]));
      if (command.elseBody) scanStatementLists(tags, command.elseBody);
      scanShellRedirections(command.redirections, tags);
      return;
    case "For":
      scanShellWords(command.words ?? [], tags);
      scanStatementLists(tags, command.body);
      scanShellRedirections(command.redirections, tags);
      return;
    case "CStyleFor":
      scanStatementLists(tags, command.body);
      scanShellRedirections(command.redirections, tags);
      return;
    case "While":
    case "Until":
      scanStatementLists(tags, command.condition, command.body);
      scanShellRedirections(command.redirections, tags);
      return;
    case "Case":
      scanShellWord(command.word, tags);
      for (const item of command.items) {
        scanShellWords(item.patterns, tags);
        scanStatementLists(tags, item.body);
      }
      scanShellRedirections(command.redirections, tags);
      return;
    case "Subshell":
    case "Group":
      scanStatementLists(tags, command.body);
      scanShellRedirections(command.redirections, tags);
      return;
    case "ArithmeticCommand":
    case "ConditionalCommand":
      scanNestedExecutableParts(command, tags);
      scanShellRedirections(command.redirections, tags);
      return;
  }
}

function scanSimpleShellCommand(command: SimpleCommandNode, tags: Set<string>): void {
  scanShellRedirections(command.redirections, tags);
  for (const assignment of command.assignments) {
    if (assignment.value) scanShellWord(assignment.value, tags);
    if (assignment.array) scanShellWords(assignment.array, tags);
  }
  scanShellWords(command.args, tags);

  if (!command.name) {
    return;
  }

  const name = literalShellWord(command.name)?.toLowerCase();
  if (!name) {
    tags.add("unclassified");
    scanShellWord(command.name, tags);
    return;
  }

  if (NETWORK_SHELL_COMMANDS.has(name)) {
    tags.add("network");
  }
  if (PRIVILEGED_SHELL_COMMANDS.has(name)) {
    tags.add("privileged");
  }
  if (DESTRUCTIVE_SHELL_COMMANDS.has(name)) {
    tags.add("destructive");
    tags.add("mutating");
  }
  if (DYNAMIC_SHELL_COMMANDS.has(name)) {
    tags.add("unclassified");
  }
  if (name === "find" && shellWordsContain(command.args, ["-delete", "-exec", "-execdir"])) {
    tags.add("destructive");
    tags.add("mutating");
  }
  if (name === "sed" && shellWordsContain(command.args, ["-i", "--in-place"])) {
    tags.add("destructive");
    tags.add("mutating");
  }
  if (!READONLY_SHELL_COMMANDS.has(name)
    && !NETWORK_SHELL_COMMANDS.has(name)
    && !PRIVILEGED_SHELL_COMMANDS.has(name)
    && !DESTRUCTIVE_SHELL_COMMANDS.has(name)
    && !DYNAMIC_SHELL_COMMANDS.has(name)
    && name !== "find"
    && name !== "sed") {
    tags.add("unclassified");
  }

  scanShellWord(command.name, tags);
}

function scanStatementLists(tags: Set<string>, ...lists: StatementNode[][]): void {
  for (const list of lists) {
    for (const statement of list) {
      scanShellStatement(statement, tags);
    }
  }
}

function scanShellRedirections(
  redirections: SimpleCommandNode["redirections"],
  tags: Set<string>,
): void {
  for (const redirect of redirections) {
    if (MUTATING_REDIRECT_OPERATORS.has(redirect.operator)) {
      tags.add("mutating");
    }
    scanNestedExecutableParts(redirect.target, tags);
  }
}

function scanShellWords(words: WordNode[], tags: Set<string>): void {
  for (const word of words) {
    scanShellWord(word, tags);
  }
}

function scanShellWord(word: WordNode, tags: Set<string>): void {
  for (const part of word.parts) {
    switch (part.type) {
      case "CommandSubstitution":
      case "ProcessSubstitution":
        tags.add("unclassified");
        scanShellScript(part.body, tags);
        break;
      case "DoubleQuoted":
        scanNestedExecutableParts(part.parts, tags);
        break;
      case "BraceExpansion":
        for (const item of part.items) {
          if (item.type === "Word") {
            scanShellWord(item.word, tags);
          }
        }
        break;
      default:
        scanNestedExecutableParts(part, tags);
        break;
    }
  }
}

function literalShellWord(word: WordNode): string | null {
  let value = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "Escaped":
        value += part.value;
        break;
      case "DoubleQuoted": {
        const nested = literalShellWord({ type: "Word", parts: part.parts });
        if (nested === null) return null;
        value += nested;
        break;
      }
      default:
        return null;
    }
  }
  return value;
}

function shellWordsContain(words: WordNode[], values: string[]): boolean {
  const expected = new Set(values);
  return words.some((word) => {
    const value = literalShellWord(word);
    if (!value) return false;
    if (expected.has(value)) return true;
    return values.some((prefix) => value.startsWith(prefix) && prefix.length > 2);
  });
}

function scanNestedExecutableParts(value: unknown, tags: Set<string>): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanNestedExecutableParts(item, tags);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "CommandSubstitution" || record.type === "ProcessSubstitution") {
    tags.add("unclassified");
    if (isShellScriptNode(record.body)) {
      scanShellScript(record.body, tags);
    }
  }
  if (record.type === "ArithCommandSubst" && typeof record.command === "string") {
    tags.add("unclassified");
    addShellCommandTags(record.command, tags);
  }

  for (const entry of Object.values(record)) {
    scanNestedExecutableParts(entry, tags);
  }
}

function isShellScriptNode(value: unknown): value is ScriptNode {
  return Boolean(value)
    && typeof value === "object"
    && (value as { type?: unknown }).type === "Script"
    && Array.isArray((value as { statements?: unknown }).statements);
}
