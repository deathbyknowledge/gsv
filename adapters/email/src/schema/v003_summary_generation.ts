import type { MailSqlMigration } from "./migrations";

export const MAIL_V003_SUMMARY_GENERATION: MailSqlMigration = {
  id: 3,
  name: "mail_summary_generation",
  statements: [
    `
      ALTER TABLE mail_intakes
      ADD COLUMN summary_generation INTEGER NOT NULL DEFAULT 1
        CHECK (summary_generation > 0)
    `,
  ],
};
