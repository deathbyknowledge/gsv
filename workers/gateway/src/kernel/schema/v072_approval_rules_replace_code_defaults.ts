import type { SqlMigration } from "../../schema/runner";

const STORED_POLICIES = "(key = 'config/ai/tools/approval' OR key LIKE 'users/%/ai/tools/approval')";

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
        WHERE CASE WHEN rule.type = 'object' THEN trim(json_extract(rule.value, '$.match')) END
          IN ('${syscall}', '${syscall}.*', '${domain}.*')
          AND (coalesce(trim(json_extract(rule.value, '$.target')), '*') IN ('*', 'gsv')
            OR lower(trim(json_extract(rule.value, '$.target'))) IN ('any', 'gateway', 'local'))
      )
  `;
}

export const KERNEL_V072_APPROVAL_RULES_REPLACE_CODE_DEFAULTS: SqlMigration = {
  id: 72,
  name: "approval_rules_replace_code_defaults",
  statements: ["mail.send", "sched.add", "sched.update", "approach.create"].map(askWhereCodeDid),
};
