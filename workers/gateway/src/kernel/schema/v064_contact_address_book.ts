import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V064_CONTACT_ADDRESS_BOOK: SqlMigration = {
  id: 64,
  name: "contact_address_book",
  statements: [
    "CREATE INDEX federation_contacts_address_book ON federation_contacts (owner_uid, saved, contact_id)",
    "CREATE INDEX federation_contacts_owner_page ON federation_contacts (owner_uid, contact_id)",
    "CREATE INDEX social_approaches_actor ON social_approaches (owner_uid, remote_ship_id, remote_subject_id, created_at DESC)",
    "ALTER TABLE federation_actor_blocks ADD COLUMN display_name TEXT",
    "ALTER TABLE federation_actor_blocks ADD COLUMN origin TEXT",
    `UPDATE federation_actor_blocks AS b SET
      display_name = (SELECT COALESCE(c.local_alias, c.remote_display_name) FROM federation_contacts c WHERE c.owner_uid = b.owner_uid AND c.remote_ship_id = b.ship_id AND c.remote_subject_id = b.subject_id),
      origin = (SELECT c.remote_origin FROM federation_contacts c WHERE c.owner_uid = b.owner_uid AND c.remote_ship_id = b.ship_id AND c.remote_subject_id = b.subject_id)`,
  ],
};
