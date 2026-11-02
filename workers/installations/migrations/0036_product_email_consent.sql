ALTER TABLE product_email_signups ADD COLUMN consented_at INTEGER;
ALTER TABLE product_email_signups ADD COLUMN consent_basis TEXT NOT NULL DEFAULT 'signup-checkbox';
ALTER TABLE product_email_signups ADD COLUMN import_id TEXT;

UPDATE product_email_signups SET consented_at = requested_at WHERE source = 'ship-signup';

-- Earlier PR previews ran an automatic backfill. Those rows require an explicit
-- operator import before delivery; completed deliveries are never replayed.
UPDATE product_email_signups SET consent_basis = 'unconfirmed-legacy-backfill'
WHERE source = 'ship-existing-user-backfill';

-- 0035 also reset earlier signup deliveries. Their old completion state cannot
-- be recovered, so require operator approval before those requests run again.
UPDATE product_email_signups SET consent_basis = 'unconfirmed-legacy-replay'
WHERE source = 'ship-signup' AND request_id LIKE '%:user' AND completed_at IS NULL;
