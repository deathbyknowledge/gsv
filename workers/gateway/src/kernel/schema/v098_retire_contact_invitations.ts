import type { SqlMigration } from "../../schema/runner";

// People invite others with a reusable link that leads to an ordinary message request, so
// single-use contact invitations and the pairing attempts that accepted them are gone.
export const KERNEL_V098_RETIRE_CONTACT_INVITATIONS: SqlMigration = {
  id: 98,
  name: "retire_contact_invitations",
  statements: [
    "DROP TABLE federation_pairing_attempts",
    "DROP TABLE federation_invites",
    "DELETE FROM owner_notices WHERE topic = 'contact.invite.accepted'",
    "DELETE FROM notice_rules WHERE kind = 'contact.invite.accepted'",
    // Without invitations, a profile that took only invited people takes no requests.
    `UPDATE social_profiles SET draft_json = json_set(draft_json, '$.contactPolicy', 'closed')
      WHERE json_extract(draft_json, '$.contactPolicy') = 'invitation'`,
  ],
};
