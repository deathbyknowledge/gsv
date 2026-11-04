import type { SqlMigration } from "../../schema/runner";

/**
 * Contact attention, contact request and failed delivery records hold the contact's own name
 * and words, but earlier releases stored them unlabelled or as local. The data notice now follows the label,
 * so stored records gain it once instead of losing the notice on upgrade.
 */
export const KERNEL_V091_OUTSIDE_TEXT_LABELS: SqlMigration = {
  id: 91,
  name: "outside_text_labels",
  statements: [
    `
      UPDATE responsibilities
      SET details_json = json_set(coalesce(details_json, '{}'), '$.contentTrust', 'untrusted')
      WHERE (
          dedupe_key LIKE 'contact.handoff:%'
          OR json_extract(details_json, '$.eventType') IN ('federation.request', 'federation.delivery.failed')
        )
        AND (details_json IS NULL OR json_valid(details_json))
        AND json_extract(coalesce(details_json, '{}'), '$.contentTrust') IS NOT 'untrusted'
    `,
  ],
};
