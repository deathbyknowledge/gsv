import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V053_TRACK_REQUEST_EXCHANGES: SqlMigration = {
  id: 53,
  name: "track_request_exchanges",
  statements: [
    `ALTER TABLE federation_requests ADD COLUMN exchange_state TEXT NOT NULL
      DEFAULT 'unconfirmed' CHECK (exchange_state IN ('pending', 'acknowledged', 'failed', 'unconfirmed'))`,
    "ALTER TABLE federation_requests ADD COLUMN exchange_delivery_id TEXT",
    "ALTER TABLE federation_requests ADD COLUMN exchange_error TEXT",
    "ALTER TABLE federation_requests ADD COLUMN exchange_source TEXT CHECK (exchange_source IN ('local', 'remote'))",
    `CREATE INDEX federation_requests_exchange_idx ON federation_requests (exchange_delivery_id)
      WHERE exchange_delivery_id IS NOT NULL`,
    `UPDATE federation_requests AS r SET
       exchange_state = 'acknowledged', exchange_source = 'remote', exchange_delivery_id = i.delivery_id
     FROM federation_inbox AS i
     WHERE i.state = 'received' AND json_extract(i.payload_json, '$.kind') = 'request.update'
       AND i.contact_id = r.contact_id AND i.contact_generation = r.contact_generation
       AND json_extract(i.payload_json, '$.requestId') = CASE r.direction
         WHEN 'outgoing' THEN r.request_id ELSE r.remote_request_id END
       AND r.revision = json_extract(i.payload_json, '$.expectedRevision') + 1
       AND r.state = json_extract(i.payload_json, '$.state') AND r.updated_at = i.received_at`,
  ],
};
