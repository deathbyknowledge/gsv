ALTER TABLE provisioning_operations
ADD COLUMN owner_username TEXT;

ALTER TABLE provisioning_operations
ADD COLUMN agent_name TEXT;

ALTER TABLE provisioning_operations
ADD COLUMN timezone TEXT;

CREATE INDEX installations_owner_idx
ON installations (owner_principal_id, created_at DESC);

CREATE INDEX installations_reservation_expiry_idx
ON installations (state, reservation_expires_at);
