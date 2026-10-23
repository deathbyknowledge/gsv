import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { isRoutableSyscall, type SyscallName } from "../syscalls";
import { z } from "zod";
import type { ProcessApprovalTarget } from "../protocol/process-frames";
import {
  DEFAULT_TOOL_APPROVAL_POLICY, isToolApprovalTargetSelector, normalizeToolApprovalTarget, toolApprovalTargetSchema,
  type ToolApprovalAction, type ToolApprovalPolicy, type ToolApprovalRule, type ToolApprovalTarget,
} from "@humansandmachines/gsv/protocol";

export { DEFAULT_TOOL_APPROVAL_POLICY };
export type { ToolApprovalPolicy, ToolApprovalRule };

export type ToolApprovalResolution = {
  action: ToolApprovalAction;
  target: string;
  matchedRule?: string;
  approvedTarget?: ProcessApprovalTarget;
};

/** Syscall arguments with the model's one-sentence purpose for the person lifted off them. */
export type ToolArgsWithPurpose = {
  args: JsonObject;
  purpose?: string;
};

const PURPOSE_MAX_CHARACTERS = 400;

/** Every syscall tool takes a `purpose` written for the person; it never reaches the syscall. */
export function takePurpose(args: JsonObject): ToolArgsWithPurpose {
  if (!("purpose" in args)) {
    return { args };
  }
  const { purpose, ...rest } = args;
  const text = z.string().safeParse(purpose).data?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) {
    return { args: rest };
  }
  return { args: rest, purpose: Array.from(text).slice(0, PURPOSE_MAX_CHARACTERS).join("") };
}

const approvalActionSchema = z.enum(["auto", "ask", "deny"]);
const approvalValueSchema = z.unknown();
type ApprovalWireValue = z.input<typeof approvalValueSchema>;
const approvalRuleSchema = z.object({
  match: z.string().trim().min(1),
  target: toolApprovalTargetSchema.optional(),
  action: approvalActionSchema,
  when: approvalValueSchema.optional(),
});
const approvalPolicySchema = z.object({
  default: approvalActionSchema.optional(),
  rules: z.array(approvalValueSchema).optional(),
});
const approvalArgsSchema = z.object({ target: z.string().optional(), sessionId: z.string().optional() });

export function parseToolApprovalPolicy(raw: string | null | undefined): ToolApprovalPolicy {
  return readToolApprovalPolicy(raw) ?? DEFAULT_TOOL_APPROVAL_POLICY;
}

/** A stored policy, or null when none is stored or it cannot be read. */
export function readToolApprovalPolicy(raw: string | null | undefined): ToolApprovalPolicy | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const record = approvalPolicySchema.parse(JSON.parse(raw));
    return {
      default: record.default ?? DEFAULT_TOOL_APPROVAL_POLICY.default,
      rules: record.rules
        ? record.rules
            .map(parseRule)
            .filter((rule): rule is ToolApprovalRule => rule !== null)
        : DEFAULT_TOOL_APPROVAL_POLICY.rules,
    };
  } catch {
    return null;
  }
}

export function resolveToolApproval(
  policy: ToolApprovalPolicy,
  syscall: string,
  args?: ApprovalWireValue,
  metadata?: ProcessApprovalTarget,
): ToolApprovalResolution {
  const target = resolveToolApprovalTarget(syscall, args);
  const rules = policy.rules
    .map((rule, index) => ({
      rule,
      index,
      matchSpecificity: rule.match === syscall ? 2 : isWildcardMatch(rule.match, syscall) ? 1 : 0,
      targetSpecificity: targetScopeSpecificity(rule.target),
    }))
    .filter((entry) => entry.matchSpecificity > 0 && targetMatchesScope(entry.rule.target, target, metadata))
    .sort((left, right) =>
      right.targetSpecificity - left.targetSpecificity
      || right.matchSpecificity - left.matchSpecificity
      || left.index - right.index
    );

  const rule = rules[0]?.rule;
  if (rule) {
    return {
      action: rule.action,
      target,
      matchedRule: rule.match,
    };
  }

  return {
    action: policy.default,
    target,
  };
}

export function approvalNeedsTargetMetadata(policy: ToolApprovalPolicy, syscall: string, ordinary: ToolApprovalResolution): boolean {
  return ordinary.target !== "gsv" && policy.rules.some((rule) =>
    rule.target && isToolApprovalTargetSelector(rule.target)
    && rule.action !== ordinary.action
    && (rule.match === syscall || isWildcardMatch(rule.match, syscall))
  );
}

export function resolveToolApprovalTarget(syscall: string, args?: ApprovalWireValue): string {
  const record = approvalArgsSchema.safeParse(args).success ? approvalArgsSchema.parse(args) : null;
  // SAFETY: syscall routing accepts the complete syscall-name union at this boundary.
  const target = isRoutableSyscall(syscall as SyscallName)
    ? normalizeExplicitTarget(record?.target)
    : null;
  if (target) {
    return target;
  }
  if (syscall === "shell.exec" && record?.sessionId?.trim()) {
    return "targets/*";
  }
  return "gsv";
}

function parseRule(value: ApprovalWireValue): ToolApprovalRule | null {
  const record = approvalRuleSchema.safeParse(value);
  if (!record.success) return null;

  return {
    match: record.data.match,
    ...normalizeTargetPatch(record.data.target, record.data.when),
    action: record.data.action,
  };
}

function isWildcardMatch(ruleMatch: string, syscall: string): boolean {
  if (!ruleMatch.endsWith(".*")) {
    return false;
  }
  const domain = ruleMatch.slice(0, -2);
  return syscall === domain || syscall.startsWith(domain + ".");
}

function normalizeTargetPatch(
  targetValue: ToolApprovalTarget | undefined,
  legacyWhen: ApprovalWireValue,
): Pick<ToolApprovalRule, "target"> {
  const target = normalizeToolApprovalTarget(targetValue)
    ?? normalizeToolApprovalTarget(legacyWhenTarget(legacyWhen));
  return target ? { target } : {};
}

function legacyWhenTarget(value: ApprovalWireValue): string | undefined {
  const parsed = z.object({ target: z.string().optional() }).safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.target === "device" ? "targets/*" : parsed.data.target;
}

function normalizeExplicitTarget(value: ApprovalWireValue): string | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const normalized = normalizeTargetAlias(parsed.data);
  return normalized || null;
}

function normalizeTargetAlias(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "gateway" || lower === "local") {
    return "gsv";
  }
  return trimmed;
}

function targetMatchesScope(scope: ToolApprovalTarget | undefined, target: string, metadata?: ProcessApprovalTarget): boolean {
  if (!scope || scope === "*" || scope === "any") {
    return true;
  }
  if (scope === "targets/*" || scope === "devices/*") {
    return target !== "gsv";
  }
  if (isToolApprovalTargetSelector(scope)) {
    return metadata?.targetId === target && metadata.route.kind === scope.route
      && (!scope.platform || metadata.platform === scope.platform);
  }
  if (target === "targets/*") {
    return scope === "targets/*" || scope === "devices/*";
  }
  return scope === target;
}

function targetScopeSpecificity(scope: ToolApprovalTarget | undefined): number {
  if (!scope || scope === "*" || scope === "any") {
    return 0;
  }
  if (scope === "targets/*" || scope === "devices/*" || scope === "gsv") {
    return 1;
  }
  if (isToolApprovalTargetSelector(scope)) return scope.platform ? 3 : 2;
  return 4;
}
