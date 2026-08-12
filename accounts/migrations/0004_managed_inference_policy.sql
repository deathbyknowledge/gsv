CREATE TABLE managed_inference_control (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);

INSERT INTO managed_inference_control (singleton, enabled, updated_at)
VALUES (1, 0, 0);

CREATE TABLE managed_inference_policies (
  installation_id        TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  enabled                INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  monthly_limit_nano_usd INTEGER NOT NULL CHECK (monthly_limit_nano_usd >= 0),
  updated_at             INTEGER NOT NULL
);
