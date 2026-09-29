PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  id                       TEXT PRIMARY KEY,
  primary_email            TEXT NOT NULL,
  primary_email_normalized TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  email_verified_at        INTEGER,
  state                    TEXT NOT NULL CHECK (state IN ('pending', 'active', 'recovery', 'disabled')),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE installations (
  id                     TEXT PRIMARY KEY,
  owner_principal_id     TEXT NOT NULL REFERENCES principals(id),
  handle                 TEXT NOT NULL UNIQUE,
  canonical_origin       TEXT NOT NULL UNIQUE,
  state                  TEXT NOT NULL CHECK (state IN (
    'reserved', 'provisioning', 'trialing', 'active', 'past_due',
    'restricted', 'cancelled', 'retained', 'deleting', 'deleted'
  )),
  provision_version      INTEGER NOT NULL,
  reservation_expires_at INTEGER,
  created_at             INTEGER NOT NULL,
  activated_at           INTEGER,
  retained_until         INTEGER,
  deleted_at             INTEGER
);

CREATE TABLE hostnames (
  normalized_hostname TEXT PRIMARY KEY,
  installation_id     TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('canonical', 'alias')),
  state               TEXT NOT NULL CHECK (state IN ('reserved', 'provisioning', 'active', 'retired')),
  created_at          INTEGER NOT NULL,
  retired_at          INTEGER
);

CREATE INDEX hostnames_installation_idx
ON hostnames (installation_id, state);

CREATE TABLE memberships (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  local_uid       INTEGER,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, principal_id),
  UNIQUE (installation_id, local_uid)
);

CREATE TABLE provisioning_operations (
  operation_id     TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  principal_id     TEXT NOT NULL REFERENCES principals(id),
  kind             TEXT NOT NULL CHECK (kind IN ('create', 'repair')),
  state            TEXT NOT NULL CHECK (state IN ('reserved', 'provisioning', 'complete', 'failed')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX provisioning_installation_idx
ON provisioning_operations (installation_id, updated_at);
