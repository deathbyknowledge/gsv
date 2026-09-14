import type { MailSqlMigration } from "./migrations";

export const MAIL_V005_RETIREMENT: MailSqlMigration = {
  id: 5,
  name: "mail_installation_retirement",
  statements: [
    `CREATE TABLE mail_retirement (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), installation_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('quiescing', 'quiesced', 'erasing', 'live-erased')),
      updated_at INTEGER NOT NULL
    )`,
    ...["mail_intake_chunks", "mail_intake_uploads", "mail_intakes", "mail_outbound_deliveries", "mail_daily_usage", "mail_installation_identity"].flatMap((table) => [
      `CREATE TRIGGER ${table}_retired_insert BEFORE INSERT ON ${table}
       WHEN EXISTS (SELECT 1 FROM mail_retirement)
       BEGIN SELECT RAISE(ABORT, 'Mail installation is retired'); END`,
      `CREATE TRIGGER ${table}_retired_update BEFORE UPDATE ON ${table}
       WHEN EXISTS (SELECT 1 FROM mail_retirement)
       BEGIN SELECT RAISE(ABORT, 'Mail installation is retired'); END`,
    ]),
  ],
};
