const SENSITIVE_CONFIG_FIELDS = new Set([
  "api_key",
  "secret",
  "token",
  "password",
  "access_token",
  "refresh_token",
  "client_secret",
]);

const SENSITIVE_CONFIG_SUFFIXES = [
  "_api_key",
  "_secret",
  "_token",
  "_password",
];

/**
 * System configuration is Master-owned. Non-root user Kernels receive only
 * keys whose semantics are deliberately public to every user. Keep this list
 * literal so adding a new ConfigStore default cannot silently expose it.
 */
const SHARED_SYSTEM_CONFIG_KEYS = new Set([
  "config/ai/provider",
  "config/ai/model",
  "config/ai/base_url",
  "config/ai/provider_style",
  "config/ai/transport_target",
  "config/ai/reasoning",
  "config/ai/max_tokens",
  "config/ai/context_window_tokens",
  "config/ai/max_context_bytes",
  "config/ai/generation/timeout_ms",
  "config/ai/generation/streaming",
  "config/ai/fallback_model_profile",
  "config/ai/image/read/provider",
  "config/ai/image/read/model",
  "config/ai/image/read/input_format",
  "config/ai/image/read/max_bytes",
  "config/ai/image/read/max_tokens",
  "config/ai/image/read/timeout_ms",
  "config/ai/image/read/prompt",
  "config/ai/image/generation/provider",
  "config/ai/image/generation/model",
  "config/ai/transcription/provider",
  "config/ai/transcription/model",
  "config/ai/transcription/max_bytes",
  "config/ai/speech/provider",
  "config/ai/speech/model",
  "config/ai/speech/speaker",
  "config/ai/speech/encoding",
  "config/ai/speech/max_chars",
  "config/ai/speech/timeout_ms",
  "config/ai/tools/approval",
  "config/server/name",
  "config/server/timezone",
  "config/server/version",
  "config/shell/timeout_ms",
  "config/shell/network_enabled",
  "config/shell/max_output_bytes",
]);

const SHARED_SYSTEM_CONFIG_PREFIXES = [
  // This namespace is deliberately global model context, not credential data.
  "config/ai/context.d/",
] as const;

export function isSensitiveConfigKey(key: string): boolean {
  const parts = key.split("/").filter(Boolean);
  const field = parts.length > 0 ? parts[parts.length - 1].toLowerCase() : "";
  if (!field) return false;

  if (SENSITIVE_CONFIG_FIELDS.has(field)) {
    return true;
  }

  return SENSITIVE_CONFIG_SUFFIXES.some((suffix) => field.endsWith(suffix));
}

export function isSharedSystemConfigKey(key: string): boolean {
  return SHARED_SYSTEM_CONFIG_KEYS.has(key)
    || SHARED_SYSTEM_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function canReadConfigKey(uid: number, key: string): boolean {
  if (uid === 0) return true;

  if (key.startsWith(`users/${uid}/`)) {
    return true;
  }

  if (key.startsWith("config/")) {
    return isSharedSystemConfigKey(key);
  }

  return false;
}
