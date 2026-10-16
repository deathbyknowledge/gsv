import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V071_TOKEN_CEILINGS: SqlMigration = {
  id: 71,
  name: "token_ceilings",
  statements: ["ALTER TABLE auth_tokens ADD COLUMN ceiling TEXT"],
};
