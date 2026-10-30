import type { SqlMigration } from "../../schema/runner";

const STORED_POLICIES = "(key = 'config/ai/tools/approval' OR key LIKE 'users/%/ai/tools/approval')";

/**
 * A call speaks for the owner, so saved policies that allow by default gain the
 * same `sys.phone.call` ask rule new policies start with, unless they already
 * name a rule for it.
 */
const ASK_BEFORE_CALLS = `
  UPDATE config_kv
  SET value = json_insert(value, '$.rules[#]', json('{"match":"sys.phone.call","action":"ask"}'))
  WHERE ${STORED_POLICIES}
    AND json_valid(value)
    AND json_type(value, '$.rules') = 'array'
    AND coalesce(json_extract(value, '$.default'), 'auto') = 'auto'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(config_kv.value, '$.rules') AS rule
      WHERE rule.type = 'object'
        AND json_type(rule.value, '$.match') = 'text'
        AND trim(json_extract(rule.value, '$.match')) IN ('sys.phone.call', 'sys.phone.*', 'sys.*')
    )
`;

/**
 * The Kernel's view of each call the calls service placed for an owner: the
 * newest revision it applied, the question it last raised with Ship, and
 * whether it has settled the ended call. Settled calls never change again.
 */
export const KERNEL_V085_PHONE_CALLS: SqlMigration = {
  id: 85,
  name: "phone_calls",
  statements: [
    `
      CREATE TABLE phone_calls (
        call_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        asked_question_id TEXT,
        transcript_path TEXT,
        settled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    "CREATE INDEX phone_calls_owner ON phone_calls (owner_uid, settled_at)",
    ASK_BEFORE_CALLS,
  ],
};
