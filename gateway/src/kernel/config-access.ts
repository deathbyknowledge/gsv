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

function lastKeySegment(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  return parts[parts.length - 1].toLowerCase();
}

export function isSensitiveConfigKey(key: string): boolean {
  const field = lastKeySegment(key);
  if (!field) return false;

  if (SENSITIVE_CONFIG_FIELDS.has(field)) {
    return true;
  }

  return SENSITIVE_CONFIG_SUFFIXES.some((suffix) => field.endsWith(suffix));
}

export function canReadConfigKey(uid: number, key: string): boolean {
  if (uid === 0) return true;

  if (key.startsWith(`users/${uid}/`)) {
    return true;
  }

  if (key.startsWith("config/")) {
    return !isSensitiveConfigKey(key);
  }

  return false;
}
