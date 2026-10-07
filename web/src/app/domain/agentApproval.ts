import { z } from "zod";

export function approvalTargetFromValue<T>(value: T): string | undefined {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const trimmed = parsed.data.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "any") {
    return undefined;
  }
  if (trimmed === "device" || trimmed === "devices/*") {
    return "targets/*";
  }
  if (trimmed === "gateway" || trimmed === "local") {
    return "gsv";
  }
  return trimmed;
}

export type ApprovalPolicyAction = "auto" | "ask" | "deny";

export type ApprovalPolicyRule = {
  match: string;
  target?: string;
  action: ApprovalPolicyAction;
};

export type ApprovalPolicyValue = {
  default: ApprovalPolicyAction;
  rules: ApprovalPolicyRule[];
};

export function protectManagedMailApproval(policy: ApprovalPolicyValue): ApprovalPolicyValue {
  if (
    policy.default !== "auto"
    || policy.rules.some((rule) =>
      approvalMatchIncludes(rule.match, "mail.send")
      && approvalTargetIncludesGsv(rule.target)
    )
  ) {
    return policy;
  }
  return {
    ...policy,
    rules: [...policy.rules, { match: "mail.send", action: "ask" }],
  };
}

function approvalMatchIncludes(match: string, syscall: string): boolean {
  const normalized = match.trim();
  if (normalized === syscall) {
    return true;
  }
  if (!normalized.endsWith(".*")) {
    return false;
  }
  const domain = normalized.slice(0, -2);
  return syscall === domain || syscall.startsWith(`${domain}.`);
}

function approvalTargetIncludesGsv(target: string | undefined): boolean {
  const normalized = approvalTargetFromValue(target);
  return normalized === undefined || normalized === "gsv";
}

// -----------------------------------------------------------------------------
// The first-approval walkthrough sorts the kinds of action the Ship asks about
// into "allow" or "ask". Each category names the ordinary rules it writes; the
// policy shape and precedence are unchanged, so Settings shows the result as-is.
// -----------------------------------------------------------------------------

export type ApprovalCategoryId = "shell" | "machine-files" | "delete" | "web" | "tools" | "mail";

export type ApprovalChoice = "auto" | "ask";

export type ApprovalCategory = {
  id: ApprovalCategoryId;
  /** What the Ship calls it, lowercase, as a row label. */
  label: string;
  /** One concrete example in the person's words, no trailing period. */
  example: string;
  /** The rules a choice writes; the action is the choice. */
  rules: readonly Pick<ApprovalPolicyRule, "match" | "target">[];
  /** Exact rules an ask choice keeps automatic when the policy has none of its own, so a wildcard
   *  above only moves what the row names. */
  keepsAuto?: readonly Pick<ApprovalPolicyRule, "match" | "target">[];
};

export type ApprovalChoices = Partial<Record<ApprovalCategoryId, ApprovalChoice>>;

export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
  { id: "shell", label: "running commands on your machines", example: "brew upgrade on your laptop", rules: [{ match: "shell.exec", target: "targets/*" }] },
  // Reads, searches and transfers keep their own exact auto rules, so this wildcard only moves changes.
  { id: "machine-files", label: "changing files on your machines", example: "a config file on your laptop", rules: [{ match: "fs.*", target: "targets/*" }],
    keepsAuto: [{ match: "fs.read", target: "targets/*" }, { match: "fs.search", target: "targets/*" }, { match: "fs.transfer.stat", target: "targets/*" }, { match: "fs.transfer.send", target: "targets/*" }] },
  // Exact rules at both scopes, so they beat the file wildcard above and the cloud-home default.
  { id: "delete", label: "deleting files", example: "an old export in your Downloads", rules: [{ match: "fs.delete", target: "gsv" }, { match: "fs.delete", target: "targets/*" }] },
  { id: "web", label: "fetching web pages through your machines", example: "a page on your office network", rules: [{ match: "net.fetch", target: "targets/*" }] },
  { id: "tools", label: "connected tools", example: "an issue through a connected server", rules: [{ match: "sys.mcp.call" }] },
  // Scoped to gsv so an allow choice satisfies the managed-mail guard instead of being re-asked.
  { id: "mail", label: "sending email", example: "a reply to Mike about the contract", rules: [{ match: "mail.send", target: "gsv" }] },
];

/** What a policy does today for each category: deny if any of its rules would block (the row is then
 *  locked so a deliberate denial in any scope is never rewritten), else ask if any would ask, else allow.
 *  A machine-wide rule is also resolved on every machine the policy names, so a rule for one machine
 *  shows in the row rather than hiding behind the wildcard. */
export function currentApprovalChoices(policy: ApprovalPolicyValue): Record<ApprovalCategoryId, ApprovalPolicyAction> {
  const entries = APPROVAL_CATEGORIES.map((category) => {
    const actions = categoryPolicyRules(policy, category)
      .map((rule) => resolveApprovalAction(policy, rule.match, rule.target ?? "gsv"));
    return [category.id, actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "auto"] as const;
  });
  // SAFETY: APPROVAL_CATEGORIES lists every ApprovalCategoryId exactly once, so the entries cover the record.
  return Object.fromEntries(entries) as Record<ApprovalCategoryId, ApprovalPolicyAction>;
}

/** Expand a category at the scopes its existing rules can override. The same
 * rules drive both its displayed choice and the policy it writes. */
