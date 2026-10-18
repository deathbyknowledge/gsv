ALTER TABLE installation_onboarding_claims ADD COLUMN issuer_version INTEGER NOT NULL DEFAULT 0;

-- Reject pre-upgrade issuers before their unconditional upsert can invalidate a resumed setup.
-- Existing capabilities and completed provisioning remain valid; an old request can retry on the new worker.
CREATE TRIGGER installation_onboarding_claims_issuer_insert
BEFORE INSERT ON installation_onboarding_claims
WHEN NEW.issuer_version = 0 AND EXISTS (
  SELECT 1 FROM installations WHERE id = NEW.installation_id AND owner_setup = 1
)
BEGIN
  SELECT RAISE(ABORT, 'onboarding issuer has changed; retry setup');
END;
