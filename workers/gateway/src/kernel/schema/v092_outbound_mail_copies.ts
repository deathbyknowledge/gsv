import type { SqlMigration } from "../../schema/runner";

/**
 * Outbound mail can copy recipients. `to_address` already holds the To list in
 * header form; a single address is a list of one, so existing intents need no
 * rewrite. `cc_addresses` holds copies in the same form, null when there are none.
 */
export const KERNEL_V092_OUTBOUND_MAIL_COPIES: SqlMigration = {
  id: 92,
  name: "outbound_mail_copies",
  statements: [
    "ALTER TABLE mail_outbound ADD COLUMN cc_addresses TEXT",
  ],
};
