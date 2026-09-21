import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V056_SEPARATE_SOCIAL_ATTENTION: SqlMigration = {
  id: 56,
  name: "separate_social_attention",
  statements: [
    `CREATE TABLE federation_attention_notices (
      owner_uid INTEGER PRIMARY KEY,
      previous_contact_added INTEGER NOT NULL CHECK (previous_contact_added IN (0, 1)),
      previous_received INTEGER NOT NULL CHECK (previous_received IN (0, 1)),
      dismissed_at INTEGER
    )`,
    `INSERT INTO federation_attention_notices (owner_uid, previous_contact_added, previous_received)
     SELECT owners.owner_uid,
       COALESCE((SELECT enabled FROM responsibility_source_policies p
         WHERE p.owner_uid = owners.owner_uid AND p.source_id = 'contact.added'), 1),
       COALESCE((SELECT enabled FROM responsibility_source_policies p
         WHERE p.owner_uid = owners.owner_uid AND p.source_id = 'federation.received'), 1)
     FROM (
       SELECT owner_uid FROM federation_contacts
       UNION SELECT owner_uid FROM responsibility_source_policies
         WHERE source_id IN ('contact.added', 'federation.received')
     ) owners`,
    "DELETE FROM responsibility_source_policies WHERE source_id IN ('contact.added', 'federation.received')",
  ],
};
