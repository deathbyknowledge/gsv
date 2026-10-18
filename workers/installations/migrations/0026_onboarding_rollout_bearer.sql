ALTER TABLE installation_onboarding_claims ADD COLUMN legacy_token_hash TEXT;
ALTER TABLE installation_onboarding_claims ADD COLUMN legacy_expires_at INTEGER;

-- Migration 0025 blocks further old issuers. Retain capabilities already committed
-- before that fence so their in-flight responses stay usable for their original lifetime.
UPDATE installation_onboarding_claims
SET legacy_token_hash = token_hash, legacy_expires_at = expires_at
WHERE issuer_version = 0 AND completed_at IS NULL AND revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM installations WHERE id = installation_onboarding_claims.installation_id AND owner_setup = 1);
