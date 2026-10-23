import type { SqlMigration } from "../../schema/runner";

const STORED_POLICIES = "(key = 'config/ai/tools/approval' OR key LIKE 'users/%/ai/tools/approval')";

/**
 * Mail, schedules and approaches used to ask from code when a saved policy
 * allowed by default and named no rule for them. Those asks are now ordinary
 * default rules, so saved policies gain the same rule where code supplied it.
 */
const RULE_TARGET = "json_extract(rule.value, '$.target')";
const LEGACY_WHEN_TARGET = "json_extract(rule.value, '$.when.target')";

function anyTarget(value: string): string {
  return `(coalesce(trim(${value}), '') IN ('', '*') OR lower(trim(${value})) = 'any')`;
}

function gsvTarget(value: string): string {
  return `(trim(${value}) = 'gsv' OR lower(trim(${value})) IN ('gateway', 'local'))`;
}

/**
 * Whether a stored rule applies to `gsv`, read as `parseRule` reads it: an
 * unscoped `target` falls back to the legacy `when.target`, a selector never
 * names `gsv`, and a rule with an unreadable target or action is dropped.
 */
const RULE_COVERS_GSV = `
  CASE
    WHEN json_extract(rule.value, '$.action') NOT IN ('auto', 'ask', 'deny')
      OR json_type(rule.value, '$.action') <> 'text' THEN 0
    WHEN json_type(rule.value, '$.target') = 'object' THEN 0
    WHEN json_type(rule.value, '$.target') <> 'text' THEN 0
    WHEN NOT ${anyTarget(RULE_TARGET)} THEN ${gsvTarget(RULE_TARGET)}
    WHEN json_type(rule.value, '$.when.target') = 'text' AND NOT ${anyTarget(LEGACY_WHEN_TARGET)}
      THEN ${gsvTarget(LEGACY_WHEN_TARGET)}
    ELSE 1
  END`;

/**
 * Mail, schedules and approaches used to ask from code when a saved policy
 * allowed by default and named no rule for them. Those asks are now ordinary
 * default rules, so saved policies gain the same rule where code supplied it.
 */
function askWhereCodeDid(syscall: string): string {
  const domain = syscall.slice(0, syscall.indexOf("."));
  return `
    UPDATE config_kv
    SET value = json_insert(value, '$.rules[#]', json('{"match":"${syscall}","action":"ask"}'))
    WHERE ${STORED_POLICIES}
      AND json_valid(value)
      AND json_type(value, '$.rules') = 'array'
      AND coalesce(json_extract(value, '$.default'), 'auto') = 'auto'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(config_kv.value, '$.rules') AS rule
        WHERE rule.type = 'object'
          AND json_type(rule.value, '$.match') = 'text'
          AND trim(json_extract(rule.value, '$.match')) IN ('${syscall}', '${syscall}.*', '${domain}.*')
          AND ${RULE_COVERS_GSV}
      )
  `;
}

export const KERNEL_V072_APPROVAL_RULES_REPLACE_CODE_DEFAULTS: SqlMigration = {
  id: 72,
  name: "approval_rules_replace_code_defaults",
  statements: ["mail.send", "sched.add", "sched.update", "approach.create"].map(askWhereCodeDid),
};
