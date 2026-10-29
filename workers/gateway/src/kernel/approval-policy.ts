import type { ToolApprovalRule } from "@humansandmachines/gsv/protocol";
import { parseToolApprovalPolicy, readToolApprovalPolicy } from "../process/approval";
import type { KernelContext } from "./context";

const SYSTEM_APPROVAL_POLICY_KEY = "config/ai/tools/approval";

function ownerApprovalPolicyKey(ownerUid: number): string {
  return `users/${ownerUid}/ai/tools/approval`;
}

/**
 * The one approval policy every process of a human owner runs under: the
 * owner's list, or the system list until the owner has one.
 */
export function readOwnerApprovalPolicy(config: KernelContext["config"], ownerUid: number): string | null {
  return config.get(ownerApprovalPolicyKey(ownerUid)) ?? config.get(SYSTEM_APPROVAL_POLICY_KEY) ?? null;
}

/**
 * "Always allow" adds a run rule for one syscall on one target to the owner's
 * list, starting that list from the system one when the owner has none yet.
 * Returns false when the rule is too broad or the stored list cannot be read.
 */
export function allowInOwnerApprovalPolicy(
  config: KernelContext["config"],
  ownerUid: number,
  allow: { match: string; target: string },
): boolean {
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(allow.match) || !isConcreteTarget(allow.target)) return false;
  const key = ownerApprovalPolicyKey(ownerUid);
  const stored = config.get(key);
  const policy = stored
    ? readToolApprovalPolicy(stored)
    : parseToolApprovalPolicy(config.get(SYSTEM_APPROVAL_POLICY_KEY));
  if (!policy) return false;
  const rule: ToolApprovalRule = { match: allow.match, target: allow.target, action: "auto" };
  const rules = policy.rules.filter((entry) => entry.match !== rule.match || entry.target !== rule.target);
  config.set(key, JSON.stringify({ default: policy.default, rules: [rule, ...rules] }));
  return true;
}

function isConcreteTarget(target: string): boolean {
  return target.trim() === target && target !== "" && !["*", "any", "device", "devices/*", "targets/*"].includes(target);
}
