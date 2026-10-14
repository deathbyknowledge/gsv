import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V069_SINGLE_HUMAN_SPACE: SqlMigration = {
  id: 69,
  name: "single_human_space",
  statements: [
    "DROP TABLE human_invitations",
    "UPDATE social_profiles SET draft_json = json_remove(draft_json, '$.alias')",
    "DROP TABLE social_profile_aliases",
  ],
};
