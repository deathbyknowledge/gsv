ALTER TABLE product_email_signups ADD COLUMN source TEXT NOT NULL DEFAULT 'ship-signup';

-- Recheck earlier deliveries for the user tag with a new idempotency key.
-- Keep the original signup evidence and let Buttondown suppress unsubscribed addresses.
UPDATE product_email_signups
SET request_id = request_id || ':user', completed_at = NULL, attempts = 0,
    due_at = unixepoch() * 1000, last_error = NULL;

-- Snapshot existing verified owners; future signups still require their checkbox.
INSERT INTO product_email_signups (
  email, principal_id, request_id, wording_version, locale,
  requested_at, verified_at, due_at, source
)
SELECT p.primary_email_normalized, p.id, lower(hex(randomblob(16))),
       'operator-backfill-2026-10-30', 'und', unixepoch() * 1000,
       p.email_verified_at, unixepoch() * 1000, 'ship-existing-user-backfill'
FROM principals p
WHERE p.state = 'active' AND p.email_verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM installations i WHERE i.owner_principal_id = p.id AND i.state = 'active'
  )
ON CONFLICT(email) DO NOTHING;