function categoryPolicyRules(policy: ApprovalPolicyValue, category: ApprovalCategory): Pick<ApprovalPolicyRule, "match" | "target">[] {
  return category.rules.flatMap((rule) => {
    const target = approvalTargetFromValue(rule.target);
    const scopes = new Set([target]);
    for (const existing of policy.rules) {
      const scope = approvalTargetFromValue(existing.target);
      if (target === "targets/*" && scope && scope !== "gsv") scopes.add(scope);
      else if (target === undefined && scope === "gsv") scopes.add(scope);
    }
    return [...scopes].flatMap((scope) => {
      const matches = new Set([rule.match]);
      for (const existing of policy.rules) {
        if (approvalTargetMatchesScope(existing.target, scope ?? "gsv")
          && approvalMatchIncludes(rule.match, existing.match)
          && !category.keepsAuto?.some((kept) => kept.match === existing.match)
          && !(category.id === "machine-files" && existing.match === "fs.delete")) {
          matches.add(existing.match);
        }
      }
      return [...matches].map((match) => scope ? { match, target: scope } : { match });
    });
  });
}

/** The categories a policy currently asks about, in walkthrough order. */
export function askingCategories(policy: ApprovalPolicyValue): ApprovalCategoryId[] {
  const current = currentApprovalChoices(policy);
  return APPROVAL_CATEGORIES.filter((category) => current[category.id] === "ask").map((category) => category.id);
}

/** The account whose approval override a persistent choice must write. The Kernel resolves the run-as
 *  account's own override before the owner's, so a process whose account has one reads that key; until
 *  the process's account is known there is no safe target, and persistent controls stay off. */
export function approvalPolicyAccount(input: { ownerUid: number; processUid: number | null; processOverride: string }): number | null {
  if (input.processUid === null) return null;
  return input.processUid !== input.ownerUid && input.processOverride !== "" ? input.processUid : input.ownerUid;
}

/** Replace the first rule with the same capability and scope, or append; every other rule keeps its place. */
export function upsertApprovalRule(policy: ApprovalPolicyValue, rule: ApprovalPolicyRule): ApprovalPolicyValue {
  const next: ApprovalPolicyRule = { match: rule.match, action: rule.action };
  const target = approvalTargetFromValue(rule.target);
  if (target) next.target = target;
  const at = policy.rules.findIndex((entry) =>
    entry.match === next.match && approvalTargetFromValue(entry.target) === target);
  return {
    default: policy.default,
    rules: at >= 0 ? policy.rules.map((entry, index) => index === at ? next : entry) : [...policy.rules, next],
  };
}

/** The complete account policy the walkthrough writes: the current override, else the inherited
 *  policy, with each chosen category's rules set to the choice. `default` is never changed. */
export function composeApprovalChoices(
  inherited: ApprovalPolicyValue,
  current: ApprovalPolicyValue | null,
  choices: ApprovalChoices,
): ApprovalPolicyValue {
  const base = current ?? inherited;
  let policy: ApprovalPolicyValue = { default: base.default, rules: [...base.rules] };
  for (const category of APPROVAL_CATEGORIES) {
    const action = choices[category.id];
    if (!action) continue;
    if (currentApprovalChoices(base)[category.id] === "deny") continue;
    const before = policy;
    const rules = categoryPolicyRules(before, category);
    for (const rule of rules) {
      if (resolveApprovalAction(policy, rule.match, rule.target ?? "gsv") !== action) {
        policy = upsertApprovalRule(policy, { ...rule, action });
      }
    }
    // File reads and transfers are separate from changes. Deletes keep what they
    // resolved to as well: that row owns them, and its own pick, applied after
    // this one, is the only thing that moves them.
    const preserved = (category.keepsAuto ?? []).map((rule) => rule.match);
    if (category.id === "machine-files") preserved.push("fs.delete");
    for (const scope of new Set(rules.map((rule) => rule.target))) {
      for (const match of preserved) {
        const previous = resolveApprovalAction(before, match, scope ?? "gsv");
        if (resolveApprovalAction(policy, match, scope ?? "gsv") !== previous) {
          policy = upsertApprovalRule(policy, { match, target: scope, action: previous });
        }
      }
    }
  }
  return protectManagedMailApproval(policy);
}

/** The rule "always allow this" writes: exactly this capability, exactly where it was asked. */
export function approvalRuleForRequest(syscall: string, target: string): ApprovalPolicyRule {
  const scope = approvalTargetFromValue(target);
  return scope ? { match: syscall, target: scope, action: "auto" } : { match: syscall, action: "auto" };
}

/** Mirrors the gateway's resolution: most specific target, then exact match over wildcard, then list order. */
export function resolveApprovalAction(policy: ApprovalPolicyValue, syscall: string, target: string): ApprovalPolicyAction {
  const scope = approvalTargetFromValue(target) ?? "gsv";
  const candidates = policy.rules
    .map((rule, index) => ({
      rule,
      index,
      match: rule.match === syscall ? 2 : approvalMatchIncludes(rule.match, syscall) ? 1 : 0,
      target: approvalTargetSpecificity(rule.target),
    }))
    .filter((entry) => entry.match > 0 && approvalTargetMatchesScope(entry.rule.target, scope))
    .sort((left, right) => right.target - left.target || right.match - left.match || left.index - right.index);
  const rule = candidates[0]?.rule;
  if (rule) return rule.action;
  if (syscall === "mail.send" && policy.default === "auto") return "ask";
  return policy.default;
}

function approvalTargetMatchesScope(ruleTarget: string | undefined, scope: string): boolean {
  const normalized = approvalTargetFromValue(ruleTarget);
  if (normalized === undefined) return true;
  if (normalized === "targets/*") return scope !== "gsv";
  if (scope === "targets/*") return normalized === "targets/*";
  return normalized === scope;
}

function approvalTargetSpecificity(ruleTarget: string | undefined): number {
  const normalized = approvalTargetFromValue(ruleTarget);
  if (normalized === undefined) return 0;
  return normalized === "targets/*" || normalized === "gsv" ? 1 : 2;
}
