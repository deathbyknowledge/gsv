-- The operator's move of every Ship's contacts to DIDs, one row per Ship. Its
-- survey records how other Ships named its person before DIDs, the DID that
-- names them now, and whom its own rows name; its move records what moved.
-- Rows hold DIDs, handles and counts, never contact names or messages.
CREATE TABLE identity_moves (
  installation_id TEXT PRIMARY KEY,
  state           TEXT NOT NULL CHECK (state IN ('surveying', 'surveyed', 'moving', 'moved')),
  ship_id         TEXT,
  subject_id      TEXT,
  did             TEXT,
  handle          TEXT,
  survey_json     TEXT,
  move_json       TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- A claimed attempt moves this past its lease, so another job leaves the Ship alone.
  next_attempt_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((ship_id IS NULL) = (did IS NULL) AND (subject_id IS NULL) = (did IS NULL)),
  CHECK (state = 'surveying' OR survey_json IS NOT NULL)
);

CREATE INDEX identity_moves_due ON identity_moves (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE UNIQUE INDEX identity_moves_person ON identity_moves (ship_id, subject_id) WHERE ship_id IS NOT NULL;
CREATE UNIQUE INDEX identity_moves_did ON identity_moves (did) WHERE did IS NOT NULL;
