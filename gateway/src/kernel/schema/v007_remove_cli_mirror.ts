import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V007_REMOVE_CLI_MIRROR: SqlMigration = {
  id: 7,
  name: "remove_cli_mirror",
  statements: [
    "DELETE FROM group_capabilities WHERE capability = 'sys.update'",
    "DELETE FROM config_kv WHERE key LIKE 'config/downloads/cli/%'",
  ],
};
