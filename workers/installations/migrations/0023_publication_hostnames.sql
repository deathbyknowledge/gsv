CREATE TABLE publication_hostnames (
  hostname TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (installation_id, site_id)
);
CREATE INDEX publication_hostnames_installation ON publication_hostnames (installation_id);
