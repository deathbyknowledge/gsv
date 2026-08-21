CREATE TABLE managed_inference_routing (
  singleton                       INTEGER PRIMARY KEY CHECK (singleton = 1),
  model_id                        TEXT NOT NULL,
  display_name                    TEXT NOT NULL,
  context_window                  INTEGER NOT NULL CHECK (context_window > 0),
  max_output_tokens               INTEGER NOT NULL CHECK (max_output_tokens > 0),
  reasoning                       INTEGER NOT NULL CHECK (reasoning IN (0, 1)),
  input_nano_usd_per_token        INTEGER NOT NULL CHECK (input_nano_usd_per_token >= 0),
  output_nano_usd_per_token       INTEGER NOT NULL CHECK (output_nano_usd_per_token >= 0),
  cache_read_nano_usd_per_token   INTEGER NOT NULL CHECK (cache_read_nano_usd_per_token >= 0),
  cache_write_nano_usd_per_token  INTEGER NOT NULL CHECK (cache_write_nano_usd_per_token >= 0),
  allow_fallbacks                 INTEGER NOT NULL CHECK (allow_fallbacks IN (0, 1)),
  require_parameters              INTEGER NOT NULL CHECK (require_parameters IN (0, 1)),
  data_collection                 TEXT NOT NULL CHECK (data_collection IN ('allow', 'deny')),
  zdr                             INTEGER NOT NULL CHECK (zdr IN (0, 1)),
  provider_order_json             TEXT NOT NULL,
  provider_only_json              TEXT NOT NULL,
  provider_ignore_json            TEXT NOT NULL,
  quantizations_json              TEXT NOT NULL,
  provider_sort                   TEXT NOT NULL CHECK (provider_sort IN ('default', 'price', 'throughput', 'latency')),
  preferred_min_throughput        REAL CHECK (preferred_min_throughput > 0),
  preferred_max_latency           REAL CHECK (preferred_max_latency > 0),
  updated_at                      INTEGER NOT NULL
);

INSERT INTO managed_inference_routing (
  singleton, model_id, display_name, context_window, max_output_tokens,
  reasoning, input_nano_usd_per_token, output_nano_usd_per_token,
  cache_read_nano_usd_per_token, cache_write_nano_usd_per_token,
  allow_fallbacks, require_parameters, data_collection, zdr,
  provider_order_json, provider_only_json, provider_ignore_json,
  quantizations_json, provider_sort, preferred_min_throughput,
  preferred_max_latency, updated_at
) VALUES (
  1, 'deepseek/deepseek-v4-flash-0731', 'DeepSeek: DeepSeek V4 Flash 0731',
  1048576, 384000, 1, 80, 180, 16, 0, 1, 0, 'allow', 0,
  '[]', '[]', '[]', '[]', 'default', NULL, NULL, 0
);
