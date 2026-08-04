ALTER TABLE entitlements
ADD COLUMN inference_period_starts_at INTEGER;

ALTER TABLE entitlements
ADD COLUMN inference_period_ends_at INTEGER;

UPDATE entitlements
SET
  inference_period_starts_at = effective_at,
  inference_period_ends_at = effective_at + 2592000000
WHERE inference_period_starts_at IS NULL
   OR inference_period_ends_at IS NULL;
