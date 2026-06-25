import { parseApprovalPolicy } from "./agents-domain";
import type { ApprovalAction, ApprovalPolicy, ApprovalRule } from "./types";

export type PermissionTone = "good" | "warning" | "danger" | "neutral";

export type PermissionSummary = {
  mode: "inherited" | "custom";
  headline: string;
  defaultLabel: string;
  detail: string;
  tone: PermissionTone;
  editable: boolean;
  lockLabel: string;
  askCount: number;
  denyCount: number;
  autoCount: number;
  ruleCount: number;
  riskyRules: ApprovalRule[];
  policy: ApprovalPolicy;
};

export function summarizePermissions(raw: string, editable: boolean): PermissionSummary {
  const trimmed = raw.trim();
  const inherited = trimmed.length === 0;
  const policy = parseApprovalPolicy(trimmed);
  const askCount = countAction(policy.rules, "ask");
  const denyCount = countAction(policy.rules, "deny");
  const autoCount = countAction(policy.rules, "auto");
  const riskyRules = policy.rules.filter(isRiskyRule);
  const ruleCount = policy.rules.length;
  const defaultLabel = inherited ? "System default" : actionLabel(policy.default);

  return {
    mode: inherited ? "inherited" : "custom",
    headline: inherited ? "Inherits system policy" : `${actionLabel(policy.default)} by default`,
    defaultLabel,
    detail: permissionDetail({ inherited, ruleCount, askCount, denyCount, autoCount }),
    tone: permissionTone(policy, inherited),
    editable,
    lockLabel: editable ? "Editable" : "Read-only",
    askCount,
    denyCount,
    autoCount,
    ruleCount,
    riskyRules,
    policy,
  };
}

export function actionLabel(action: ApprovalAction): string {
  switch (action) {
    case "auto": return "Allow";
    case "ask": return "Ask";
    case "deny": return "Deny";
  }
}

export function ruleLabel(rule: ApprovalRule): string {
  return `${rule.match || "unnamed rule"} -> ${actionLabel(rule.action)}`;
}

function countAction(rules: ApprovalRule[], action: ApprovalAction): number {
  return rules.filter((rule) => rule.action === action).length;
}

function permissionDetail({
  inherited,
  ruleCount,
  askCount,
  denyCount,
  autoCount,
}: {
  inherited: boolean;
  ruleCount: number;
  askCount: number;
  denyCount: number;
  autoCount: number;
}): string {
  if (inherited) {
    return "Uses the system approval policy.";
  }
  if (ruleCount === 0) {
    return "No custom tool rules.";
  }
  const parts = [
    askCount > 0 ? `${askCount} ask` : "",
    denyCount > 0 ? `${denyCount} deny` : "",
    autoCount > 0 ? `${autoCount} allow` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : `${ruleCount} custom rules`;
}

function permissionTone(policy: ApprovalPolicy, inherited: boolean): PermissionTone {
  if (policy.default === "auto") return "danger";
  if (policy.rules.some((rule) => rule.action === "auto" && isRiskyRule(rule))) return "danger";
  if (policy.default === "deny" || policy.rules.some((rule) => rule.action === "deny")) return "warning";
  if (inherited || policy.default === "ask") return "neutral";
  return "good";
}

function isRiskyRule(rule: ApprovalRule): boolean {
  const match = rule.match.toLowerCase();
  return match === "fs.delete" ||
    match === "shell.exec" ||
    match === "sys.mcp.call" ||
    match.includes("delete") ||
    match.includes("shell") ||
    match.includes("mcp");
}
