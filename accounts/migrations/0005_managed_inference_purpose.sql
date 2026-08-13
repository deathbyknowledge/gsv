ALTER TABLE managed_inference_usage_events
ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'
CHECK (purpose IN ('agent', 'mail-intake'));

CREATE INDEX managed_inference_usage_purpose_idx
ON managed_inference_usage_events (
  period,
  purpose,
  installation_id,
  completed_at
);
