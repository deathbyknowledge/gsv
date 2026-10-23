-- Public username policy: exact normalized matches, independent of identity storage.
CREATE TABLE username_policy (
  kind TEXT NOT NULL CHECK (kind IN ('reserved', 'blocked')),
  normalized_handle TEXT NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (kind, normalized_handle)
);
