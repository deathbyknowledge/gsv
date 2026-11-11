ALTER TABLE installations ADD COLUMN signup_at INTEGER;
WITH RECURSIVE cohorts(id, signup_at) AS (
  SELECT id, created_at FROM installations i
  WHERE NOT EXISTS (SELECT 1 FROM installation_reset_operations r WHERE r.replacement_installation_id = i.id)
  UNION ALL
  SELECT r.replacement_installation_id, c.signup_at FROM cohorts c
  JOIN installation_reset_operations r ON r.previous_installation_id = c.id
)
UPDATE installations SET signup_at = COALESCE((SELECT signup_at FROM cohorts WHERE cohorts.id = installations.id), created_at);

CREATE TABLE installation_activity (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id),
  captured_at INTEGER, attempted_at INTEGER NOT NULL DEFAULT 0,
  tracked_from INTEGER, first_active_at INTEGER, last_active_at INTEGER,
  messages INTEGER, tasks INTEGER, successful_tasks INTEGER, failed_tasks INTEGER, aborted_tasks INTEGER,
  availability TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE installation_activity_days (
  installation_id TEXT NOT NULL REFERENCES installations(id),
  day TEXT NOT NULL, messages INTEGER NOT NULL, captured_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, day)
);
CREATE TABLE installation_outreach (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id),
  status TEXT NOT NULL DEFAULT 'not_contacted' CHECK (status IN ('not_contacted', 'emailed', 'replied', 'follow_up', 'not_applicable')),
  notes TEXT NOT NULL DEFAULT '', last_contacted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE installation_outreach_history (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id),
  actor TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL, last_contacted_at INTEGER,
  revision INTEGER NOT NULL, UNIQUE (installation_id, revision)
);
CREATE INDEX installation_outreach_history_user ON installation_outreach_history(installation_id, at DESC);
CREATE TRIGGER installation_outreach_insert AFTER INSERT ON installation_outreach BEGIN
  INSERT INTO installation_outreach_history VALUES (lower(hex(randomblob(16))), NEW.installation_id, NEW.updated_by,
    NEW.updated_at, NEW.status, NEW.notes, NEW.last_contacted_at, NEW.revision);
END;
CREATE TRIGGER installation_outreach_update AFTER UPDATE ON installation_outreach BEGIN
  INSERT INTO installation_outreach_history VALUES (lower(hex(randomblob(16))), NEW.installation_id, NEW.updated_by,
    NEW.updated_at, NEW.status, NEW.notes, NEW.last_contacted_at, NEW.revision);
END;
