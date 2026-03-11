/**
 * ConfigStore — SQLite key-value store for runtime configuration.
 *
 * Exposed to userspace via /sys/config/* (system-wide, root-only writes)
 * and /sys/users/{uid}/* (per-user, owner or root writes).
 *
 * Keys are virtual path segments stripped of the /sys/ prefix:
 *   "config/ai/provider"   → /sys/config/ai/provider
 *   "users/0/ai/model"     → /sys/users/0/ai/model
 *
 * System config is the runtime truth. R2 dotfiles (/etc/gsv/config,
 * ~/.config/gsv/config) are seed files loaded on first connect.
 */

// =============================================================================
// System config defaults — every field documented.
//
// Keys live under "config/" and are exposed at /sys/config/*.
// Per-user overrides go under "users/{uid}/" at /sys/users/{uid}/*.
// =============================================================================

export const SYSTEM_CONFIG_DEFAULTS: Record<string, string> = {
  // -- AI / LLM ---------------------------------------------------------------
  // The LLM provider to use (anthropic, openai, google, mistral, etc.)
  "config/ai/provider": "anthropic", // TODO: should make this workersai
  // The model identifier for the LLM provider
  "config/ai/model": "claude-sonnet-4-20250514",
  // API key for the LLM provider. Empty = not configured (must be set by root).
  "config/ai/api_key": "",
  // Reasoning effort/mode hint passed to the model (off, low, medium, high).
  // Only applies to models that support extended thinking.
  "config/ai/reasoning": "off",
  // Max tokens for LLM responses (model-dependent upper bound).
  "config/ai/max_tokens": "8192",

  // -- Server -----------------------------------------------------------------
  // Human-readable name for this GSV instance.
  "config/server/name": "gsv",
  // Timezone used for cron scheduling and log timestamps (IANA format).
  "config/server/timezone": "UTC",
  // The current server version (set at boot, read-only for users).
  "config/server/version": "0.0.1",

  // -- Shell ------------------------------------------------------------------
  // Default shell timeout in ms for native shell.exec.
  "config/shell/timeout_ms": "30000",
  // Whether curl/wget are enabled in the native bash shell (true/false).
  "config/shell/network_enabled": "true",
  // Max output size in bytes for shell command results.
  "config/shell/max_output_bytes": "524288",

  // -- Processes ---------------------------------------------------------------
  // Default label format for init processes. {username} is replaced.
  "config/process/init_label": "init ({username})",
  // Max concurrent processes per user (0 = unlimited).
  "config/process/max_per_user": "0",
};

// Per-user config keys follow the same structure under "users/{uid}/ai/*".
// e.g. "users/1000/ai/provider" overrides "config/ai/provider" for uid 1000.
// Only AI config is user-overridable; server/shell/process config is system-only.
export const USER_OVERRIDABLE_PREFIXES = ["ai/"] as const;

export class ConfigStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  get(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>(
      "SELECT value FROM config_kv WHERE key = ?",
      key,
    ).toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  set(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO config_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  delete(key: string): boolean {
    const existing = this.get(key);
    if (existing === null) return false;
    this.sql.exec("DELETE FROM config_kv WHERE key = ?", key);
    return true;
  }

  /**
   * List all keys (and values) under a prefix.
   * e.g. list("config/ai") returns all /sys/config/ai/* entries.
   */
  list(prefix: string): { key: string; value: string }[] {
    const pattern = prefix.endsWith("/") ? prefix : prefix + "/";
    return this.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM config_kv WHERE key LIKE ? ORDER BY key",
      pattern + "%",
    ).toArray();
  }

  /**
   * Seed defaults — only inserts keys that don't already exist.
   */
  seed(defaults: Record<string, string>): void {
    for (const [key, value] of Object.entries(defaults)) {
      this.sql.exec(
        "INSERT OR IGNORE INTO config_kv (key, value) VALUES (?, ?)",
        key,
        value,
      );
    }
  }

  /**
   * Seed from a parsed key=value config string (like /etc/gsv/config).
   * Only inserts keys that don't already exist.
   */
  seedFromText(prefix: string, text: string): void {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      this.sql.exec(
        "INSERT OR IGNORE INTO config_kv (key, value) VALUES (?, ?)",
        `${prefix}/${key}`,
        value,
      );
    }
  }
}
