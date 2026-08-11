CREATE TABLE managed_inference_usage_events (
  installation_id       TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  logical_request_id     TEXT NOT NULL,
  period                 TEXT NOT NULL,
  local_uid              INTEGER NOT NULL,
  process_id             TEXT,
  run_id                 TEXT,
  model                  TEXT NOT NULL,
  response_model         TEXT,
  provider_response_id   TEXT,
  input_tokens           INTEGER NOT NULL,
  output_tokens          INTEGER NOT NULL,
  cache_read_tokens      INTEGER NOT NULL,
  cache_write_tokens     INTEGER NOT NULL,
  total_tokens           INTEGER NOT NULL,
  reserved_nano_usd      INTEGER NOT NULL,
  cost_nano_usd          INTEGER NOT NULL,
  outcome                TEXT NOT NULL CHECK (outcome IN (
    'completed', 'failed', 'aborted', 'abandoned'
  )),
  stop_reason             TEXT,
  started_at              INTEGER NOT NULL,
  completed_at            INTEGER NOT NULL,
  received_at             INTEGER NOT NULL,
  PRIMARY KEY (installation_id, logical_request_id)
);

CREATE INDEX managed_inference_usage_period_idx
ON managed_inference_usage_events (period, installation_id, completed_at);
